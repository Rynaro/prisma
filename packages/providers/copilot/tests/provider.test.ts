import { ProviderErrorThrowable, type ProviderReviewInput } from '@prisma-bot/shared';
import { describe, expect, it, vi } from 'vitest';
import { COPILOT_PROVIDER_NAME, type CopilotClientLike, CopilotProvider } from '../src/index.js';

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
                // GitHub Models / OpenAI-compatible APIs return `arguments`
                // as a JSON-encoded string. The adapter must JSON.parse it.
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

describe('CopilotProvider', () => {
  it('exposes name = "copilot" and default capabilities', () => {
    const provider = new CopilotProvider({
      apiKey: 'irrelevant',
      client: { chatCompletions: vi.fn() },
    });
    expect(provider.name).toBe(COPILOT_PROVIDER_NAME);
    expect(provider.name).toBe('copilot');
    expect(provider.capabilities.structured_output).toBe(true);
    expect(provider.capabilities.function_calling).toBe(true);
    expect(provider.capabilities.max_context_tokens).toBeGreaterThan(0);
  });

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
    const client: CopilotClientLike = { chatCompletions };
    const provider = new CopilotProvider({ apiKey: 'k', client });

    const out = await provider.review(validInput);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.path).toBe('src/a.ts');
    expect(chatCompletions).toHaveBeenCalledTimes(1);
  });

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
    const provider = new CopilotProvider({
      apiKey: 'k',
      client: { chatCompletions },
    });
    await expect(provider.review(validInput)).rejects.toMatchObject({
      name: 'ProviderErrorThrowable',
      cause_kind: 'schema_validation',
    });
  });

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
    const provider = new CopilotProvider({
      apiKey: 'k',
      client: { chatCompletions },
    });
    await expect(provider.review(validInput)).rejects.toMatchObject({
      name: 'ProviderErrorThrowable',
      cause_kind: 'schema_validation',
    });
  });

  it('client throws → mapped through mapCopilotError and re-thrown as ProviderErrorThrowable', async () => {
    const chatCompletions = vi.fn().mockRejectedValue({ status: 401, message: 'invalid api key' });
    const provider = new CopilotProvider({
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

  it('cost-ceiling: oversized input throws before client.chatCompletions is called', async () => {
    const chatCompletions = vi.fn();
    const provider = new CopilotProvider({
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
});
