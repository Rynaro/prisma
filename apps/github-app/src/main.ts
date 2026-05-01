import { type SecretSource, envSecretSource } from '@prisma-bot/github';
import IORedis from 'ioredis';
import { BullMqJobQueue } from './queue/index.js';
import { buildServer } from './server.js';
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

  const app = buildServer({
    webhookSecret: buildWebhookSecretResolver(secretSource),
    replayCache,
    enqueueJob: (payload) => jobQueue.enqueue(payload),
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
