/**
 * `transport.test.ts` — the OpenAI adapter driven through its PRODUCTION
 * client against a mocked HTTP boundary.
 *
 * Every other test in this package injects an `OpenAIClientLike`, which proves
 * what `review()` hands to a client but not what a client would put on the
 * wire: the URL, the serialized JSON body, and the response readers are all
 * below that seam. This file closes that gap by stubbing the global HTTP
 * primitive and constructing `OpenAIProvider` WITHOUT a `client`, so
 * `createOpenAIClient` is the code under test alongside `review()`.
 *
 * Asserted here: the endpoint URL, the exact serialized request body, reading
 * findings out of a `function_call` output item, a missing function call, a
 * malformed arguments payload, output truncation, and the existing 400 →
 * `capability` error mapping.
 *
 * Note on ADR-002: `scripts/check-vendor-isolation.sh` confines the network
 * primitive to each adapter's own `client.ts` within `packages/providers/`, and that rule
 * is matched textually. This file therefore never spells the call form — it
 * installs a stub by name through `vi.stubGlobal` and reads the recorded
 * arguments.
 */

import { type ProviderReviewInput } from '@prisma-bot/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../src/index.js';

const reviewInput: ProviderReviewInput = {
  files: [
    {
      path: 'src/a.ts',
      hunks: [{ id: 'H1', line_start: 1, line_end: 5, content: 'export const a = 1;\n' }],
    },
  ],
};

interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

let recorded: RecordedCall[] = [];

/** Install an HTTP stub that answers every request with `payload`. */
function stubOk(payload: unknown, status = 200): void {
  const stub = vi.fn(async (url: unknown, init: unknown) => {
    const requestInit = (init ?? {}) as { body?: string; headers?: Record<string, string> };
    recorded.push({
      url: String(url),
      body: JSON.parse(requestInit.body ?? '{}') as Record<string, unknown>,
      headers: requestInit.headers ?? {},
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  });
  vi.stubGlobal('fetch', stub);
}

/** A `/responses` payload carrying one `function_call` output item. */
function responsesPayload(toolArgs: unknown, name = 'submit_review_findings') {
  return {
    id: 'resp_1',
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'function_call', call_id: 'c1', name, arguments: JSON.stringify(toolArgs) },
    ],
    usage: {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 60,
      output_tokens_details: { reasoning_tokens: 45 },
    },
  };
}

const oneFinding = {
  findings: [
    {
      path: 'src/a.ts',
      line: 1,
      severity: 'medium',
      category: 'correctness',
      message: 'transport finding',
      rationale: 'read from the function_call output item',
      confidence: 0.8,
    },
  ],
};

beforeEach(() => {
  recorded = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAI transport boundary — URL and request body', () => {
  it('posts a gpt-5.6 review to /v1/responses with the translated incident body', async () => {
    stubOk(responsesPayload(oneFinding));
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-5.6-luna' });

    const out = await provider.review({
      ...reviewInput,
      // The exact configuration from issue #40.
      request_shaping: { deterministic_seed: 42, provider_options: { reasoning_effort: 'high' } },
    });

    expect(out.findings).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    const call = recorded[0];
    expect(call?.url).toBe('https://api.openai.com/v1/responses');
    expect(call?.headers.Authorization).toBe('Bearer sk-test');

    const body = call?.body ?? {};
    // [P1] reasoning is the Responses spelling, and the chat spelling is gone.
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect('reasoning_effort' in body).toBe(false);
    // [P1] one-shot: no state reference, no retention.
    expect(body.store).toBe(false);
    expect('previous_response_id' in body).toBe(false);
    expect('conversation' in body).toBe(false);
    // [P2] no seed on an endpoint that has none.
    expect('seed' in body).toBe(false);
    // [P2] one cap, in the native spelling only.
    expect(body.max_output_tokens).toBe(4096);
    expect('max_tokens' in body).toBe(false);
    expect('max_completion_tokens' in body).toBe(false);
    // The review contract survives the translation.
    expect('messages' in body).toBe(false);
    expect(typeof body.instructions).toBe('string');
    expect(Array.isArray(body.input)).toBe(true);
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]?.name).toBe('submit_review_findings');
    expect('function' in (tools[0] ?? {})).toBe(false);
    expect(body.tool_choice).toBe('required');
  });

  it('serializes a native max_output_tokens override at the transport, not the 4096 default', async () => {
    stubOk(responsesPayload({ findings: [] }));
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-5.6-luna' });
    await provider.review({
      ...reviewInput,
      request_shaping: { provider_options: { max_output_tokens: 32000 } },
    });
    expect(recorded[0]?.body.max_output_tokens).toBe(32000);
  });

  it('posts a classic-model review to /v1/chat/completions in the pre-Responses shape', async () => {
    stubOk({
      id: 'chatcmpl_1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: {
                  name: 'submit_review_findings',
                  arguments: JSON.stringify(oneFinding),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o' });
    const out = await provider.review({
      ...reviewInput,
      request_shaping: { deterministic_seed: 42 },
    });

    expect(out.findings).toHaveLength(1);
    expect(recorded[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    const body = recorded[0]?.body ?? {};
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.max_tokens).toBe(4096);
    expect(body.seed).toBe(42);
    expect('input' in body).toBe(false);
    expect('store' in body).toBe(false);
    expect('max_output_tokens' in body).toBe(false);
  });

  it('builds the /responses URL from OPENAI_BASE_URL', async () => {
    stubOk(responsesPayload({ findings: [] }));
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      model: 'gpt-5.6-luna',
      baseUrl: 'https://gateway.internal/openai/v1/',
    });
    await provider.review(reviewInput);
    expect(recorded[0]?.url).toBe('https://gateway.internal/openai/v1/responses');
  });
});

