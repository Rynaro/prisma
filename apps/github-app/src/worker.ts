import {
  type AppCredentials,
  InstallationAuth,
  type SecretSource,
  envSecretSource,
} from '@prisma-bot/github';
import { AnthropicProvider, type AnthropicProviderOptions } from '@prisma-bot/provider-anthropic';
import { FakeProvider } from '@prisma-bot/provider-fake';
import {
  type JobPayload,
  type Provider,
  ProviderErrorThrowable,
  type RepoConfig,
  RepoConfigSchema,
} from '@prisma-bot/shared';
import IORedis from 'ioredis';
import { type RepoIdentity, type RepoLookup, runPipeline } from './pipeline/index.js';
import { BullMqJobConsumer, type JobOutcome } from './queue/index.js';

/**
 * `worker.ts` — production wiring for the BullMQ consumer. Builds the
 * provider, the installation-auth, and the orchestrator, then runs the
 * consumer until SIGTERM.
 *
 * Provider selection (MVP):
 *   - If `ANTHROPIC_API_KEY` is set → `AnthropicProvider` with
 *     `maxTokensPerCall = MAX_TOKENS_PER_PR / 2` (a soft cost-ceiling proxy
 *     per `docs/operational-runbooks.md` § Numeric tunables).
 *   - Otherwise → `FakeProvider` with an empty script — the dev stack
 *     boots without secrets, but every actual job will exhaust the script
 *     and fail terminal. This is the correct dev affordance: a worker
 *     that boots and logs `worker.started` but cannot service real work
 *     until the operator configures the API key.
 *
 * Tunables come from env per `docs/operational-runbooks.md`. The
 * `BullMqJobConsumer` is constructed with `consumerTunablesFromEnv()`
 * inside the class.
 */

const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'prisma-review-bot';
const MAX_TOKENS_PER_PR = Number.parseInt(process.env.MAX_TOKENS_PER_PR ?? '60000', 10);

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

const tryGetSecret = async (
  secretSource: SecretSource,
  name: string,
): Promise<string | undefined> => {
  try {
    return await secretSource.getSecret(name);
  } catch {
    return undefined;
  }
};

/**
 * Build the `Provider` instance per the MVP selection rule. When the
 * Anthropic key is missing the worker still boots with a no-script
 * `FakeProvider`; this is documented above.
 */
const buildProvider = async (secretSource: SecretSource): Promise<Provider> => {
  const apiKey = await tryGetSecret(secretSource, 'ANTHROPIC_API_KEY');
  if (apiKey !== undefined) {
    const opts: AnthropicProviderOptions = {
      apiKey,
      maxTokensPerCall: Math.floor(MAX_TOKENS_PER_PR / 2),
    };
    log('worker.provider.selected', { provider: 'anthropic' });
    return new AnthropicProvider(opts);
  }
  log('worker.provider.selected', {
    provider: 'fake',
    reason: 'ANTHROPIC_API_KEY not set; using FakeProvider with empty script',
  });
  return new FakeProvider({ script: [] });
};

/**
 * Build the InstallationAuth. When App credentials are absent we return a
 * stub whose `getOctokit()` rejects with a typed error so the server can
 * still bind to the port (the dev affordance) but any real job fails fast.
 */
const buildInstallationAuth = async (secretSource: SecretSource): Promise<InstallationAuth> => {
  const appIdRaw = await tryGetSecret(secretSource, 'GITHUB_APP_ID');
  const privateKeyPem = await tryGetSecret(secretSource, 'GITHUB_APP_PRIVATE_KEY');
  if (appIdRaw !== undefined && privateKeyPem !== undefined) {
    const appId = Number.parseInt(appIdRaw, 10);
    if (Number.isFinite(appId) && appId > 0) {
      const credentials: AppCredentials = { appId, privateKeyPem };
      return new InstallationAuth({ credentials });
    }
  }
  log('worker.installation_auth.dev_fallback', {
    message: 'GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not configured; getOctokit() will reject',
  });
  // Stub: an InstallationAuth-shaped object whose getOctokit always rejects.
  // We synthesize via a real InstallationAuth with a mintToken that throws
  // — this preserves the type without exposing a partial.
  return new InstallationAuth({
    credentials: { appId: 0, privateKeyPem: '' },
    mintToken: async () => {
      throw new Error('GitHub App credentials not configured');
    },
  });
};

