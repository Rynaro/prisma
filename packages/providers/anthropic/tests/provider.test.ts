import {
  IMMUTABLE_SYSTEM_PROMPT,
  ProviderErrorThrowable,
  type ProviderRespondInput,
  type ProviderReviewInput,
  TOOL_DESCRIPTION,
  buildRespondPrompt,
  buildToolInputSchema,
  estimatePromptTokens,
  serializeForEstimate,
} from '@prisma-bot/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_PASSTHROUGH_DENYLIST,
  ANTHROPIC_PROVIDER_NAME,
  ANTHROPIC_TOOL_NUDGE,
  type AnthropicClientLike,
  AnthropicProvider,
  applyAnthropicProviderOptions,
  buildPrompt,
  extractAnthropicUsage,
  resolveAnthropicContextWindow,
  resolveAnthropicDefaultMaxOutputTokens,
  resolveAnthropicTokenizerFamily,
  resolveAnthropicToolChoiceMode,
  toAnthropicStrictSchema,
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
    // ADR-009 D11/D6/D7: the default model is claude-sonnet-5-5.
    expect(provider.capabilities.max_context_tokens).toBe(1_000_000);
    expect(provider.capabilities.tokenizer_family).toBe('anthropic-approx-v2');
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
    // The default model (claude-sonnet-5-5) is on the unforced path: one retry.
    expect(create).toHaveBeenCalledTimes(2);
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
    // No maxOutputTokens option → defaults to 4096 for a pre-5 model.
    const provider = new AnthropicProvider({
      apiKey: 'k',
      model: 'claude-haiku-4-5',
      client: { messages: { create } },
    });
    await provider.review(validInput);
    const callArgs = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.max_tokens).toBe(4096);
  });

  it('AC1.5b: default model claude-sonnet-5-5 sends max_tokens 16384', async () => {
    const create = vi.fn().mockResolvedValue(toolUseResponse({ findings: [] }));
    const provider = new AnthropicProvider({ apiKey: 'k', client: { messages: { create } } });
    await provider.review(validInput);
    const callArgs = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.max_tokens).toBe(16384);
  });

  it('default model flip (ADR-009 D11): claude-sonnet-5-5, unforced bundle, 1M window, v2 tokenizer', async () => {
    expect(ANTHROPIC_DEFAULT_MODEL).toBe('claude-sonnet-5-5');
    const create = vi.fn().mockResolvedValue(toolUseResponse({ findings: [] }));
    const provider = new AnthropicProvider({ apiKey: 'k', client: { messages: { create } } });
    await provider.review(validInput);
    const callArgs = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.model).toBe('claude-sonnet-5-5');
    expect(callArgs.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(provider.capabilities.max_context_tokens).toBe(1_000_000);
    expect(provider.capabilities.tokenizer_family).toBe('anthropic-approx-v2');
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

describe('pre-5 request bytes (ADR-009 G-3)', () => {
  const PRE5_MODELS = [
    'claude-haiku-4-5',
    'claude-sonnet-4-6',
    'claude-opus-4-8',
    'my-claude-alias',
  ];

  function legacyWire(model: string, input: ProviderReviewInput, feedback?: { max_items: number }) {
    return JSON.stringify({
      model,
      max_tokens: 4096,
      system: IMMUTABLE_SYSTEM_PROMPT,
      messages: buildPrompt(input).messages,
      tools: [
        {
          name: 'submit_review_findings',
          description: TOOL_DESCRIPTION,
          input_schema: buildToolInputSchema(feedback),
        },
      ],
      tool_choice: { type: 'tool', name: 'submit_review_findings' },
    });
  }

  it.each(PRE5_MODELS)('review() on %s sends the legacy forced-tool bytes', async (model) => {
    const create = vi.fn().mockResolvedValue(toolUseResponse({ findings: [] }));
    const provider = new AnthropicProvider({
      apiKey: 'k',
      model,
      client: { messages: { create } },
    });
    await provider.review(validInput);
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(create.mock.calls[0]?.[0])).toBe(legacyWire(model, validInput));
  });

  it.each(PRE5_MODELS)(
    'review() on %s with positive_feedback keeps the legacy bytes',
    async (model) => {
      const create = vi.fn().mockResolvedValue(toolUseResponse({ findings: [] }));
      const provider = new AnthropicProvider({
        apiKey: 'k',
        model,
        client: { messages: { create } },
      });
      const input: ProviderReviewInput = { ...validInput, positive_feedback: { max_items: 3 } };
      await provider.review(input);
      expect(create).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(create.mock.calls[0]?.[0])).toBe(
        legacyWire(model, input, { max_items: 3 }),
      );
    },
  );

  it('respond() on claude-haiku-4-5 sends the legacy bytes', async () => {
    const create = vi.fn().mockResolvedValue(textResponse('ok'));
    const provider = new AnthropicProvider({
      apiKey: 'k',
      model: 'claude-haiku-4-5',
      client: { messages: { create } },
    });
    await provider.respond(validRespondInput);
    const prompt = buildRespondPrompt(validRespondInput);
    expect(JSON.stringify(create.mock.calls[0]?.[0])).toBe(
      JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 4096,
        system: prompt.system,
        messages: prompt.messages,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// ADR-009 — Claude 5.x model-family compatibility
// ---------------------------------------------------------------------------

const ADAPTIVE_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-1',
  'claude-mythos-5-1',
  'claude-opus-5',
  'claude-foo-6',
];

const EMPTY_TOOL_RESPONSE = toolUseResponse({ findings: [] });

const VALID_FINDING = {
  path: 'src/a.ts',
  line: 3,
  severity: 'medium',
  category: 'correctness',
  message: 'flag',
  rationale: 'because reasons',
  confidence: 0.7,
};

function makeProvider(
  model: string,
  create: ReturnType<typeof vi.fn>,
  extra: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {},
): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: 'k',
    model,
    client: { messages: { create } },
    ...extra,
  });
}

function sentArgs(create: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  return create.mock.calls[call]?.[0] as Record<string, unknown>;
}

function withShaping(shaping: NonNullable<ProviderReviewInput['request_shaping']>) {
  return { ...validInput, request_shaping: shaping } as ProviderReviewInput;
}

describe('resolveAnthropicToolChoiceMode (ADR-009 D1)', () => {
  it.each([...ADAPTIVE_MODELS, 'us.anthropic.claude-opus-5-5', 'CLAUDE-OPUS-5-5'])(
    'auto: %s -> unforced',
    (model) => {
      expect(resolveAnthropicToolChoiceMode(model, undefined)).toBe('unforced');
    },
  );

  it.each(['claude-haiku-4-5', 'claude-opus-4-8', 'my-alias'])('auto: %s -> forced', (model) => {
    expect(resolveAnthropicToolChoiceMode(model, undefined)).toBe('forced');
  });

  it('a bag that enables thinking turns the unforced bundle on; disabled does not', () => {
    expect(
      resolveAnthropicToolChoiceMode('claude-haiku-4-5', { thinking: { type: 'adaptive' } }),
    ).toBe('unforced');
    expect(
      resolveAnthropicToolChoiceMode('claude-haiku-4-5', {
        thinking: { type: 'enabled', budget_tokens: 2048 },
      }),
    ).toBe('unforced');
    expect(
      resolveAnthropicToolChoiceMode('claude-haiku-4-5', { thinking: { type: 'disabled' } }),
    ).toBe('forced');
  });

  it('explicit style beats the rule', () => {
    expect(resolveAnthropicToolChoiceMode('my-alias', undefined, 'unforced')).toBe('unforced');
    expect(resolveAnthropicToolChoiceMode('claude-opus-5-5', undefined, 'forced')).toBe('forced');
  });
});

describe('resolveAnthropicDefaultMaxOutputTokens (ADR-009 D5)', () => {
  it.each(ADAPTIVE_MODELS)('%s -> 16384', (model) => {
    expect(resolveAnthropicDefaultMaxOutputTokens(model)).toBe(16384);
  });

  it.each(['claude-haiku-4-5', 'claude-opus-4-8', 'my-alias'])('%s -> 4096', (model) => {
    expect(resolveAnthropicDefaultMaxOutputTokens(model)).toBe(4096);
  });

  it('a bag with thinking enabled raises a pre-5 model to 16384', () => {
    expect(
      resolveAnthropicDefaultMaxOutputTokens('claude-haiku-4-5', { thinking: { type: 'enabled' } }),
    ).toBe(16384);
  });
});

describe('resolveAnthropicContextWindow / resolveAnthropicTokenizerFamily (ADR-009 D6/D7)', () => {
  it.each([
    ...ADAPTIVE_MODELS,
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
  ])('%s has a 1,000,000 window', (model) => {
    expect(resolveAnthropicContextWindow(model)).toBe(1_000_000);
  });

  it.each([
    'claude-haiku-4-5',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-20250514',
    'claude-opus-4-1',
    'claude-3-5-sonnet-latest',
    'my-alias',
  ])('%s has a 200,000 window', (model) => {
    expect(resolveAnthropicContextWindow(model)).toBe(200_000);
  });

  it.each([...ADAPTIVE_MODELS, 'claude-opus-4-7', 'claude-opus-4-8', 'my-alias'])(
    '%s uses anthropic-approx-v2',
    (model) => {
      expect(resolveAnthropicTokenizerFamily(model)).toBe('anthropic-approx-v2');
    },
  );

  it.each([
    'claude-haiku-4-5',
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-opus-4-20250514',
    'claude-3-5-sonnet-latest',
  ])('%s uses anthropic-approx', (model) => {
    expect(resolveAnthropicTokenizerFamily(model)).toBe('anthropic-approx');
  });
});

describe('AnthropicProvider capabilities (ADR-009 D6/D7)', () => {
  it('derives max_context_tokens and tokenizer_family per model; explicit capabilities win', () => {
    const create = vi.fn();
    const haiku = makeProvider('claude-haiku-4-5', create);
    expect(haiku.capabilities.max_context_tokens).toBe(200000);
    expect(haiku.capabilities.tokenizer_family).toBe('anthropic-approx');
    const opus = makeProvider('claude-opus-5-5', create);
    expect(opus.capabilities.max_context_tokens).toBe(1_000_000);
    expect(opus.capabilities.tokenizer_family).toBe('anthropic-approx-v2');
    const explicit = makeProvider('claude-opus-5-5', create, {
      capabilities: {
        structured_output: true,
        function_calling: true,
        deterministic_seed: false,
        max_context_tokens: 50000,
        tokenizer_family: 'anthropic-approx',
      },
    });
    expect(explicit.capabilities.max_context_tokens).toBe(50000);
    expect(explicit.capabilities.tokenizer_family).toBe('anthropic-approx');
  });
});

describe('Claude 5.x unforced tool bundle (ADR-009 D1/D2/D5)', () => {
  it.each(ADAPTIVE_MODELS)(
    '%s sends tool_choice auto, strict tool, nudge, 16384',
    async (model) => {
      const create = vi.fn().mockResolvedValue(EMPTY_TOOL_RESPONSE);
      await makeProvider(model, create).review(validInput);
      expect(create).toHaveBeenCalledTimes(1);
      const args = sentArgs(create);
      expect(args.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
      const tools = args.tools as Array<Record<string, unknown>>;
      expect(tools[0]?.strict).toBe(true);
      expect(tools[0]?.input_schema).toEqual(
        toAnthropicStrictSchema(buildToolInputSchema(undefined)),
      );
      expect(args.system).toBe(IMMUTABLE_SYSTEM_PROMPT + ANTHROPIC_TOOL_NUDGE);
      expect(args.max_tokens).toBe(16384);
      expect(args.model).toBe(model);
      for (const key of ['thinking', 'output_config', 'temperature', 'top_p', 'top_k', 'seed']) {
        expect(args).not.toHaveProperty(key);
      }
      expect(Object.keys(args)).toEqual([
        'model',
        'max_tokens',
        'system',
        'messages',
        'tools',
        'tool_choice',
      ]);
    },
  );

  it('respond() on claude-sonnet-5-5 sends only the cap change (no tools, no nudge)', async () => {
    const create = vi.fn().mockResolvedValue(textResponse('ok'));
    await makeProvider('claude-sonnet-5-5', create).respond(validRespondInput);
    const prompt = buildRespondPrompt(validRespondInput);
    expect(JSON.stringify(sentArgs(create))).toBe(
      JSON.stringify({
        model: 'claude-sonnet-5-5',
        max_tokens: 16384,
        system: prompt.system,
        messages: prompt.messages,
      }),
    );
  });

  it('ANTHROPIC_TOOL_CHOICE=unforced puts an alias on the bundle; forced keeps 5.x forced', async () => {
    const create = vi.fn().mockResolvedValue(EMPTY_TOOL_RESPONSE);
    await makeProvider('my-alias', create, { toolChoiceStyle: 'unforced' }).review(validInput);
    expect(sentArgs(create).tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    const create2 = vi.fn().mockResolvedValue(EMPTY_TOOL_RESPONSE);
    await makeProvider('claude-opus-5-5', create2, { toolChoiceStyle: 'forced' }).review(
      validInput,
    );
    expect(sentArgs(create2).tool_choice).toEqual({
      type: 'tool',
      name: 'submit_review_findings',
    });
  });
});

describe('missing tool call retry (ADR-009 D1)', () => {
  const noCall = {
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'x' },
    ],
  };

  it('unforced: one identical retry, then success; usage fires twice', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(noCall)
      .mockResolvedValueOnce(toolUseResponse({ findings: [VALID_FINDING] }));
    const onUsage = vi.fn();
    const out = await makeProvider('claude-sonnet-5-5', create, { onUsage }).review(validInput);
    expect(out.findings).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(sentArgs(create, 0)).toEqual(sentArgs(create, 1));
    expect(onUsage).toHaveBeenCalledTimes(2);
  });

  it('unforced: second miss throws schema_validation after 2 calls', async () => {
    const create = vi.fn().mockResolvedValue(noCall);
    const err = await makeProvider('claude-sonnet-5-5', create)
      .review(validInput)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderErrorThrowable);
    const value = (err as ProviderErrorThrowable).value;
    expect(value.kind).toBe('schema_validation');
    expect(value.message).toContain("did not call 'submit_review_findings'");
    expect(value.message).toContain('after 1 retry');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('forced path never retries and keeps the legacy message', async () => {
    const create = vi.fn().mockResolvedValue(noCall);
    const err = await makeProvider('claude-haiku-4-5', create)
      .review(validInput)
      .catch((e: unknown) => e);
    expect((err as ProviderErrorThrowable).value.message).toBe(
      "anthropic response missing tool_use block for tool 'submit_review_findings'",
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a tool_use whose input fails Zod does not retry', async () => {
    const create = vi.fn().mockResolvedValue(toolUseResponse({ findings: [{ bogus: 1 }] }));
    await expect(
      makeProvider('claude-sonnet-5-5', create).review(validInput),
    ).rejects.toMatchObject({
      cause_kind: 'schema_validation',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('refusal (ADR-009 D8)', () => {
  const refusal = (stopDetails: unknown, extra: Record<string, unknown> = {}) => ({
    stop_reason: 'refusal',
    stop_details: stopDetails,
    content: [],
    ...extra,
  });

  it('review(): refusal -> schema_validation code refusal, no retry, explanation never surfaced', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        refusal({ type: 'refusal', category: 'cyber', explanation: 'SECRET-EXPLANATION' }),
      );
    const onUsage = vi.fn();
    const err = await makeProvider('claude-sonnet-5-5', create, { onUsage })
      .review(validInput)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderErrorThrowable);
    expect((err as ProviderErrorThrowable).value).toEqual({
      kind: 'schema_validation',
      code: 'refusal',
      message: 'anthropic declined the request: stop_reason refusal (category: cyber)',
    });
    expect(JSON.stringify((err as ProviderErrorThrowable).value)).not.toContain(
      'SECRET-EXPLANATION',
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['null stop_details', null, 'none'],
    ['unsanitary category', { category: 'Cyber Stuff!' }, 'none'],
    ['missing category', {}, 'none'],
  ])('review(): %s -> category %s', async (_label, details, category) => {
    const create = vi.fn().mockResolvedValue(refusal(details));
    await expect(
      makeProvider('claude-sonnet-5-5', create).review(validInput),
    ).rejects.toMatchObject({
      value: { code: 'refusal', message: expect.stringContaining(`(category: ${category})`) },
    });
  });

  it('a refusal beats a valid tool_use block', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        refusal({ category: 'cyber' }, toolUseResponse({ findings: [VALID_FINDING] })),
      );
    await expect(makeProvider('claude-haiku-4-5', create).review(validInput)).rejects.toMatchObject(
      {
        value: { kind: 'schema_validation', code: 'refusal' },
      },
    );
  });

  it('respond(): the same refusal is thrown', async () => {
    const create = vi.fn().mockResolvedValue(refusal({ category: 'cyber', explanation: 'X' }));
    await expect(
      makeProvider('claude-sonnet-5-5', create).respond(validRespondInput),
    ).rejects.toMatchObject({
      value: {
        kind: 'schema_validation',
        code: 'refusal',
        message: 'anthropic declined the request: stop_reason refusal (category: cyber)',
      },
    });
  });
});

describe('output cap (ADR-009 D4/D5)', () => {
  const truncated = { stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '' }] };

  it('claude-sonnet-5-5 truncation reports 16384 after 1 call (unforced does not retry a truncation)', async () => {
    const create = vi.fn().mockResolvedValue(truncated);
    const err = await makeProvider('claude-sonnet-5-5', create)
      .review(validInput)
      .catch((e: unknown) => e);
    const value = (err as ProviderErrorThrowable).value;
    expect(value).toMatchObject({ kind: 'output_truncated', requested_max_tokens: 16384 });
    expect(value.message).toContain('(max_tokens: 16384)');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(['claude-sonnet-5-5', 'claude-haiku-4-5'])(
    'explicit maxOutputTokens 8192 applies to %s',
    async (model) => {
      const create = vi.fn().mockResolvedValue(EMPTY_TOOL_RESPONSE);
      await makeProvider(model, create, { maxOutputTokens: 8192 }).review(validInput);
      expect(sentArgs(create).max_tokens).toBe(8192);
    },
  );

  it('generation.max_output_tokens beats the env/option cap', async () => {
    const create = vi.fn().mockResolvedValue(truncated);
    const provider = makeProvider('claude-sonnet-5-5', create, { maxOutputTokens: 8192 });
    const err = await provider
      .review(withShaping({ generation: { max_output_tokens: 12000 } }))
      .catch((e: unknown) => e);
    expect(sentArgs(create).max_tokens).toBe(12000);
    expect((err as ProviderErrorThrowable).value).toMatchObject({
      requested_max_tokens: 12000,
    });
  });

  it('bag max_tokens beats everything', async () => {
    const create = vi.fn().mockResolvedValue(truncated);
    const provider = makeProvider('claude-sonnet-5-5', create, { maxOutputTokens: 8192 });
    const err = await provider
      .review(
        withShaping({
          generation: { max_output_tokens: 12000 },
          provider_options: { max_tokens: 9000 },
        }),
      )
      .catch((e: unknown) => e);
    expect(sentArgs(create).max_tokens).toBe(9000);
    expect((err as ProviderErrorThrowable).value).toMatchObject({ requested_max_tokens: 9000 });
  });

  it('respond(): claude-sonnet-5-5 -> 16384, claude-haiku-4-5 -> 4096', async () => {
    const create = vi.fn().mockResolvedValue(textResponse('ok'));
    await makeProvider('claude-sonnet-5-5', create).respond(validRespondInput);
    expect(sentArgs(create).max_tokens).toBe(16384);
    const create2 = vi.fn().mockResolvedValue(textResponse('ok'));
    await makeProvider('claude-haiku-4-5', create2).respond(validRespondInput);
    expect(sentArgs(create2).max_tokens).toBe(4096);
  });
});

describe('request_shaping.model (ADR-009 D4)', () => {
  it('a haiku-4-5 provider with a sonnet-5-5 override sends the 5.x bundle and 16384', async () => {
    const create = vi.fn().mockResolvedValue(EMPTY_TOOL_RESPONSE);
    await makeProvider('claude-haiku-4-5', create).review(
      withShaping({ model: 'claude-sonnet-5-5' }),
    );
    const args = sentArgs(create);
    expect(args.model).toBe('claude-sonnet-5-5');
    expect(args.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(args.max_tokens).toBe(16384);
  });

  it('the reverse override sends forced and 4096', async () => {
    const create = vi.fn().mockResolvedValue(EMPTY_TOOL_RESPONSE);
    await makeProvider('claude-sonnet-5-5', create).review(
      withShaping({ model: 'claude-haiku-4-5' }),
    );
    const args = sentArgs(create);
    expect(args.model).toBe('claude-haiku-4-5');
    expect(args.tool_choice).toEqual({ type: 'tool', name: 'submit_review_findings' });
    expect(args.max_tokens).toBe(4096);
  });

  it('respond() always sends this.model', async () => {
    const create = vi.fn().mockResolvedValue(textResponse('ok'));
    await makeProvider('claude-haiku-4-5', create).respond(validRespondInput);
    expect(sentArgs(create).model).toBe('claude-haiku-4-5');
  });

  it.each(['claude-haiku-4-5', 'claude-sonnet-5-5'])(
    'sampling and seed are never sent (%s)',
    async (model) => {
      const create = vi.fn().mockResolvedValue(EMPTY_TOOL_RESPONSE);
      await makeProvider(model, create).review(
        withShaping({
          generation: { temperature: 0.2, top_p: 0.9, seed: 1 },
          deterministic_seed: 1,
        }),
      );
      const args = sentArgs(create);
      for (const key of ['temperature', 'top_p', 'top_k', 'seed']) {
        expect(args).not.toHaveProperty(key);
      }
    },
  );
});

describe('provider_options.anthropic passthrough (ADR-009 D3/D4)', () => {
  async function send(model: string, bag: Record<string, unknown>) {
    const create = vi.fn().mockResolvedValue(EMPTY_TOOL_RESPONSE);
    await makeProvider(model, create).review(withShaping({ provider_options: bag }));
    return sentArgs(create);
  }

  it('flat effort maps to output_config.effort', async () => {
    const args = await send('claude-sonnet-5-5', { effort: 'medium' });
    expect(args.output_config).toEqual({ effort: 'medium' });
    expect(args).not.toHaveProperty('effort');
  });

  it('native output_config.effort wins over the flat key', async () => {
    const args = await send('claude-sonnet-5-5', {
      effort: 'low',
      output_config: { effort: 'high' },
    });
    expect((args.output_config as Record<string, unknown>).effort).toBe('high');
    expect(args).not.toHaveProperty('effort');
  });

  it('output_config.format is stripped', async () => {
    const args = await send('claude-sonnet-5-5', {
      output_config: { format: { type: 'json_schema' }, effort: 'low' },
    });
    expect(args.output_config).toEqual({ effort: 'low' });
  });

  it('the ten denylisted keys never reach the wire', async () => {
    const hostile = Object.fromEntries(
      [...ANTHROPIC_PASSTHROUGH_DENYLIST].map((k) => [k, `HOSTILE-${k}`]),
    );
    const clean = await send('claude-sonnet-5-5', {});
    const args = await send('claude-sonnet-5-5', hostile);
    for (const key of ['model', 'system', 'messages', 'tools', 'tool_choice']) {
      expect(args[key]).toEqual(clean[key]);
    }
    for (const key of ['stream', 'betas', 'mcp_servers', 'container', 'fallbacks']) {
      expect(args).not.toHaveProperty(key);
    }
  });

  it('forwards thinking, sampling, service_tier and max_tokens verbatim and turns the bundle on', async () => {
    const args = await send('claude-haiku-4-5', {
      thinking: { type: 'enabled', budget_tokens: 2048 },
      temperature: 0.5,
      service_tier: 'auto',
      max_tokens: 9000,
    });
    expect(args.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(args.temperature).toBe(0.5);
    expect(args.service_tier).toBe('auto');
    expect(args.max_tokens).toBe(9000);
    expect(args.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
  });

  it('the denylist has exactly the ten keys', () => {
    expect([...ANTHROPIC_PASSTHROUGH_DENYLIST].sort()).toEqual(
      [
        'betas',
        'container',
        'fallbacks',
        'mcp_servers',
        'messages',
        'model',
        'stream',
        'system',
        'tool_choice',
        'tools',
      ].sort(),
    );
  });

  it('applyAnthropicProviderOptions mutates neither input and its notes carry key names only', () => {
    const args = { model: 'm', max_tokens: 1 };
    const bag = {
      model: 'SECRET-VALUE',
      effort: 'low',
      output_config: { format: 'SECRET-FORMAT', effort: 'high' },
    };
    const argsBefore = structuredClone(args);
    const bagBefore = structuredClone(bag);
    const { args: merged, droppedNotes } = applyAnthropicProviderOptions(args, bag);
    expect(args).toEqual(argsBefore);
    expect(bag).toEqual(bagBefore);
    expect(merged.model).toBe('m');
    expect(droppedNotes).toEqual([
      'provider_options.anthropic.model ignored (Prisma-managed field)',
      'provider_options.anthropic.output_config.format ignored (Prisma-managed field)',
      'provider_options.anthropic.effort ignored (output_config.effort is set)',
    ]);
    expect(droppedNotes.join('\n')).not.toContain('SECRET');
  });
});

describe('per-request guard (ADR-009 D6/D7)', () => {
  const bigInput: ProviderReviewInput = {
    files: [
      {
        path: 'src/big.ts',
        hunks: [{ id: 'H1', line_start: 1, line_end: 5, content: 'x'.repeat(800_000) }],
      },
    ],
  };

  it('a per-request model override is guarded with that model window and family', async () => {
    const create = vi.fn().mockResolvedValue(EMPTY_TOOL_RESPONSE);
    const provider = makeProvider('claude-sonnet-5-5', create, { maxTokensPerCall: 2_000_000 });
    const err = await provider
      .review({ ...bigInput, request_shaping: { model: 'claude-haiku-4-5' } })
      .catch((e: unknown) => e);
    const value = (err as ProviderErrorThrowable).value;
    expect(value).toMatchObject({ kind: 'over_budget', hard_cap_in: 195904 });
    if (value.kind === 'over_budget') {
      expect(value.estimated_tokens).toBe(
        estimatePromptTokens(serializeForEstimate(bigInput), 'anthropic-approx'),
      );
    }
    expect(create).not.toHaveBeenCalled();
    // Without the override the call proceeds (cap 983,616).
    await provider.review(bigInput);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('claude-haiku-4-5 at MAX_TOKENS_PER_PR=120000 keeps hard_cap_in 120000', async () => {
    const create = vi.fn();
    const err = await makeProvider('claude-haiku-4-5', create, { maxTokensPerCall: 120000 })
      .review(bigInput)
      .catch((e: unknown) => e);
    expect((err as ProviderErrorThrowable).value).toMatchObject({
      kind: 'over_budget',
      hard_cap_in: 120000,
    });
  });

  it('explicit capabilities.max_context_tokens 50000 on sonnet-5-5 gives cap 33616', async () => {
    const create = vi.fn();
    const provider = makeProvider('claude-sonnet-5-5', create, {
      maxTokensPerCall: 2_000_000,
      capabilities: {
        structured_output: true,
        function_calling: true,
        deterministic_seed: false,
        max_context_tokens: 50000,
        tokenizer_family: 'anthropic-approx-v2',
      },
    });
    const err = await provider.review(bigInput).catch((e: unknown) => e);
    expect((err as ProviderErrorThrowable).value).toMatchObject({
      kind: 'over_budget',
      hard_cap_in: 33616,
    });
  });
});

describe('usage telemetry (ADR-009 D13)', () => {
  it('extractAnthropicUsage sums cache counts into input_tokens', () => {
    expect(
      extractAnthropicUsage(
        {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10,
          },
        },
        'm',
      ),
    ).toEqual({
      endpoint: 'messages',
      model: 'm',
      input_tokens: 130,
      output_tokens: 50,
      cached_input_tokens: 20,
      cache_write_tokens: 10,
    });
  });

  it('omits null cache fields; tolerates missing usage', () => {
    expect(
      extractAnthropicUsage(
        {
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
          },
        },
        'm',
      ),
    ).toEqual({ endpoint: 'messages', model: 'm', input_tokens: 100, output_tokens: 5 });
    expect(extractAnthropicUsage({}, 'm')).toEqual({ endpoint: 'messages', model: 'm' });
    expect(extractAnthropicUsage(null, 'm')).toEqual({ endpoint: 'messages', model: 'm' });
  });

  it('review() reports once per call, including max_tokens responses, with the override model', async () => {
    const onUsage = vi.fn();
    const create = vi
      .fn()
      .mockResolvedValue({ stop_reason: 'max_tokens', content: [], usage: { output_tokens: 7 } });
    await makeProvider('claude-haiku-4-5', create, { onUsage })
      .review(withShaping({ model: 'claude-sonnet-5-5' }))
      .catch(() => undefined);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({
      endpoint: 'messages',
      model: 'claude-sonnet-5-5',
      output_tokens: 7,
    });
  });

  it('a throwing onUsage does not fail the review; respond() never reports', async () => {
    const create = vi.fn().mockResolvedValue(EMPTY_TOOL_RESPONSE);
    const onUsage = vi.fn(() => {
      throw new Error('boom');
    });
    await expect(
      makeProvider('claude-sonnet-5-5', create, { onUsage }).review(validInput),
    ).resolves.toEqual({ findings: [] });
    const create2 = vi.fn().mockResolvedValue(textResponse('ok'));
    const onUsage2 = vi.fn();
    await makeProvider('claude-sonnet-5-5', create2, { onUsage: onUsage2 }).respond(
      validRespondInput,
    );
    expect(onUsage2).not.toHaveBeenCalled();
  });
});
