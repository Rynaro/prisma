import {
  type AppCredentials,
  InstallationAuth,
  type SecretSource,
  envSecretSource,
} from '@prisma-bot/github';
import IORedis from 'ioredis';
import { BullMqJobQueue } from './queue/index.js';
import {
  type DepsProbe,
  type DepsProbeResult,
  type ReadinessProbe,
  buildServer,
} from './server.js';
import { InMemoryReplayCache, RedisReplayCache } from './webhook/replay-cache.js';

/**
 * `main.ts` — production wiring for the Fastify webhook ingress. Builds the
 * `JobQueue`, the replay cache, and the secret-source boundary, then hands
 * them to `buildServer`.
 *
 * Per `docs/system-design.md` § Secret storage abstraction the webhook
 * secret resolves through `SecretSource` (env-backed for MVP). Per
 * `docs/operational-runbooks.md` § Numeric tunables the BullMQ tunables
 * read from env vars; the `BullMqJobQueue` consumes them via
 * `tunablesFromEnv()`.
 *
 * Dev affordance: when `GITHUB_APP_WEBHOOK_SECRET` is unset the server
 * still boots with a documented dev-only constant so `make up` can surface
 * health endpoints without a configured GitHub App.
 */

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';
const REPLAY_WINDOW_SECONDS = Number.parseInt(
  process.env.INSTALLATION_REPLAY_WINDOW_SECONDS ?? '300',
  10,
);
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'prisma-review-bot';
const DEV_FALLBACK_SECRET = 'dev-only-not-secure';

