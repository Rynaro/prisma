import {
  ProviderErrorThrowable,
  type ProviderRespondInput,
  type ProviderReviewInput,
} from '@prisma-bot/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_PROVIDER_NAME,
  type AnthropicClientLike,
  AnthropicProvider,
} from '../src/index.js';

const validInput: ProviderReviewInput = {
  files: [
    {
      path: 'src/a.ts',
      hunks: [{ id: 'H1', line_start: 1, line_end: 5, content: 'export const a = 1;\n' }],
    },
  ],
};

const validRespondInput: ProviderRespondInput = {
  pr: {
    title: 'Fix payment race condition',
    description: '',
    base_ref: 'main',
    head_ref: 'fix/payment-race',
    head_sha: 'deadbeefcafef00d',
  },
  review_context: { round: 2, summary_markdown: 'Round 2', findings: [] },
  thread: [],
  message: { author_login: 'alice', text: 'why is finding 2 a security risk?' },
};

function textResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

function toolUseResponse(input: unknown, toolName = 'submit_review_findings') {
  return {
    content: [
      { type: 'text', text: 'okay' },
      { type: 'tool_use', name: toolName, input },
    ],
  };
}

describe('AnthropicProvider', () => {
  it('exposes name = "anthropic" and default capabilities', () => {
    const provider = new AnthropicProvider({
      apiKey: 'irrelevant',
      client: { messages: { create: vi.fn() } },
    });
    expect(provider.name).toBe(ANTHROPIC_PROVIDER_NAME);
    expect(provider.name).toBe('anthropic');
    expect(provider.capabilities.structured_output).toBe(true);
    expect(provider.capabilities.function_calling).toBe(true);
    expect(provider.capabilities.max_context_tokens).toBeGreaterThan(0);
  });

  it('happy path: tool_use response → schema-valid ProviderReviewOutput is returned', async () => {
    const create = vi.fn().mockResolvedValue(
      toolUseResponse({
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
    const client: AnthropicClientLike = { messages: { create } };
    const provider = new AnthropicProvider({ apiKey: 'k', client });

    const out = await provider.review(validInput);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.path).toBe('src/a.ts');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rejects tool_use input with extra fields (strict schema)', async () => {
    const create = vi.fn().mockResolvedValue(
      toolUseResponse({
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
    const provider = new AnthropicProvider({
      apiKey: 'k',
      client: { messages: { create } },
    });
    await expect(provider.review(validInput)).rejects.toMatchObject({
      name: 'ProviderErrorThrowable',
      cause_kind: 'schema_validation',
    });
  });

  it('throws schema_validation when no tool_use block is present', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'I refuse to call the tool.' }],
    });
    const provider = new AnthropicProvider({
      apiKey: 'k',
      client: { messages: { create } },
    });
    await expect(provider.review(validInput)).rejects.toMatchObject({
      name: 'ProviderErrorThrowable',
      cause_kind: 'schema_validation',
    });
  });

  it('client throws → mapped through mapAnthropicError and re-thrown as ProviderErrorThrowable', async () => {
    const create = vi.fn().mockRejectedValue({ status: 401, message: 'invalid api key' });
    const provider = new AnthropicProvider({
      apiKey: 'k',
      client: { messages: { create } },
    });
    try {
      await provider.review(validInput);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderErrorThrowable);
      expect((err as ProviderErrorThrowable).cause_kind).toBe('auth');
    }
  });

  // Phase 4: guard now throws `over_budget` (not `capability/cost_ceiling`)
  // so the orchestrator can degrade (split/skip) instead of aborting the PR.
  // Per chunking-stability-spec.md § Phase 4 "New degradable error kind".
  it('over_budget (Phase 4): oversized input throws over_budget before client.messages.create is called', async () => {
    const create = vi.fn();
    const provider = new AnthropicProvider({
      apiKey: 'k',
      maxTokensPerCall: 1, // any non-trivial input will exceed this
      client: { messages: { create } },
    });
    try {
      await provider.review(validInput);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderErrorThrowable);
      const thrown = err as ProviderErrorThrowable;
      // Phase 4: guard throws over_budget, not capability/cost_ceiling.
      expect(thrown.cause_kind).toBe('over_budget');
      if (thrown.value.kind === 'over_budget') {
        expect(thrown.value.estimated_tokens).toBeGreaterThan(0);
        expect(thrown.value.hard_cap_in).toBe(1);
      }
    }
    expect(create).not.toHaveBeenCalled();
  });

  // T10: stop_reason==='max_tokens' → output_truncated (Phase 1: split-and-retry)
  it('throws output_truncated when stop_reason is "max_tokens" (response truncated)', async () => {
    // Simulate a response where the model hit max_tokens: tool_use input
    // may be a partially-written object that would pass schema but silently drop findings.
    const create = vi.fn().mockResolvedValue({
      stop_reason: 'max_tokens',
      content: [
        {
          type: 'tool_use',
          name: 'submit_review_findings',
          input: { findings: [] },
        },
      ],
    });
    const provider = new AnthropicProvider({ apiKey: 'k', client: { messages: { create } } });
    await expect(provider.review(validInput)).rejects.toMatchObject({
      name: 'ProviderErrorThrowable',
      cause_kind: 'output_truncated',
    });
  });

  // T10b: output_truncated carries requested_max_tokens
  it('output_truncated error carries requested_max_tokens matching what was sent', async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: 'max_tokens',
      content: [
        {
          type: 'tool_use',
          name: 'submit_review_findings',
          input: { findings: [] },
        },
      ],
    });
    // Use a non-default maxOutputTokens so we can distinguish it.
    const provider = new AnthropicProvider({
      apiKey: 'k',
      client: { messages: { create } },
      maxOutputTokens: 8192,
    });
    try {
      await provider.review(validInput);
      expect.fail('expected throw');
    } catch (err) {
      const thrown = err as ProviderErrorThrowable;
      expect(thrown.cause_kind).toBe('output_truncated');
      if (thrown.value.kind === 'output_truncated') {
        expect(thrown.value.requested_max_tokens).toBe(8192);
      }
    }
  });

  // T11: stop_reason==='tool_use' (normal) → does NOT throw truncation error
  it('does not throw truncation error when stop_reason is "tool_use"', async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: 'tool_use',
      ...toolUseResponse({ findings: [] }),
    });
    const provider = new AnthropicProvider({ apiKey: 'k', client: { messages: { create } } });
    const out = await provider.review(validInput);
    expect(out.findings).toHaveLength(0);
  });

  // AC1.2: configurable maxOutputTokens flows to the provider call
  it('AC1.2: maxOutputTokens option sets max_tokens on the wire request', async () => {
    const create = vi.fn().mockResolvedValue(toolUseResponse({ findings: [] }));
    // Provide non-default value to verify it flows through.
    const provider = new AnthropicProvider({
      apiKey: 'k',
      client: { messages: { create } },
      maxOutputTokens: 8192,
    });
    await provider.review(validInput);
    expect(create).toHaveBeenCalledTimes(1);
    const callArgs = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.max_tokens).toBe(8192);
  });

  // AC1.5 regression: default maxOutputTokens is 4096 (byte-identical to pre-Phase-1)
  it('AC1.5: default maxOutputTokens is 4096 (happy-path regression)', async () => {
    const create = vi.fn().mockResolvedValue(toolUseResponse({ findings: [] }));
    // No maxOutputTokens option → defaults to 4096.
    const provider = new AnthropicProvider({ apiKey: 'k', client: { messages: { create } } });
    await provider.review(validInput);
    const callArgs = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.max_tokens).toBe(4096);
  });

  describe('respond()', () => {
    it('happy path: text response → non-empty ProviderRespondOutput', async () => {
      const create = vi
        .fn()
        .mockResolvedValue(textResponse('Good catch — that finding is a false positive.'));
      const provider = new AnthropicProvider({ apiKey: 'k', client: { messages: { create } } });
      const out = await provider.respond(validRespondInput);
      expect(out.reply_markdown).toBe('Good catch — that finding is a false positive.');
      expect(create).toHaveBeenCalledTimes(1);
      const callArgs = create.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.tools).toBeUndefined();
    });

    it('throws schema_validation when the response has no text content', async () => {
      const create = vi
        .fn()
        .mockResolvedValue({ content: [{ type: 'tool_use', name: 'x', input: {} }] });
      const provider = new AnthropicProvider({ apiKey: 'k', client: { messages: { create } } });
      await expect(provider.respond(validRespondInput)).rejects.toMatchObject({
        name: 'ProviderErrorThrowable',
        cause_kind: 'schema_validation',
      });
    });

    it('client throws → mapped through mapAnthropicError and re-thrown as ProviderErrorThrowable', async () => {
      const create = vi.fn().mockRejectedValue({ status: 401, message: 'invalid api key' });
      const provider = new AnthropicProvider({ apiKey: 'k', client: { messages: { create } } });
      await expect(provider.respond(validRespondInput)).rejects.toMatchObject({
        name: 'ProviderErrorThrowable',
        cause_kind: 'auth',
      });
    });

    it('throws output_truncated when stop_reason is "max_tokens"', async () => {
      const create = vi.fn().mockResolvedValue({
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: 'partial...' }],
      });
      const provider = new AnthropicProvider({ apiKey: 'k', client: { messages: { create } } });
      await expect(provider.respond(validRespondInput)).rejects.toMatchObject({
        name: 'ProviderErrorThrowable',
        cause_kind: 'output_truncated',
      });
    });

    it('over_budget: oversized input throws before client.messages.create is called', async () => {
      const create = vi.fn();
      const provider = new AnthropicProvider({
        apiKey: 'k',
        maxTokensPerCall: 1,
        client: { messages: { create } },
      });
      await expect(provider.respond(validRespondInput)).rejects.toMatchObject({
        name: 'ProviderErrorThrowable',
        cause_kind: 'over_budget',
      });
      expect(create).not.toHaveBeenCalled();
    });
  });
});
