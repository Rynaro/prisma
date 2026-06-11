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
