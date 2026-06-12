import { type NormalizedFinding, type RepoConfig, RepoConfigSchema } from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import type { CheckRunsClient } from '../../src/check-runs/index.js';
import {
  type PublishContext,
  type PublisherDeps,
  harvestPriorRound,
  publish,
} from '../../src/publisher/index.js';
import type { ReviewCommentsClient } from '../../src/review-comments/index.js';

interface FakeChecks extends CheckRunsClient {
  startCalls: Array<{ owner: string; repo: string; head_sha: string; name: string }>;
  finalizeCalls: Array<{
    check_run_id: number;
    conclusion: 'success' | 'neutral' | 'failure';
    title: string;
    summary: string;
  }>;
  setFinalizeError: (err: unknown) => void;
  setListOursResults: (
    items: Array<{ id: number; conclusion: string | null; output_summary: string | null }>,
  ) => void;
}

interface FakeComments extends ReviewCommentsClient {
  postCalls: Array<{ path: string; line: number; body: string }>;
  setListResults: (
    items: Array<{ id: number; path: string; line: number | null; body: string }>,
  ) => void;
  setPostError: (err: unknown) => void;
}

const buildFakes = (): { checks: FakeChecks; comments: FakeComments } => {
  let nextCheckRunId = 1;
  let finalizeError: unknown;
  let listResults: Array<{ id: number; path: string; line: number | null; body: string }> = [];
  let listOursResults: Array<{
    id: number;
    conclusion: string | null;
    output_summary: string | null;
  }> = [];
  let postError: unknown;

  const checks: Partial<FakeChecks> = {};
  checks.startCalls = [];
  checks.finalizeCalls = [];
  checks.setFinalizeError = (err) => {
    finalizeError = err;
  };
  checks.setListOursResults = (items) => {
    listOursResults = items;
  };
  checks.startInProgress = async (args) => {
    checks.startCalls?.push({
      owner: args.owner,
      repo: args.repo,
      head_sha: args.head_sha,
      name: args.name,
    });
    return { check_run_id: nextCheckRunId++ };
  };
  checks.finalize = async (args) => {
    if (finalizeError !== undefined) {
      const err = finalizeError;
      finalizeError = undefined;
      throw err;
    }
    checks.finalizeCalls?.push({
      check_run_id: args.check_run_id,
      conclusion: args.conclusion,
      title: args.title,
      summary: args.summary,
    });
  };
  checks.listOurs = async () => listOursResults;

  const comments: Partial<FakeComments> = {};
  comments.postCalls = [];
  comments.setListResults = (items) => {
    listResults = items;
  };
  comments.setPostError = (err) => {
    postError = err;
  };
  comments.postInline = async (args) => {
    if (postError !== undefined) {
      const err = postError;
      postError = undefined;
      throw err;
    }
    comments.postCalls?.push({ path: args.path, line: args.line, body: args.body });
    return { id: comments.postCalls?.length ?? 0 };
  };
  comments.listOurs = async () => listResults;

  return { checks: checks as FakeChecks, comments: comments as FakeComments };
};

const finding = (overrides: Partial<NormalizedFinding> & { id: string }): NormalizedFinding => ({
  id: overrides.id,
  path: overrides.path ?? 'src/a.ts',
  line_start: overrides.line_start ?? 10,
  line_end: overrides.line_end ?? 10,
  category: overrides.category ?? 'correctness',
  severity: overrides.severity ?? 'high',
  confidence: overrides.confidence ?? 0.9,
  title: overrides.title ?? 'title',
  explanation: overrides.explanation ?? 'explanation body',
  evidence: overrides.evidence ?? ['src/a.ts:10', 'hunk:src/a.ts#10-15'],
  render_target: overrides.render_target ?? 'inline',
  source_artifacts_used: overrides.source_artifacts_used ?? ['pr_diff'],
  dedupe_key: overrides.dedupe_key ?? `dk-${overrides.id}`,
  ...(overrides.suggested_fix !== undefined ? { suggested_fix: overrides.suggested_fix } : {}),
});

const cfg = (mode: 'dry-run' | 'summary-only' | 'summary-plus-inline'): RepoConfig =>
  RepoConfigSchema.parse({
    mode,
    comment_cap: { per_pr: 5, per_file: 1 },
    thresholds: {
      severity_floor: { inline: 'medium' },
      confidence_floor: { inline: 0.7 },
    },
  });

const ctx: PublishContext = {
  owner: 'octocat',
  repo: 'hello-world',
  installation_id: 100,
  repository_id: 200,
  pull_request_number: 7,
  head_sha: 'sha-head',
  app_id: 555,
  app_login: 'prisma-bot',
  run_id: 'run-test-1',
};

