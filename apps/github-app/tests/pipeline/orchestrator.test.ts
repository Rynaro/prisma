import type { InstallationAuth, OctokitLike, PublicationExtras } from '@prisma-bot/github';
import { FakeProvider, makeFindingFixture } from '@prisma-bot/provider-fake';
import {
  type JobPayload,
  type PrSnapshot,
  ProviderErrorThrowable,
  type ProviderReviewInput,
  type ProviderReviewOutput,
  type RepoConfig,
  RepoConfigSchema,
} from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import {
  type LogEvent,
  type OrchestratorDeps,
  type PipelineLogger,
  type RepoIdentity,
  type RepoLookup,
  runPipeline,
} from '../../src/pipeline/index.js';
import { type NoFindingsReasoningHint } from '../../src/pipeline/index.js';

const REPO_ID: RepoIdentity = {
  owner: 'octocat',
  repo: 'hello-world',
  app_id: 999,
  app_login: 'prisma-bot',
};

const repoLookup: RepoLookup = async () => REPO_ID;

type PrJobPayload = Extract<
  JobPayload,
  { event_type: 'pull_request.opened' | 'pull_request.synchronize' | 'pull_request.reopened' }
>;

const makePayload = (over: Partial<PrJobPayload> = {}): PrJobPayload => ({
  idempotency_key: 'idemp-1',
  installation_id: 100,
  repository_id: 200,
  pull_request_number: 7,
  head_sha: 'a'.repeat(40),
  event_type: 'pull_request.opened',
  received_at: '2025-01-01T00:00:00.000Z',
  ...over,
});

const cfg = (
  mode: 'dry-run' | 'summary-only' | 'summary-plus-inline' = 'summary-plus-inline',
): RepoConfig =>
  RepoConfigSchema.parse({
    mode,
    comment_cap: { per_pr: 5, per_file: 1 },
    thresholds: {
      severity_floor: { inline: 'medium' },
      confidence_floor: { inline: 0.7 },
    },
  });

const stubInstallationAuth = {} as InstallationAuth;

interface OctokitSpy {
  octokit: OctokitLike;
  checksCreate: Array<unknown>;
  checksUpdate: Array<{ check_run_id: number; conclusion?: string }>;
  reviewCommentsCreate: Array<{ path: string; line: number; body: string }>;
}

const buildOctokitSpy = (): OctokitSpy => {
  let nextCheckId = 1;
  const checksCreate: unknown[] = [];
  const checksUpdate: Array<{ check_run_id: number; conclusion?: string }> = [];
  const reviewCommentsCreate: Array<{ path: string; line: number; body: string }> = [];
  const octokit: OctokitLike = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            number: 7,
            head: { sha: 'a'.repeat(40), ref: 'feature' },
            base: { sha: 'b'.repeat(40), ref: 'main' },
          },
        }),
        listFiles: async () => ({ data: [] }),
      },
      repos: {
        getContent: async () => ({ data: {} }),
      },
      checks: {
        create: async (params) => {
          checksCreate.push(params);
          const id = nextCheckId++;
          return { data: { id } };
        },
        update: async (params) => {
          checksUpdate.push({
            check_run_id: params.check_run_id,
            ...(params.conclusion !== undefined ? { conclusion: params.conclusion } : {}),
          });
          return { data: { id: params.check_run_id } };
        },
        listForRef: async () => ({ data: { check_runs: [] } }),
      },
      pulls_reviews: {
        createReviewComment: async (params) => {
          reviewCommentsCreate.push({
            path: params.path,
            line: params.line,
            body: params.body,
          });
          return {
            data: {
              id: reviewCommentsCreate.length,
              body: params.body,
              path: params.path,
              line: params.line,
              user: null,
            },
          };
        },
        listReviewComments: async () => ({ data: [] }),
        createReview: async () => ({
          data: { id: 1, state: 'APPROVED', body: '', user: null },
        }),
        listReviews: async () => ({ data: [] }),
        dismissReview: async () => ({
          data: { id: 1, state: 'DISMISSED', body: '', user: null },
        }),
      },
      issues: {
        createComment: async () => ({ data: { id: 1, body: null, user: null } }),
        getComment: async () => ({ data: { id: 1, body: null, user: null } }),
      },
      reactions: {
        createForIssueComment: async () => ({ data: { id: 1 } }),
      },
    },
  };
  return { octokit, checksCreate, checksUpdate, reviewCommentsCreate };
};

const buildSnapshot = (overrides: Partial<PrSnapshot> = {}): PrSnapshot => ({
  installation_id: 100,
  repository_id: 200,
  pull_request_number: 7,
  head_sha: 'a'.repeat(40),
  base_sha: 'b'.repeat(40),
  default_branch: 'main',
  total_changed_lines: 4,
  files: [
    {
      path: 'src/example.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      hunks: [{ new_start: 10, new_lines: 5, old_start: 10, old_lines: 4 }],
      is_binary: false,
      language: 'typescript',
    },
  ],
  ...overrides,
});

const buildLogger = (): PipelineLogger & {
  events: Array<{ event: LogEvent; fields: Record<string, unknown> }>;
} => {
  const events: Array<{ event: LogEvent; fields: Record<string, unknown> }> = [];
  return {
    events,
    emit(event, fields) {
      events.push({ event, fields });
    },
  };
};

interface BuildDepsArgs {
  provider: OrchestratorDeps['provider'];
  config?: RepoConfig;
  octokitSpy?: OctokitSpy;
  snapshot?: PrSnapshot;
  logger?: PipelineLogger;
}

const buildDeps = (args: BuildDepsArgs): OrchestratorDeps => {
  const spy = args.octokitSpy ?? buildOctokitSpy();
  const snap = args.snapshot ?? buildSnapshot();
  return {
    installationAuth: stubInstallationAuth,
    provider: args.provider,
    config: args.config ?? cfg('summary-plus-inline'),
    repoLookup,
    octokit: spy.octokit,
    ...(args.logger !== undefined ? { logger: args.logger } : {}),
    hooks: {
      fetchSnapshot: async () => snap,
    },
  };
};

const validOutputForExampleFile = (): ProviderReviewOutput => ({
  findings: [
    makeFindingFixture({
      path: 'src/example.ts',
      line: 12,
      severity: 'high',
      confidence: 0.9,
      message: 'unsafe input',
      rationale: 'value flows into eval without sanitization',
    }),
  ],
});

