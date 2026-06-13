import { ConfigParseError, REPO_LOCAL_CONFIG_PATH, loadRepoConfig } from '@prisma-bot/config';
import {
  type AppCredentials,
  InstallationAuth,
  type IssueCommentsClient,
  type OctokitLike,
  type SecretSource,
  buildContentFetcher,
  buildIssueCommentsClient,
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
  parseCommand,
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

/**
 * Build the text body for a `help` command reply.
 * The `marker` parameter is the configured command_marker (default `@`).
 */
const buildHelpReply = (botLogin: string, marker = '@'): string =>
  `### ${botLogin} — commands\n\n| Command | Description |\n|---|---|\n| \`${marker}${botLogin} review\` | Run an incremental review (skips already-posted findings) |\n| \`${marker}${botLogin} full review\` | Run a fresh review (re-evaluates all findings) |\n| \`${marker}${botLogin} help\` | Show this command reference |\n| \`${marker}${botLogin} configuration\` | Show the effective repo configuration |\n\nYou can also click **Re-run** on the "AI Code Review" check to trigger an incremental round.`;

/**
 * Build the text body for a `configuration` command reply.
 *
 * Includes `max_files` and `max_changed_lines` so operators can identify
 * which limit an oversized PR is hitting without reading the default docs.
 */
const buildConfigReply = (config: RepoConfig): string => {
  const lines: string[] = ['### Effective repo configuration\n', '```yaml'];
  lines.push(`mode: ${config.mode}`);
  if (config.model !== undefined) lines.push(`model: ${config.model}`);
  if (config.nickname !== undefined) lines.push(`nickname: ${config.nickname}`);
  // Always show command_marker so operators can confirm the active value.
  lines.push(`command_marker: "${config.command_marker}"`);
  // Size limits: always shown so operators can see which threshold an
  // oversized PR is hitting. Defaults are max_files=50, max_changed_lines=2000
  // (config-spec.md § max_files / § max_changed_lines).
  lines.push(`max_files: ${config.max_files}`);
  lines.push(`max_changed_lines: ${config.max_changed_lines}`);
  // Chunking settings: always shown so operators can diagnose large-PR behavior.
  // Per docs/config-spec.md § chunking.
  lines.push(
    'chunking:',
    `  enabled: ${String(config.chunking.enabled)}`,
    `  max_files: ${config.chunking.max_files}`,
    `  max_changed_lines: ${config.chunking.max_changed_lines}`,
    `  max_provider_calls_per_pr: ${config.chunking.max_provider_calls_per_pr}`,
    `  call_token_budget: ${config.chunking.call_token_budget}`,
  );
  lines.push(
    'repo_heuristics:',
    `  security: ${String(config.repo_heuristics.security)}`,
    `  tests: ${String(config.repo_heuristics.tests)}`,
    `  migrations: ${String(config.repo_heuristics.migrations)}`,
    `  layering: ${String(config.repo_heuristics.layering)}`,
  );
  const { review_guidance } = config;
  if (
    review_guidance.instructions !== undefined ||
    review_guidance.path_instructions.length > 0 ||
    review_guidance.context_files.length > 0
  ) {
    lines.push('review_guidance: (configured)');
  }
  lines.push('```');
  return lines.join('\n');
};

const start = async (): Promise<void> => {
  const secretSource = envSecretSource();
  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('connect', () => log('worker.redis.connected', { redis_url: REDIS_URL }));
  connection.on('error', (err: Error) => log('worker.redis.error', { message: err.message }));

  const provider = await buildProvider(secretSource);
  const installationAuth = await buildInstallationAuth(secretSource);
  const repoLookup = buildRepoLookup(secretSource);

  // Resolve the bot login once at startup. Used for loop prevention and
  // nickname resolution. The GITHUB_APP_SLUG env var carries the bot's login
  // (e.g. "mybot") and GitHub appends "[bot]" to it on comment authorship.
  const botLogin = (await tryGetSecret(secretSource, 'GITHUB_APP_SLUG')) ?? 'prisma-review-bot';
  const botCommentLogin = `${botLogin}[bot]`;

  const consumer = new BullMqJobConsumer({ connection });

  /**
   * Dispatch a comment job: ack with 👀, resolve nickname, dispatch command,
   * ack with ✅ + reply on success. All ack effects fail-open.
   */
  const handleCommentJob = async (
    payload: Extract<JobPayload, { event_type: 'issue_comment.command' }>,
    octokit: OctokitLike,
    issueComments: IssueCommentsClient,
    identity: RepoIdentity,
    config: RepoConfig,
    configNotes: string[],
  ): Promise<JobOutcome> => {
    const { owner, repo } = identity;
    const pr_number = payload.pull_request_number;
    const comment_id = payload.comment_id;

    // 1. Defensive loop prevention (worker-side): discard if comment author is a bot.
    if (payload.commenter_login === botCommentLogin || payload.commenter_login.endsWith('[bot]')) {
      log('command.loop_prevention', {
        idempotency_key: payload.idempotency_key,
        commenter_login: payload.commenter_login,
      });
      return { state: 'discarded_idempotent' };
    }

    // 2. Marker enforcement: drop if the marker used does not match the configured one.
    // command_marker defaults to '@' for old payloads that pre-date this field.
    const payloadMarker = payload.command_marker ?? '@';
    const configuredMarker = config.command_marker ?? '@';
    if (payloadMarker !== configuredMarker) {
      log('command.dropped_marker_mismatch', {
        idempotency_key: payload.idempotency_key,
        marker: payloadMarker,
        expected: configuredMarker,
        candidate: payload.mention_candidate,
      });
      return { state: 'discarded_idempotent' };
    }

    // 3. Nickname resolution (D2): bot_login ∪ { config.nickname if set }.
    // Case-insensitive comparison: GitHub mention semantics are case-insensitive.
    const candidateLower = payload.mention_candidate.toLowerCase();
    const validTargets = new Set<string>([botLogin.toLowerCase(), botCommentLogin.toLowerCase()]);
    if (config.nickname !== undefined) validTargets.add(config.nickname.toLowerCase());
    if (!validTargets.has(candidateLower)) {
      log('command.dropped_nickname_mismatch', {
        idempotency_key: payload.idempotency_key,
        candidate: payload.mention_candidate,
        bot_login: botLogin,
        nickname: config.nickname,
      });
      return { state: 'discarded_idempotent' };
    }

    // 4. Post 👀 reaction (fail-open) — only after marker + identity validation,
    // so the bot never reacts to comments addressed to other people.
    try {
      await issueComments.addReaction({ owner, repo, comment_id, content: 'eyes' });
    } catch (err) {
      log('command.ack.eyes_failed', {
        idempotency_key: payload.idempotency_key,
        message: err instanceof Error ? err.message : 'unknown',
      });
    }

    // 5. Parse command (authoritative; command_raw was set at ingress).
    const cmd = parseCommand(payload.command_raw);

    log('command.dispatching', {
      idempotency_key: payload.idempotency_key,
      command_kind: cmd.kind,
    });

    // 6. Dispatch.
    try {
      if (cmd.kind === 'help') {
        const body = buildHelpReply(botLogin, configuredMarker);
        await issueComments.createReply({ owner, repo, issue_number: pr_number, body });
      } else if (cmd.kind === 'configuration') {
        const body = buildConfigReply(config);
        await issueComments.createReply({ owner, repo, issue_number: pr_number, body });
      } else {
        // review or full_review: resolve head sha, then run the pipeline.
        const roundIntent: 'incremental' | 'full' =
          cmd.kind === 'full_review' ? 'full' : 'incremental';

        // Fetch the live PR head sha (sentinel '' was set at ingress).
        const prData = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: pr_number,
        });
        const resolvedHeadSha = prData.data.head.sha;

        const contentFetcher = buildContentFetcher(octokit, owner, repo);
        const result = await runPipeline(payload, {
          installationAuth,
          provider,
          config,
          repoLookup,
          octokit,
          contentFetcher,
          configNotes,
          roundIntent,
          resolvedHeadSha,
        });
        if (result.state !== 'succeeded') {
          // Post a friendly error reply.
          try {
            await issueComments.createReply({
              owner,
              repo,
              issue_number: pr_number,
              body: 'Sorry, I encountered an error while running the review. Please try again later.',
            });
          } catch {
            // fail-open
          }
          return { state: 'failed_terminal', reason: result.reason ?? 'pipeline_failed' };
        }

        // 7. Post ✅ reaction + outcome-aware reply.
        //
        // Branch on result.outcome so the reply accurately reflects what
        // happened (per the logged real-world case: reason=too_many_changed_lines
        // previously caused a misleading "Review complete!" reply).
        //
        // - oversized          → explain which limit was hit, cite numbers and
        //                        the config pointer (.github/review-bot.yml).
        // - no_findings        → the review ran clean; no issues were found.
        // - review_complete    → normal success: direct the user to the check run.
        // - anything else      → fall back to the generic check-run pointer.
        try {
          await issueComments.addReaction({ owner, repo, comment_id, content: '+1' });
        } catch (err) {
          log('command.ack.plus1_failed', {
            idempotency_key: payload.idempotency_key,
            message: err instanceof Error ? err.message : 'unknown',
          });
        }
        let replyBody: string;
        if (result.outcome?.kind === 'oversized') {
          const { detail } = result.outcome;
          const limitClause =
            detail.prefilter_reason === 'too_many_changed_lines'
              ? `${detail.lines_considered.toLocaleString('en-US')} changed lines across ${detail.files_considered} files (limit: \`max_changed_lines=${detail.max_changed_lines}\`, \`max_files=${detail.max_files}\`)`
              : `${detail.files_considered} files (limit: \`max_files=${detail.max_files}\`, \`max_changed_lines=${detail.max_changed_lines}\`)`;
          replyBody = `Review skipped — this PR exceeds the configured size limit: ${limitClause}. Raise the limits in \`.github/review-bot.yml\` or split the PR. The **AI Code Review** check run shows the same notice.`;
        } else if (result.outcome?.kind === 'review_complete_chunked') {
          const { detail } = result.outcome;
          const baseLine = `Reviewed your large PR in ${detail.batch_count} section(s).`;
          const partialNote =
            detail.failed_batches.length > 0
              ? ` ${detail.failed_batches.length} of ${detail.batch_count} section(s) could not be analyzed and were skipped.`
              : '';
          const skippedFileNote =
            detail.skipped_files.length > 0
              ? ` ${detail.skipped_files.length} file(s) were too large to analyze individually and were skipped.`
              : '';
          replyBody = `${baseLine}${partialNote}${skippedFileNote} Check the **AI Code Review** check run for results.`;
        } else if (result.outcome?.kind === 'no_findings') {
          replyBody =
            'Review complete — no issues found. Check the **AI Code Review** check run for the full summary.';
        } else {
          replyBody = 'Review complete! Check the **AI Code Review** check run for results.';
        }
        try {
          await issueComments.createReply({
            owner,
            repo,
            issue_number: pr_number,
            body: replyBody,
          });
        } catch (err) {
          log('command.ack.reply_failed', {
            idempotency_key: payload.idempotency_key,
            message: err instanceof Error ? err.message : 'unknown',
          });
        }
        if (result.publication === undefined) {
          return { state: 'discarded_idempotent' };
        }
        return {
          state: 'succeeded',
          result: result.publication,
        };
      }

      // For help/configuration: also post ✅ reaction.
      try {
        await issueComments.addReaction({ owner, repo, comment_id, content: '+1' });
      } catch (err) {
        log('command.ack.plus1_failed', {
          idempotency_key: payload.idempotency_key,
          message: err instanceof Error ? err.message : 'unknown',
        });
      }

      return { state: 'discarded_idempotent' };
    } catch (err) {
      // Post a reply that accurately reflects the failure reason (fail-open).
      //
      // For ProviderErrorThrowable with kind === 'auth' or 'capability', post a
      // specific, operator-actionable reply instead of the generic error message.
      // This ensures exactly ONE clear reply for provider errors: the orchestrator
      // already published the check-run notice; this reply adds the comment-level
      // signal pointing the operator at the root cause.
      //
      // For capability: make it explicit that this is NOT a PR-size limit so the
      // operator doesn't conflate it with the oversized path (the real-world
      // incident that prompted this change: tiny PR → model rejection → looked
      // identical to oversized).
      //
      // Still re-throw ProviderErrorThrowable afterward so the consumer can mark
      // the job failed_terminal (terminal classification is done in the consumer
      // wrapper, not here).
      if (err instanceof ProviderErrorThrowable) {
        const { kind } = err.value;
        if (kind === 'capability' || kind === 'auth') {
          // err.value.message is always non-empty (required by ProviderErrorSchema).
          const safeMsg = err.value.message;
          let providerReply: string;
          if (kind === 'capability') {
            providerReply = `⚠️ Review unavailable — the AI provider rejected the request (capability: ${safeMsg}). This usually means the configured model is unavailable to your API key or incompatible with this integration. Check the \`model\` setting in \`.github/review-bot.yml\` (or the provider's model env var). This is **not** a PR-size limit — the check run shows the same notice.`;
          } else {
            providerReply = `⚠️ Review unavailable — the AI provider rejected the credentials (authentication failure: ${safeMsg}). Check the provider API key. The **AI Code Review** check run shows the same notice.`;
          }
          try {
            await issueComments.createReply({
              owner,
              repo,
              issue_number: pr_number,
              body: providerReply,
            });
          } catch {
            // fail-open
          }
          throw err;
        }
        // Other provider error kinds (transport, rate_limited): post the generic
        // message and re-throw for retry classification by the consumer.
        try {
          await issueComments.createReply({
            owner,
            repo,
            issue_number: pr_number,
            body: 'Sorry, I encountered an error while processing your request. Please try again later.',
          });
        } catch {
          // fail-open
        }
        throw err;
      }
      // Non-provider errors: post generic message and log.
      try {
        await issueComments.createReply({
          owner,
          repo,
          issue_number: pr_number,
          body: 'Sorry, I encountered an error while processing your request. Please try again later.',
        });
      } catch {
        // fail-open
      }
      log('command.dispatch_error', {
        idempotency_key: payload.idempotency_key,
        message: err instanceof Error ? err.message : 'unknown',
      });
      throw err;
    }
  };

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
      // For comment/check_run jobs, head_sha may be absent until pulls.get
      // is called (Track 6 worker dispatch). Fall back to 'HEAD' so the
      // config loader uses the default branch ref.
      const configRef =
        'head_sha' in payload && typeof payload.head_sha === 'string' && payload.head_sha.length > 0
          ? payload.head_sha
          : 'HEAD';

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
        has_nickname: config.nickname !== undefined,
        config_notes: configNotes.length,
      });

      // Route by event_type.
      if (payload.event_type === 'issue_comment.command') {
        const issueComments = buildIssueCommentsClient(octokit);
        return await handleCommentJob(
          payload,
          octokit,
          issueComments,
          identity,
          config,
          configNotes,
        );
      }

      // check_run.rerequested: incremental review (same as pull_request.* path).
      // For pull_request.* and check_run.rerequested, use runPipeline directly.
      const contentFetcher = buildContentFetcher(octokit, identity.owner, identity.repo);
      const roundIntent: 'incremental' | 'full' = 'incremental';

      const result = await runPipeline(payload, {
        installationAuth,
        provider,
        config,
        repoLookup,
        octokit,
        contentFetcher,
        configNotes,
        roundIntent,
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
