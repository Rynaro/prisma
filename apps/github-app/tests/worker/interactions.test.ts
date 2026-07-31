/**
 * Unit tests for `runAsk` (`src/interactions.ts`) — the reviewer-interaction
 * orchestration module (`@bot ask <message>`). Extracted to its own module
 * (mirrors `repo-config.ts`) so these tests exercise the REAL implementation
 * without importing `worker.ts` (which boots Redis + BullMQ on import).
 *
 * Per docs/_planning/reviewer-interaction/spec.md § 7 / § 9 acceptance.
 */

import type {
  CheckRunsClient,
  IssueCommentsClient,
  ReviewCommentsClient,
} from '@prisma-bot/github';
import { buildInteractionMarker, renderInteractionReply } from '@prisma-bot/github';
import { FakeProvider } from '@prisma-bot/provider-fake';
import { ProviderErrorThrowable, type RespondPrMeta } from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import { type AskContext, type AskDeps, runAsk } from '../../src/interactions.js';

const ctx: AskContext = {
  owner: 'octocat',
  repo: 'hello-world',
  pull_request_number: 42,
  head_sha: 'deadbeefcafef00d',
  app_id: 999,
  app_login: 'prisma-bot',
};

const pr: RespondPrMeta = {
  title: 'Fix payment race condition',
  description: '',
  base_ref: 'main',
  head_ref: 'fix/payment-race',
  head_sha: 'deadbeefcafef00d',
};

const roundMarker = (round: number): string =>
  `Round ${round}\n\n<!-- prisma-bot:round=${round} head=deadbeef -->`;

const makeCheckRuns = (summaries: string[]): CheckRunsClient =>
  ({
    startInProgress: async () => ({ check_run_id: 1 }),
    finalize: async () => undefined,
    listOurs: async () =>
      summaries.map((s, i) => ({ id: i + 1, conclusion: null, output_summary: s })),
  }) as unknown as CheckRunsClient;

const makeReviewComments = (): ReviewCommentsClient =>
  ({
    postInline: async () => ({ id: 1 }),
    listOurs: async () => [],
  }) as unknown as ReviewCommentsClient;

const makeIssueComments = (bodies: string[]): IssueCommentsClient =>
  ({
    createReply: async () => ({ id: 1 }),
    getAuthor: async () => null,
    addReaction: async () => undefined,
    listOurs: async () => bodies.map((body, i) => ({ id: i + 1, body })),
  }) as unknown as IssueCommentsClient;

