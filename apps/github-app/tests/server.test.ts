import { createHmac } from 'node:crypto';
import type { JobPayload } from '@prisma-bot/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BuildServerOptions, buildServer } from '../src/server.js';
import type { EnqueueJob } from '../src/webhook/enqueue.js';
import { deriveIdempotencyKey } from '../src/webhook/idempotency.js';
import { InMemoryReplayCache } from '../src/webhook/replay-cache.js';

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

interface BuildArgs {
  enqueueJob?: EnqueueJob;
  replayCache?: BuildServerOptions['replayCache'];
  bodyLimit?: number;
  webhookSecret?: BuildServerOptions['webhookSecret'];
}

const buildTestServer = (args: BuildArgs = {}): FastifyInstance => {
  const replayCache = args.replayCache ?? new InMemoryReplayCache({ windowSeconds: 60 });
  const enqueueJob =
    args.enqueueJob ??
    (vi.fn(async (payload: JobPayload) => ({
      enqueued: true,
      idempotency_key: payload.idempotency_key,
    })) as EnqueueJob);
  const opts: BuildServerOptions = {
    webhookSecret: args.webhookSecret ?? (() => TEST_SECRET),
    replayCache,
    enqueueJob,
    ...(args.bodyLimit !== undefined ? { bodyLimit: args.bodyLimit } : {}),
  };
  return buildServer(opts);
};

describe('Fastify server (Phase 4 healthz / smoke contract)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildTestServer();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with status ok on /healthz/live', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns 200 on /healthz/ready', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz/ready' });
    expect(res.statusCode).toBe(200);
  });

  it('returns dependency status snapshot on /healthz/deps', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz/deps' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // When no depsProbe is injected (dev/test affordance) the route returns
    // an unchecked snapshot. The contract only requires redis and github
    // fields; provider is not a dependency surface exposed at /healthz/deps.
    expect(body.dependencies).toMatchObject({
      redis: expect.any(String),
      github: expect.any(String),
    });
  });

  it('accepts a valid signed POST to /webhooks/github with 202', async () => {
    // Phase 4 contract: webhook returns 202 on the happy path. The Phase 5.2
    // happy path additionally requires a valid signature and a pull_request
    // event; the contract (202 with an "accepted" indicator) is preserved.
    const body = makePullRequestBody();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'phase4-smoke-delivery',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(
      expect.objectContaining({ accepted: true, idempotency_key: expect.any(String) }),
    );
  });
});

