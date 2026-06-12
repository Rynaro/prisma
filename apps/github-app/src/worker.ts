import { ConfigParseError, REPO_LOCAL_CONFIG_PATH, loadRepoConfig } from '@prisma-bot/config';
import {
  type AppCredentials,
  InstallationAuth,
  type OctokitLike,
  type SecretSource,
  buildContentFetcher,
  envSecretSource,
} from '@prisma-bot/github';
import { AnthropicProvider, type AnthropicProviderOptions } from '@prisma-bot/provider-anthropic';
import { CopilotProvider, type CopilotProviderOptions } from '@prisma-bot/provider-copilot';
import { FakeProvider } from '@prisma-bot/provider-fake';
import { OpenAIProvider, type OpenAIProviderOptions } from '@prisma-bot/provider-openai';
import {
  type JobPayload,
  type Provider,
  ProviderErrorThrowable,
  type RepoConfig,
} from '@prisma-bot/shared';
import IORedis from 'ioredis';
import { type RepoIdentity, type RepoLookup, runPipeline } from './pipeline/index.js';
import { BullMqJobConsumer, type JobOutcome } from './queue/index.js';
import { resolveRepoIdentity } from './repo-identity.js';

/**
 * `worker.ts` — production wiring for the BullMQ consumer. Builds the
 * provider, the installation-auth, and the orchestrator, then runs the
 * consumer until SIGTERM.
 *
 * Provider selection (deterministic, in precedence order):
 *   1. If `ANTHROPIC_API_KEY` is set → `AnthropicProvider` (OQ-1 reference
 *      adapter; preserves existing behavior).
 *   2. Else if `COPILOT_API_KEY` is set → `CopilotProvider` (GitHub Models
 *      inference endpoint; per `.spectra/plans/copilot-vendor/spec.yaml`).
 *      Honors optional `COPILOT_MODEL` and `COPILOT_BASE_URL` overrides.
 *   3. Else if `OPENAI_API_KEY` is set → `OpenAIProvider` (OpenAI inference
 *      endpoint; supports deterministic seed). Honors optional `OPENAI_MODEL`
 *      and `OPENAI_BASE_URL` overrides.
 *   4. Otherwise → `FakeProvider` with an empty script — the dev stack
 *      boots without secrets, but every actual job will exhaust the script
 *      and fail terminal. This is the correct dev affordance: a worker
 *      that boots and logs `worker.started` but cannot service real work
 *      until the operator configures one of the API keys.
 *
 * Both real adapters use `maxTokensPerCall = MAX_TOKENS_PER_PR / 2` (a soft
 * cost-ceiling proxy per `docs/operational-runbooks.md` § Numeric tunables).
 * If both `ANTHROPIC_API_KEY` and `COPILOT_API_KEY` are set, Anthropic wins;
 * the operator must explicitly unset it to switch vendors. The chosen vendor
 * is observable via the `worker.provider.selected` log event.
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
 * Build the `Provider` instance per the documented selection rule. When no
 * vendor key is present the worker still boots with a no-script
 * `FakeProvider`; this is documented above.
 */