describe('runPipeline', () => {
  it('happy path: 1 file, 1 valid finding -> 1 inline comment published', async () => {
    const provider = new FakeProvider({
      script: [{ kind: 'output', output: validOutputForExampleFile() }],
    });
    const spy = buildOctokitSpy();
    const result = await runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy }));
    expect(result.state).toBe('succeeded');
    expect(provider.calls).toHaveLength(1);
    expect(spy.checksCreate).toHaveLength(1);
    expect(spy.checksUpdate).toHaveLength(1);
    expect(spy.reviewCommentsCreate).toHaveLength(1);
    expect(spy.reviewCommentsCreate[0]?.path).toBe('src/example.ts');
    expect(spy.reviewCommentsCreate[0]?.line).toBe(12);
  });

  it('oversized PR triggers summary-only fast-path with no provider call', async () => {
    const provider = new FakeProvider({ script: [] });
    // A PR that exceeds BOTH max_changed_lines (2000) AND chunking.max_changed_lines (12000)
    // so it falls straight through to the oversized outcome without any provider call.
    const oversized = buildSnapshot({
      total_changed_lines: 15000,
      files: [
        {
          path: 'src/big.ts',
          status: 'modified',
          additions: 9000,
          deletions: 6000,
          hunks: [{ new_start: 1, new_lines: 15000, old_start: 1, old_lines: 14000 }],
          is_binary: false,
          language: 'typescript',
        },
      ],
    });
    const spy = buildOctokitSpy();
    const result = await runPipeline(
      makePayload(),
      buildDeps({ provider, octokitSpy: spy, snapshot: oversized }),
    );
    expect(result.state).toBe('succeeded');
    expect(provider.calls).toHaveLength(0);
    // The publisher still runs to emit the summary checks-run.
    expect(spy.checksCreate).toHaveLength(1);
    expect(spy.reviewCommentsCreate).toHaveLength(0);
  });

  it('oversized PR (too_many_changed_lines): outcome.kind === oversized with correct detail', async () => {
    // PR exceeds chunking.max_changed_lines (12000) → true oversized.
    const provider = new FakeProvider({ script: [] });
    const oversized = buildSnapshot({
      total_changed_lines: 15000,
      files: [
        {
          path: 'src/big.ts',
          status: 'modified',
          additions: 9000,
          deletions: 6000,
          hunks: [{ new_start: 1, new_lines: 15000, old_start: 1, old_lines: 14000 }],
          is_binary: false,
          language: 'typescript',
        },
      ],
    });
    const spy = buildOctokitSpy();
    const result = await runPipeline(
      makePayload(),
      buildDeps({ provider, octokitSpy: spy, snapshot: oversized }),
    );
    expect(result.outcome?.kind).toBe('oversized');
    if (result.outcome?.kind !== 'oversized') return;
    expect(result.outcome.detail.prefilter_reason).toBe('too_many_changed_lines');
    expect(result.outcome.detail.files_considered).toBe(1);
    expect(result.outcome.detail.lines_considered).toBe(15000);
    // Configured defaults: max_files=50, max_changed_lines=2000
    expect(result.outcome.detail.max_files).toBe(50);
    expect(result.outcome.detail.max_changed_lines).toBe(2000);
  });

  it('oversized PR (too_many_files): outcome.kind === oversized with correct prefilter_reason', async () => {
    // Build a snapshot with 210 files (> chunking.max_files=200) to produce true oversized.
    const provider = new FakeProvider({ script: [] });
    const manyFiles = buildSnapshot({
      total_changed_lines: 210,
      files: Array.from({ length: 210 }, (_, i) => ({
        path: `src/file${i}.ts`,
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
        hunks: [{ new_start: 1, new_lines: 1, old_start: 1, old_lines: 0 }],
        is_binary: false,
        language: 'typescript',
      })),
    });
    const spy = buildOctokitSpy();
    const result = await runPipeline(
      makePayload(),
      buildDeps({ provider, octokitSpy: spy, snapshot: manyFiles }),
    );
    expect(result.state).toBe('succeeded');
    expect(result.outcome?.kind).toBe('oversized');
    if (result.outcome?.kind !== 'oversized') return;
    expect(result.outcome.detail.prefilter_reason).toBe('too_many_files');
    expect(result.outcome.detail.files_considered).toBe(210);
    expect(result.outcome.detail.max_files).toBe(50);
  });

  it('oversized PR: check-run summary contains the oversized notice text', async () => {
    // The summary markdown published to GitHub must state the reason and
    // numbers rather than rendering "_No findings._" as if the PR were clean.
    const provider = new FakeProvider({ script: [] });
    // Use a truly oversized snapshot (>12000 lines) so it bypasses chunking.
    const oversized = buildSnapshot({
      total_changed_lines: 15000,
      files: [
        {
          path: 'src/big.ts',
          status: 'modified',
          additions: 9000,
          deletions: 6000,
          hunks: [{ new_start: 1, new_lines: 15000, old_start: 1, old_lines: 14000 }],
          is_binary: false,
          language: 'typescript',
        },
      ],
    });
    // Capture what the publisher receives via a runPublish hook.
    const capturedSummaries: string[] = [];
    const spy = buildOctokitSpy();
    const deps = buildDeps({ provider, octokitSpy: spy, snapshot: oversized });
    deps.hooks = {
      ...deps.hooks,
      runPublish: async (ranked, cfgArg, ctx, publisherDepsArg, _roundIntent, notice) => {
        if (notice !== undefined) capturedSummaries.push(notice);
        // Fall through to the real publish (spy already wraps octokit).
        const { publish: realPublish } = await import('@prisma-bot/github');
        return realPublish(ranked, cfgArg, ctx, publisherDepsArg);
      },
    };
    const result = await runPipeline(makePayload(), deps);
    expect(result.state).toBe('succeeded');
    // The notice captured by the hook must mention the size limit outcome.
    expect(capturedSummaries).toHaveLength(1);
    expect(capturedSummaries[0]).toMatch(/Review skipped/);
    expect(capturedSummaries[0]).toMatch(/max_changed_lines/);
    expect(capturedSummaries[0]).toMatch(/review-bot\.yml/);
  });

  it('single-call empty review: notice explains zero findings (not a bare "_No findings._")', async () => {
    // A classic model that returns zero findings on a real diff must explain
    // itself in the check-run summary rather than render a bare "_No findings._".
    const provider = new FakeProvider({ script: [{ kind: 'output', output: { findings: [] } }] });
    const capturedNotices: (string | undefined)[] = [];
    const spy = buildOctokitSpy();
    const deps = buildDeps({ provider, octokitSpy: spy });
    deps.hooks = {
      ...deps.hooks,
      runPublish: async (ranked, cfgArg, ctx, publisherDepsArg, roundIntent, notice) => {
        capturedNotices.push(notice);
        const { publish: realPublish } = await import('@prisma-bot/github');
        return realPublish(ranked, cfgArg, ctx, publisherDepsArg, roundIntent, notice);
      },
    };
    const result = await runPipeline(makePayload(), deps);
    expect(result.state).toBe('succeeded');
    expect(result.outcome?.kind).toBe('review_complete');
    expect(capturedNotices[0]).toMatch(
      /No issues were reported at or above your configured inline floors/,
    );
  });

  it('chunked empty review: notice explains zero findings (chunked path was silent)', async () => {
    const snap = buildChunkableSnapshot(2);
    const provider = new FakeProvider({
      script: [
        { kind: 'output', output: { findings: [] } },
        { kind: 'output', output: { findings: [] } },
      ],
    });
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 1, // tiny budget → one batch per file → 2 sections
      },
    });
    const capturedNotices: (string | undefined)[] = [];
    const spy = buildOctokitSpy();
    const deps = buildDeps({ provider, octokitSpy: spy, snapshot: snap, config });
    deps.hooks = {
      ...deps.hooks,
      runPublish: async (ranked, cfgArg, ctx, publisherDepsArg, roundIntent, notice) => {
        capturedNotices.push(notice);
        const { publish: realPublish } = await import('@prisma-bot/github');
        return realPublish(ranked, cfgArg, ctx, publisherDepsArg, roundIntent, notice);
      },
    };
    const result = await runPipeline(makePayload(), deps);
    expect(result.state).toBe('succeeded');
    expect(result.outcome?.kind).toBe('review_complete_chunked');
    // The chunked prefix AND the empty-review explanation are both present.
    expect(capturedNotices[0]).toMatch(/Reviewed in 2 section\(s\)/);
    expect(capturedNotices[0]).toMatch(
      /No issues were reported at or above your configured inline floors/,
    );
  });

  it('normal review (review_complete): outcome.kind === review_complete', async () => {
    const provider = new FakeProvider({
      script: [{ kind: 'output', output: validOutputForExampleFile() }],
    });
    const spy = buildOctokitSpy();
    const result = await runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy }));
    expect(result.state).toBe('succeeded');
    expect(result.outcome?.kind).toBe('review_complete');
  });

  it('empty diff (no_findings): outcome.kind === no_findings', async () => {
    const provider = new FakeProvider({ script: [] });
    const empty = buildSnapshot({ total_changed_lines: 0, files: [] });
    const spy = buildOctokitSpy();
    const result = await runPipeline(
      makePayload(),
      buildDeps({ provider, octokitSpy: spy, snapshot: empty }),
    );
    expect(result.state).toBe('succeeded');
    expect(result.outcome?.kind).toBe('no_findings');
  });

  it('malformed provider output: outcome.kind === malformed_provider_output', async () => {
    const provider = new FakeProvider({
      script: [
        {
          kind: 'error',
          error: { kind: 'schema_validation', message: 'truncated output' },
        },
      ],
    });
    const spy = buildOctokitSpy();
    const result = await runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy }));
    expect(result.state).toBe('succeeded');
    expect(result.outcome?.kind).toBe('malformed_provider_output');
  });

  it('empty diff (no analyzable files) -> publishes "no findings" summary, no provider call', async () => {
    const provider = new FakeProvider({ script: [] });
    const empty = buildSnapshot({ total_changed_lines: 0, files: [] });
    const spy = buildOctokitSpy();
    const result = await runPipeline(
      makePayload(),
      buildDeps({ provider, octokitSpy: spy, snapshot: empty }),
    );
    expect(result.state).toBe('succeeded');
    expect(provider.calls).toHaveLength(0);
    expect(spy.checksCreate).toHaveLength(1);
    expect(spy.reviewCommentsCreate).toHaveLength(0);
  });

  it('provider truncation (finish_reason=length, schema_validation) -> malformed_provider_output summary; succeeded state', async () => {
    // The OpenAI adapter throws schema_validation when finish_reason==='length'.
    // The orchestrator must publish malformed_provider_output summary-only and
    // return succeeded so the job is not retried.
    const provider = new FakeProvider({
      script: [
        {
          kind: 'error',
          error: {
            kind: 'schema_validation',
            message: "openai response truncated: finish_reason is 'length' (max_tokens: 4096)",
          },
        },
      ],
    });
    const spy = buildOctokitSpy();
    const result = await runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy }));
    expect(result.state).toBe('succeeded');
    expect(spy.checksCreate).toHaveLength(1);
    expect(spy.reviewCommentsCreate).toHaveLength(0);
    expect(result.rejections.some((r) => r.reason_code === 'provider_output_zod_failed')).toBe(
      true,
    );
  });

  it('provider returns malformed output -> "review unavailable" summary; succeeded state', async () => {
    const provider = new FakeProvider({
      script: [
        {
          kind: 'error',
          error: {
            kind: 'schema_validation',
            message: 'malformed output',
          },
        },
      ],
    });
    const spy = buildOctokitSpy();
    const result = await runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy }));
    expect(result.state).toBe('succeeded');
    expect(spy.checksCreate).toHaveLength(1);
    expect(spy.reviewCommentsCreate).toHaveLength(0);
    expect(result.rejections.some((r) => r.reason_code === 'provider_output_zod_failed')).toBe(
      true,
    );
  });

  it('provider throws transport error -> re-thrown; no inline publish', async () => {
    const provider = new FakeProvider({
      script: [
        {
          kind: 'error',
          error: { kind: 'transport', message: 'connection reset' },
        },
      ],
    });
    const spy = buildOctokitSpy();
    await expect(
      runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy })),
    ).rejects.toBeInstanceOf(ProviderErrorThrowable);
    // No inline comments and no checks-update published — the provider error
    // is re-thrown for the consumer to retry.
    expect(spy.reviewCommentsCreate).toHaveLength(0);
  });

  it('provider throws auth error -> publishes "review unavailable" then re-throws', async () => {
    const provider = new FakeProvider({
      script: [
        {
          kind: 'error',
          error: { kind: 'auth', message: 'invalid api key' },
        },
      ],
    });
    const spy = buildOctokitSpy();
    await expect(
      runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy })),
    ).rejects.toBeInstanceOf(ProviderErrorThrowable);
    // Publish must have been called once before the re-throw so the user
    // sees a status.
    expect(spy.checksCreate).toHaveLength(1);
  });

  it('auth error: provider.error log includes message field', async () => {
    // The message comes from the provider adapter's safeMessage and must appear
    // in the provider.error log event so operators can distinguish failure causes.
    const provider = new FakeProvider({
      script: [
        {
          kind: 'error',
          error: { kind: 'auth', message: 'invalid api key' },
        },
      ],
    });
    const logger = buildLogger();
    const spy = buildOctokitSpy();
    await expect(
      runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy, logger })),
    ).rejects.toBeInstanceOf(ProviderErrorThrowable);
    const errorEvent = logger.events.find((e) => e.event === 'provider.error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.fields.kind).toBe('auth');
    expect(errorEvent?.fields.message).toBe('invalid api key');
  });

  it('capability error: provider.error log includes message field', async () => {
    const provider = new FakeProvider({
      script: [
        {
          kind: 'error',
          error: { kind: 'capability', message: 'model_not_found' },
        },
      ],
    });
    const logger = buildLogger();
    const spy = buildOctokitSpy();
    await expect(
      runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy, logger })),
    ).rejects.toBeInstanceOf(ProviderErrorThrowable);
    const errorEvent = logger.events.find((e) => e.event === 'provider.error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.fields.kind).toBe('capability');
    expect(errorEvent?.fields.message).toBe('model_not_found');
  });

  it('capability error: notice passed to runPublish contains model-pointer text and NOT-size-limit text', async () => {
    // Per spec: the capability notice must make clear this is a provider/model
    // rejection, NOT a size limit, and point at the model config.
    const provider = new FakeProvider({
      script: [
        {
          kind: 'error',
          error: { kind: 'capability', message: 'model_not_found' },
        },
      ],
    });
    const capturedNotices: Array<string | undefined> = [];
    const spy = buildOctokitSpy();
    const deps = buildDeps({ provider, octokitSpy: spy });
    deps.hooks = {
      ...deps.hooks,
      runPublish: async (ranked, cfgArg, ctx, publisherDepsArg, _roundIntent, notice) => {
        capturedNotices.push(notice);
        const { publish: realPublish } = await import('@prisma-bot/github');
        return realPublish(ranked, cfgArg, ctx, publisherDepsArg);
      },
    };
    await expect(runPipeline(makePayload(), deps)).rejects.toBeInstanceOf(ProviderErrorThrowable);
    expect(capturedNotices).toHaveLength(1);
    const notice = capturedNotices[0];
    expect(notice).toBeDefined();
    expect(notice).toMatch(/capability/);
    expect(notice).toMatch(/model_not_found/);
    expect(notice).toMatch(/review-bot\.yml/);
    expect(notice).toMatch(/not a PR-size limit/i);
  });

  it('auth error: notice passed to runPublish contains credentials text', async () => {
    const provider = new FakeProvider({
      script: [
        {
          kind: 'error',
          error: { kind: 'auth', message: 'invalid api key' },
        },
      ],
    });
    const capturedNotices: Array<string | undefined> = [];
    const spy = buildOctokitSpy();
    const deps = buildDeps({ provider, octokitSpy: spy });
    deps.hooks = {
      ...deps.hooks,
      runPublish: async (ranked, cfgArg, ctx, publisherDepsArg, _roundIntent, notice) => {
        capturedNotices.push(notice);
        const { publish: realPublish } = await import('@prisma-bot/github');
        return realPublish(ranked, cfgArg, ctx, publisherDepsArg);
      },
    };
    await expect(runPipeline(makePayload(), deps)).rejects.toBeInstanceOf(ProviderErrorThrowable);
    expect(capturedNotices).toHaveLength(1);
    const notice = capturedNotices[0];
    expect(notice).toBeDefined();
    expect(notice).toMatch(/authentication failure/i);
    expect(notice).toMatch(/invalid api key/);
    expect(notice).toMatch(/API key/i);
  });

  it('validator rejects all findings (out-of-diff) -> publishes summary listing rejections', async () => {
    const provider = new FakeProvider({
      script: [
        {
          kind: 'output',
          output: {
            findings: [
              makeFindingFixture({
                path: 'src/example.ts',
                line: 9999, // outside the touched hunk [10..14]
              }),
            ],
          },
        },
      ],
    });
    const spy = buildOctokitSpy();
    const result = await runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy }));
    expect(result.state).toBe('succeeded');
    // Validator-stage rejections (line_not_in_diff) appear in the result.
    expect(
      result.rejections.some(
        (r) => r.stage === 'validator' && r.reason_code === 'line_not_in_diff',
      ),
    ).toBe(true);
    // Summary checks-run is emitted; no inline comments.
    expect(spy.checksCreate).toHaveLength(1);
    expect(spy.reviewCommentsCreate).toHaveLength(0);
  });

  it('mode=dry-run produces 0 inline comments even with high-confidence findings', async () => {
    const provider = new FakeProvider({
      script: [
        {
          kind: 'output',
          output: {
            findings: [
              makeFindingFixture({
                path: 'src/example.ts',
                line: 11,
                severity: 'critical',
                confidence: 0.99,
              }),
              makeFindingFixture({
                path: 'src/example.ts',
                line: 12,
                severity: 'critical',
                confidence: 0.95,
                message: 'second issue',
              }),
            ],
          },
        },
      ],
    });
    const spy = buildOctokitSpy();
    const result = await runPipeline(
      makePayload(),
      buildDeps({ provider, octokitSpy: spy, config: cfg('dry-run') }),
    );
    expect(result.state).toBe('succeeded');
    expect(spy.reviewCommentsCreate).toHaveLength(0);
    expect(spy.checksCreate).toHaveLength(1);
  });

  it('mode=summary-plus-inline publishes up to per_pr cap inline (5 here)', async () => {
    const provider = new FakeProvider({
      script: [
        {
          kind: 'output',
          output: {
            findings: [
              { ...makeFindingFixture({ path: 'a.ts', line: 11 }), category: 'security' },
              { ...makeFindingFixture({ path: 'b.ts', line: 11 }), category: 'security' },
              { ...makeFindingFixture({ path: 'c.ts', line: 11 }), category: 'security' },
              { ...makeFindingFixture({ path: 'd.ts', line: 11 }), category: 'security' },
              { ...makeFindingFixture({ path: 'e.ts', line: 11 }), category: 'security' },
            ],
          },
        },
      ],
    });
    const spy = buildOctokitSpy();
    // Build a snapshot with 5 files each touched at line 11; per-file cap is 1
    // and per-PR cap is 5 → all 5 inline.
    const snap: PrSnapshot = {
      installation_id: 100,
      repository_id: 200,
      pull_request_number: 7,
      head_sha: 'a'.repeat(40),
      base_sha: 'b'.repeat(40),
      default_branch: 'main',
      total_changed_lines: 25,
      files: ['a', 'b', 'c', 'd', 'e'].map((n) => ({
        path: `${n}.ts`,
        status: 'modified',
        additions: 3,
        deletions: 2,
        hunks: [{ new_start: 10, new_lines: 5, old_start: 10, old_lines: 5 }],
        is_binary: false,
        language: 'typescript',
      })),
    };
    const result = await runPipeline(
      makePayload(),
      buildDeps({ provider, octokitSpy: spy, snapshot: snap }),
    );
    expect(result.state).toBe('succeeded');
    expect(spy.reviewCommentsCreate).toHaveLength(5);
  });

  it('propagates traceparent from JobPayload into log events', async () => {
    const provider = new FakeProvider({
      script: [{ kind: 'output', output: validOutputForExampleFile() }],
    });
    const logger = buildLogger();
    const spy = buildOctokitSpy();
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const result = await runPipeline(
      makePayload({ traceparent }),
      buildDeps({ provider, octokitSpy: spy, logger }),
    );
    expect(result.state).toBe('succeeded');
    // Every emitted event should carry the traceparent field.
    expect(logger.events.length).toBeGreaterThan(0);
    for (const e of logger.events) {
      expect(e.fields.traceparent).toBe(traceparent);
    }
  });

  it('emits prefilter.accepted with file count and provider.called events', async () => {
    const provider = new FakeProvider({
      script: [{ kind: 'output', output: validOutputForExampleFile() }],
    });
    const logger = buildLogger();
    const spy = buildOctokitSpy();
    await runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy, logger }));
    const events = logger.events.map((e) => e.event);
    expect(events).toContain('prefilter.accepted');
    expect(events).toContain('provider.called');
    expect(events).toContain('publisher.published');
    expect(events).toContain('job.terminal');
  });

  it('emits provider.output with correct findings_count after successful provider call', async () => {
    const provider = new FakeProvider({
      script: [{ kind: 'output', output: validOutputForExampleFile() }],
    });
    const logger = buildLogger();
    const spy = buildOctokitSpy();
    await runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy, logger }));
    const outputEvent = logger.events.find((e) => e.event === 'provider.output');
    expect(outputEvent).toBeDefined();
    expect(outputEvent?.fields.findings_count).toBe(1);
  });

  it('provider.output emitted with findings_count=0 when provider returns empty findings', async () => {
    const provider = new FakeProvider({
      script: [{ kind: 'output', output: { findings: [] } }],
    });
    const logger = buildLogger();
    const spy = buildOctokitSpy();
    await runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy, logger }));
    const outputEvent = logger.events.find((e) => e.event === 'provider.output');
    expect(outputEvent).toBeDefined();
    expect(outputEvent?.fields.findings_count).toBe(0);
  });

  it('provider.output is NOT emitted when provider throws', async () => {
    const provider = new FakeProvider({
      script: [{ kind: 'error', error: { kind: 'transport', message: 'network error' } }],
    });
    const logger = buildLogger();
    const spy = buildOctokitSpy();
    await expect(
      runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy, logger })),
    ).rejects.toBeInstanceOf(ProviderErrorThrowable);
    const outputEvent = logger.events.find((e) => e.event === 'provider.output');
    expect(outputEvent).toBeUndefined();
  });

  it('validator.rejected emits count and per-rejection detail with required RejectionLogEntry fields', async () => {
    const provider = new FakeProvider({
      script: [
        {
          kind: 'output',
          output: {
            findings: [
              makeFindingFixture({
                path: 'src/example.ts',
                line: 9999, // outside the touched hunk [10..14]
              }),
            ],
          },
        },
      ],
    });
    const logger = buildLogger();
    const spy = buildOctokitSpy();
    await runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy, logger }));
    const rejectedEvent = logger.events.find((e) => e.event === 'validator.rejected');
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent?.fields.count).toBe(1);
    const rejections = rejectedEvent?.fields.rejections as Array<Record<string, unknown>>;
    expect(Array.isArray(rejections)).toBe(true);
    expect(rejections).toHaveLength(1);
    const entry = rejections[0];
    expect(entry).toBeDefined();
    // All RejectionLogEntry fields must be present
    expect(typeof entry?.reason_code).toBe('string');
    expect(typeof entry?.reason_message).toBe('string');
    expect(typeof entry?.stage).toBe('string');
    expect('finding_id' in (entry ?? {})).toBe(true);
    expect('provider_output_excerpt' in (entry ?? {})).toBe(true);
    expect(typeof entry?.timestamp).toBe('string');
    // reason_code matches the validator's out-of-diff rejection
    expect(entry?.reason_code).toBe('line_not_in_diff');
  });
});

