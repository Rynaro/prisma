import { createHmac } from 'node:crypto';
import type { InstallationAuth, OctokitLike } from '@prisma-bot/github';
import { FakeProvider, makeFindingFixture } from '@prisma-bot/provider-fake';
import {
  type JobPayload,
  type ProviderReviewOutput,
  type RepoConfig,
  RepoConfigSchema,
} from '@prisma-bot/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryJobConsumer,
  InMemoryJobQueue,
  type JobOutcome,
  type RepoIdentity,
  type RepoLookup,
  runPipeline,
} from '../../src/index.js';
import { buildServer } from '../../src/server.js';
import { InMemoryReplayCache } from '../../src/webhook/replay-cache.js';

/**
 * End-to-end integration test: ingress → enqueue → orchestrator → publish.
 *
 * Wires:
 *   - `buildServer` with the real verifySignature path active.
 *   - `InMemoryReplayCache` for the webhook ingress.
 *   - `InMemoryJobQueue` whose `enqueue` synchronously runs the registered
 *     handler — collapses the BullMQ "enqueue → background-poll → execute"
 *     pattern into a deterministic in-process flow.
 *   - `FakeProvider` scripted per test case.
 *   - Hand-rolled `OctokitLike` whose pulls/checks/reviews methods record
 *     every call into spies.
 *
 * This file is the single most important asset of Phase 5: it proves the
 * pipeline works end-to-end against real component instances (no mocking
 * of internal functions).
 */

const TEST_SECRET = 'test-webhook-secret';

const sign = (body: Buffer | string, secret = TEST_SECRET): string => {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const digest = createHmac('sha256', secret).update(buf).digest('hex');
  return `sha256=${digest}`;
};

interface PullRequestBodyArgs {
  installation_id?: number;
  repository_id?: number;
  repository_owner?: string;
  repository_name?: string;
  pull_request_number?: number;
  head_sha?: string;
  action?: string;
}

const makePullRequestBody = (args: PullRequestBodyArgs = {}): Record<string, unknown> => ({
  action: args.action ?? 'opened',
  installation: { id: args.installation_id ?? 1234 },
  repository: {
    id: args.repository_id ?? 5678,
    name: args.repository_name ?? 'hello-world',
    owner: { login: args.repository_owner ?? 'octocat' },
  },
  pull_request: {
    number: args.pull_request_number ?? 42,
    head: { sha: args.head_sha ?? 'a'.repeat(40) },
  },
});

const REPO_ID: RepoIdentity = {
  owner: 'octocat',
  repo: 'hello-world',
  app_id: 999,
  app_login: 'prisma-bot',
};

const repoLookup: RepoLookup = async () => REPO_ID;

interface OctokitSpy {
  octokit: OctokitLike;
  checksCreate: Array<{ head_sha: string }>;
  checksUpdate: Array<{
    check_run_id: number;
    conclusion?: string;
    summary?: string;
  }>;
  reviewCommentsCreate: Array<{ path: string; line: number; body: string }>;
}

interface OctokitFakeOptions {
  files?: Array<{
    filename: string;
    patch?: string;
    additions?: number;
    deletions?: number;
    status?: 'added' | 'modified' | 'removed' | 'renamed';
  }>;
  fileCount?: number;
}

