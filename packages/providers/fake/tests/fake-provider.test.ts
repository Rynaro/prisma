import {
  ProviderErrorThrowable,
  type ProviderRespondInput,
  type ProviderReviewInput,
  type ProviderReviewOutput,
  ProviderReviewOutputFindingSchema,
} from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import {
  FAKE_PROVIDER_NAME,
  FakeProvider,
  type FakeRespondStep,
  type FakeStep,
  makeFindingFixture,
} from '../src/index.js';

const baseInput: ProviderReviewInput = {
  files: [
    {
      path: 'src/a.ts',
      hunks: [{ id: 'H1', line_start: 1, line_end: 3, content: 'export const a = 1;\n' }],
    },
  ],
};

describe('@prisma-bot/provider-fake', () => {
  it('keeps the FAKE_PROVIDER_NAME constant for backward compat', () => {
    expect(FAKE_PROVIDER_NAME).toBe('fake');
    const p = new FakeProvider({ script: [] });
    expect(p.name).toBe(FAKE_PROVIDER_NAME);
  });

  it('returns scripted outputs in order', async () => {
    const out1: ProviderReviewOutput = { findings: [makeFindingFixture({ path: 'a.ts' })] };
    const out2: ProviderReviewOutput = { findings: [] };
    const provider = new FakeProvider({
      script: [
        { kind: 'output', output: out1 },
        { kind: 'output', output: out2 },
      ],
    });

    const r1 = await provider.review(baseInput);
    const r2 = await provider.review(baseInput);
    expect(r1.findings).toHaveLength(1);
    expect(r1.findings[0]?.path).toBe('a.ts');
    expect(r2.findings).toHaveLength(0);
    expect(provider.remainingSteps).toBe(0);
  });

  it('throws scripted ProviderErrorThrowable instances', async () => {
    const provider = new FakeProvider({
      script: [
        {
          kind: 'error',
          error: {
            kind: 'rate_limit',
            message: 'quota exceeded',
            retry_after_ms: 5000,
            retryable: true,
          },
        },
      ],
    });
    await expect(provider.review(baseInput)).rejects.toBeInstanceOf(ProviderErrorThrowable);
    const errProvider = new FakeProvider({
      script: [{ kind: 'error', error: { kind: 'auth', message: 'bad credentials' } }],
    });
    try {
      await errProvider.review(baseInput);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ProviderErrorThrowable);
      expect((err as ProviderErrorThrowable).cause_kind).toBe('auth');
      expect((err as ProviderErrorThrowable).value.kind).toBe('auth');
      expect((err as ProviderErrorThrowable).value.message).toBe('bad credentials');
    }
  });

  it('records each input in calls', async () => {
    const provider = new FakeProvider({
      script: [
        { kind: 'output', output: { findings: [] } },
        { kind: 'output', output: { findings: [] } },
      ],
    });
    const input2: ProviderReviewInput = {
      files: [
        {
          path: 'src/b.ts',
          hunks: [{ id: 'H2', line_start: 5, line_end: 6, content: 'export const b = 2;\n' }],
        },
      ],
    };
    await provider.review(baseInput);
    await provider.review(input2);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.files[0]?.path).toBe('src/a.ts');
    expect(provider.calls[1]?.files[0]?.path).toBe('src/b.ts');
  });

  it('uses output_lazy to build a tailored response from the input', async () => {
    const step: FakeStep = {
      kind: 'output_lazy',
      build: (input) => ({
        findings: input.files.map((f) =>
          makeFindingFixture({ path: f.path, message: `seen ${f.path}` }),
        ),
      }),
    };
    const provider = new FakeProvider({ script: [step] });
    const out = await provider.review(baseInput);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.path).toBe('src/a.ts');
    expect(out.findings[0]?.message).toBe('seen src/a.ts');
  });

  it('throws schema_validation when an output literal fails the schema', async () => {
    const malformed = {
      findings: [{ path: '', line: -1, severity: 'medium', category: 'correctness' }],
    } as unknown as ProviderReviewOutput;
    const provider = new FakeProvider({ script: [{ kind: 'output', output: malformed }] });
    await expect(provider.review(baseInput)).rejects.toMatchObject({
      name: 'ProviderErrorThrowable',
      cause_kind: 'schema_validation',
    });
  });

  it('throws when the script is exhausted', async () => {
    const provider = new FakeProvider({ script: [] });
    await expect(provider.review(baseInput)).rejects.toThrow('FakeProvider script exhausted');
  });

  it('makeFindingFixture produces a finding that passes the schema', () => {
    const fixture = makeFindingFixture();
    const result = ProviderReviewOutputFindingSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    const overridden = makeFindingFixture({ severity: 'critical', confidence: 0.42 });
    expect(overridden.severity).toBe('critical');
    expect(overridden.confidence).toBe(0.42);
  });

  // ── respond() — reviewer interaction (`@bot ask <message>`) ────────────────

  const baseRespondInput: ProviderRespondInput = {
    pr: {
      title: 'Fix payment race condition',
      description: '',
      base_ref: 'main',
      head_ref: 'fix/payment-race',
      head_sha: 'deadbeefcafef00d',
    },
    review_context: {
      round: 2,
      summary_markdown: 'Round 2 · 1 still open',
      findings: [
        {
          file: 'src/payments/charge.ts',
          line: 142,
          severity: 'high',
          category: 'security',
          title: 'Unbounded user input',
          body: 'Reachable from a public route.',
        },
      ],
    },
    thread: [],
    message: { author_login: 'alice', text: 'why is finding 2 a security risk?' },
  };

  describe('respond()', () => {
    it('is deterministic: echoes round, finding count, and thread length with no script', async () => {
      const provider = new FakeProvider({ script: [] });
      const out = await provider.respond(baseRespondInput);
      expect(out.reply_markdown).toContain('Round 2');
      expect(out.reply_markdown).toContain('1 finding(s)');
      expect(out.reply_markdown).toContain('0 prior exchange(s)');
    });

    it('echoes a non-zero thread length when prior exchanges are present', async () => {
      const provider = new FakeProvider({ script: [] });
      const out = await provider.respond({
        ...baseRespondInput,
        thread: [{ author_login: 'bob', question: 'q1', reply_markdown: 'r1' }],
      });
      expect(out.reply_markdown).toContain('1 prior exchange(s)');
    });

    it('is stable across repeated calls with the same shape (key-less evals)', async () => {
      const provider = new FakeProvider({ script: [] });
      const out1 = await provider.respond(baseRespondInput);
      const out2 = await provider.respond(baseRespondInput);
      expect(out1.reply_markdown).toBe(out2.reply_markdown);
    });

    it('records each respond() input in respondCalls', async () => {
      const provider = new FakeProvider({ script: [] });
      await provider.respond(baseRespondInput);
      expect(provider.respondCalls).toHaveLength(1);
      expect(provider.respondCalls[0]?.message.text).toBe(baseRespondInput.message.text);
    });

    it('honors an optional respondScript for scripted outputs', async () => {
      const step: FakeRespondStep = {
        kind: 'output',
        output: { reply_markdown: 'scripted reply' },
      };
      const provider = new FakeProvider({ script: [], respondScript: [step] });
      const out = await provider.respond(baseRespondInput);
      expect(out.reply_markdown).toBe('scripted reply');
    });

    it('falls back to the canned reply once the respondScript is exhausted', async () => {
      const step: FakeRespondStep = {
        kind: 'output',
        output: { reply_markdown: 'scripted reply' },
      };
      const provider = new FakeProvider({ script: [], respondScript: [step] });
      await provider.respond(baseRespondInput);
      const out2 = await provider.respond(baseRespondInput);
      expect(out2.reply_markdown).toContain('Round 2');
    });

    it('honors a scripted error (provider-failure eval scenario)', async () => {
      const provider = new FakeProvider({
        script: [],
        respondScript: [{ kind: 'error', error: { kind: 'auth', message: 'bad credentials' } }],
      });
      await expect(provider.respond(baseRespondInput)).rejects.toMatchObject({
        name: 'ProviderErrorThrowable',
        cause_kind: 'auth',
      });
    });
  });
});