describe('POST /webhooks/github (Phase 5.2)', () => {
  let app: FastifyInstance;
  let enqueueJob: ReturnType<typeof vi.fn>;
  let replayCache: InMemoryReplayCache;

  beforeEach(() => {
    enqueueJob = vi.fn(async (payload: JobPayload) => ({
      enqueued: true,
      idempotency_key: payload.idempotency_key,
    }));
    replayCache = new InMemoryReplayCache({ windowSeconds: 60 });
    app = buildTestServer({ enqueueJob: enqueueJob as unknown as EnqueueJob, replayCache });
  });

  afterEach(async () => {
    await app.close();
  });

  it('happy path: 202, returns derived idempotency key, enqueues exactly once, remembers delivery', async () => {
    const body = makePullRequestBody();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const deliveryId = '11111111-2222-3333-4444-555555555555';

    const rememberSpy = vi.spyOn(replayCache, 'remember');

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId,
      },
      payload: raw,
    });

    expect(res.statusCode).toBe(202);
    const expectedKey = deriveIdempotencyKey({
      installation_id: 1234,
      repository_id: 5678,
      pull_request_number: 42,
      head_sha: 'a'.repeat(40),
      delivery_id: deliveryId,
    });
    expect(res.json()).toEqual(
      expect.objectContaining({ accepted: true, idempotency_key: expectedKey }),
    );
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const enqueuedPayload = enqueueJob.mock.calls[0]?.[0] as JobPayload;
    expect(enqueuedPayload).toEqual(
      expect.objectContaining({
        idempotency_key: expectedKey,
        installation_id: 1234,
        repository_id: 5678,
        pull_request_number: 42,
        head_sha: 'a'.repeat(40),
        event_type: 'pull_request.opened',
        owner: 'octocat',
        repo: 'hello-world',
      }),
    );
    expect(typeof enqueuedPayload.received_at).toBe('string');
    expect(rememberSpy).toHaveBeenCalledTimes(1);
    expect(rememberSpy).toHaveBeenCalledWith(1234, deliveryId);
  });

  it('returns 401 with missing signature header and does not enqueue', async () => {
    const body = makePullRequestBody();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd-no-sig',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(expect.objectContaining({ ok: false, reason: 'missing_header' }));
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('returns 401 with malformed signature header and does not enqueue', async () => {
    const body = makePullRequestBody();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'not-a-real-sig',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd-malformed',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(expect.objectContaining({ ok: false, reason: 'malformed_header' }));
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('returns 401 with valid-shape but wrong-digest signature and does not enqueue', async () => {
    const body = makePullRequestBody();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const wrongSig = `sha256=${'0'.repeat(64)}`;
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': wrongSig,
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd-wrong-digest',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(expect.objectContaining({ ok: false, reason: 'mismatch' }));
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('returns 202 with ignored:true for an unsupported event (issues) and does not enqueue', async () => {
    const body = makePullRequestBody();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'issues',
        'x-github-delivery': 'd-issues',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(expect.objectContaining({ accepted: false, ignored: true }));
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('returns 202 with ignored:true for pull_request.closed and does not enqueue', async () => {
    const body = makePullRequestBody({ action: 'closed' });
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd-closed',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(expect.objectContaining({ accepted: false, ignored: true }));
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('returns 202 with status:discarded_idempotent on a replayed delivery_id and does not enqueue', async () => {
    const body = makePullRequestBody();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const deliveryId = 'replay-d-1';

    // Pre-seed the replay cache so the request is treated as a replay.
    await replayCache.remember(1234, deliveryId);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId,
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    const expectedKey = deriveIdempotencyKey({
      installation_id: 1234,
      repository_id: 5678,
      pull_request_number: 42,
      head_sha: 'a'.repeat(40),
      delivery_id: deliveryId,
    });
    expect(res.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        idempotency_key: expectedKey,
        status: 'discarded_idempotent',
      }),
    );
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('returns 400 for non-JSON Content-Type and does not enqueue', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'text/plain',
        'x-hub-signature-256': sign('hello'),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd-text',
      },
      payload: 'hello',
    });
    expect(res.statusCode).toBe(400);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('returns 413 for a body larger than bodyLimit and does not enqueue', async () => {
    await app.close();
    app = buildTestServer({
      enqueueJob: enqueueJob as unknown as EnqueueJob,
      replayCache,
      bodyLimit: 256,
    });

    // 1 KB of payload comfortably exceeds the 256-byte limit.
    const oversized = Buffer.alloc(1024, 0x7b); // '{' bytes; content irrelevant
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(oversized),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd-too-big',
      },
      payload: oversized,
    });
    expect(res.statusCode).toBe(413);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('returns 400 when the envelope is missing required fields (Zod-style rejection) and does not enqueue', async () => {
    // No `installation` field — passes signature verification but fails the
    // envelope structural validation.
    const incompleteBody = {
      action: 'opened',
      repository: { id: 5678 },
      pull_request: { number: 42, head: { sha: 'a'.repeat(40) } },
    };
    const raw = Buffer.from(JSON.stringify(incompleteBody), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd-missing-installation',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(400);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('forwards traceparent header into the JobPayload when present', async () => {
    const body = makePullRequestBody();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd-traceparent',
        traceparent,
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const payload = enqueueJob.mock.calls[0]?.[0] as JobPayload;
    expect(payload.traceparent).toBe(traceparent);
  });

  it('carries owner and repo from webhook payload into the enqueued JobPayload', async () => {
    const body = makePullRequestBody({ repository_owner: 'my-org', repository_name: 'my-service' });
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd-owner-repo',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const payload = enqueueJob.mock.calls[0]?.[0] as JobPayload;
    expect(payload.owner).toBe('my-org');
    expect(payload.repo).toBe('my-service');
  });

  it('returns 400 when the webhook payload is missing repository.owner.login and does not enqueue', async () => {
    // A payload that has repository.id but is missing the owner object.
    const incompleteBody = {
      action: 'opened',
      installation: { id: 1234 },
      repository: { id: 5678, name: 'hello-world' }, // missing owner
      pull_request: { number: 42, head: { sha: 'a'.repeat(40) } },
    };
    const raw = Buffer.from(JSON.stringify(incompleteBody), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd-missing-owner',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(400);
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Dynamic bot interactions — Track 1 (T1)
// ---------------------------------------------------------------------------

interface IssueCommentBodyArgs {
  installation_id?: number;
  repository_id?: number;
  repository_owner?: string;
  repository_name?: string;
  issue_number?: number;
  comment_id?: number;
  comment_body?: string;
  comment_user_login?: string;
  comment_user_type?: string;
  sender_login?: string;
  sender_type?: string;
  action?: string;
  is_pr_comment?: boolean;
}

const makeIssueCommentBody = (args: IssueCommentBodyArgs = {}): Record<string, unknown> => ({
  action: args.action ?? 'created',
  installation: { id: args.installation_id ?? 1234 },
  repository: {
    id: args.repository_id ?? 5678,
    name: args.repository_name ?? 'hello-world',
    owner: { login: args.repository_owner ?? 'octocat' },
  },
  issue: {
    number: args.issue_number ?? 42,
    pull_request:
      args.is_pr_comment !== false ? { url: 'https://api.github.com/pulls/42' } : undefined,
  },
  comment: {
    id: args.comment_id ?? 9999,
    body: args.comment_body ?? '@test-bot review',
    user: {
      login: args.comment_user_login ?? 'alice',
      type: args.comment_user_type ?? 'User',
    },
    author_association: 'COLLABORATOR',
  },
  sender: {
    login: args.sender_login ?? 'alice',
    type: args.sender_type ?? 'User',
  },
});

interface CheckRunBodyArgs {
  installation_id?: number;
  repository_id?: number;
  repository_owner?: string;
  repository_name?: string;
  check_run_id?: number;
  head_sha?: string;
  pull_request_number?: number;
  action?: string;
}

const makeCheckRunBody = (args: CheckRunBodyArgs = {}): Record<string, unknown> => ({
  action: args.action ?? 'rerequested',
  installation: { id: args.installation_id ?? 1234 },
  repository: {
    id: args.repository_id ?? 5678,
    name: args.repository_name ?? 'hello-world',
    owner: { login: args.repository_owner ?? 'octocat' },
  },
  check_run: {
    id: args.check_run_id ?? 7777,
    head_sha: args.head_sha ?? 'c'.repeat(40),
    pull_requests:
      args.pull_request_number !== undefined
        ? [{ number: args.pull_request_number }]
        : [{ number: 42 }],
  },
});

describe('POST /webhooks/github — issue_comment event (T1)', () => {
  let app: ReturnType<typeof buildTestServer>;
  let enqueueJob: ReturnType<typeof vi.fn>;
  let replayCache: InMemoryReplayCache;

  beforeEach(() => {
    enqueueJob = vi.fn(async (payload: JobPayload) => ({
      enqueued: true,
      idempotency_key: payload.idempotency_key,
    }));
    replayCache = new InMemoryReplayCache({ windowSeconds: 60 });
    app = buildTestServer({ enqueueJob: enqueueJob as unknown as EnqueueJob, replayCache });
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts a valid issue_comment.created on a PR with a mention and enqueues', async () => {
    const body = makeIssueCommentBody({ comment_body: '@test-bot review' });
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'ic-delivery-1',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(expect.objectContaining({ accepted: true }));
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const payload = enqueueJob.mock.calls[0]?.[0] as JobPayload;
    expect(payload.event_type).toBe('issue_comment.command');
  });

  it('ignores issue_comment.created on a non-PR issue (no pull_request field)', async () => {
    const body = makeIssueCommentBody({ comment_body: '@bot review', is_pr_comment: false });
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'ic-not-pr',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(expect.objectContaining({ accepted: false, ignored: true }));
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('drops a bot-authored issue_comment and does not enqueue (loop prevention)', async () => {
    const body = makeIssueCommentBody({
      comment_body: '@bot review',
      comment_user_type: 'Bot',
      comment_user_login: 'prisma-bot[bot]',
      sender_type: 'Bot',
    });
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'ic-bot-author',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(expect.objectContaining({ accepted: false, ignored: true }));
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('ignores issue_comment with no @mention and does not enqueue', async () => {
    const body = makeIssueCommentBody({ comment_body: 'LGTM, ship it!' });
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'ic-no-mention',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(expect.objectContaining({ accepted: false, ignored: true }));
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('ignores issue_comment.edited (not accepted action)', async () => {
    const body = makeIssueCommentBody({ action: 'edited', comment_body: '@bot review' });
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'ic-edited',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(expect.objectContaining({ accepted: false, ignored: true }));
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/github — check_run event (T1)', () => {
  let app: ReturnType<typeof buildTestServer>;
  let enqueueJob: ReturnType<typeof vi.fn>;
  let replayCache: InMemoryReplayCache;

  beforeEach(() => {
    enqueueJob = vi.fn(async (payload: JobPayload) => ({
      enqueued: true,
      idempotency_key: payload.idempotency_key,
    }));
    replayCache = new InMemoryReplayCache({ windowSeconds: 60 });
    app = buildTestServer({ enqueueJob: enqueueJob as unknown as EnqueueJob, replayCache });
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts a valid check_run.rerequested and enqueues', async () => {
    const body = makeCheckRunBody();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'check_run',
        'x-github-delivery': 'cr-delivery-1',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(expect.objectContaining({ accepted: true }));
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const payload = enqueueJob.mock.calls[0]?.[0] as JobPayload;
    expect(payload.event_type).toBe('check_run.rerequested');
  });

  it('ignores check_run.completed (not accepted action)', async () => {
    const body = makeCheckRunBody({ action: 'completed' });
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'check_run',
        'x-github-delivery': 'cr-completed',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(expect.objectContaining({ accepted: false, ignored: true }));
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('pull_request.opened still works correctly (regression guard)', async () => {
    const body = makePullRequestBody();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'pr-regression-1',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(expect.objectContaining({ accepted: true }));
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const payload = enqueueJob.mock.calls[0]?.[0] as JobPayload;
    expect(payload.event_type).toBe('pull_request.opened');
  });
});

// ---------------------------------------------------------------------------
// botLogin loop prevention (e) + command_marker in JobPayload
// ---------------------------------------------------------------------------

describe('POST /webhooks/github — botLogin wiring (e)', () => {
  let enqueueJob: ReturnType<typeof vi.fn>;
  let replayCache: InMemoryReplayCache;

  beforeEach(() => {
    enqueueJob = vi.fn(async (payload: JobPayload) => ({
      enqueued: true,
      idempotency_key: payload.idempotency_key,
    }));
    replayCache = new InMemoryReplayCache({ windowSeconds: 60 });
  });

  it('drops a bot-authored comment when botLogin is provided and login matches "<botLogin>[bot]"', async () => {
    // Build a server with botLogin configured.
    const opts: BuildServerOptions = {
      webhookSecret: () => TEST_SECRET,
      replayCache,
      enqueueJob: enqueueJob as unknown as EnqueueJob,
      botLogin: 'my-review-bot',
    };
    const app = buildServer(opts);
    try {
      const body = makeIssueCommentBody({
        comment_body: '@my-review-bot review',
        comment_user_login: 'my-review-bot[bot]',
        comment_user_type: 'User', // type is NOT 'Bot' to isolate the login-based check
        sender_type: 'User',
      });
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sign(raw),
          'x-github-event': 'issue_comment',
          'x-github-delivery': 'ic-botlogin-drop',
        },
        payload: raw,
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual(expect.objectContaining({ accepted: false, ignored: true }));
      expect(enqueueJob).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does NOT drop a human comment even when botLogin is provided', async () => {
    const opts: BuildServerOptions = {
      webhookSecret: () => TEST_SECRET,
      replayCache,
      enqueueJob: enqueueJob as unknown as EnqueueJob,
      botLogin: 'my-review-bot',
    };
    const app = buildServer(opts);
    try {
      const body = makeIssueCommentBody({
        comment_body: '@my-review-bot review',
        comment_user_login: 'alice',
        comment_user_type: 'User',
        sender_type: 'User',
      });
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sign(raw),
          'x-github-event': 'issue_comment',
          'x-github-delivery': 'ic-botlogin-human',
        },
        payload: raw,
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual(expect.objectContaining({ accepted: true }));
      expect(enqueueJob).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('enqueued comment job carries command_marker "@" for @-prefix comment', async () => {
    const app = buildTestServer({ enqueueJob: enqueueJob as unknown as EnqueueJob, replayCache });
    try {
      const body = makeIssueCommentBody({ comment_body: '@test-bot review' });
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      await app.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sign(raw),
          'x-github-event': 'issue_comment',
          'x-github-delivery': 'ic-marker-at',
        },
        payload: raw,
      });
      expect(enqueueJob).toHaveBeenCalledTimes(1);
      const payload = enqueueJob.mock.calls[0]?.[0] as JobPayload;
      expect(payload.event_type).toBe('issue_comment.command');
      if (payload.event_type === 'issue_comment.command') {
        expect(payload.command_marker).toBe('@');
      }
    } finally {
      await app.close();
    }
  });

  it('enqueued comment job carries command_marker "$" for $-prefix comment', async () => {
    const app = buildTestServer({ enqueueJob: enqueueJob as unknown as EnqueueJob, replayCache });
    try {
      const body = makeIssueCommentBody({ comment_body: '$test-bot review' });
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      await app.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sign(raw),
          'x-github-event': 'issue_comment',
          'x-github-delivery': 'ic-marker-dollar',
        },
        payload: raw,
      });
      expect(enqueueJob).toHaveBeenCalledTimes(1);
      const payload = enqueueJob.mock.calls[0]?.[0] as JobPayload;
      expect(payload.event_type).toBe('issue_comment.command');
      if (payload.event_type === 'issue_comment.command') {
        expect(payload.command_marker).toBe('$');
      }
    } finally {
      await app.close();
    }
  });

  it('enqueued comment job carries command_marker "!" for !-prefix comment', async () => {
    const app = buildTestServer({ enqueueJob: enqueueJob as unknown as EnqueueJob, replayCache });
    try {
      const body = makeIssueCommentBody({ comment_body: '!test-bot review' });
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      await app.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sign(raw),
          'x-github-event': 'issue_comment',
          'x-github-delivery': 'ic-marker-bang',
        },
        payload: raw,
      });
      expect(enqueueJob).toHaveBeenCalledTimes(1);
      const payload = enqueueJob.mock.calls[0]?.[0] as JobPayload;
      expect(payload.event_type).toBe('issue_comment.command');
      if (payload.event_type === 'issue_comment.command') {
        expect(payload.command_marker).toBe('!');
      }
    } finally {
      await app.close();
    }
  });

  it('enqueued comment job carries command_marker "/" for /-prefix comment', async () => {
    const app = buildTestServer({ enqueueJob: enqueueJob as unknown as EnqueueJob, replayCache });
    try {
      const body = makeIssueCommentBody({ comment_body: '/test-bot review' });
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      await app.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sign(raw),
          'x-github-event': 'issue_comment',
          'x-github-delivery': 'ic-marker-slash',
        },
        payload: raw,
      });
      expect(enqueueJob).toHaveBeenCalledTimes(1);
      const payload = enqueueJob.mock.calls[0]?.[0] as JobPayload;
      expect(payload.event_type).toBe('issue_comment.command');
      if (payload.event_type === 'issue_comment.command') {
        expect(payload.command_marker).toBe('/');
      }
    } finally {
      await app.close();
    }
  });

  it('comment with no recognised marker is still ignored (# is not a valid marker)', async () => {
    const app = buildTestServer({ enqueueJob: enqueueJob as unknown as EnqueueJob, replayCache });
    try {
      const body = makeIssueCommentBody({ comment_body: '#test-bot review' });
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sign(raw),
          'x-github-event': 'issue_comment',
          'x-github-delivery': 'ic-marker-hash',
        },
        payload: raw,
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual(expect.objectContaining({ accepted: false, ignored: true }));
      expect(enqueueJob).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
