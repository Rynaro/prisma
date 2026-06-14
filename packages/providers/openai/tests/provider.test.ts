import { ProviderErrorThrowable, type ProviderReviewInput } from '@prisma-bot/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  OPENAI_CAPABILITIES,
  OPENAI_DEFAULT_MODEL,
  OPENAI_PROVIDER_NAME,
  type OpenAIClientLike,
  OpenAIProvider,
  resolveTokenParam,
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

  // T10: finish_reason==='length' → schema_validation (truncation guard)
  it('throws schema_validation when finish_reason is "length" (response truncated at max_tokens)', async () => {
    // Simulate a response where the model hit max_tokens: tool_call arguments
    // may be a partially-written JSON array that would parse but silently drop findings.
    const chatCompletions = vi.fn().mockResolvedValue({
      id: 'chatcmpl-truncated',
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
                  name: 'submit_review_findings',
                  arguments: JSON.stringify({ findings: [] }),
                },
              },
            ],
          },
          finish_reason: 'length',
        },
      ],
    });
    const provider = new OpenAIProvider({ apiKey: 'k', client: { chatCompletions } });
    await expect(provider.review(validInput)).rejects.toMatchObject({
      name: 'ProviderErrorThrowable',
      cause_kind: 'schema_validation',
    });
  });

  // T11: finish_reason==='tool_calls' (normal) → does NOT throw truncation error
  it('does not throw truncation error when finish_reason is "tool_calls"', async () => {
    const chatCompletions = vi.fn().mockResolvedValue(chatCompletionsResponse({ findings: [] }));
    const provider = new OpenAIProvider({ apiKey: 'k', client: { chatCompletions } });
    const out = await provider.review(validInput);
    expect(out.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveTokenParam — unit tests across model matrix (D1)
// ---------------------------------------------------------------------------

describe('resolveTokenParam', () => {
  // Auto-select: newer models → max_completion_tokens
  it('auto: gpt-5.4-nano → max_completion_tokens', () => {
    expect(resolveTokenParam('gpt-5.4-nano')).toBe('max_completion_tokens');
  });

  it('auto: gpt-5-nano → max_completion_tokens', () => {
    expect(resolveTokenParam('gpt-5-nano')).toBe('max_completion_tokens');
  });

  it('auto: gpt-5 → max_completion_tokens', () => {
    expect(resolveTokenParam('gpt-5')).toBe('max_completion_tokens');
  });

  it('auto: o3 → max_completion_tokens', () => {
    expect(resolveTokenParam('o3')).toBe('max_completion_tokens');
  });

  it('auto: o1 → max_completion_tokens', () => {
    expect(resolveTokenParam('o1')).toBe('max_completion_tokens');
  });

  it('auto: o4-mini → max_completion_tokens', () => {
    expect(resolveTokenParam('o4-mini')).toBe('max_completion_tokens');
  });

  it('auto: gpt-6 (future) → max_completion_tokens', () => {
    expect(resolveTokenParam('gpt-6')).toBe('max_completion_tokens');
  });

  it('auto: gpt-10 (two-digit major, future) → max_completion_tokens', () => {
    expect(resolveTokenParam('gpt-10')).toBe('max_completion_tokens');
  });

  // Auto-select: classic models → max_tokens
  it('auto: gpt-4o → max_tokens', () => {
    expect(resolveTokenParam('gpt-4o')).toBe('max_tokens');
  });

  it('auto: gpt-4.1 → max_tokens', () => {
    expect(resolveTokenParam('gpt-4.1')).toBe('max_tokens');
  });

  it('auto: gpt-4 → max_tokens', () => {
    expect(resolveTokenParam('gpt-4')).toBe('max_tokens');
  });

  it('auto: gpt-3.5-turbo → max_tokens', () => {
    expect(resolveTokenParam('gpt-3.5-turbo')).toBe('max_tokens');
  });

  it('auto: default (undefined override) is equivalent to auto', () => {
    // resolveTokenParam with no second argument defaults to 'auto'
    expect(resolveTokenParam('gpt-5.4-nano', undefined)).toBe('max_completion_tokens');
    expect(resolveTokenParam('gpt-4o', undefined)).toBe('max_tokens');
  });

  // Explicit override bypasses heuristic
  it('explicit max_tokens override forces max_tokens even for gpt-5.4-nano', () => {
    expect(resolveTokenParam('gpt-5.4-nano', 'max_tokens')).toBe('max_tokens');
  });

  it('explicit max_completion_tokens override forces max_completion_tokens even for gpt-4o', () => {
    expect(resolveTokenParam('gpt-4o', 'max_completion_tokens')).toBe('max_completion_tokens');
  });

  it('explicit max_tokens override forces max_tokens for o3', () => {
    expect(resolveTokenParam('o3', 'max_tokens')).toBe('max_tokens');
  });

  it('explicit max_completion_tokens override forces max_completion_tokens for gpt-3.5-turbo', () => {
    expect(resolveTokenParam('gpt-3.5-turbo', 'max_completion_tokens')).toBe(
      'max_completion_tokens',
    );
  });

  it('explicit auto behaves identically to omitted override', () => {
    expect(resolveTokenParam('gpt-5.4-nano', 'auto')).toBe('max_completion_tokens');
    expect(resolveTokenParam('gpt-4o', 'auto')).toBe('max_tokens');
  });
});

// ---------------------------------------------------------------------------
// Token-param integration — per-request wiring (D1/D2)
// ---------------------------------------------------------------------------

describe('OpenAIProvider — token param per-request wiring', () => {
  // Helper: returns the args passed to chatCompletions
  function makeCapturingClient(): {
    client: OpenAIClientLike;
    getArgs: () => Record<string, unknown>;
  } {
    let capturedArgs: Record<string, unknown> = {};
    const client: OpenAIClientLike = {
      chatCompletions: vi.fn().mockImplementation((args: unknown) => {
        capturedArgs = args as Record<string, unknown>;
        return Promise.resolve(chatCompletionsResponse({ findings: [] }));
      }),
    };
    return { client, getArgs: () => capturedArgs };
  }

  it('classic model (gpt-4o default) → sends max_tokens, NOT max_completion_tokens', async () => {
    const { client, getArgs } = makeCapturingClient();
    const provider = new OpenAIProvider({ apiKey: 'k', client });
    await provider.review(validInput);
    const args = getArgs();
    expect('max_tokens' in args).toBe(true);
    expect('max_completion_tokens' in args).toBe(false);
  });

  it('gpt-5.4-nano via request_shaping.model → sends max_completion_tokens, NOT max_tokens', async () => {
    const { client, getArgs } = makeCapturingClient();
    const provider = new OpenAIProvider({ apiKey: 'k', client });
    await provider.review({ ...validInput, request_shaping: { model: 'gpt-5.4-nano' } });
    const args = getArgs();
    expect('max_completion_tokens' in args).toBe(true);
    expect('max_tokens' in args).toBe(false);
  });

  it('o3 via request_shaping.model → sends max_completion_tokens, NOT max_tokens', async () => {
    const { client, getArgs } = makeCapturingClient();
    const provider = new OpenAIProvider({ apiKey: 'k', client });
    await provider.review({ ...validInput, request_shaping: { model: 'o3' } });
    const args = getArgs();
    expect('max_completion_tokens' in args).toBe(true);
    expect('max_tokens' in args).toBe(false);
  });

  it('never sends both max_tokens and max_completion_tokens in the same request', async () => {
    const { client, getArgs } = makeCapturingClient();
    const provider = new OpenAIProvider({ apiKey: 'k', client });
    // gpt-4o default
    await provider.review(validInput);
    const args1 = getArgs();
    expect('max_tokens' in args1 && 'max_completion_tokens' in args1).toBe(false);

    // gpt-5 override
    await provider.review({ ...validInput, request_shaping: { model: 'gpt-5' } });
    const args2 = getArgs();
    expect('max_tokens' in args2 && 'max_completion_tokens' in args2).toBe(false);
  });

  it('explicit tokenParamStyle=max_tokens forces max_tokens even when gpt-5.4-nano is the model', async () => {
    const { client, getArgs } = makeCapturingClient();
    const provider = new OpenAIProvider({
      apiKey: 'k',
      client,
      tokenParamStyle: 'max_tokens',
      model: 'gpt-5.4-nano',
    });
    await provider.review(validInput);
    const args = getArgs();
    expect('max_tokens' in args).toBe(true);
    expect('max_completion_tokens' in args).toBe(false);
  });

  it('explicit tokenParamStyle=max_completion_tokens forces max_completion_tokens even for gpt-4o', async () => {
    const { client, getArgs } = makeCapturingClient();
    const provider = new OpenAIProvider({
      apiKey: 'k',
      client,
      tokenParamStyle: 'max_completion_tokens',
    });
    await provider.review(validInput);
    const args = getArgs();
    expect('max_completion_tokens' in args).toBe(true);
    expect('max_tokens' in args).toBe(false);
  });

  it('maxOutputTokens flows to the chosen token param field', async () => {
    const { client, getArgs } = makeCapturingClient();
    const provider = new OpenAIProvider({
      apiKey: 'k',
      client,
      model: 'gpt-5.4-nano',
      maxOutputTokens: 8192,
    });
    await provider.review(validInput);
    const args = getArgs();
    expect(args.max_completion_tokens).toBe(8192);
    expect('max_tokens' in args).toBe(false);
  });

  it('maxOutputTokens defaults to 4096 when unset', async () => {
    const { client, getArgs } = makeCapturingClient();
    const provider = new OpenAIProvider({ apiKey: 'k', client });
    await provider.review(validInput);
    const args = getArgs();
    expect(args.max_tokens).toBe(4096);
  });

  it('truncation guard message is param-agnostic and includes the output token cap', async () => {
    // Use a newer model so the param is max_completion_tokens
    const truncatedResponse = {
      id: 'chatcmpl-truncated',
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
                  name: 'submit_review_findings',
                  arguments: JSON.stringify({ findings: [] }),
                },
              },
            ],
          },
          finish_reason: 'length',
        },
      ],
    };
    const client: OpenAIClientLike = {
      chatCompletions: vi.fn().mockResolvedValue(truncatedResponse),
    };
    const provider = new OpenAIProvider({
      apiKey: 'k',
      client,
      model: 'gpt-5.4-nano',
      maxOutputTokens: 8192,
    });
    await expect(provider.review(validInput)).rejects.toMatchObject({
      name: 'ProviderErrorThrowable',
      cause_kind: 'schema_validation',
    });
    // Verify the message is generic (doesn't hard-code a param name)
    // and contains the actual cap value
    try {
      await provider.review(validInput);
    } catch (err) {
      if (err instanceof ProviderErrorThrowable) {
        expect(err.value.message).toContain('output token cap');
        expect(err.value.message).toContain('8192');
        expect(err.value.message).not.toContain('max_tokens: 4096');
      }
    }
  });
});
