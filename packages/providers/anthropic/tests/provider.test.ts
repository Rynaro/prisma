import { ProviderErrorThrowable, type ProviderReviewInput } from '@prisma-bot/shared';
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

  it('cost-ceiling: oversized input throws before client.messages.create is called', async () => {
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
      expect(thrown.cause_kind).toBe('capability');
      if (thrown.value.kind === 'capability') {
        expect(thrown.value.missing_capability).toBe('cost_ceiling');
      }
    }
    expect(create).not.toHaveBeenCalled();
  });
});