// ---------------------------------------------------------------------------
// Diff-chunking tests
// ---------------------------------------------------------------------------

/**
 * Build a snapshot whose changed-lines total exceeds max_changed_lines (2000)
 * but stays within chunking.max_changed_lines (12000) so the prefilter returns
 * `chunkable`. The snapshot contains `fileCount` files split across multiple
 * paths, each with a hunk at line 10 (so validator can validate provider
 * findings at line 11–14).
 *
 * Each file contributes 1100 lines (additions + deletions), so even 2 files
 * = 2200 lines, exceeding the default max_changed_lines=2000 → chunkable.
 */
const buildChunkableSnapshot = (fileCount = 3): PrSnapshot => ({
  installation_id: 100,
  repository_id: 200,
  pull_request_number: 7,
  head_sha: 'a'.repeat(40),
  base_sha: 'b'.repeat(40),
  default_branch: 'main',
  total_changed_lines: fileCount * 1100,
  files: Array.from({ length: fileCount }, (_, i) => ({
    path: `src/file${i}.ts`,
    status: 'modified' as const,
    additions: 1100,
    deletions: 0,
    hunks: [{ new_start: 10, new_lines: 1100, old_start: 10, old_lines: 0 }],
    is_binary: false,
    language: 'typescript' as const,
  })),
});