describe('runAsk', () => {
  it('disabled: returns {kind: disabled} with zero I/O', async () => {
    const checkRuns = makeCheckRuns([]);
    const listOursSpy = checkRuns.listOurs;
    const deps: AskDeps = {
      checkRuns,
      reviewComments: makeReviewComments(),
      issueComments: makeIssueComments([]),
      provider: new FakeProvider({ script: [] }),
    };
    const result = await runAsk(deps, ctx, {
      author_login: 'alice',
      message: 'why?',
      interactions: { enabled: false, max_per_review: 3 },
      pr,
    });
    expect(result).toEqual({ kind: 'disabled' });
    // No harvest call was made: listOurs on the injected checkRuns client is
    // still the pristine reference (never invoked).
    expect(checkRuns.listOurs).toBe(listOursSpy);
  });

  it('no_round: returns {kind: no_round} when no review round has been published', async () => {
    const deps: AskDeps = {
      checkRuns: makeCheckRuns([]),
      reviewComments: makeReviewComments(),
      issueComments: makeIssueComments([]),
      provider: new FakeProvider({ script: [] }),
    };
    const result = await runAsk(deps, ctx, {
      author_login: 'alice',
      message: 'why?',
      interactions: { enabled: true, max_per_review: 3 },
      pr,
    });
    expect(result).toEqual({ kind: 'no_round' });
  });

  it('cap_exceeded: returns used/max when the round budget is spent', async () => {
    const priorReply1 = renderInteractionReply({
      author_login: 'alice',
      question: 'q1',
      reply_markdown: 'r1',
      round: 2,
      seq: 1,
    });
    const priorReply2 = renderInteractionReply({
      author_login: 'bob',
      question: 'q2',
      reply_markdown: 'r2',
      round: 2,
      seq: 2,
    });
    const deps: AskDeps = {
      checkRuns: makeCheckRuns([roundMarker(2)]),
      reviewComments: makeReviewComments(),
      issueComments: makeIssueComments([priorReply1, priorReply2]),
      provider: new FakeProvider({ script: [] }),
    };
    const result = await runAsk(deps, ctx, {
      author_login: 'carol',
      message: 'another question',
      interactions: { enabled: true, max_per_review: 2 },
      pr,
    });
    expect(result).toEqual({ kind: 'cap_exceeded', used: 2, max: 2 });
  });

  it('happy path: provider.respond is called and the reply is rendered with the marker', async () => {
    const provider = new FakeProvider({ script: [] });
    const deps: AskDeps = {
      checkRuns: makeCheckRuns([roundMarker(3)]),
      reviewComments: makeReviewComments(),
      issueComments: makeIssueComments([]),
      provider,
    };
    const result = await runAsk(deps, ctx, {
      author_login: 'alice',
      message: 'why is finding 2 a security risk?',
      interactions: { enabled: true, max_per_review: 3 },
      pr,
    });
    expect(result.kind).toBe('replied');
    if (result.kind === 'replied') {
      expect(result.round).toBe(3);
      expect(result.seq).toBe(1);
      expect(result.body).toContain('> **@alice asked:** why is finding 2 a security risk?');
      expect(result.body).toContain(buildInteractionMarker(3, 1));
    }
    expect(provider.respondCalls).toHaveLength(1);
    expect(provider.respondCalls[0]?.message).toEqual({
      author_login: 'alice',
      text: 'why is finding 2 a security risk?',
    });
  });

  it('provider-error: propagates (does not catch) so the caller applies command-path error semantics', async () => {
    const provider = new FakeProvider({
      script: [],
      respondScript: [{ kind: 'error', error: { kind: 'auth', message: 'bad credentials' } }],
    });
    const deps: AskDeps = {
      checkRuns: makeCheckRuns([roundMarker(1)]),
      reviewComments: makeReviewComments(),
      issueComments: makeIssueComments([]),
      provider,
    };
    await expect(
      runAsk(deps, ctx, {
        author_login: 'alice',
        message: 'why?',
        interactions: { enabled: true, max_per_review: 3 },
        pr,
      }),
    ).rejects.toMatchObject({
      name: 'ProviderErrorThrowable',
      cause_kind: 'auth',
    });
  });

  it('provider-error instance check: the thrown value is a ProviderErrorThrowable', async () => {
    const provider = new FakeProvider({
      script: [],
      respondScript: [{ kind: 'error', error: { kind: 'capability', message: 'model rejected' } }],
    });
    const deps: AskDeps = {
      checkRuns: makeCheckRuns([roundMarker(1)]),
      reviewComments: makeReviewComments(),
      issueComments: makeIssueComments([]),
      provider,
    };
    try {
      await runAsk(deps, ctx, {
        author_login: 'alice',
        message: 'why?',
        interactions: { enabled: true, max_per_review: 3 },
        pr,
      });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderErrorThrowable);
    }
  });

  it('truncation: an oversized reply_markdown is truncated to the issue-comment ceiling', async () => {
    const hugeReply = 'x'.repeat(70 * 1024);
    const provider = new FakeProvider({
      script: [],
      respondScript: [{ kind: 'output', output: { reply_markdown: hugeReply } }],
    });
    const deps: AskDeps = {
      checkRuns: makeCheckRuns([roundMarker(1)]),
      reviewComments: makeReviewComments(),
      issueComments: makeIssueComments([]),
      provider,
    };
    const result = await runAsk(deps, ctx, {
      author_login: 'alice',
      message: 'why?',
      interactions: { enabled: true, max_per_review: 3 },
      pr,
    });
    expect(result.kind).toBe('replied');
    if (result.kind === 'replied') {
      expect(Buffer.byteLength(result.body, 'utf8')).toBeLessThanOrEqual(64 * 1024);
      // The header + marker must survive truncation intact.
      expect(result.body).toContain('> **@alice asked:** why?');
      expect(result.body).toContain(buildInteractionMarker(1, 1));
    }
  });

  it('thread-context-only-when-cap>1: max_per_review=1 sends an empty thread even with prior exchanges', async () => {
    // max_per_review=1 means `used >= max` would normally cap immediately once
    // 1 interaction exists; to observe the thread-omission behavior we need
    // a round with ZERO prior interactions but max_per_review=1 (first ask of
    // the round always passes the budget check regardless of the cap value).
    const provider = new FakeProvider({ script: [] });
    const deps: AskDeps = {
      checkRuns: makeCheckRuns([roundMarker(5)]),
      reviewComments: makeReviewComments(),
      issueComments: makeIssueComments([]),
      provider,
    };
    await runAsk(deps, ctx, {
      author_login: 'alice',
      message: 'first question',
      interactions: { enabled: true, max_per_review: 1 },
      pr,
    });
    expect(provider.respondCalls[0]?.thread).toEqual([]);
  });

  it('thread-context-only-when-cap>1: max_per_review>1 includes prior exchanges in the thread', async () => {
    const priorReply = renderInteractionReply({
      author_login: 'bob',
      question: 'first question',
      reply_markdown: 'first reply',
      round: 4,
      seq: 1,
    });
    const provider = new FakeProvider({ script: [] });
    const deps: AskDeps = {
      checkRuns: makeCheckRuns([roundMarker(4)]),
      reviewComments: makeReviewComments(),
      issueComments: makeIssueComments([priorReply]),
      provider,
    };
    const result = await runAsk(deps, ctx, {
      author_login: 'alice',
      message: 'second question',
      interactions: { enabled: true, max_per_review: 3 },
      pr,
    });
    expect(result.kind).toBe('replied');
    if (result.kind === 'replied') {
      expect(result.seq).toBe(2);
    }
    expect(provider.respondCalls[0]?.thread).toEqual([
      { author_login: 'bob', question: 'first question', reply_markdown: 'first reply' },
    ]);
  });

  it('does not include a `guidance` key on the provider input when absent (zero-config invariant)', async () => {
    const provider = new FakeProvider({ script: [] });
    const deps: AskDeps = {
      checkRuns: makeCheckRuns([roundMarker(1)]),
      reviewComments: makeReviewComments(),
      issueComments: makeIssueComments([]),
      provider,
    };
    await runAsk(deps, ctx, {
      author_login: 'alice',
      message: 'why?',
      interactions: { enabled: true, max_per_review: 3 },
      pr,
    });
    expect('guidance' in (provider.respondCalls[0] ?? {})).toBe(false);
  });

  it('forwards `guidance` on the provider input when configured', async () => {
    const provider = new FakeProvider({ script: [] });
    const deps: AskDeps = {
      checkRuns: makeCheckRuns([roundMarker(1)]),
      reviewComments: makeReviewComments(),
      issueComments: makeIssueComments([]),
      provider,
    };
    await runAsk(deps, ctx, {
      author_login: 'alice',
      message: 'why?',
      interactions: { enabled: true, max_per_review: 3 },
      pr,
      guidance: 'Prefer functional style.',
    });
    expect(provider.respondCalls[0]?.guidance).toBe('Prefer functional style.');
  });
});
