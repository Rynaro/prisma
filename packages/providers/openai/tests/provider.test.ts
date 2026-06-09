import { ProviderErrorThrowable, type ProviderReviewInput } from '@prisma-bot/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  OPENAI_CAPABILITIES,
  OPENAI_DEFAULT_MODEL,
  OPENAI_PROVIDER_NAME,
  type OpenAIClientLike,
  OpenAIProvider,
} from '../src/index.js';

const validInput: ProviderReviewInput = {
  files: [
    {
      path: 'src/a.ts',
      hunks: [{ id: 'H1', line_start: 1, line_end: 5, content: 'export const a = 1;\n' }],
    },
  ],
};

function chatCompletionsResponse(toolArgs: unknown, toolName = 'submit_review_findings') {
  return {
    id: 'chatcmpl-fake',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: toolName,
                // OpenAI returns `arguments` as a JSON-encoded string.
                // The adapter must JSON.parse it.
                arguments: JSON.stringify(toolArgs),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

describe('OpenAIProvider', () => {
  // T1: name + caps (deterministic_seed===true)
  it('exposes name = "openai" and default capabilities with deterministic_seed true', () => {
    const provider = new OpenAIProvider({
      apiKey: 'irrelevant',
      client: { chatCompletions: vi.fn() },
    });
    expect(provider.name).toBe(OPENAI_PROVIDER_NAME);
    expect(provider.name).toBe('openai');
    expect(provider.capabilities.structured_output).toBe(true);
    expect(provider.capabilities.function_calling).toBe(true);
    expect(provider.capabilities.deterministic_seed).toBe(true);
    expect(provider.capabilities.max_context_tokens).toBeGreaterThan(0);
    // deep-equal check against OPENAI_CAPABILITIES
    expect(provider.capabilities).toEqual(OPENAI_CAPABILITIES);
  });

  // T2: happy path
  it('happy path: tool_call response → schema-valid ProviderReviewOutput is returned', async () => {
    const chatCompletions = vi.fn().mockResolvedValue(
      chatCompletionsResponse({
        findings: [
          {
            path: 'src/a.ts',
            line: 3,
            severity: 'medium',
            category: 'correctness',
            message: 'flag',
            rationale: 'because reasons',
            confidence: 0.7,
          },
        ],
      }),
    );
    const client: OpenAIClientLike = { chatCompletions };
    const provider = new OpenAIProvider({ apiKey: 'k', client });

    const out = await provider.review(validInput);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.path).toBe('src/a.ts');
    expect(chatCompletions).toHaveBeenCalledTimes(1);
  });

  // T3: strict-reject extra fields
  it('rejects tool_call arguments with extra fields (strict schema)', async () => {
    const chatCompletions = vi.fn().mockResolvedValue(
      chatCompletionsResponse({
        findings: [
          {
            path: 'src/a.ts',
            line: 3,
            severity: 'medium',
            category: 'correctness',
            message: 'flag',
            rationale: 'because reasons',
            confidence: 0.7,
            unexpected_extra: 'should be rejected',
          },
        ],
      }),
    );
    const provider = new OpenAIProvider({
      apiKey: 'k',
      client: { chatCompletions },
    });
    await expect(provider.review(validInput)).rejects.toMatchObject({
      name: 'ProviderErrorThrowable',
      cause_kind: 'schema_validation',
    });
  });

  // T4: no-tool-call → schema_validation
  it('throws schema_validation when no tool_call is present', async () => {
    const chatCompletions = vi.fn().mockResolvedValue({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'I refuse to call the tool.' },
          finish_reason: 'stop',
        },
      ],
    });
    const provider = new OpenAIProvider({
      apiKey: 'k',
      client: { chatCompletions },
    });
    await expect(provider.review(validInput)).rejects.toMatchObject({
      name: 'ProviderErrorThrowable',
      cause_kind: 'schema_validation',
    });
  });

  // T5: client throw → mapped ProviderErrorThrowable
  it('client throws → mapped through mapOpenAIError and re-thrown as ProviderErrorThrowable', async () => {
    const chatCompletions = vi.fn().mockRejectedValue({ status: 401, message: 'invalid api key' });
    const provider = new OpenAIProvider({
      apiKey: 'k',
      client: { chatCompletions },
    });
    try {
      await provider.review(validInput);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderErrorThrowable);
      expect((err as ProviderErrorThrowable).cause_kind).toBe('auth');
    }
  });

  // T6: cost-ceiling
  it('cost-ceiling: oversized input throws before client.chatCompletions is called', async () => {
    const chatCompletions = vi.fn();
    const provider = new OpenAIProvider({
      apiKey: 'k',
      maxTokensPerCall: 1, // any non-trivial input will exceed this
      client: { chatCompletions },
    });
    try {
      await provider.review(validInput);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderErrorThrowable);
      const thrown = err as ProviderErrorThrowable;
      expect(thrown.cause_kind).toBe('capability');
      if (thrown.value.kind === 'capability') {
        expect(thrown.value.missing_capability).toBe('cost_ceiling');
      }
    }
    expect(chatCompletions).not.toHaveBeenCalled();
  });

  // T7: seed threading — args.seed === 42
  it('threads deterministic_seed=42 from request_shaping into args.seed', async () => {
    let capturedArgs: unknown;
    const chatCompletions = vi.fn().mockImplementation((args: unknown) => {
      capturedArgs = args;
      return Promise.resolve(chatCompletionsResponse({ findings: [] }));
    });
    const provider = new OpenAIProvider({ apiKey: 'k', client: { chatCompletions } });
    await provider.review({ ...validInput, request_shaping: { deterministic_seed: 42 } });
    expect(chatCompletions).toHaveBeenCalledTimes(1);
    expect((capturedArgs as Record<string, unknown>).seed).toBe(42);
  });

  // T8: no seed → 'seed' in args === false
  it('omits seed entirely when no deterministic_seed in request_shaping', async () => {
    let capturedArgs: unknown;
    const chatCompletions = vi.fn().mockImplementation((args: unknown) => {
      capturedArgs = args;
      return Promise.resolve(chatCompletionsResponse({ findings: [] }));
    });
    const provider = new OpenAIProvider({ apiKey: 'k', client: { chatCompletions } });
    await provider.review(validInput);
    expect(chatCompletions).toHaveBeenCalledTimes(1);
    expect('seed' in (capturedArgs as Record<string, unknown>)).toBe(false);
  });

  // T9: model override via request_shaping
  it('uses model from request_shaping when provided, falls back to default otherwise', async () => {
    let capturedArgs: unknown;
    const chatCompletions = vi.fn().mockImplementation((args: unknown) => {
      capturedArgs = args;
      return Promise.resolve(chatCompletionsResponse({ findings: [] }));
    });
    const provider = new OpenAIProvider({ apiKey: 'k', client: { chatCompletions } });

    // with override
    await provider.review({ ...validInput, request_shaping: { model: 'gpt-4-turbo' } });
    expect((capturedArgs as Record<string, unknown>).model).toBe('gpt-4-turbo');

    // without override — should use default
    await provider.review(validInput);
    expect((capturedArgs as Record<string, unknown>).model).toBe(OPENAI_DEFAULT_MODEL);
  });
});