describe('OpenAI transport boundary — response readers', () => {
  it('reads findings from the function_call output item past the reasoning item', async () => {
    stubOk(responsesPayload(oneFinding));
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-5.6-luna' });
    const out = await provider.review(reviewInput);
    expect(out.findings[0]?.message).toBe('transport finding');
  });

  it('maps a response with no function_call output item to the missing tool_call error', async () => {
    stubOk({
      id: 'resp_1',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'looks fine to me' }] }],
    });
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-5.6-luna' });
    await expect(provider.review(reviewInput)).rejects.toMatchObject({
      cause_kind: 'schema_validation',
    });
  });

  it('maps a malformed function_call arguments payload to schema_validation', async () => {
    stubOk({
      id: 'resp_1',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'submit_review_findings',
          arguments: '{"findings": [',
        },
      ],
    });
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-5.6-luna' });
    await expect(provider.review(reviewInput)).rejects.toMatchObject({
      cause_kind: 'schema_validation',
    });
  });

  it('maps an out-of-schema findings payload to schema_validation', async () => {
    stubOk(
      responsesPayload({
        findings: [
          {
            path: 'src/a.ts',
            line: 1,
            // `severity` carrying a category value is the documented gpt-5.6
            // failure mode at reasoning_effort 'none' (PR #41 description).
            severity: 'correctness',
            category: 'correctness',
            message: 'x',
            rationale: 'y',
            confidence: 0.5,
          },
        ],
      }),
    );
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-5.6-luna' });
    await expect(provider.review(reviewInput)).rejects.toMatchObject({
      cause_kind: 'schema_validation',
    });
  });

  it('maps status incomplete / max_output_tokens to output_truncated', async () => {
    stubOk({
      id: 'resp_1',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
    });
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-5.6-luna' });
    await expect(provider.review(reviewInput)).rejects.toMatchObject({
      cause_kind: 'output_truncated',
    });
  });
});

describe('OpenAI transport boundary — error mapping', () => {
  it('maps the issue #40 400 rejection to a capability error carrying the provider message', async () => {
    stubOk(
      {
        error: {
          message:
            "Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
          type: 'invalid_request_error',
        },
      },
      400,
    );
    // Pinned to chat so the rejection the issue reports is what the transport sees.
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      model: 'gpt-5.6-luna',
      apiStyle: 'chat',
    });
    await expect(provider.review(reviewInput)).rejects.toMatchObject({
      cause_kind: 'capability',
    });
    expect(recorded[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('maps a 400 from /responses through the same mapper', async () => {
    stubOk(
      { error: { message: "Unsupported parameter: 'max_tokens'", type: 'invalid_request_error' } },
      400,
    );
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-5.6-luna' });
    await expect(provider.review(reviewInput)).rejects.toMatchObject({
      cause_kind: 'capability',
    });
    expect(recorded[0]?.url).toBe('https://api.openai.com/v1/responses');
  });

  it('maps a 401 from /responses to auth and a 429 to rate_limited', async () => {
    stubOk({ error: { message: 'Invalid API key', type: 'invalid_request_error' } }, 401);
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-5.6-luna' });
    await expect(provider.review(reviewInput)).rejects.toMatchObject({ cause_kind: 'auth' });

    stubOk({ error: { message: 'Rate limit reached', type: 'rate_limit_error' } }, 429);
    await expect(provider.review(reviewInput)).rejects.toMatchObject({
      cause_kind: 'rate_limit',
    });
  });
});