const buildProvider = async (secretSource: SecretSource): Promise<Provider> => {
  const anthropicKey = await tryGetSecret(secretSource, 'ANTHROPIC_API_KEY');
  if (anthropicKey !== undefined) {
    const opts: AnthropicProviderOptions = {
      apiKey: anthropicKey,
      maxTokensPerCall: Math.floor(MAX_TOKENS_PER_PR / 2),
    };
    log('worker.provider.selected', { provider: 'anthropic' });
    return new AnthropicProvider(opts);
  }
  const copilotKey = await tryGetSecret(secretSource, 'COPILOT_API_KEY');
  if (copilotKey !== undefined) {
    const opts: CopilotProviderOptions = {
      apiKey: copilotKey,
      maxTokensPerCall: Math.floor(MAX_TOKENS_PER_PR / 2),
    };
    const model = await tryGetSecret(secretSource, 'COPILOT_MODEL');
    if (model !== undefined) {
      opts.model = model;
    }
    const baseUrl = await tryGetSecret(secretSource, 'COPILOT_BASE_URL');
    if (baseUrl !== undefined) {
      opts.baseUrl = baseUrl;
    }
    log('worker.provider.selected', { provider: 'copilot' });
    return new CopilotProvider(opts);
  }
  const openaiKey = await tryGetSecret(secretSource, 'OPENAI_API_KEY');
  if (openaiKey !== undefined) {
    const opts: OpenAIProviderOptions = {
      apiKey: openaiKey,
      maxTokensPerCall: Math.floor(MAX_TOKENS_PER_PR / 2),
    };
    const model = await tryGetSecret(secretSource, 'OPENAI_MODEL');
    if (model !== undefined) {
      opts.model = model;
    }
    const baseUrl = await tryGetSecret(secretSource, 'OPENAI_BASE_URL');
    if (baseUrl !== undefined) {
      opts.baseUrl = baseUrl;
    }
    log('worker.provider.selected', { provider: 'openai' });
    return new OpenAIProvider(opts);
  }
  log('worker.provider.selected', {
    provider: 'fake',
    reason:
      'no vendor API key set (ANTHROPIC_API_KEY, COPILOT_API_KEY, OPENAI_API_KEY); using FakeProvider with empty script',
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
 * Build the `RepoLookup` callback. Resolution order (highest precedence first):
 *
 *   1. **Env-var override** — if `GITHUB_DEFAULT_OWNER` and
 *      `GITHUB_DEFAULT_REPO` are both set they take precedence over every
 *      other source.  This is the existing single-tenant escape hatch; it
 *      continues to work unchanged so that operators who rely on it are
 *      unaffected by this change.
 *   2. **Webhook payload fields** — `owner` and `repo` are carried from the
 *      GitHub `pull_request` webhook payload (`repository.owner.login` and
 *      `repository.name`) into the `JobPayload` by the server.  This is the
 *      primary production path and requires no extra GitHub API call.
 *   3. **Error** — if neither source yields a value the lookup throws a
 *      descriptive `Error` so the job fails fast with a clear log message
 *      instead of silently routing to `unknown-owner/unknown-repo`.  Old
 *      payloads (enqueued before this change) will hit this path; that is the
 *      correct behaviour for in-flight jobs that cannot be resolved.
 */
const buildRepoLookup = (secretSource: SecretSource): RepoLookup => {
  return async (params): Promise<RepoIdentity> => {
    const resolution = resolveRepoIdentity({
      payloadOwner: params.owner,
      payloadRepo: params.repo,
      envOwner: await tryGetSecret(secretSource, 'GITHUB_DEFAULT_OWNER'),
      envRepo: await tryGetSecret(secretSource, 'GITHUB_DEFAULT_REPO'),
      appIdRaw: await tryGetSecret(secretSource, 'GITHUB_APP_ID'),
      appLogin: await tryGetSecret(secretSource, 'GITHUB_APP_SLUG'),
    });

    if (!resolution.ok) {
      log('worker.repo_lookup.error', {
        installation_id: params.installation_id,
        repository_id: params.repository_id,
        missing: resolution.missing,
        message: resolution.message,
      });
      throw new Error(resolution.message);
    }

    log('worker.repo_lookup', {
      installation_id: params.installation_id,
      repository_id: params.repository_id,
      owner: resolution.identity.owner,
      repo: resolution.identity.repo,
      source: resolution.source,
    });
    return resolution.identity;
  };
};

/**
 * Fetch and parse the per-repo config from `.github/review-bot.yml` at the
 * given ref. Returns `{ config, notes }` where `notes` carries any parse
 * error description (config error → default config, review succeeds).
 *
 * Per spec § S4 / §6.1: config is per-job (each PR's repo has its own config);
 * the static `defaultRepoConfig()` is removed from the per-process scope.
 */
const fetchRepoConfig = async (
  octokit: OctokitLike,
  owner: string,
  repo: string,
  ref: string,
): Promise<{ config: RepoConfig; notes: string[] }> => {
  const fetcher = buildContentFetcher(octokit, owner, repo);
  const result = await fetcher.fetchText({
    path: REPO_LOCAL_CONFIG_PATH,
    ref,
    maxBytes: 65536,
  });

  if (!result.ok) {
    if (result.reason === 'missing') {
      // No config file → pure defaults, no note needed.
      return { config: loadRepoConfig({ yamlContents: null }), notes: [] };
    }
    // Other fetch error → defaults + note.
    return {
      config: loadRepoConfig({ yamlContents: null }),
      notes: [`config fetch failed (${result.reason}): using defaults`],
    };
  }

  try {
    const config = loadRepoConfig({ yamlContents: result.text });
    return { config, notes: [] };
  } catch (err) {
    if (err instanceof ConfigParseError) {
      log('worker.config.parse_error', { code: err.code, message: err.message });
      return {
        config: loadRepoConfig({ yamlContents: null }),
        notes: [`config error (${err.code}): ${err.message} — using defaults`],
      };
    }
    return {
      config: loadRepoConfig({ yamlContents: null }),
      notes: ['config parse error: unknown error — using defaults'],
    };
  }
};

const start = async (): Promise<void> => {
  const secretSource = envSecretSource();
  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('connect', () => log('worker.redis.connected', { redis_url: REDIS_URL }));
  connection.on('error', (err: Error) => log('worker.redis.error', { message: err.message }));

  const provider = await buildProvider(secretSource);
  const installationAuth = await buildInstallationAuth(secretSource);
  const repoLookup = buildRepoLookup(secretSource);

  const consumer = new BullMqJobConsumer({ connection });

  const handler = async (payload: JobPayload): Promise<JobOutcome> => {
    log('job.started', { idempotency_key: payload.idempotency_key });
    try {
      // Get an authenticated octokit for this job's installation.
      const octokit = await installationAuth.getOctokit(payload.installation_id);
      // Resolve repo identity first (needed for content fetcher).
      const identity = await repoLookup({
        installation_id: payload.installation_id,
        repository_id: payload.repository_id,
        ...(payload.owner !== undefined ? { owner: payload.owner } : {}),
        ...(payload.repo !== undefined ? { repo: payload.repo } : {}),
      });

      // D3: use head_sha for same-repo PRs as the default ref; without the
      // snapshot we don't yet know if it's a fork, so we use head_sha from
      // the payload (same-repo assumption). The orchestrator re-evaluates
      // this from the snapshot for context-file fetching (where fork matters).
      const configRef = payload.head_sha;

      const { config, notes: configNotes } = await fetchRepoConfig(
        octokit,
        identity.owner,
        identity.repo,
        configRef,
      );

      log('worker.config.loaded', {
        idempotency_key: payload.idempotency_key,
        owner: identity.owner,
        repo: identity.repo,
        ref: configRef,
        has_guidance:
          config.review_guidance.instructions !== undefined ||
          config.review_guidance.path_instructions.length > 0 ||
          config.review_guidance.context_files.length > 0,
        config_notes: configNotes.length,
      });

      const contentFetcher = buildContentFetcher(octokit, identity.owner, identity.repo);

      const result = await runPipeline(payload, {
        installationAuth,
        provider,
        config,
        repoLookup,
        octokit,
        contentFetcher,
        configNotes,
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