/**
 * Build the `RepoLookup` callback. Ideally this resolves
 * `(installation_id, repository_id) → { owner, repo, app_id, app_login }`
 * via an Octokit lookup against `installations/{id}/repositories`. For
 * MVP we read defaults from env vars; production wiring is a follow-up.
 */
const buildRepoLookup = (secretSource: SecretSource): RepoLookup => {
  return async (params): Promise<RepoIdentity> => {
    const ownerEnv = await tryGetSecret(secretSource, 'GITHUB_DEFAULT_OWNER');
    const repoEnv = await tryGetSecret(secretSource, 'GITHUB_DEFAULT_REPO');
    const appIdRaw = await tryGetSecret(secretSource, 'GITHUB_APP_ID');
    const appLoginEnv = await tryGetSecret(secretSource, 'GITHUB_APP_SLUG');
    const owner = ownerEnv ?? 'unknown-owner';
    const repo = repoEnv ?? 'unknown-repo';
    const app_id = appIdRaw !== undefined ? Number.parseInt(appIdRaw, 10) : 0;
    const app_login = appLoginEnv ?? 'prisma-bot';
    log('worker.repo_lookup', {
      installation_id: params.installation_id,
      repository_id: params.repository_id,
      owner,
      repo,
    });
    return {
      owner,
      repo,
      app_id: Number.isFinite(app_id) && app_id > 0 ? app_id : 0,
      app_login,
    };
  };
};

const defaultRepoConfig = (): RepoConfig => RepoConfigSchema.parse({});

const start = async (): Promise<void> => {
  const secretSource = envSecretSource();
  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('connect', () => log('worker.redis.connected', { redis_url: REDIS_URL }));
  connection.on('error', (err: Error) => log('worker.redis.error', { message: err.message }));

  const provider = await buildProvider(secretSource);
  const installationAuth = await buildInstallationAuth(secretSource);
  const repoLookup = buildRepoLookup(secretSource);
  const config = defaultRepoConfig();

  const consumer = new BullMqJobConsumer({ connection });

  const handler = async (payload: JobPayload): Promise<JobOutcome> => {
    log('job.started', { idempotency_key: payload.idempotency_key });
    try {
      const result = await runPipeline(payload, {
        installationAuth,
        provider,
        config,
        repoLookup,
      });
      if (result.state === 'succeeded' && result.publication !== undefined) {
        return { state: 'succeeded', result: result.publication };
      }
      return {
        state: 'failed_terminal',
        reason: result.reason ?? 'unknown',
      };
    } catch (err) {
      // ProviderErrorThrowable bubbles up here for transient/rate-limited
      // classification by the consumer; non-transient kinds are converted
      // to UnrecoverableError inside the consumer wrapper.
      if (err instanceof ProviderErrorThrowable) throw err;
      log('worker.handler.error', {
        idempotency_key: payload.idempotency_key,
        message: err instanceof Error ? err.message : 'unknown',
      });
      throw err;
    }
  };

  await consumer.run(handler);
  log('worker.started', { queue: 'pr-review' });

  const shutdown = async (): Promise<void> => {
    log('worker.shutdown.start');
    try {
      await consumer.close();
    } catch (err) {
      log('worker.consumer.close_error', {
        message: err instanceof Error ? err.message : 'unknown',
      });
    }
    try {
      await connection.quit();
    } catch (err) {
      log('worker.redis.error', {
        message: err instanceof Error ? err.message : 'unknown',
      });
    }
    log('worker.shutdown.done');
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
};

void start();