const log = (event: string, payload: Record<string, unknown> = {}): void => {
  process.stdout.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      service: SERVICE_NAME,
      event,
      ...payload,
    })}\n`,
  );
};

/**
 * Resolve the webhook secret per `docs/system-design.md`
 * § Secret storage abstraction. The MVP implementation reads from
 * `GITHUB_APP_WEBHOOK_SECRET` via the env-backed `SecretSource`. When the
 * variable is unset we log a warning and fall back to a documented
 * dev-only constant; production deployments must set the env var.
 */
const buildWebhookSecretResolver = (secretSource: SecretSource): (() => Promise<string>) => {
  return async () => {
    try {
      return await secretSource.getSecret('GITHUB_APP_WEBHOOK_SECRET');
    } catch {
      log('webhook.secret.dev_fallback', {
        message: 'GITHUB_APP_WEBHOOK_SECRET not set; using dev-only fallback secret',
      });
      return DEV_FALLBACK_SECRET;
    }
  };
};

/**
 * Build the readiness probe per `docs/deployment.md` § Readiness.
 *
 * Returns ready:true only when:
 *   (1) SecretSource can resolve GITHUB_APP_PRIVATE_KEY
 *   (2) SecretSource can resolve GITHUB_APP_WEBHOOK_SECRET
 *   (3) SecretSource can resolve at least one provider key
 *       (ANTHROPIC_API_KEY → COPILOT_API_KEY → OPENAI_API_KEY, same
 *       precedence as worker.ts § Provider selection)
 *   (4) The IORedis connection is in 'ready' state
 *
 * All checks are synchronous or fast-resolving; the Promise.race timeout in
 * buildServer provides the outer bound.
 */
const buildReadinessProbe = (
  secretSource: SecretSource,
  redisConnection: IORedis,
): ReadinessProbe => {
  const tryGet = async (name: string): Promise<string | undefined> => {
    try {
      return await secretSource.getSecret(name);
    } catch {
      return undefined;
    }
  };

  return async () => {
    // (1) private key
    const privateKey = await tryGet('GITHUB_APP_PRIVATE_KEY');
    if (privateKey === undefined) {
      return { ready: false, reason: 'missing_secret:GITHUB_APP_PRIVATE_KEY' };
    }
    // (2) webhook secret
    const webhookSecret = await tryGet('GITHUB_APP_WEBHOOK_SECRET');
    if (webhookSecret === undefined) {
      return { ready: false, reason: 'missing_secret:GITHUB_APP_WEBHOOK_SECRET' };
    }
    // (3) at least one provider key (same precedence as worker.ts)
    const anthropicKey = await tryGet('ANTHROPIC_API_KEY');
    const copilotKey = await tryGet('COPILOT_API_KEY');
    const openaiKey = await tryGet('OPENAI_API_KEY');
    if (anthropicKey === undefined && copilotKey === undefined && openaiKey === undefined) {
      return {
        ready: false,
        reason: 'missing_secret:provider_key(ANTHROPIC_API_KEY|COPILOT_API_KEY|OPENAI_API_KEY)',
      };
    }
    // (4) Redis connected
    const redisStatus = redisConnection.status;
    if (redisStatus !== 'ready') {
      return { ready: false, reason: `redis_not_ready:${redisStatus}` };
    }
    return { ready: true };
  };
};

/**
 * Sentinel installation id used by the deps probe to exercise the GitHub
 * Installations API path. The token mint will fail (404) for a bogus id, but
 * that still exercises the network path and credential shape.
 *
 * In production we don't have a real installation id at probe time, so we
 * accept any non-transport error (including 404 for bad id or 401/403 for
 * bad credentials) as "github reachable but auth failed" — distinguishing
 * it from a timeout / ECONNREFUSED which indicates "github unreachable".
 *
 * For a real sentinel, operators should set `GITHUB_PROBE_INSTALLATION_ID`.
 */
const PROBE_INSTALLATION_ID_ENV = 'GITHUB_PROBE_INSTALLATION_ID';

/**
 * Build the deps probe per `docs/deployment.md` § Dependency check.
 *
 * (a) Redis reachable: ping() must succeed
 * (b) GitHub token mint: InstallationAuth.getToken() with a sentinel id;
 *     transport failures (ECONNREFUSED, timeout, ENOTFOUND) → 'error';
 *     auth/404 errors count as 'ok' (the API was reached, credentials
 *     shape the failure, not connectivity)
 * (c) OTLP: when OTEL_EXPORTER_OTLP_ENDPOINT is set, HTTP HEAD/GET probe;
 *     failure → 'degraded' (non-blocking, never 503)
 *
 * The `mintToken` parameter accepts a function matching the TokenMintFn
 * interface so tests can inject a fake without real GitHub credentials.
 */
const buildDepsProbe = (
  redisConnection: IORedis,
  mintToken: (installationId: number) => Promise<void>,
): DepsProbe => {
  return async (): Promise<DepsProbeResult> => {
    // (a) Redis ping
    let redisDep: DepsProbeResult['dependencies']['redis'] = 'error';
    try {
      await redisConnection.ping();
      redisDep = 'ok';
    } catch {
      // redisDep stays 'error'
    }

    // (b) GitHub installation token mint
    let githubDep: DepsProbeResult['dependencies']['github'] = 'error';
    if (redisDep === 'ok') {
      // Only probe GitHub if Redis is healthy; if Redis is down the overall
      // status will be 'error' regardless.
      try {
        await mintToken(Number.parseInt(process.env[PROBE_INSTALLATION_ID_ENV] ?? '1', 10));
        githubDep = 'ok';
      } catch (err) {
        // Distinguish transport failures (unreachable) from API-level
        // failures (wrong credentials, bad installation id). The latter
        // means the API was reached, which is sufficient for connectivity.
        const isTransport =
          err instanceof Error &&
          (err.message.includes('transport') ||
            err.message.includes('ECONNREFUSED') ||
            err.message.includes('ETIMEDOUT') ||
            err.message.includes('ENOTFOUND'));
        githubDep = isTransport ? 'error' : 'ok';
      }
    }

    // (c) OTLP probe — non-blocking, degraded on failure
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    let otlpDep: DepsProbeResult['dependencies']['otlp'] = undefined;
    if (otlpEndpoint !== undefined && otlpEndpoint.length > 0) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1500);
        try {
          const response = await fetch(otlpEndpoint, {
            method: 'HEAD',
            signal: controller.signal,
          });
          otlpDep = response.status < 500 ? 'ok' : 'degraded';
        } finally {
          clearTimeout(timeoutId);
        }
      } catch {
        otlpDep = 'degraded';
      }
    }

    const hardFailed = redisDep === 'error' || githubDep === 'error';
    let overallStatus: DepsProbeResult['status'];
    if (hardFailed) {
      overallStatus = 'error';
    } else if (otlpDep === 'degraded') {
      overallStatus = 'degraded';
    } else {
      overallStatus = 'ok';
    }

    const dependencies: DepsProbeResult['dependencies'] = {
      redis: redisDep,
      github: githubDep,
      ...(otlpDep !== undefined ? { otlp: otlpDep } : {}),
    };

    return { status: overallStatus, dependencies };
  };
};

const start = async (): Promise<void> => {
  const secretSource = envSecretSource();

  // Connect to Redis lazily so a missing Redis surfaces in logs at boot
  // rather than only on the first webhook delivery.
  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  connection.on('connect', () => log('app.redis.connected', { redis_url: REDIS_URL }));
  connection.on('error', (err: Error) => log('app.redis.error', { message: err.message }));
  let redisOk = true;
  try {
    await connection.connect();
  } catch (err) {
    redisOk = false;
    log('app.redis.error', {
      message: err instanceof Error ? err.message : 'unknown',
    });
  }

  // Replay cache: prefer Redis-backed, fall back to in-memory if Redis is
  // unreachable so the dev stack still boots without Redis. Production
  // deployments set up Redis as part of the compose stack.
  const replayCache = redisOk
    ? new RedisReplayCache(connection, REPLAY_WINDOW_SECONDS)
    : new InMemoryReplayCache({ windowSeconds: REPLAY_WINDOW_SECONDS });

  // BullMQ-backed job queue. Tunables are sourced from env vars per
  // `docs/operational-runbooks.md` § Numeric tunables. BullMQ's
  // `ConnectionOptions` accepts an `IORedis.Redis` instance directly.
  const jobQueue = new BullMqJobQueue({ connection });

  // Build the token-mint helper for the deps probe. Reads credentials from
  // the secret source at probe time so a key rotation takes effect without a
  // restart. Uses a real InstallationAuth with injectable mintToken; the
  // probe only calls getToken, not getOctokit, so no HTTP client is created
  // until the probe fires.
  const tryGetSecret = async (name: string): Promise<string | undefined> => {
    try {
      return await secretSource.getSecret(name);
    } catch {
      return undefined;
    }
  };

  const probeMintToken = async (installationId: number): Promise<void> => {
    const appIdRaw = await tryGetSecret('GITHUB_APP_ID');
    const privateKeyPem = await tryGetSecret('GITHUB_APP_PRIVATE_KEY');
    if (appIdRaw === undefined || privateKeyPem === undefined) {
      // Credentials not configured — treat as auth failure (API reachable question is moot).
      throw new Error('GitHub App credentials not configured');
    }
    const appId = Number.parseInt(appIdRaw, 10);
    if (!Number.isFinite(appId) || appId <= 0) {
      throw new Error('GitHub App credentials not configured');
    }
    const credentials: AppCredentials = { appId, privateKeyPem };
    const auth = new InstallationAuth({ credentials });
    await auth.getToken(installationId);
  };

  const app = buildServer({
    webhookSecret: buildWebhookSecretResolver(secretSource),
    replayCache,
    enqueueJob: (payload) => jobQueue.enqueue(payload),
    readinessProbe: buildReadinessProbe(secretSource, connection),
    depsProbe: buildDepsProbe(connection, probeMintToken),
  });

  const shutdown = async (): Promise<void> => {
    log('app.shutdown.start');
    try {
      await app.close();
    } finally {
      try {
        await jobQueue.close();
      } catch (err) {
        log('app.queue.close_error', {
          message: err instanceof Error ? err.message : 'unknown',
        });
      }
      try {
        await connection.quit();
      } catch (err) {
        log('app.redis.error', {
          message: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
    log('app.shutdown.done');
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    log('app.started', { port: PORT, host: HOST, redis_url: REDIS_URL });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