describe('runPipeline — diff chunking', () => {
  it('chunkable PR: calls provider once per batch, merges findings, returns review_complete_chunked', async () => {
    // 3 files × 900 lines = 2700 lines > 2000 (max_changed_lines) → chunkable.
    // Budget is very tight (1 token) so each file gets its own batch → 3 batches.
    const snap = buildChunkableSnapshot(3);

    // Each batch produces one finding for one of the files.
    const provider = new FakeProvider({
      script: [
        {
          kind: 'output',
          output: { findings: [makeFindingFixture({ path: 'src/file0.ts', line: 11 })] },
        },
        {
          kind: 'output',
          output: { findings: [makeFindingFixture({ path: 'src/file1.ts', line: 11 })] },
        },
        {
          kind: 'output',
          output: { findings: [makeFindingFixture({ path: 'src/file2.ts', line: 11 })] },
        },
      ],
    });
    const spy = buildOctokitSpy();
    // Use a tiny token budget so each file is its own batch.
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      comment_cap: { per_pr: 10, per_file: 5 },
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 1,
      },
    });
    const result = await runPipeline(
      makePayload(),
      buildDeps({ provider, octokitSpy: spy, snapshot: snap, config }),
    );

    expect(result.state).toBe('succeeded');
    expect(result.outcome?.kind).toBe('review_complete_chunked');
    if (result.outcome?.kind !== 'review_complete_chunked') return;
    expect(result.outcome.detail.batch_count).toBe(3);
    expect(result.outcome.detail.failed_batches).toHaveLength(0);
    expect(result.outcome.detail.skipped_files).toHaveLength(0);
    // All 3 findings were merged and published (one inline per file, within caps).
    expect(spy.reviewCommentsCreate).toHaveLength(3);
    // Provider was called 3 times (once per batch).
    expect(provider.calls).toHaveLength(3);
  });

  it('chunking.planned and provider.batch.* events are emitted', async () => {
    const snap = buildChunkableSnapshot(2);
    const provider = new FakeProvider({
      script: [
        { kind: 'output', output: { findings: [] } },
        { kind: 'output', output: { findings: [] } },
      ],
    });
    const logger = buildLogger();
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 1,
      },
    });
    await runPipeline(
      makePayload(),
      buildDeps({ provider, octokitSpy: spy, snapshot: snap, config, logger }),
    );

    const events = logger.events.map((e) => e.event);
    expect(events).toContain('chunking.planned');
    expect(events).toContain('provider.batch.called');
    expect(events).toContain('provider.batch.output');

    const plannedEvent = logger.events.find((e) => e.event === 'chunking.planned');
    expect(plannedEvent?.fields.batch_count).toBe(2);

    const batchCalledEvents = logger.events.filter((e) => e.event === 'provider.batch.called');
    expect(batchCalledEvents).toHaveLength(2);
    expect(batchCalledEvents[0]?.fields.batch_index).toBe(0);
    expect(batchCalledEvents[1]?.fields.batch_index).toBe(1);
  });

  it('per-batch schema_validation → partial review + notice; other batches publish', async () => {
    const snap = buildChunkableSnapshot(2);
    // Batch 0 succeeds; batch 1 fails schema_validation.
    const provider = new FakeProvider({
      script: [
        {
          kind: 'output',
          output: { findings: [makeFindingFixture({ path: 'src/file0.ts', line: 11 })] },
        },
        { kind: 'error', error: { kind: 'schema_validation', message: 'truncated' } },
      ],
    });
    const capturedNotices: Array<string | undefined> = [];
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      comment_cap: { per_pr: 10, per_file: 5 },
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 1,
      },
    });
    const deps = buildDeps({ provider, octokitSpy: spy, snapshot: snap, config });
    deps.hooks = {
      ...deps.hooks,
      runPublish: async (ranked, cfgArg, ctx, publisherDepsArg, _roundIntent, notice) => {
        capturedNotices.push(notice);
        const { publish: realPublish } = await import('@prisma-bot/github');
        return realPublish(ranked, cfgArg, ctx, publisherDepsArg);
      },
    };

    const result = await runPipeline(makePayload(), deps);

    expect(result.state).toBe('succeeded');
    expect(result.outcome?.kind).toBe('review_complete_chunked');
    if (result.outcome?.kind !== 'review_complete_chunked') return;
    expect(result.outcome.detail.failed_batches).toHaveLength(1);
    expect(result.outcome.detail.failed_batches[0]).toBe(1);
    // Finding from batch 0 was published.
    expect(spy.reviewCommentsCreate).toHaveLength(1);
    // Notice describes partial review.
    expect(capturedNotices[0]).toMatch(/section/i);
    expect(capturedNotices[0]).toMatch(/could not be analyzed/i);
  });

  it('all batches fail schema_validation → malformed_provider_output outcome', async () => {
    const snap = buildChunkableSnapshot(2);
    const provider = new FakeProvider({
      script: [
        { kind: 'error', error: { kind: 'schema_validation', message: 'bad output' } },
        { kind: 'error', error: { kind: 'schema_validation', message: 'bad output' } },
      ],
    });
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 1,
      },
    });
    const result = await runPipeline(
      makePayload(),
      buildDeps({ provider, octokitSpy: spy, snapshot: snap, config }),
    );

    expect(result.state).toBe('succeeded');
    expect(result.outcome?.kind).toBe('malformed_provider_output');
    // Summary check-run still published.
    expect(spy.checksCreate).toHaveLength(1);
    expect(spy.reviewCommentsCreate).toHaveLength(0);
  });

  it('auth error mid-loop → review_unavailable abort (re-throws)', async () => {
    const snap = buildChunkableSnapshot(2);
    // Batch 0 succeeds, batch 1 throws auth.
    const provider = new FakeProvider({
      script: [
        { kind: 'output', output: { findings: [] } },
        { kind: 'error', error: { kind: 'auth', message: 'invalid api key' } },
      ],
    });
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 1,
      },
    });

    await expect(
      runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy, snapshot: snap, config })),
    ).rejects.toBeInstanceOf(ProviderErrorThrowable);

    // review_unavailable summary was published before re-throw.
    expect(spy.checksCreate).toHaveLength(1);
  });

  it('transport error mid-loop → re-throws (job retries)', async () => {
    const snap = buildChunkableSnapshot(2);
    const provider = new FakeProvider({
      script: [
        { kind: 'output', output: { findings: [] } },
        { kind: 'error', error: { kind: 'transport', message: 'connection reset' } },
      ],
    });
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 1,
      },
    });

    await expect(
      runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy, snapshot: snap, config })),
    ).rejects.toBeInstanceOf(ProviderErrorThrowable);

    // No inline comments (job will be retried).
    expect(spy.reviewCommentsCreate).toHaveLength(0);
  });

  /**
   * Phase 4 AC4.1: GIVEN 3 batches with max_provider_calls_per_pr=2,
   * THEN exactly 2 batches are called, their findings publish, and the
   * notice lists the dropped file under "not reviewed" — the PR is NOT
   * skipped wholesale (contrast: pre-Phase-4 this produced outcome.kind==='oversized').
   */
  it('AC4.1: overCap → subset reviewed (not skipped); not-reviewed files in notice', async () => {
    const snap = buildChunkableSnapshot(3);
    // budget=1 → 3 batches; maxCalls=2 → overCap; kept = first 2 batches
    const provider = new FakeProvider({
      script: [
        // Call 1: first kept batch → success with finding for file0
        {
          kind: 'output',
          output: { findings: [makeFindingFixture({ path: 'src/file0.ts', line: 11 })] },
        },
        // Call 2: second kept batch → success with finding for file1
        {
          kind: 'output',
          output: { findings: [makeFindingFixture({ path: 'src/file1.ts', line: 11 })] },
        },
        // (third batch is dropped — file2 goes to notReviewed, no call made)
      ],
    });
    const capturedNotices: Array<string | undefined> = [];
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      comment_cap: { per_pr: 10, per_file: 5 },
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 2,
        call_token_budget: 1,
      },
    });
    const deps = buildDeps({ provider, octokitSpy: spy, snapshot: snap, config });
    deps.hooks = {
      ...deps.hooks,
      runPublish: async (ranked, cfgArg, ctx, publisherDepsArg, _roundIntent, notice) => {
        capturedNotices.push(notice);
        const { publish: realPublish } = await import('@prisma-bot/github');
        return realPublish(ranked, cfgArg, ctx, publisherDepsArg);
      },
    };

    const result = await runPipeline(makePayload(), deps);

    // PR is NOT aborted or skipped — outcome is review_complete_chunked.
    expect(result.state).toBe('succeeded');
    expect(result.outcome?.kind).toBe('review_complete_chunked');
    // Exactly 2 provider calls (the 2 kept batches).
    expect(provider.calls).toHaveLength(2);
    // Findings from both kept batches were published.
    expect(spy.reviewCommentsCreate).toHaveLength(2);
    // Notice lists the "not reviewed" file (src/file2.ts is in the dropped batch).
    expect(capturedNotices[0]).toMatch(/not reviewed/i);
    expect(capturedNotices[0]).toMatch(/max_provider_calls_per_pr/i);
    expect(capturedNotices[0]).toContain('src/file2.ts');
    // Outcome detail contains the not_reviewed_files.
    if (result.outcome?.kind !== 'review_complete_chunked') return;
    expect(result.outcome.detail.not_reviewed_files).toHaveLength(1);
    expect(result.outcome.detail.not_reviewed_files[0]?.path).toBe('src/file2.ts');
  });

  /**
   * Phase 4 AC4.2: priority ordering is deterministic — same input always
   * produces the same kept set.
   */
  it('AC4.2: subset selection is deterministic — same input → same kept set', async () => {
    // Run the same overCap scenario twice and verify the same files are reviewed.
    const snap = buildChunkableSnapshot(3);
    const makeScript = () => [
      {
        kind: 'output' as const,
        output: { findings: [makeFindingFixture({ path: 'src/file0.ts', line: 11 })] },
      },
      {
        kind: 'output' as const,
        output: { findings: [makeFindingFixture({ path: 'src/file1.ts', line: 11 })] },
      },
    ];
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      comment_cap: { per_pr: 10, per_file: 5 },
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 2,
        call_token_budget: 1,
      },
    });

    const spy1 = buildOctokitSpy();
    const r1 = await runPipeline(
      makePayload(),
      buildDeps({
        provider: new FakeProvider({ script: makeScript() }),
        octokitSpy: spy1,
        snapshot: snap,
        config,
      }),
    );

    const spy2 = buildOctokitSpy();
    const r2 = await runPipeline(
      makePayload(),
      buildDeps({
        provider: new FakeProvider({ script: makeScript() }),
        octokitSpy: spy2,
        snapshot: snap,
        config,
      }),
    );

    expect(r1.outcome?.kind).toBe('review_complete_chunked');
    expect(r2.outcome?.kind).toBe('review_complete_chunked');
    if (r1.outcome?.kind !== 'review_complete_chunked') return;
    if (r2.outcome?.kind !== 'review_complete_chunked') return;
    // Same not_reviewed_files in both runs.
    const nr1 = r1.outcome.detail.not_reviewed_files.map((f) => f.path).sort();
    const nr2 = r2.outcome.detail.not_reviewed_files.map((f) => f.path).sort();
    expect(nr1).toEqual(nr2);
  });

  /**
   * Phase 4 AC4.3: over_budget guard trip mid-loop → batch split+retried;
   * on exhaustion its files go to notReviewedFiles; PR publishes other
   * findings and does NOT abort.
   *
   * Setup: 2-file snapshot (2 batches with budget=1 so each file gets its own
   * batch). The provider for batch 0 throws over_budget every time;
   * batch 1 succeeds with a finding for file1.
   * After max_truncation_retries=2 exhausted for batch 0 (single-file/single-hunk
   * cannot split further), file0 goes to notReviewedFiles and the PR still
   * publishes file1's finding.
   */
  it('AC4.3: over_budget guard trip mid-loop → degrade not abort; PR publishes surviving findings', async () => {
    const snap = buildChunkableSnapshot(2);
    // The over_budget error is thrown directly as if the per-call guard fired.
    // Since the batch has 1 file/1 hunk, it cannot split → after 1 attempt
    // (depth 0 >= maxRetries? No, retryDepth=0 < maxRetries=2 but single-file
    // single-hunk means no split is possible, so it goes to notReviewedFiles).
    // For a 1-file/1-hunk batch: the first over_budget → no split → record immediately.
    const provider = new FakeProvider({
      script: [
        // Call 1: file0 → over_budget (single file/hunk → cannot split → notReviewed)
        {
          kind: 'error',
          error: {
            kind: 'over_budget',
            estimated_tokens: 200000,
            hard_cap_in: 100000,
            message: 'request exceeds per-call token budget',
          },
        },
        // Call 2: file1 → success
        {
          kind: 'output',
          output: { findings: [makeFindingFixture({ path: 'src/file1.ts', line: 11 })] },
        },
      ],
    });
    const capturedNotices: Array<string | undefined> = [];
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      comment_cap: { per_pr: 10, per_file: 5 },
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 1,
        max_truncation_retries: 2,
      },
    });
    const deps = buildDeps({ provider, octokitSpy: spy, snapshot: snap, config });
    deps.hooks = {
      ...deps.hooks,
      runPublish: async (ranked, cfgArg, ctx, publisherDepsArg, _roundIntent, notice) => {
        capturedNotices.push(notice);
        const { publish: realPublish } = await import('@prisma-bot/github');
        return realPublish(ranked, cfgArg, ctx, publisherDepsArg);
      },
    };

    const result = await runPipeline(makePayload(), deps);

    // PR is NOT aborted.
    expect(result.state).toBe('succeeded');
    // file1's finding was published.
    expect(spy.reviewCommentsCreate).toHaveLength(1);
    expect(spy.reviewCommentsCreate[0]?.path).toBe('src/file1.ts');
    // outcome is review_complete_chunked, not aborted
    expect(result.outcome?.kind).toBe('review_complete_chunked');
    if (result.outcome?.kind !== 'review_complete_chunked') return;
    // file0 went to not_reviewed_files.
    expect(result.outcome.detail.not_reviewed_files.some((f) => f.path === 'src/file0.ts')).toBe(
      true,
    );
    // Notice mentions the not-reviewed file.
    expect(capturedNotices[0]).toMatch(/not reviewed/i);
    expect(capturedNotices[0]).toContain('src/file0.ts');
  });

  /**
   * Phase 4 AC4.4: genuine auth error STILL aborts with review_unavailable.
   * This test is separate from the existing auth mid-loop test but explicitly
   * verifies that auth is not over-broadened by the over_budget degrade path.
   */
  it('AC4.4: genuine auth error still aborts with review_unavailable (not over-broadened)', async () => {
    const snap = buildChunkableSnapshot(2);
    const provider = new FakeProvider({
      script: [
        { kind: 'output', output: { findings: [] } },
        { kind: 'error', error: { kind: 'auth', message: 'invalid api key' } },
      ],
    });
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 1,
      },
    });

    // Must reject (auth aborts the PR).
    await expect(
      runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy, snapshot: snap, config })),
    ).rejects.toBeInstanceOf(ProviderErrorThrowable);
    // review_unavailable summary was published before re-throw.
    expect(spy.checksCreate).toHaveLength(1);
  });

  /**
   * Phase 4 AC4.5: a PR where every batch fits under both hard_cap_in and
   * maxCalls → notReviewedFiles is empty and the notice omits the "not reviewed" line.
   */
  it('AC4.5: happy-path PR → not_reviewed_files empty; notice omits "not reviewed" line', async () => {
    const snap = buildChunkableSnapshot(2);
    const provider = new FakeProvider({
      script: [
        {
          kind: 'output',
          output: { findings: [makeFindingFixture({ path: 'src/file0.ts', line: 11 })] },
        },
        { kind: 'output', output: { findings: [] } },
      ],
    });
    const capturedNotices: Array<string | undefined> = [];
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      comment_cap: { per_pr: 10, per_file: 5 },
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6, // well above the 2-batch plan
        call_token_budget: 1,
      },
    });
    const deps = buildDeps({ provider, octokitSpy: spy, snapshot: snap, config });
    deps.hooks = {
      ...deps.hooks,
      runPublish: async (ranked, cfgArg, ctx, publisherDepsArg, _roundIntent, notice) => {
        capturedNotices.push(notice);
        const { publish: realPublish } = await import('@prisma-bot/github');
        return realPublish(ranked, cfgArg, ctx, publisherDepsArg);
      },
    };

    const result = await runPipeline(makePayload(), deps);

    expect(result.state).toBe('succeeded');
    expect(result.outcome?.kind).toBe('review_complete_chunked');
    if (result.outcome?.kind !== 'review_complete_chunked') return;
    // No not-reviewed files (all batches fit within cap).
    expect(result.outcome.detail.not_reviewed_files).toHaveLength(0);
    // Notice does NOT contain the "not reviewed" section.
    expect(capturedNotices[0]).not.toMatch(/not reviewed \(PR exceeds/i);
  });

  it('cross-batch deduplication: same finding from 2 batches → dedupe to 1 inline comment', async () => {
    // Both batches return the same (path, message) finding → same dedupe_key.
    // The validator + planner should collapse them to one inline comment.
    const snap = buildChunkableSnapshot(2);
    const provider = new FakeProvider({
      script: [
        {
          kind: 'output',
          output: {
            findings: [
              makeFindingFixture({ path: 'src/file0.ts', line: 11, message: 'dupe issue' }),
            ],
          },
        },
        {
          kind: 'output',
          output: {
            findings: [
              makeFindingFixture({ path: 'src/file0.ts', line: 11, message: 'dupe issue' }),
            ],
          },
        },
      ],
    });
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      comment_cap: { per_pr: 10, per_file: 5 },
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 1,
      },
    });
    const result = await runPipeline(
      makePayload(),
      buildDeps({ provider, octokitSpy: spy, snapshot: snap, config }),
    );

    expect(result.state).toBe('succeeded');
    // The duplicate finding should be collapsed by within-run dedupe → at most 1 inline comment.
    expect(spy.reviewCommentsCreate).toHaveLength(1);
  });

  it('review_complete_chunked: chunked notice passed to publish', async () => {
    const snap = buildChunkableSnapshot(2);
    const provider = new FakeProvider({
      script: [
        { kind: 'output', output: { findings: [] } },
        { kind: 'output', output: { findings: [] } },
      ],
    });
    const capturedNotices: Array<string | undefined> = [];
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 1,
      },
    });
    const deps = buildDeps({ provider, octokitSpy: spy, snapshot: snap, config });
    deps.hooks = {
      ...deps.hooks,
      runPublish: async (ranked, cfgArg, ctx, publisherDepsArg, _roundIntent, notice) => {
        capturedNotices.push(notice);
        const { publish: realPublish } = await import('@prisma-bot/github');
        return realPublish(ranked, cfgArg, ctx, publisherDepsArg);
      },
    };

    await runPipeline(makePayload(), deps);
    expect(capturedNotices[0]).toMatch(/section/i);
    expect(capturedNotices[0]).toMatch(/large PR/i);
  });

  // -------------------------------------------------------------------------
  // Phase 1: output_truncated split-and-retry (chunking-stability-spec.md)
  // -------------------------------------------------------------------------

  /**
   * AC1.1: GIVEN a 3-file batch, WHEN the provider returns output_truncated,
   * THEN the orchestrator splits into retry-batches, re-calls, and merges
   * findings from both — zero findings dropped if the halves succeed.
   *
   * Setup: call_token_budget=60000 so all 3 files land in ONE initial batch.
   */
  it('AC1.1: 3-file batch truncates → splits into halves → merges findings, none dropped', async () => {
    const snap = buildChunkableSnapshot(3);
    // Batch 0 (all 3 files): truncates → splits into [file0,file1] and [file2].
    // Retry [file0,file1]: succeeds with finding for file0.
    // Retry [file2]: succeeds with finding for file2.
    // Total provider calls: 3 (1 initial + 2 retry halves).
    const provider = new FakeProvider({
      script: [
        // Call 1: initial 3-file batch → output_truncated
        {
          kind: 'error',
          error: { kind: 'output_truncated', message: 'truncated', requested_max_tokens: 4096 },
        },
        // Call 2: left half [file0, file1] → success with file0 finding
        {
          kind: 'output',
          output: { findings: [makeFindingFixture({ path: 'src/file0.ts', line: 11 })] },
        },
        // Call 3: right half [file2] → success with file2 finding
        {
          kind: 'output',
          output: { findings: [makeFindingFixture({ path: 'src/file2.ts', line: 11 })] },
        },
      ],
    });
    const spy = buildOctokitSpy();
    // Use a large token budget so all 3 files land in ONE batch initially.
    // Each file has 1100 lines × ~4 chars/token ≈ 4400 tokens; all 3 fit in 60000.
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      comment_cap: { per_pr: 10, per_file: 5 },
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 60000,
        max_truncation_retries: 2,
      },
    });
    const result = await runPipeline(
      makePayload(),
      buildDeps({ provider, octokitSpy: spy, snapshot: snap, config }),
    );

    expect(result.state).toBe('succeeded');
    // Provider was called 3 times: once for the initial batch, twice for the halves.
    expect(provider.calls).toHaveLength(3);
    // 2 findings published (one per file).
    expect(spy.reviewCommentsCreate).toHaveLength(2);
    expect(result.outcome?.kind).toBe('review_complete_chunked');
    if (result.outcome?.kind !== 'review_complete_chunked') return;
    // No truncated files in the detail (halves succeeded).
    expect(result.outcome.detail.truncated_files).toHaveLength(0);
  });

  /**
   * AC1.3: GIVEN a single 1-file/1-hunk batch that truncates, WHEN retries
   * are exhausted, THEN the PR still publishes with surviving findings and
   * the check-run notice contains "not fully reviewed (output truncated): <path>".
   * The PR is NOT aborted.
   */
  it('AC1.3: single 1-file/1-hunk truncation exhausted → PR publishes surviving findings + truncated notice', async () => {
    // 2-file snapshot: file0 succeeds, file1 truncates all retries.
    // With max_truncation_retries=2, file1's batch is tried once and
    // cannot split (1 file / 1 hunk) → recorded as truncated.
    const snap = buildChunkableSnapshot(2);
    const provider = new FakeProvider({
      script: [
        // Call 1: file0 batch → success
        {
          kind: 'output',
          output: { findings: [makeFindingFixture({ path: 'src/file0.ts', line: 11 })] },
        },
        // Call 2: file1 batch → output_truncated (1 file, 1 hunk → cannot split)
        {
          kind: 'error',
          error: { kind: 'output_truncated', message: 'truncated', requested_max_tokens: 4096 },
        },
      ],
    });
    const capturedNotices: Array<string | undefined> = [];
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      comment_cap: { per_pr: 10, per_file: 5 },
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 1,
        max_truncation_retries: 2,
      },
    });
    const deps = buildDeps({ provider, octokitSpy: spy, snapshot: snap, config });
    deps.hooks = {
      ...deps.hooks,
      runPublish: async (ranked, cfgArg, ctx, publisherDepsArg, _roundIntent, notice) => {
        capturedNotices.push(notice);
        const { publish: realPublish } = await import('@prisma-bot/github');
        return realPublish(ranked, cfgArg, ctx, publisherDepsArg);
      },
    };

    const result = await runPipeline(makePayload(), deps);

    // PR is NOT aborted — state is still succeeded.
    expect(result.state).toBe('succeeded');
    // File0's finding was published.
    expect(spy.reviewCommentsCreate).toHaveLength(1);
    expect(spy.reviewCommentsCreate[0]?.path).toBe('src/file0.ts');
    // The check-run notice mentions the truncated file.
    expect(capturedNotices[0]).toMatch(/not fully reviewed \(output truncated\)/i);
    expect(capturedNotices[0]).toContain('src/file1.ts');
    // Outcome detail records the truncated file.
    expect(result.outcome?.kind).toBe('review_complete_chunked');
    if (result.outcome?.kind !== 'review_complete_chunked') return;
    expect(result.outcome.detail.truncated_files).toContain('src/file1.ts');
  });

  /**
   * AC1.4: GIVEN `max_truncation_retries=2`, WHEN a 2-file batch truncates,
   * splits, and each half also truncates (depth=1 < 2), THEN the halves are
   * called once each (depth=1 has not exhausted the cap), each 1-file half
   * records as truncated since it cannot be split further.
   * Total: 3 calls. Both files truncated. PR does NOT abort. Global cap respected.
   *
   * Setup: call_token_budget=60000 → both files land in ONE initial batch.
   *   Call 1: initial [file0, file1] (depth=0) → truncated → splits
   *   Call 2: [file0] (depth=1 < maxRetries=2) → truncated → 1-file → recorded
   *   Call 3: [file1] (depth=1 < maxRetries=2) → truncated → 1-file → recorded
   * Total: 3 calls, both files truncated.
   */
  it('AC1.4: max_truncation_retries=2, 2-file batch truncates + halves truncate → 3 calls, both files truncated, no abort', async () => {
    const snap = buildChunkableSnapshot(2);
    const provider = new FakeProvider({
      script: [
        // Call 1: initial 2-file batch → truncated → splits into [file0] and [file1]
        {
          kind: 'error',
          error: { kind: 'output_truncated', message: 'truncated', requested_max_tokens: 4096 },
        },
        // Call 2: [file0] half (depth=1 < max_truncation_retries=2) → truncated → 1-file → recorded
        {
          kind: 'error',
          error: { kind: 'output_truncated', message: 'truncated', requested_max_tokens: 4096 },
        },
        // Call 3: [file1] half (depth=1 < max_truncation_retries=2) → truncated → 1-file → recorded
        {
          kind: 'error',
          error: { kind: 'output_truncated', message: 'truncated', requested_max_tokens: 4096 },
        },
      ],
    });
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        // Large budget so 2 files land in one initial batch.
        call_token_budget: 60000,
        max_truncation_retries: 2,
      },
    });

    const result = await runPipeline(
      makePayload(),
      buildDeps({ provider, octokitSpy: spy, snapshot: snap, config }),
    );

    // PR is NOT aborted.
    expect(result.state).toBe('succeeded');
    // 3 provider calls: 1 initial + 2 retry halves.
    expect(provider.calls).toHaveLength(3);
    // Both files end up truncated.
    expect(result.outcome?.kind).toBe('review_complete_chunked');
    if (result.outcome?.kind !== 'review_complete_chunked') return;
    expect(result.outcome.detail.truncated_files).toContain('src/file0.ts');
    expect(result.outcome.detail.truncated_files).toContain('src/file1.ts');
    // Global cap: 6 * (2+1) = 18; we used only 3 — well within cap.
    expect(provider.calls.length).toBeLessThanOrEqual(
      6 * (2 + 1), // max_provider_calls_per_pr * (max_truncation_retries + 1)
    );
  });

  /**
   * AC1.5 (regression): GIVEN a happy-path PR with default config, WHEN
   * reviewed, THEN no split occurs, no truncated files, and
   * the PR publishes normally (byte-identical behavior for non-truncating PRs).
   */
  it('AC1.5: happy-path PR (no truncation) produces normal review_complete_chunked without truncated files', async () => {
    const snap = buildChunkableSnapshot(2);
    const provider = new FakeProvider({
      script: [
        {
          kind: 'output',
          output: { findings: [makeFindingFixture({ path: 'src/file0.ts', line: 11 })] },
        },
        { kind: 'output', output: { findings: [] } },
      ],
    });
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      comment_cap: { per_pr: 10, per_file: 5 },
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 1,
        // Default max_truncation_retries=2, reserved_output_tokens=4096
      },
    });

    const result = await runPipeline(
      makePayload(),
      buildDeps({ provider, octokitSpy: spy, snapshot: snap, config }),
    );

    expect(result.state).toBe('succeeded');
    // Exactly 2 provider calls (no retries).
    expect(provider.calls).toHaveLength(2);
    expect(result.outcome?.kind).toBe('review_complete_chunked');
    if (result.outcome?.kind !== 'review_complete_chunked') return;
    // No truncated files.
    expect(result.outcome.detail.truncated_files).toHaveLength(0);
    // Finding published normally.
    expect(spy.reviewCommentsCreate).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Config DX: buildProviderInput request_shaping threading (spec § 5.4, R1)
