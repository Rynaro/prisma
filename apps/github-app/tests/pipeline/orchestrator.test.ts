import type { InstallationAuth, OctokitLike } from '@prisma-bot/github';
import { FakeProvider, makeFindingFixture } from '@prisma-bot/provider-fake';
import {
  type JobPayload,
  type PrSnapshot,
  ProviderErrorThrowable,
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

  it('overCap → oversized outcome with notice describing batch count', async () => {
    const snap = buildChunkableSnapshot(3);
    const provider = new FakeProvider({ script: [] });
    const capturedNotices: Array<string | undefined> = [];
    const spy = buildOctokitSpy();
    // budget=1 → 3 batches; maxCalls=2 → overCap
    const config = RepoConfigSchema.parse({
      mode: 'summary-plus-inline',
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

    expect(result.state).toBe('succeeded');
    expect(result.outcome?.kind).toBe('oversized');
    expect(provider.calls).toHaveLength(0);
    // Notice explains that too many batches would be needed.
    expect(capturedNotices[0]).toMatch(/provider calls/i);
    expect(capturedNotices[0]).toMatch(/max_provider_calls_per_pr/i);
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
});
