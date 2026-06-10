/**
 * S7 — tests for the hardened /healthz/ready, /healthz/deps, and the
 * /healthz/live regression guard.
 *
 * All probes are injected via BuildServerOptions so no real Redis or GitHub
 * credentials are required. The test file mirrors the conventions of
 * tests/server.test.ts (vitest, Fastify inject, InMemoryReplayCache).
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BuildServerOptions,
  type DepsProbe,
  type DepsProbeResult,
  type ReadinessProbe,
  type ReadinessProbeResult,
  buildServer,
} from '../src/server.js';
import type { EnqueueJob } from '../src/webhook/enqueue.js';
import { InMemoryReplayCache } from '../src/webhook/replay-cache.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeReadyProbe = (result: ReadinessProbeResult): ReadinessProbe => vi.fn(async () => result);

const makeDepsProbe = (result: DepsProbeResult): DepsProbe => vi.fn(async () => result);

const noop: EnqueueJob = async (payload) => ({
  enqueued: true,
  idempotency_key: payload.idempotency_key,
});

const buildTestServer = (opts: Partial<BuildServerOptions> = {}): FastifyInstance => {
  const replayCache = new InMemoryReplayCache({ windowSeconds: 60 });
  return buildServer({
    webhookSecret: () => 'test-secret',
    replayCache,
    enqueueJob: noop,
    ...opts,
  });
};

// ---------------------------------------------------------------------------
// /healthz/live — regression guard (S6 contract must not change)
// ---------------------------------------------------------------------------

describe('GET /healthz/live (regression guard)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildTestServer();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with { status: "ok" } unconditionally', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns 200 even when readiness probe is injected and failing', async () => {
    await app.close();
    app = buildTestServer({
      readinessProbe: makeReadyProbe({
        ready: false,
        reason: 'missing_secret:GITHUB_APP_PRIVATE_KEY',
      }),
    });
    const res = await app.inject({ method: 'GET', url: '/healthz/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

// ---------------------------------------------------------------------------
// /healthz/ready — no probe injected (dev/backward-compat affordance)
// ---------------------------------------------------------------------------

describe('GET /healthz/ready — no probe (dev affordance)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildTestServer(); // no readinessProbe
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 when no probe is injected', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

// ---------------------------------------------------------------------------
// /healthz/ready — with probe injected
// ---------------------------------------------------------------------------

describe('GET /healthz/ready — with probe', () => {
  const runReady = async (probe: ReadinessProbe) => {
    const app = buildTestServer({ readinessProbe: probe });
    try {
      return await app.inject({ method: 'GET', url: '/healthz/ready' });
    } finally {
      await app.close();
    }
  };

  it('returns 200 when probe reports ready:true', async () => {
    const res = await runReady(makeReadyProbe({ ready: true }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('returns 503 when probe reports ready:false (missing webhook secret)', async () => {
    const res = await runReady(
      makeReadyProbe({ ready: false, reason: 'missing_secret:GITHUB_APP_WEBHOOK_SECRET' }),
    );
    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string; reason: string };
    expect(body.status).toBe('not_ready');
    expect(body.reason).toContain('GITHUB_APP_WEBHOOK_SECRET');
  });

  it('returns 503 when probe reports ready:false (missing private key)', async () => {
    const res = await runReady(
      makeReadyProbe({ ready: false, reason: 'missing_secret:GITHUB_APP_PRIVATE_KEY' }),
    );
    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string; reason: string };
    expect(body.status).toBe('not_ready');
    expect(body.reason).toContain('GITHUB_APP_PRIVATE_KEY');
  });

  it('returns 503 when probe reports ready:false (no provider key)', async () => {
    const res = await runReady(
      makeReadyProbe({
        ready: false,
        reason: 'missing_secret:provider_key(ANTHROPIC_API_KEY|COPILOT_API_KEY|OPENAI_API_KEY)',
      }),
    );
    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string; reason: string };
    expect(body.status).toBe('not_ready');
    expect(body.reason).toContain('provider_key');
  });

  it('returns 503 when probe reports ready:false (redis not ready)', async () => {
    const res = await runReady(
      makeReadyProbe({ ready: false, reason: 'redis_not_ready:connecting' }),
    );
    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string; reason: string };
    expect(body.status).toBe('not_ready');
    expect(body.reason).toContain('redis_not_ready');
  });

  it('returns 503 when probe throws (probe error is not fatal to the process)', async () => {
    const throwingProbe: ReadinessProbe = vi.fn(async () => {
      throw new Error('secret_source_unavailable');
    });
    const res = await runReady(throwingProbe);
    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string; reason: string };
    expect(body.status).toBe('not_ready');
    expect(body.reason).toBe('secret_source_unavailable');
  });

  it('returns 503 when probe times out (> 2s race)', async () => {
    // Simulate a probe that never resolves by using a promise that resolves
    // after the 2s race window. We use fake timers to avoid real waits.
    vi.useFakeTimers();
    const hangingProbe: ReadinessProbe = vi.fn(
      () => new Promise<ReadinessProbeResult>(() => undefined), // never resolves
    );
    const app = buildTestServer({ readinessProbe: hangingProbe });
    const responsePromise = app.inject({ method: 'GET', url: '/healthz/ready' });
    // Advance past the 2s timeout inside buildServer
    await vi.advanceTimersByTimeAsync(2500);
    const res = await responsePromise;
    await app.close();
    vi.useRealTimers();
    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string; reason: string };
    expect(body.status).toBe('not_ready');
    expect(body.reason).toContain('timed out');
  });
});

// ---------------------------------------------------------------------------
// /healthz/deps — no probe injected (dev/backward-compat affordance)
// ---------------------------------------------------------------------------

describe('GET /healthz/deps — no probe (dev affordance)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildTestServer(); // no depsProbe
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with unchecked dependencies snapshot', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz/deps' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { dependencies: Record<string, string> };
    expect(body.dependencies).toMatchObject({
      redis: expect.any(String),
      github: expect.any(String),
    });
  });
});

// ---------------------------------------------------------------------------
// /healthz/deps — with probe injected
// ---------------------------------------------------------------------------

describe('GET /healthz/deps — with probe', () => {
  const runDeps = async (probe: DepsProbe) => {
    const app = buildTestServer({ depsProbe: probe });
    try {
      return await app.inject({ method: 'GET', url: '/healthz/deps' });
    } finally {
      await app.close();
    }
  };

  it('returns 200 when redis and github pass and no OTLP configured', async () => {
    const res = await runDeps(
      makeDepsProbe({
        status: 'ok',
        dependencies: { redis: 'ok', github: 'ok' },
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as DepsProbeResult;
    expect(body.status).toBe('ok');
    expect(body.dependencies.redis).toBe('ok');
    expect(body.dependencies.github).toBe('ok');
  });

  it('returns 503 when redis probe fails', async () => {
    const res = await runDeps(
      makeDepsProbe({
        status: 'error',
        dependencies: { redis: 'error', github: 'error' },
      }),
    );
    expect(res.statusCode).toBe(503);
    const body = res.json() as DepsProbeResult;
    expect(body.status).toBe('error');
    expect(body.dependencies.redis).toBe('error');
  });

  it('returns 503 when github token mint fails', async () => {
    const res = await runDeps(
      makeDepsProbe({
        status: 'error',
        dependencies: { redis: 'ok', github: 'error' },
      }),
    );
    expect(res.statusCode).toBe(503);
    const body = res.json() as DepsProbeResult;
    expect(body.status).toBe('error');
    expect(body.dependencies.github).toBe('error');
  });

  it('returns 200 with degraded status when OTLP configured but unreachable', async () => {
    const res = await runDeps(
      makeDepsProbe({
        status: 'degraded',
        dependencies: { redis: 'ok', github: 'ok', otlp: 'degraded' },
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as DepsProbeResult;
    expect(body.status).toBe('degraded');
    expect(body.dependencies.redis).toBe('ok');
    expect(body.dependencies.github).toBe('ok');
    expect(body.dependencies.otlp).toBe('degraded');
  });

  it('returns 200 when OTLP is configured and reachable', async () => {
    const res = await runDeps(
      makeDepsProbe({
        status: 'ok',
        dependencies: { redis: 'ok', github: 'ok', otlp: 'ok' },
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as DepsProbeResult;
    expect(body.status).toBe('ok');
    expect(body.dependencies.otlp).toBe('ok');
  });

  it('returns 503 when probe throws', async () => {
    const throwingProbe: DepsProbe = vi.fn(async () => {
      throw new Error('deps_probe_failed');
    });
    const res = await runDeps(throwingProbe);
    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string; dependencies: Record<string, string> };
    expect(body.status).toBe('error');
    expect(body.dependencies.redis).toBe('error');
    expect(body.dependencies.github).toBe('error');
  });

  it('returns 503 when probe times out (> 2s race)', async () => {
    vi.useFakeTimers();
    const hangingProbe: DepsProbe = vi.fn(
      () => new Promise<DepsProbeResult>(() => undefined), // never resolves
    );
    const app = buildTestServer({ depsProbe: hangingProbe });
    const responsePromise = app.inject({ method: 'GET', url: '/healthz/deps' });
    await vi.advanceTimersByTimeAsync(2500);
    const res = await responsePromise;
    await app.close();
    vi.useRealTimers();
    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string };
    expect(body.status).toBe('error');
  });
});