// ---------------------------------------------------------------------------

describe('buildProviderInput: request_shaping threading through the orchestrator', () => {
  const repoLookupFn: RepoLookup = async () => REPO_ID;

  /** Build an octokit that returns a single changed file. */
  const buildSimpleOctokit = (): OctokitLike =>
    ({
      rest: {
        pulls: {
          get: async () => ({
            data: {
              number: 7,
              head: { sha: 'a'.repeat(40), ref: 'feature' },
              base: { sha: 'b'.repeat(40), ref: 'main' },
            },
          }),
          listFiles: async () => ({
            data: [
              {
                filename: 'src/app.ts',
                status: 'modified',
                additions: 5,
                deletions: 0,
                patch: '@@ -1,3 +1,8 @@\n+const x = 1;\n',
              },
            ],
          }),
        },
        repos: {
          getContent: async () => ({ data: {} }),
        },
        checks: {
          create: async () => ({ data: { id: 1 } }),
          update: async () => ({ data: { id: 1 } }),
          listForRef: async () => ({ data: { check_runs: [] } }),
        },
        issues: {
          listComments: async () => ({ data: [] }),
        },
        // biome-ignore lint/suspicious/noExplicitAny: test stub
      } as any,
      graphql: async () => ({}),
      paginate: async <T>(_method: unknown, _params: unknown, mapFn: unknown) => {
        // For the paginate call used by check runs listing, return empty
        if (typeof mapFn === 'function') {
          const result = await (mapFn as (data: unknown) => T)({ check_runs: [] });
          return result as T[];
        }
        return [];
      },
    }) as unknown as OctokitLike;

  /** Build a pipeline that captures the first provider call's request_shaping. */
  const runAndCapture = async (
    config: RepoConfig,
    providerName = 'fake',
  ): Promise<ProviderReviewInput | undefined> => {
    let captured: ProviderReviewInput | undefined;
    const provider = new FakeProvider({
      name: providerName,
      script: [{ kind: 'output', output: { findings: [] } }],
    });
    // Wrap to capture the input
    const originalReview = provider.review.bind(provider);
    provider.review = async (input) => {
      captured = input;
      return originalReview(input);
    };

    const octokit = buildSimpleOctokit();
    const deps: OrchestratorDeps = {
      installationAuth: {} as InstallationAuth,
      provider,
      config,
      repoLookup: repoLookupFn,
      octokit,
      logger: { emit: () => {} },
    };
    await runPipeline(makePayload(), deps);
    return captured;
  };

  it('zero-config: request_shaping is absent when no model/generation/provider_options set (AS-11)', async () => {
    const config = RepoConfigSchema.parse({ mode: 'summary-plus-inline' });
    const captured = await runAndCapture(config);
    expect(captured?.request_shaping).toBeUndefined();
  });

  it('threads each hunk diff body into the provider input so the model reviews real code', async () => {
    // Regression guard: the orchestrator must pass a `hunkContent` resolver to
    // the prefilter. Without it the provider receives empty hunk bodies and
    // reviews on path + heuristics alone (anchoring everything to line 1).
    const config = RepoConfigSchema.parse({ mode: 'summary-plus-inline' });
    const captured = await runAndCapture(config);
    const hunk = captured?.files[0]?.hunks[0];
    // buildSimpleOctokit feeds patch `@@ -1,3 +1,8 @@\n+const x = 1;\n`.
    expect(hunk?.line_start).toBe(1);
    expect(hunk?.content).toContain('+const x = 1;');
  });

  it('slug model → request_shaping.model is bare name (no provider prefix) (AS-2)', async () => {
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      model: 'fake/gpt-test',
    });
    const captured = await runAndCapture(config, 'fake');
    expect(captured?.request_shaping?.model).toBe('gpt-test');
  });

  it('generation.seed → request_shaping.deterministic_seed (single seed source, spec § 5.4)', async () => {
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      generation: { seed: 42, max_output_tokens: 8192 },
    });
    const captured = await runAndCapture(config, 'fake');
    expect(captured?.request_shaping?.deterministic_seed).toBe(42);
    expect(captured?.request_shaping?.generation?.max_output_tokens).toBe(8192);
  });

  it('provider_options narrowed to active provider (AS-10, G9)', async () => {
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      provider_options: {
        fake: { custom_knob: 'value_for_fake' },
        openai: { reasoning_effort: 'low' },
      },
    });
    // Active provider is "fake"
    const captured = await runAndCapture(config, 'fake');
    // Only the "fake" bag should be present
    expect(captured?.request_shaping?.provider_options?.custom_knob).toBe('value_for_fake');
    // "openai" bag must NOT leak in
    expect(captured?.request_shaping?.provider_options?.reasoning_effort).toBeUndefined();
  });

  // R1: slug provider ≠ active provider → mismatch note + model falls back
  it('R1: slug provider ≠ active provider → config note emitted, model not forwarded', async () => {
    const capturedNotes: string[][] = [];
    const provider = new FakeProvider({
      name: 'fake', // active provider is "fake"
      script: [{ kind: 'output', output: { findings: [] } }],
    });

    let captured: ProviderReviewInput | undefined;
    const originalReview = provider.review.bind(provider);
    provider.review = async (input) => {
      captured = input;
      return originalReview(input);
    };

    const octokit = buildSimpleOctokit();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      // slug names "anthropic" but active provider is "fake"
      model: 'anthropic/claude-sonnet-4.5',
    });

    const deps: OrchestratorDeps = {
      installationAuth: {} as InstallationAuth,
      provider,
      config,
      repoLookup: repoLookupFn,
      octokit,
      logger: { emit: () => {} },
    };
    const result = await runPipeline(makePayload(), deps);

    // Model should NOT be forwarded (it's a foreign provider's model name)
    expect(captured?.request_shaping?.model).toBeUndefined();

    // A config note should mention the mismatch
    const notes = result.config_notes ?? [];
    expect(notes.some((n) => n.includes('anthropic') && n.includes('fake'))).toBe(true);
  });

  // R1: slug provider matches active → model forwarded normally
  it('R1: slug provider = active provider → model forwarded (no mismatch note)', async () => {
    const provider = new FakeProvider({
      name: 'fake',
      script: [{ kind: 'output', output: { findings: [] } }],
    });

    let captured: ProviderReviewInput | undefined;
    const originalReview = provider.review.bind(provider);
    provider.review = async (input) => {
      captured = input;
      return originalReview(input);
    };

    const octokit = buildSimpleOctokit();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      model: 'fake/test-model-v2',
    });

    const deps: OrchestratorDeps = {
      installationAuth: {} as InstallationAuth,
      provider,
      config,
      repoLookup: repoLookupFn,
      octokit,
      logger: { emit: () => {} },
    };
    const result = await runPipeline(makePayload(), deps);

    // Model should be forwarded as bare name
    expect(captured?.request_shaping?.model).toBe('test-model-v2');

    // No mismatch config note
    const notes = result.config_notes ?? [];
    const hasMismatchNote = notes.some(
      (n) => n.includes('names provider') && n.includes('but this deployment'),
    );
    expect(hasMismatchNote).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// no_findings + reasoning model hint (Change 2)
