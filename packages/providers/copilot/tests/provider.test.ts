import {
  ProviderErrorThrowable,
  type ProviderRespondInput,
  type ProviderReviewInput,
} from '@prisma-bot/shared';
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

function textCompletionResponse(content: string, finish_reason = 'stop') {
  return {
    id: 'chatcmpl-fake',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason }],
  };
}

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
      client: { chatCompletions: vi.fn(), textCompletion: vi.fn() },
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
    const client: CopilotClientLike = { chatCompletions, textCompletion: vi.fn() };
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
      client: { chatCompletions, textCompletion: vi.fn() },
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
      client: { chatCompletions, textCompletion: vi.fn() },
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
      client: { chatCompletions, textCompletion: vi.fn() },
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
  it('over_budget (Phase 4): oversized input throws over_budget before client.chatCompletions is called', async () => {
    const chatCompletions = vi.fn();
    const provider = new CopilotProvider({
      apiKey: 'k',
      maxTokensPerCall: 1, // any non-trivial input will exceed this
      client: { chatCompletions, textCompletion: vi.fn() },
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
    expect(chatCompletions).not.toHaveBeenCalled();
  });

  // T10: finish_reason==='length' → output_truncated (Phase 1: split-and-retry)
  it('throws output_truncated when finish_reason is "length" (response truncated at max_tokens)', async () => {
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
    const provider = new CopilotProvider({
      apiKey: 'k',
      client: { chatCompletions, textCompletion: vi.fn() },
    });
    await expect(provider.review(validInput)).rejects.toMatchObject({
      name: 'ProviderErrorThrowable',
      cause_kind: 'output_truncated',
    });
  });

  // T10b: output_truncated carries requested_max_tokens
  it('output_truncated error carries requested_max_tokens matching what was sent', async () => {
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
    // Use a non-default maxOutputTokens so we can distinguish it.
    const provider = new CopilotProvider({
      apiKey: 'k',
      client: { chatCompletions, textCompletion: vi.fn() },
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

  // T11: finish_reason==='tool_calls' (normal) → does NOT throw truncation error
  it('does not throw truncation error when finish_reason is "tool_calls"', async () => {
    const chatCompletions = vi.fn().mockResolvedValue(chatCompletionsResponse({ findings: [] }));
    const provider = new CopilotProvider({
      apiKey: 'k',
      client: { chatCompletions, textCompletion: vi.fn() },
    });
    const out = await provider.review(validInput);
    expect(out.findings).toHaveLength(0);
  });

  // AC1.2: configurable maxOutputTokens flows to the provider call
  it('AC1.2: maxOutputTokens option sets max_tokens on the wire request', async () => {
    const chatCompletions = vi.fn().mockResolvedValue(chatCompletionsResponse({ findings: [] }));
    // Provide non-default value to verify it flows through.
    const provider = new CopilotProvider({
      apiKey: 'k',
      client: { chatCompletions, textCompletion: vi.fn() },
      maxOutputTokens: 8192,
    });
    await provider.review(validInput);
    expect(chatCompletions).toHaveBeenCalledTimes(1);
    const callArgs = chatCompletions.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.max_tokens).toBe(8192);
  });

  // AC1.5 regression: default maxOutputTokens is 4096 (byte-identical to pre-Phase-1)
  it('AC1.5: default maxOutputTokens is 4096 (happy-path regression)', async () => {
    const chatCompletions = vi.fn().mockResolvedValue(chatCompletionsResponse({ findings: [] }));
    // No maxOutputTokens option → defaults to 4096.
    const provider = new CopilotProvider({
      apiKey: 'k',
      client: { chatCompletions, textCompletion: vi.fn() },
    });
    await provider.review(validInput);
    const callArgs = chatCompletions.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.max_tokens).toBe(4096);
  });

  describe('respond()', () => {
    it('happy path: text completion → non-empty ProviderRespondOutput', async () => {
      const textCompletion = vi.fn().mockResolvedValue(textCompletionResponse('Good catch.'));
      const provider = new CopilotProvider({
        apiKey: 'k',
        client: { chatCompletions: vi.fn(), textCompletion },
      });
      const out = await provider.respond(validRespondInput);
      expect(out.reply_markdown).toBe('Good catch.');
      expect(textCompletion).toHaveBeenCalledTimes(1);
      const callArgs = textCompletion.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.tools).toBeUndefined();
      expect(callArgs.tool_choice).toBeUndefined();
      expect(callArgs.max_tokens).toBe(4096);
    });

    it('throws schema_validation when the message has no text content', async () => {
      const textCompletion = vi.fn().mockResolvedValue(textCompletionResponse(''));
      const provider = new CopilotProvider({
        apiKey: 'k',
        client: { chatCompletions: vi.fn(), textCompletion },
      });
      await expect(provider.respond(validRespondInput)).rejects.toMatchObject({
        name: 'ProviderErrorThrowable',
        cause_kind: 'schema_validation',
      });
    });

    it('client throws → mapped through mapCopilotError and re-thrown as ProviderErrorThrowable', async () => {
      const textCompletion = vi.fn().mockRejectedValue({ status: 401, message: 'invalid api key' });
      const provider = new CopilotProvider({
        apiKey: 'k',
        client: { chatCompletions: vi.fn(), textCompletion },
      });
      await expect(provider.respond(validRespondInput)).rejects.toMatchObject({
        name: 'ProviderErrorThrowable',
        cause_kind: 'auth',
      });
    });

    it('throws output_truncated when finish_reason is "length"', async () => {
      const textCompletion = vi
        .fn()
        .mockResolvedValue(textCompletionResponse('partial...', 'length'));
      const provider = new CopilotProvider({
        apiKey: 'k',
        client: { chatCompletions: vi.fn(), textCompletion },
      });
      await expect(provider.respond(validRespondInput)).rejects.toMatchObject({
        name: 'ProviderErrorThrowable',
        cause_kind: 'output_truncated',
      });
    });

    it('over_budget: oversized input throws before client.textCompletion is called', async () => {
      const textCompletion = vi.fn();
      const provider = new CopilotProvider({
        apiKey: 'k',
        maxTokensPerCall: 1,
        client: { chatCompletions: vi.fn(), textCompletion },
      });
      await expect(provider.respond(validRespondInput)).rejects.toMatchObject({
        name: 'ProviderErrorThrowable',
        cause_kind: 'over_budget',
      });
      expect(textCompletion).not.toHaveBeenCalled();
    });
  });
});
