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

const makePayload = (over: Partial<JobPayload> = {}): JobPayload => ({
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
    // A PR with way more changed lines than max_changed_lines (default 2000).
    const oversized = buildSnapshot({
      total_changed_lines: 5000,
      files: [
        {
          path: 'src/big.ts',
          status: 'modified',
          additions: 3000,
          deletions: 2000,
          hunks: [{ new_start: 1, new_lines: 5000, old_start: 1, old_lines: 4000 }],
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
});