// ---------------------------------------------------------------------------

describe('runPipeline — no_findings reasoning model hint', () => {
  // Helper: build a RepoConfig with the given model slug
  const cfgWithModel = (model: string): RepoConfig =>
    RepoConfigSchema.parse({ mode: 'summary-plus-inline', model });

  it('no_findings + reasoning model (gpt-5.4-nano) + provider called -> hint emitted', async () => {
    // Provider returns empty findings on a non-trivial diff.
    const provider = new FakeProvider({
      script: [{ kind: 'output', output: { findings: [] } }],
    });
    const spy = buildOctokitSpy();
    const result = await runPipeline(
      makePayload(),
      buildDeps({
        provider,
        octokitSpy: spy,
        config: cfgWithModel('openai/gpt-5.4-nano'),
      }),
    );
    expect(result.state).toBe('succeeded');
    expect(result.outcome?.kind).toBe('no_findings');
    const outcome = result.outcome as { kind: 'no_findings'; detail?: NoFindingsReasoningHint };
    expect(outcome.detail?.reasoning_model_empty).toBe(true);
    expect(outcome.detail?.model).toBe('gpt-5.4-nano');
  });

  it('no_findings + reasoning model (o3) + provider called -> hint emitted', async () => {
    const provider = new FakeProvider({
      script: [{ kind: 'output', output: { findings: [] } }],
    });
    const spy = buildOctokitSpy();
    const result = await runPipeline(
      makePayload(),
      buildDeps({
        provider,
        octokitSpy: spy,
        config: cfgWithModel('openai/o3'),
      }),
    );
    expect(result.outcome?.kind).toBe('no_findings');
    const outcome = result.outcome as { kind: 'no_findings'; detail?: NoFindingsReasoningHint };
    expect(outcome.detail?.reasoning_model_empty).toBe(true);
    expect(outcome.detail?.model).toBe('o3');
  });

  it('no_findings + classic model (gpt-4o) + provider called -> NO hint', async () => {
    const provider = new FakeProvider({
      script: [{ kind: 'output', output: { findings: [] } }],
    });
    const spy = buildOctokitSpy();
    const result = await runPipeline(
      makePayload(),
      buildDeps({
        provider,
        octokitSpy: spy,
        config: cfgWithModel('openai/gpt-4o'),
      }),
    );
    // When the provider returns findings (none here) and the model is classic,
    // the pipeline proceeds to the validator/ranker/publisher path normally.
    // Outcome is review_complete (no findings -> 0 published, still complete).
    expect(result.state).toBe('succeeded');
    // Classic model with 0 findings -> review_complete (not no_findings hint path)
    expect(result.outcome?.kind).toBe('review_complete');
  });

  it('no_findings prefilter-excluded path (provider not called) -> NO hint, no detail', async () => {
    // Use a snapshot with NO files (all filtered), so the orchestrator hits
    // the prefilter.files.length === 0 branch and never calls the provider.
    const emptySnapshot = buildSnapshot({ files: [], total_changed_lines: 0 });
    const provider = new FakeProvider({ script: [] });
    const spy = buildOctokitSpy();
    const result = await runPipeline(
      makePayload(),
      buildDeps({
        provider,
        octokitSpy: spy,
        snapshot: emptySnapshot,
        config: cfgWithModel('openai/gpt-5.4-nano'),
      }),
    );
    // Provider was NOT called
    expect(provider.calls).toHaveLength(0);
    // The outcome is no_findings but without the reasoning hint
    expect(result.outcome?.kind).toBe('no_findings');
    const outcome = result.outcome as { kind: 'no_findings'; detail?: NoFindingsReasoningHint };
    expect(outcome.detail).toBeUndefined();
  });

  it('no_findings + reasoning model: outcome detail carries model name for worker notice', async () => {
    const provider = new FakeProvider({
      script: [{ kind: 'output', output: { findings: [] } }],
    });
    const spy = buildOctokitSpy();
    const result = await runPipeline(
      makePayload(),
      buildDeps({
        provider,
        octokitSpy: spy,
        config: cfgWithModel('openai/gpt-5.4-nano'),
      }),
    );
    // Outcome detail carries the model name so the worker can compose
    // the model-aware reply without re-parsing config.
    expect(result.outcome?.kind).toBe('no_findings');
    const outcome = result.outcome as { kind: 'no_findings'; detail?: NoFindingsReasoningHint };
    expect(outcome.detail?.model).toBe('gpt-5.4-nano');
    // Check-run was still published (summary-only path).
    expect(spy.checksCreate).toHaveLength(1);
    expect(spy.checksUpdate).toHaveLength(1);
  });
});