describe('publish', () => {
  it('dry-run: zero postInline calls; one startInProgress + one finalize', async () => {
    const { checks, comments } = buildFakes();
    const deps: PublisherDeps = { checkRuns: checks, reviewComments: comments };
    const ranked = [finding({ id: 'A' })];
    const result = await publish(ranked, cfg('dry-run'), ctx, deps);
    expect(comments.postCalls).toHaveLength(0);
    expect(checks.startCalls).toHaveLength(1);
    expect(checks.finalizeCalls).toHaveLength(1);
    expect(result.published_inline).toEqual([]);
  });

  it('summary-only: zero postInline calls; one startInProgress + one finalize', async () => {
    const { checks, comments } = buildFakes();
    const deps: PublisherDeps = { checkRuns: checks, reviewComments: comments };
    const ranked = [finding({ id: 'A' }), finding({ id: 'B', path: 'src/b.ts' })];
    const result = await publish(ranked, cfg('summary-only'), ctx, deps);
    expect(comments.postCalls).toHaveLength(0);
    expect(checks.startCalls).toHaveLength(1);
    expect(checks.finalizeCalls).toHaveLength(1);
    expect(result.published_inline).toEqual([]);
    expect(result.published_summary.map((f) => f.id)).toEqual(['A', 'B']);
  });

  it('summary-plus-inline with 12 findings: 5 postInline calls; summary lists all 12 in markdown', async () => {
    const { checks, comments } = buildFakes();
    const deps: PublisherDeps = { checkRuns: checks, reviewComments: comments };
    const ranked = [
      finding({ id: 'F-01', path: 'src/payments/charge.ts', severity: 'high', confidence: 0.92 }),
      finding({ id: 'F-02', path: 'src/payments/charge.ts', severity: 'high', confidence: 0.88 }),
      finding({ id: 'F-03', path: 'src/auth/session.ts', severity: 'high', confidence: 0.86 }),
      finding({ id: 'F-04', path: 'src/cart/coupon.ts', severity: 'medium', confidence: 0.84 }),
      finding({ id: 'F-05', path: 'src/cart/coupon.ts', severity: 'medium', confidence: 0.82 }),
      finding({ id: 'F-06', path: 'src/api/router.ts', severity: 'medium', confidence: 0.8 }),
      finding({ id: 'F-07', path: 'src/api/router.ts', severity: 'medium', confidence: 0.78 }),
      finding({ id: 'F-08', path: 'src/db/migrate.ts', severity: 'medium', confidence: 0.77 }),
      finding({ id: 'F-09', path: 'src/db/migrate.ts', severity: 'medium', confidence: 0.76 }),
      finding({ id: 'F-10', path: 'src/auth/session.ts', severity: 'medium', confidence: 0.75 }),
      finding({ id: 'F-11', path: 'src/payments/charge.ts', severity: 'medium', confidence: 0.74 }),
      finding({ id: 'F-12', path: 'src/api/router.ts', severity: 'medium', confidence: 0.72 }),
    ];
    const result = await publish(ranked, cfg('summary-plus-inline'), ctx, deps);
    expect(comments.postCalls).toHaveLength(5);
    const summary = result.summary_artifact;
    // Every input id appears in the rendered Markdown body.
    for (const f of ranked) {
      expect(summary.includes(f.id) || summary.includes(f.title)).toBe(true);
    }
  });

  it('across-run dedupe: prior listOurs result with matching dedupe marker → 0 new inline posts for that finding', async () => {
    const { checks, comments } = buildFakes();
    comments.setListResults([
      {
        id: 9001,
        path: 'src/a.ts',
        line: 10,
        body: 'previous body\n<!-- prisma-bot:dedupe=prior-key -->',
      },
    ]);
    const deps: PublisherDeps = { checkRuns: checks, reviewComments: comments };
    const ranked = [
      finding({ id: 'X', dedupe_key: 'prior-key' }),
      finding({ id: 'Y', dedupe_key: 'fresh', path: 'src/b.ts' }),
    ];
    const result = await publish(ranked, cfg('summary-plus-inline'), ctx, deps);
    // X should not be posted inline; Y should.
    expect(comments.postCalls.map((c) => c.path)).toEqual(['src/b.ts']);
    expect(result.published_summary.map((f) => f.id)).toEqual(['X']);
  });

  it('check-runs error during finalize → rejections include a github.api_error entry; no deadlock', async () => {
    const { checks, comments } = buildFakes();
    checks.setFinalizeError(new Error('checks-runs-down'));
    const deps: PublisherDeps = { checkRuns: checks, reviewComments: comments };
    const ranked = [finding({ id: 'A' })];
    const result = await publish(ranked, cfg('summary-plus-inline'), ctx, deps);
    expect(result.rejections.some((r) => r.reason_code === 'github.api_error')).toBe(true);
  });

  it('summary truncation: a 1000-finding plan produces a summary ≤ 60 KB + round header overhead', async () => {
    const { checks, comments } = buildFakes();
    const deps: PublisherDeps = { checkRuns: checks, reviewComments: comments };
    const ranked: NormalizedFinding[] = [];
    for (let i = 0; i < 1000; i += 1) {
      ranked.push(
        finding({
          id: `F${i}`,
          severity: 'high',
          confidence: 0.9,
          path: `src/p${i}.ts`,
          dedupe_key: `dk-${i}`,
          title: `finding ${i} ${'x'.repeat(100)}`,
        }),
      );
    }
    const result = await publish(ranked, cfg('summary-plus-inline'), ctx, deps);
    // The summary_artifact includes the planner summary (≤ 60 KiB) plus a
    // round-summary header line and round marker (~200 bytes overhead).
    const MAX_SUMMARY_WITH_ROUND = 60 * 1024 + 512;
    expect(Buffer.byteLength(result.summary_artifact, 'utf8')).toBeLessThanOrEqual(
      MAX_SUMMARY_WITH_ROUND,
    );
  });

  // --- T5: round model tests ---

  it('round 1 when no prior check-run markers', async () => {
    const { checks, comments } = buildFakes();
    // listOurs returns empty (no prior markers)
    const deps: PublisherDeps = { checkRuns: checks, reviewComments: comments };
    const ranked = [finding({ id: 'A', dedupe_key: 'dk-a' })];
    const result = await publish(ranked, cfg('summary-plus-inline'), ctx, deps);
    expect(result.summary_artifact).toMatch(/Round 1/);
    // Round marker should be emitted
    expect(result.summary_artifact).toMatch(/<!--\s*prisma-bot:round=1\s+head=/);
  });

  it('round N+1 when prior check-run summary has round=N marker', async () => {
    const { checks, comments } = buildFakes();
    checks.setListOursResults([
      {
        id: 42,
        conclusion: 'success',
        output_summary: '<!-- prisma-bot:round=3 head=abcd1234 -->',
      },
    ]);
    const deps: PublisherDeps = { checkRuns: checks, reviewComments: comments };
    const ranked = [finding({ id: 'B', dedupe_key: 'dk-b' })];
    const result = await publish(ranked, cfg('summary-plus-inline'), ctx, deps);
    expect(result.summary_artifact).toMatch(/Round 4/);
    expect(result.summary_artifact).toMatch(/<!--\s*prisma-bot:round=4\s+head=/);
  });

  it('full round: labels summary "(full)" and ignores prior dedupe keys', async () => {
    const { checks, comments } = buildFakes();
    // Set a prior inline comment with a dedupe key (would normally suppress the finding)
    comments.setListResults([
      {
        id: 9001,
        path: 'src/a.ts',
        line: 10,
        body: 'prior body\n<!-- prisma-bot:dedupe=dk-prior -->',
      },
    ]);
    const deps: PublisherDeps = { checkRuns: checks, reviewComments: comments };
    const ranked = [finding({ id: 'C', dedupe_key: 'dk-prior' })];
    // With roundIntent='full', the prior dedupe key is ignored → finding is posted inline
    const result = await publish(ranked, cfg('summary-plus-inline'), ctx, deps, 'full');
    expect(result.summary_artifact).toMatch(/Round 1 \(full\)/);
    // The finding should be posted inline (prior dedupe key ignored in 'full' mode)
    expect(comments.postCalls).toHaveLength(1);
  });

  it('round summary: set arithmetic for incremental round', async () => {
    const { checks, comments } = buildFakes();
    // Two prior dedupe keys exist on the PR
    comments.setListResults([
      { id: 1, path: 'src/a.ts', line: 1, body: '<!-- prisma-bot:dedupe=key-a -->' },
      { id: 2, path: 'src/b.ts', line: 2, body: '<!-- prisma-bot:dedupe=key-b -->' },
    ]);
    const deps: PublisherDeps = { checkRuns: checks, reviewComments: comments };
    // Current round produces key-b (still open) and key-c (new); key-a is addressed
    const ranked = [
      finding({ id: 'B', dedupe_key: 'key-b', path: 'src/b.ts' }),
      finding({ id: 'C', dedupe_key: 'key-c', path: 'src/c.ts' }),
    ];
    const result = await publish(ranked, cfg('summary-plus-inline'), ctx, deps, 'incremental');
    // key-a: addressed (prior, not in current)
    // key-b: still open (prior AND current)
    // key-c: new (current, not in prior)
    expect(result.summary_artifact).toMatch(/1 addressed/);
    expect(result.summary_artifact).toMatch(/1 still open/);
    expect(result.summary_artifact).toMatch(/1 new/);
  });

  it('harvestPriorRound returns 0 when listOurs throws (fail-open)', async () => {
    const { comments } = buildFakes();
    const failingCheckRuns: CheckRunsClient = {
      startInProgress: async () => ({ check_run_id: 1 }),
      finalize: async () => {},
      listOurs: async () => {
        throw new Error('github down');
      },
    };
    const deps: PublisherDeps = { checkRuns: failingCheckRuns, reviewComments: comments };
    const round = await harvestPriorRound(deps, ctx);
    expect(round).toBe(0);
  });

  it('harvestPriorRound returns the max round across multiple check runs', async () => {
    const { checks, comments } = buildFakes();
    checks.setListOursResults([
      { id: 1, conclusion: 'success', output_summary: '<!-- prisma-bot:round=2 head=abcd1234 -->' },
      { id: 2, conclusion: 'success', output_summary: '<!-- prisma-bot:round=5 head=cafe5678 -->' },
      { id: 3, conclusion: 'success', output_summary: 'no marker here' },
    ]);
    const deps: PublisherDeps = { checkRuns: checks, reviewComments: comments };
    const round = await harvestPriorRound(deps, ctx);
    expect(round).toBe(5);
  });
});