const buildOctokitSpy = (opts: OctokitFakeOptions = {}): OctokitSpy => {
  let nextCheckId = 1;
  const checksCreate: Array<{ head_sha: string }> = [];
  const checksUpdate: Array<{
    check_run_id: number;
    conclusion?: string;
    summary?: string;
  }> = [];
  const reviewCommentsCreate: Array<{ path: string; line: number; body: string }> = [];
  const files = opts.files ?? [
    {
      filename: 'src/example.ts',
      patch: '@@ -10,4 +10,5 @@ context\n line\n+added\n+added\n',
      additions: 3,
      deletions: 1,
      status: 'modified' as const,
    },
  ];
  const expandedFiles =
    opts.fileCount !== undefined
      ? Array.from({ length: opts.fileCount }, (_, i) => ({
          filename: `src/file${i}.ts`,
          patch: '@@ -10,4 +10,5 @@ context\n line\n+added\n+added\n',
          additions: 3,
          deletions: 1,
          status: 'modified' as const,
        }))
      : files;
  const octokit: OctokitLike = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            number: 42,
            head: { sha: 'a'.repeat(40), ref: 'feature' },
            base: { sha: 'b'.repeat(40), ref: 'main' },
          },
        }),
        listFiles: async (params) => {
          const page = params.page ?? 1;
          const perPage = params.per_page ?? 100;
          const start = (page - 1) * perPage;
          const slice = expandedFiles.slice(start, start + perPage).map((f) => ({
            filename: f.filename,
            status: (f.status ?? 'modified') as 'added' | 'modified' | 'removed' | 'renamed',
            additions: f.additions ?? 1,
            deletions: f.deletions ?? 0,
            changes: (f.additions ?? 1) + (f.deletions ?? 0),
            ...(f.patch !== undefined ? { patch: f.patch } : {}),
          }));
          return { data: slice };
        },
      },
      checks: {
        create: async (params) => {
          checksCreate.push({ head_sha: params.head_sha });
          const id = nextCheckId++;
          return { data: { id } };
        },
        update: async (params) => {
          checksUpdate.push({
            check_run_id: params.check_run_id,
            ...(params.conclusion !== undefined ? { conclusion: params.conclusion } : {}),
            ...(params.output?.summary !== undefined ? { summary: params.output.summary } : {}),
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

const cfg = (mode: 'dry-run' | 'summary-only' | 'summary-plus-inline'): RepoConfig =>
  RepoConfigSchema.parse({
    mode,
    comment_cap: { per_pr: 5, per_file: 1 },
    thresholds: {
      severity_floor: { inline: 'medium' },
      confidence_floor: { inline: 0.7 },
    },
  });

const stubInstallationAuth = {} as InstallationAuth;

interface E2EHarness {
  app: ReturnType<typeof buildServer>;
  queue: InMemoryJobQueue;
  consumer: InMemoryJobConsumer;
  spy: OctokitSpy;
  provider: FakeProvider;
  pipelineCalls: number;
}

interface BuildE2EArgs {
  provider: FakeProvider;
  octokitSpy: OctokitSpy;
  config: RepoConfig;
}

const buildE2E = (args: BuildE2EArgs): E2EHarness => {
  const replayCache = new InMemoryReplayCache({ windowSeconds: 60 });
  const queue = new InMemoryJobQueue();
  const consumer = new InMemoryJobConsumer(queue);
  let pipelineCalls = 0;

  const handler = async (payload: JobPayload): Promise<JobOutcome> => {
    // Errors thrown by runPipeline (e.g., ProviderErrorThrowable) propagate
    // up through enqueue() in the in-memory queue; in production BullMQ
    // would classify and retry. The pipelineCalls counter still ticks even
    // on throw because we increment before the await.
    pipelineCalls += 1;
    const result = await runPipeline(payload, {
      installationAuth: stubInstallationAuth,
      provider: args.provider,
      config: args.config,
      repoLookup,
      octokit: args.octokitSpy.octokit,
    });
    if (result.state === 'succeeded' && result.publication !== undefined) {
      return { state: 'succeeded', result: result.publication };
    }
    return { state: 'failed_terminal', reason: result.reason ?? 'unknown' };
  };

  void consumer.run(handler);

  const app = buildServer({
    webhookSecret: () => TEST_SECRET,
    replayCache,
    enqueueJob: (payload) => queue.enqueue(payload),
  });

  return {
    app,
    queue,
    consumer,
    spy: args.octokitSpy,
    provider: args.provider,
    get pipelineCalls(): number {
      return pipelineCalls;
    },
  };
};

const validOutput = (path = 'src/example.ts', line = 12): ProviderReviewOutput => ({
  findings: [
    makeFindingFixture({
      path,
      line,
      severity: 'high',
      confidence: 0.9,
      message: 'unsafe input',
      rationale: 'value flows into eval without sanitization',
    }),
  ],
});

describe('end-to-end webhook → orchestrator → publish', () => {
  let harness: E2EHarness;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.app.close();
      await harness.consumer.close();
      await harness.queue.close();
    }
  });

  it('happy path: signed webhook → orchestrator → 1 inline comment posted', async () => {
    const provider = new FakeProvider({
      script: [{ kind: 'output', output: validOutput() }],
    });
    // Override mode to summary-plus-inline so an inline comment is actually
    // posted; the default RepoConfig mode is dry-run.
    harness = buildE2E({
      provider,
      octokitSpy: buildOctokitSpy(),
      config: cfg('summary-plus-inline'),
    });
    const body = makePullRequestBody();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'e2e-happy-1',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(harness.pipelineCalls).toBe(1);
    expect(harness.spy.checksCreate).toHaveLength(1);
    expect(harness.spy.checksUpdate).toHaveLength(1);
    // The default planner conclusion for summary-plus-inline with at least
    // one inline finding is `success`.
    expect(harness.spy.checksUpdate[0]?.conclusion).toBe('success');
    expect(harness.spy.reviewCommentsCreate).toHaveLength(1);
  });

  it('bad signature → 401, no enqueue, no octokit calls', async () => {
    const provider = new FakeProvider({ script: [] });
    harness = buildE2E({
      provider,
      octokitSpy: buildOctokitSpy(),
      config: cfg('summary-plus-inline'),
    });
    const body = makePullRequestBody();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
        'x-github-event': 'pull_request',
        'x-github-delivery': 'e2e-badsig-1',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
    expect(harness.pipelineCalls).toBe(0);
    expect(harness.spy.checksCreate).toHaveLength(0);
    expect(harness.spy.reviewCommentsCreate).toHaveLength(0);
  });

  it('replay: same delivery_id processed only once', async () => {
    const provider = new FakeProvider({
      script: [{ kind: 'output', output: validOutput() }],
    });
    harness = buildE2E({
      provider,
      octokitSpy: buildOctokitSpy(),
      config: cfg('summary-plus-inline'),
    });
    const body = makePullRequestBody();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {
      'content-type': 'application/json',
      'x-hub-signature-256': sign(raw),
      'x-github-event': 'pull_request',
      'x-github-delivery': 'e2e-replay-1',
    } as const;
    const first = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers,
      payload: raw,
    });
    const second = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers,
      payload: raw,
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(expect.objectContaining({ status: 'discarded_idempotent' }));
    expect(harness.pipelineCalls).toBe(1);
  });

  it('oversized PR: hits prefilter oversized fast-path; summary-only publish, no inline', async () => {
    const provider = new FakeProvider({ script: [] });
    // 1000 changed files comfortably exceeds max_files (default 50).
    const spy = buildOctokitSpy({ fileCount: 1000 });
    harness = buildE2E({
      provider,
      octokitSpy: spy,
      config: cfg('summary-plus-inline'),
    });
    const body = makePullRequestBody({ pull_request_number: 99 });
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'e2e-oversized-1',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(harness.pipelineCalls).toBe(1);
    expect(provider.calls).toHaveLength(0);
    // Summary checks-run is emitted; no inline comments.
    expect(spy.checksCreate).toHaveLength(1);
    expect(spy.reviewCommentsCreate).toHaveLength(0);
  });

  it('provider auth error → publish "review unavailable" summary; job marked terminal', async () => {
    const provider = new FakeProvider({
      script: [
        {
          kind: 'error',
          error: { kind: 'auth', message: 'invalid api key' },
        },
      ],
    });
    const spy = buildOctokitSpy();
    harness = buildE2E({ provider, octokitSpy: spy, config: cfg('summary-plus-inline') });
    const body = makePullRequestBody({ pull_request_number: 77 });
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    // The in-memory queue surfaces the handler's throw to the enqueue
    // caller, which the route translates to a 500. We test the
    // octokit-side observable effects.
    const res = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'e2e-auth-1',
      },
      payload: raw,
    });
    // The webhook returns 500 because the handler throws (the BullMQ
    // production path would instead retry / mark terminal — see
    // `apps/github-app/tests/queue/bullmq-job-queue.test.ts`).
    expect(res.statusCode).toBe(500);
    // Even on the auth error path, the orchestrator publishes a "review
    // unavailable" summary before re-throwing. Hence one checks-create.
    expect(spy.checksCreate).toHaveLength(1);
    expect(spy.reviewCommentsCreate).toHaveLength(0);
  });
});