describe('runPipeline — positive feedback + clean-review threading (S7)', () => {
  const cfgWithPositiveFeedback = (maxItems: number): RepoConfig =>
    RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      positive_feedback: { enabled: true, max_items: maxItems },
    });

  it('positive_feedback disabled (default config): providerInput carries no positive_feedback key', async () => {
    const provider = new FakeProvider({ script: [{ kind: 'output', output: { findings: [] } }] });
    const spy = buildOctokitSpy();
    await runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy }));
    expect(provider.calls[0]?.positive_feedback).toBeUndefined();
  });

  it('positive_feedback enabled: single-call providerInput carries { max_items }', async () => {
    const provider = new FakeProvider({ script: [{ kind: 'output', output: { findings: [] } }] });
    const spy = buildOctokitSpy();
    const config = cfgWithPositiveFeedback(2);
    await runPipeline(makePayload(), buildDeps({ provider, octokitSpy: spy, config }));
    expect(provider.calls[0]?.positive_feedback).toEqual({ max_items: 2 });
  });

  it('positive_feedback enabled: every chunked batch providerInput carries { max_items }', async () => {
    const snap = buildChunkableSnapshot(2);
    const provider = new FakeProvider({
      script: [
        { kind: 'output', output: { findings: [] } },
        { kind: 'output', output: { findings: [] } },
      ],
    });
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      positive_feedback: { enabled: true, max_items: 4 },
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 1,
      },
    });
    await runPipeline(
      makePayload(),
      buildDeps({ provider, octokitSpy: spy, snapshot: snap, config }),
    );
    expect(provider.calls).toHaveLength(2);
    for (const call of provider.calls) {
      expect(call.positive_feedback).toEqual({ max_items: 4 });
    }
  });

  it('single-call clean review (0 provider findings, 0 validated findings): extras.clean_review is true and highlights are threaded', async () => {
    const provider = new FakeProvider({
      script: [
        {
          kind: 'output',
          output: {
            findings: [],
            highlights: [{ message: 'Clear naming', rationale: 'Improves readability.' }],
          },
        },
      ],
    });
    const spy = buildOctokitSpy();
    const config = cfgWithPositiveFeedback(3);
    const capturedExtras: Array<PublicationExtras | undefined> = [];
    const deps = buildDeps({ provider, octokitSpy: spy, config });
    deps.hooks = {
      ...deps.hooks,
      runPublish: async (ranked, cfgArg, ctx, publisherDepsArg, roundIntent, notice, extras) => {
        capturedExtras.push(extras);
        const { publish: realPublish } = await import('@prisma-bot/github');
        return realPublish(ranked, cfgArg, ctx, publisherDepsArg, roundIntent, notice, extras);
      },
    };

    await runPipeline(makePayload(), deps);
    expect(capturedExtras[0]?.clean_review).toBe(true);
    expect(capturedExtras[0]?.highlights).toHaveLength(1);
  });

  it('single-call dirty review (findings present): extras.clean_review is false', async () => {
    const provider = new FakeProvider({
      script: [{ kind: 'output', output: validOutputForExampleFile() }],
    });
    const spy = buildOctokitSpy();
    const capturedExtras: Array<PublicationExtras | undefined> = [];
    const deps = buildDeps({ provider, octokitSpy: spy });
    deps.hooks = {
      ...deps.hooks,
      runPublish: async (ranked, cfgArg, ctx, publisherDepsArg, roundIntent, notice, extras) => {
        capturedExtras.push(extras);
        const { publish: realPublish } = await import('@prisma-bot/github');
        return realPublish(ranked, cfgArg, ctx, publisherDepsArg, roundIntent, notice, extras);
      },
    };

    await runPipeline(makePayload(), deps);
    expect(capturedExtras[0]?.clean_review).toBe(false);
  });

  it('chunked review with all batches succeeding and zero findings: extras.clean_review is true', async () => {
    const snap = buildChunkableSnapshot(2);
    const provider = new FakeProvider({
      script: [
        { kind: 'output', output: { findings: [] } },
        { kind: 'output', output: { findings: [] } },
      ],
    });
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 1,
      },
    });
    const capturedExtras: Array<PublicationExtras | undefined> = [];
    const deps = buildDeps({ provider, octokitSpy: spy, snapshot: snap, config });
    deps.hooks = {
      ...deps.hooks,
      runPublish: async (ranked, cfgArg, ctx, publisherDepsArg, roundIntent, notice, extras) => {
        capturedExtras.push(extras);
        const { publish: realPublish } = await import('@prisma-bot/github');
        return realPublish(ranked, cfgArg, ctx, publisherDepsArg, roundIntent, notice, extras);
      },
    };

    await runPipeline(makePayload(), deps);
    expect(capturedExtras[0]?.clean_review).toBe(true);
  });

  it('chunked review with a partial (failed) batch and zero surviving findings: extras.clean_review is false (a partial review is never clean)', async () => {
    const snap = buildChunkableSnapshot(2);
    const provider = new FakeProvider({
      script: [
        { kind: 'output', output: { findings: [] } },
        { kind: 'error', error: { kind: 'schema_validation', message: 'truncated' } },
      ],
    });
    const spy = buildOctokitSpy();
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
      chunking: {
        enabled: true,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 1,
      },
    });
    const capturedExtras: Array<PublicationExtras | undefined> = [];
    const deps = buildDeps({ provider, octokitSpy: spy, snapshot: snap, config });
    deps.hooks = {
      ...deps.hooks,
      runPublish: async (ranked, cfgArg, ctx, publisherDepsArg, roundIntent, notice, extras) => {
        capturedExtras.push(extras);
        const { publish: realPublish } = await import('@prisma-bot/github');
        return realPublish(ranked, cfgArg, ctx, publisherDepsArg, roundIntent, notice, extras);
      },
    };

    await runPipeline(makePayload(), deps);
    expect(capturedExtras[0]?.clean_review).toBe(false);
  });

  it('publishSummaryOnly (oversized) never asserts clean: runPublish receives no extras', async () => {
    const provider = new FakeProvider({ script: [] });
    // 300 files → oversized short-circuit; provider is never called.
    const oversizedSnap: PrSnapshot = {
      installation_id: 100,
      repository_id: 200,
      pull_request_number: 7,
      head_sha: 'a'.repeat(40),
      base_sha: 'b'.repeat(40),
      default_branch: 'main',
      total_changed_lines: 1200,
      files: Array.from({ length: 300 }, (_, i) => ({
        path: `src/f${i}.ts`,
        status: 'modified' as const,
        additions: 4,
        deletions: 0,
        hunks: [{ new_start: 1, new_lines: 4, old_start: 1, old_lines: 0 }],
        is_binary: false,
      })),
    };
    const spy = buildOctokitSpy();
    const capturedExtras: Array<PublicationExtras | undefined> = [];
    const deps = buildDeps({ provider, octokitSpy: spy, snapshot: oversizedSnap });
    deps.hooks = {
      ...deps.hooks,
      runPublish: async (ranked, cfgArg, ctx, publisherDepsArg, roundIntent, notice, extras) => {
        capturedExtras.push(extras);
        const { publish: realPublish } = await import('@prisma-bot/github');
        return realPublish(ranked, cfgArg, ctx, publisherDepsArg, roundIntent, notice, extras);
      },
    };

    const result = await runPipeline(makePayload(), deps);
    expect(result.outcome?.kind).toBe('oversized');
    expect(capturedExtras[0]).toBeUndefined();
  });
});
