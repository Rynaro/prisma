import {
  type AugmentationCaps,
  type SnapshotterOctokitLike,
  fetchPrSnapshot,
  resolveAugmentation,
  runPrefilter,
  runRanker,
  runValidator,
} from '@prisma-bot/core';
import {
  type ContentFetcher,
  type InstallationAuth,
  type OctokitLike,
  type PublishContext,
  type PublisherDeps,
  buildCheckRunsClient,
  buildReviewCommentsClient,
  publish as defaultPublish,
} from '@prisma-bot/github';
import {
  type CustomGuidance,
  type Hunk,
  type JobPayload,
  MAX_AUGMENTATION_TOKENS,
  MAX_CONTEXT_FILE_BYTES,
  type NormalizedFinding,
  type PrSnapshot,
  type PrefilteredFile,
  type Provider,
  ProviderErrorThrowable,
  type ProviderReviewInput,
  type ProviderReviewOutput,
  type PublicationResult,
  type RankedFindings,
  type RejectionLogEntry,
  type RepoConfig,
} from '@prisma-bot/shared';

/**
 * `runPipeline` — single-function orchestrator that wires the Phase 5.1–5.5
 * stages into the end-to-end sequence per `docs/system-design.md`
 * § End-to-end sequence:
 *
 *   1. Resolve an `OctokitLike` for the installation (or use `deps.octokit`).
 *   2. Fetch the PR snapshot.
 *   3. Run the prefilter; on `oversized` short-circuit to a summary-only
 *      publication per `docs/publication-policy.md` § Diff too large.
 *   4. Call the provider; classify the throwable per
 *      `docs/system-design.md` § Error taxonomy mapping.
 *   5. Run the validator and ranker.
 *   6. Publish.
 *
 * The function is the only place that knows about the queue framework's
 * retry policy: it re-throws transient and rate-limited errors so the
 * caller (the BullMQ consumer) can apply exponential backoff. Non-transient
 * errors (auth/capability/schema_validation) are handled here so the user
 * sees a "review unavailable" Checks run before the job marks terminal.
 *
 * Logging discipline (per `docs/observability.md`):
 *   - One event per stage: prefilter.{accepted,skipped}, provider.{called,error},
 *     validator.rejected, ranker.dropped, publisher.{published,dropped}.
 *   - `traceparent` from the JobPayload is propagated to every log entry.
 *   - No raw provider output, finding text, or diff content is logged.
 */

export interface RepoIdentity {
  owner: string;
  repo: string;
  /** GitHub App identity for the publisher's `PublishContext`. */
  app_id: number;
  app_login: string;
}

export type RepoLookup = (params: {
  installation_id: number;
  repository_id: number;
  /** Optional: repo owner login carried from the webhook payload. */
  owner?: string;
  /** Optional: repo name carried from the webhook payload. */
  repo?: string;
}) => Promise<RepoIdentity>;

export type LogEvent =
  | 'job.started'
  | 'prefilter.accepted'
  | 'prefilter.skipped'
  | 'provider.called'
  | 'provider.output'
  | 'provider.error'
  | 'validator.rejected'
  | 'ranker.dropped'
  | 'publisher.published'
  | 'publisher.dropped'
  | 'job.terminal';

export interface PipelineLogger {
  emit(event: LogEvent, fields: Record<string, unknown>): void;
}

const buildDefaultLogger = (): PipelineLogger => ({
  emit(event, fields) {
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        event,
        ...fields,
      })}\n`,
    );
  },
});

export interface SnapshotterCall {
  installation_id: number;
  repository_id: number;
  owner: string;
  repo: string;
  pull_request_number: number;
}

export interface OrchestratorHooks {
  fetchSnapshot?: (octokit: OctokitLike, params: SnapshotterCall) => Promise<PrSnapshot>;
  runPublish?: (
    ranked: RankedFindings,
    cfg: RepoConfig,
    ctx: PublishContext,
    deps: PublisherDeps,
    roundIntent?: 'incremental' | 'full',
    notice?: string,
  ) => Promise<PublicationResult>;
}

export interface OrchestratorDeps {
  installationAuth: InstallationAuth;
  provider: Provider;
  config: RepoConfig;
  /** Resolves owner/repo and App identity for an installation/repo pair. */
  repoLookup: RepoLookup;
  /** Test seam: skip the InstallationAuth path and use this client directly. */
  octokit?: OctokitLike;
  /** Clock for created_at timestamps; default `() => new Date().toISOString()`. */
  now?: () => string;
  /** Test seam: id generator. Default uses run_id + counter. */
  generateId?: () => string;
  /** Logger; defaults to a JSON-line writer to stdout. */
  logger?: PipelineLogger;
  /** Hooks for snapshotter / publisher; tests inject simpler implementations. */
  hooks?: OrchestratorHooks;
  /**
   * Fetcher for repository files (config + context files). Optional: when
   * absent, augmentation falls back to instructions/path_instructions only
   * (no context-file fetch). Tests and evals that don't exercise context files
   * can omit this.
   */
  contentFetcher?: ContentFetcher;
  /**
   * Notes surfaced by the worker's config-fetch step (e.g. config parse
   * errors). Passed through to the OrchestratorResult so the publisher can
   * include them in the summary. Optional.
   */
  configNotes?: string[];
  /**
   * Round intent: 'incremental' (default) or 'full'. When 'full', the publisher
   * ignores prior dedupe keys and reviews fresh. Threaded from the job payload
   * (Track 5).
   */
  roundIntent?: 'incremental' | 'full';
  /**
   * Resolved head SHA to use for the publish context. Required when the job
   * payload carries an empty head_sha sentinel (comment jobs). The worker
   * resolves this via pulls.get before calling runPipeline.
   */
  resolvedHeadSha?: string;
}

/**
 * Detail carried when the prefilter short-circuited due to an oversized PR.
 * Fields mirror the `PrefilterOutcome` oversized branch plus the configured
 * limits so callers can compose human-readable messages without re-fetching
 * config.
 */
export interface OversizedDetail {
  /** Which limit was exceeded. */
  prefilter_reason: 'too_many_files' | 'too_many_changed_lines';
  files_considered: number;
  lines_considered: number;
  /** Configured limit from `config.max_files`. */
  max_files: number;
  /** Configured limit from `config.max_changed_lines`. */
  max_changed_lines: number;
}

/**
 * Detail carried when the pipeline terminated due to a non-transient provider
 * error. Mirrors the `ProviderError` kind so callers can compose user-visible
 * messages that distinguish auth vs. capability failures without inspecting
 * log events.
 */
export interface ReviewUnavailableDetail {
  /** Which provider error kind caused the unavailability. */
  provider_error_kind: 'auth' | 'capability';
  /**
   * The safe, redaction-scrubbed message from `err.value.message`. Present when
   * the provider error carries a non-empty message; absent otherwise. The message
   * originates from the provider adapter's `safeMessage` mapping and is safe to
   * surface to operators (no credential, no raw HTTP body).
   */
  message?: string;
}

/**
 * Discriminated outcome union surfaced by `runPipeline`. Callers use this to
 * compose user-visible messages that reflect what actually happened, rather than
 * treating every succeeded result as a completed review.
 *
 * - `'review_complete'`  — provider was called; findings (if any) were ranked
 *   and published. "Review complete!" is appropriate.
 * - `'oversized'`        — prefilter short-circuited; `oversized_detail` carries
 *   the specifics (reason, counts, limits). PR was not reviewed.
 * - `'no_findings'`      — provider was called but no analyzable files remained
 *   after prefilter (e.g. pure-delete or all-generated diff). Review ran clean.
 * - `'review_unavailable'` — non-transient provider error (auth / capability).
 *   `detail` carries the provider_error_kind and the safe message so callers
 *   can compose specific, actionable replies instead of a generic failure.
 * - `'malformed_provider_output'` — provider output failed schema validation;
 *   job terminated cleanly without retry.
 */
export type PipelineOutcome =
  | { kind: 'review_complete' }
  | { kind: 'oversized'; detail: OversizedDetail }
  | { kind: 'no_findings' }
  | { kind: 'review_unavailable'; detail: ReviewUnavailableDetail }
  | { kind: 'malformed_provider_output' };

export interface OrchestratorResult {
  state: 'succeeded' | 'failed_terminal';
  publication?: PublicationResult;
  reason?: string;
  rejections: RejectionLogEntry[];
  /** Notes from config-fetch / augmentation (config errors, skipped files, etc.). */
  config_notes?: string[];
  /**
   * Discriminated outcome that lets callers distinguish pipeline paths without
   * inspecting log events. Absent only on `failed_terminal` states where the
   * pipeline did not return a result (re-threw). Always present on `succeeded`.
   * For `review_unavailable` the outcome carries a `detail` field with the
   * provider error kind and the safe message so the worker catch block can post
   * a specific reply without re-inspecting the thrown error.
   *
   * NOTE: The auth/capability branch in the provider catch re-throws after
   * publishing. The outcome is therefore NOT readable from a return value by
   * the outer caller — it is instead inspected in the worker's inner catch
   * via `err instanceof ProviderErrorThrowable` (see item 5 of the spec).
   */
  outcome?: PipelineOutcome;
}

const buildSyntheticEmptyOutput = (): {
  empty_findings: NormalizedFinding[];
} => ({ empty_findings: [] });

const traceFields = (payload: JobPayload): Record<string, unknown> => {
  const fields: Record<string, unknown> = {
    installation_id: payload.installation_id,
    repository_id: payload.repository_id,
    pull_request_number: payload.pull_request_number,
    idempotency_key: payload.idempotency_key,
  };
  if (payload.traceparent !== undefined) fields.traceparent = payload.traceparent;
  return fields;
};

const buildProviderInput = (
  files: PrefilteredFile[],
  cfg: RepoConfig,
  guidance?: CustomGuidance,
): ProviderReviewInput => {
  const heuristics: Record<string, boolean> = {
    security: cfg.repo_heuristics.security,
    tests: cfg.repo_heuristics.tests,
    migrations: cfg.repo_heuristics.migrations,
    layering: cfg.repo_heuristics.layering,
  };
  // Drop the empty `content` strings from each Hunk so the provider input
  // matches the schema's positive-int constraints. The hunks are passed
  // through unchanged.
  const sanitizedFiles: PrefilteredFile[] = files.map((file) => {
    const hunks: Hunk[] = file.hunks.map((h) => ({
      id: h.id,
      line_start: h.line_start,
      line_end: h.line_end,
      content: h.content,
    }));
    const result: PrefilteredFile = { path: file.path, hunks };
    if (file.language !== undefined) {
      return { ...result, language: file.language };
    }
    return result;
  });
  const input: ProviderReviewInput = {
    files: sanitizedFiles,
    repo_heuristics: heuristics,
  };
  if (cfg.model !== undefined) {
    input.request_shaping = { model: cfg.model };
  }
  if (guidance !== undefined) {
    input.custom_guidance = guidance;
  }
  return input;
};

const buildPublishContext = (
  payload: JobPayload,
  identity: RepoIdentity,
  resolvedHeadSha?: string,
): PublishContext => ({
  owner: identity.owner,
  repo: identity.repo,
  installation_id: payload.installation_id,
  repository_id: payload.repository_id,
  pull_request_number: payload.pull_request_number,
  head_sha:
    resolvedHeadSha ??
    ('head_sha' in payload && typeof payload.head_sha === 'string' ? payload.head_sha : ''),
  app_id: identity.app_id,
  app_login: identity.app_login,
  run_id: payload.idempotency_key,
});

const publisherDepsFor = (octokit: OctokitLike): PublisherDeps => ({
  checkRuns: buildCheckRunsClient(octokit),
  reviewComments: buildReviewCommentsClient(octokit),
});

interface FailureSummaryArgs {
  payload: JobPayload;
  identity: RepoIdentity;
  octokit: OctokitLike;
  cfg: RepoConfig;
  hooks: OrchestratorHooks;
  reason: 'review_unavailable' | 'oversized' | 'no_findings' | 'malformed_provider_output';
  reasonMessage: string;
  rejections: RejectionLogEntry[];
  resolvedHeadSha?: string | undefined;
  /**
   * Optional notice/preamble prepended to the check-run summary body. When
   * provided, it is forwarded through publish → planPublication → renderSummary
   * so the check-run body explains the outcome instead of just showing
   * "_No findings._". Does not alter the plan partition invariant.
   */
  notice?: string;
}

const publishSummaryOnly = async (args: FailureSummaryArgs): Promise<PublicationResult> => {
  const ctx = buildPublishContext(args.payload, args.identity, args.resolvedHeadSha);
  const deps = publisherDepsFor(args.octokit);
  const publishFn = args.hooks.runPublish ?? defaultPublish;
  // Force a summary-only publication regardless of the configured mode by
  // overriding the mode on a shallow copy of the config. Per
  // `publication-policy.md` § Diff too large the publisher emits
  // "summary-only output regardless of the configured `mode`".
  const summaryOnlyCfg: RepoConfig = { ...args.cfg, mode: 'summary-only' };
  const empty: RankedFindings = buildSyntheticEmptyOutput().empty_findings;
  return publishFn(empty, summaryOnlyCfg, ctx, deps, undefined, args.notice);
};

const fetchSnapshotDefault = async (
  octokit: OctokitLike,
  params: SnapshotterCall,
): Promise<PrSnapshot> =>
  fetchPrSnapshot({
    // The snapshotter's OctokitLike is a strict subset of this package's
    // OctokitLike — pull-request methods only — so the structural assignment
    // is safe without a cast.
    octokit: octokit as unknown as SnapshotterOctokitLike,
    installation_id: params.installation_id,
    repository_id: params.repository_id,
    owner: params.owner,
    repo: params.repo,
    pull_request_number: params.pull_request_number,
  });

export const runPipeline = async (
  payload: JobPayload,
  deps: OrchestratorDeps,
): Promise<OrchestratorResult> => {
  const logger = deps.logger ?? buildDefaultLogger();
  const hooks = deps.hooks ?? {};
  const now = deps.now ?? (() => new Date().toISOString());
  const trace = traceFields(payload);

  logger.emit('job.started', { ...trace, event_type: payload.event_type });

  const identity = await deps.repoLookup({
    installation_id: payload.installation_id,
    repository_id: payload.repository_id,
    ...(payload.owner !== undefined ? { owner: payload.owner } : {}),
    ...(payload.repo !== undefined ? { repo: payload.repo } : {}),
  });

  const octokit = deps.octokit ?? (await deps.installationAuth.getOctokit(payload.installation_id));

  const fetchSnapshot = hooks.fetchSnapshot ?? fetchSnapshotDefault;

  const snapshot = await fetchSnapshot(octokit, {
    installation_id: payload.installation_id,
    repository_id: payload.repository_id,
    owner: identity.owner,
    repo: identity.repo,
    pull_request_number: payload.pull_request_number,
  });

  // Stage: prefilter.
  const prefilter = runPrefilter({ snapshot, config: deps.config });
  if (prefilter.kind === 'oversized') {
    logger.emit('prefilter.skipped', {
      ...trace,
      reason: prefilter.reason,
      files_considered: prefilter.files_considered,
      lines_considered: prefilter.lines_considered,
    });
    // Build the structured outcome so the worker can compose a user-visible
    // message without re-fetching config.
    const oversizedDetail: OversizedDetail = {
      prefilter_reason: prefilter.reason,
      files_considered: prefilter.files_considered,
      lines_considered: prefilter.lines_considered,
      max_files: deps.config.max_files,
      max_changed_lines: deps.config.max_changed_lines,
    };
    // Build the check-run summary notice per
    // `docs/publication-policy.md` § Diff too large. The notice explains
    // which limit was hit, the measured values, and the remediation hint.
    // Numbers come from the prefilter outcome and the resolved config.
    const limitClause =
      prefilter.reason === 'too_many_changed_lines'
        ? `${prefilter.lines_considered.toLocaleString('en-US')} changed lines considered across ${prefilter.files_considered} files; limit: max_changed_lines=${deps.config.max_changed_lines}, max_files=${deps.config.max_files}`
        : `${prefilter.files_considered} files considered; limit: max_files=${deps.config.max_files}, max_changed_lines=${deps.config.max_changed_lines}`;
    const oversizedNotice = `⚠️ Review skipped — this PR exceeds the configured size limit (${limitClause}). Raise the limits in \`.github/review-bot.yml\` or split the PR.`;
    const publication = await publishSummaryOnly({
      payload,
      identity,
      octokit,
      cfg: deps.config,
      hooks,
      reason: 'oversized',
      reasonMessage: `prefilter oversized: ${prefilter.reason}`,
      rejections: [],
      resolvedHeadSha: deps.resolvedHeadSha,
      notice: oversizedNotice,
    });
    logger.emit('publisher.published', {
      ...trace,
      mode: 'summary-only',
      reason: 'oversized',
      inline_count: publication.published_inline.length,
      summary_count: publication.published_summary.length,
    });
    logger.emit('job.terminal', { ...trace, state: 'succeeded' });
    return {
      state: 'succeeded',
      publication,
      rejections: publication.rejections,
      outcome: { kind: 'oversized', detail: oversizedDetail },
    };
  }

  logger.emit('prefilter.accepted', {
    ...trace,
    files: prefilter.files.length,
    skipped: prefilter.skipped.length,
  });

  if (prefilter.files.length === 0) {
    // No analyzable files: skip the provider call and publish a no-findings
    // summary. The publisher renders the "no findings" markdown body via
    // the planner's `mode === 'summary-only'` path.
    const publication = await publishSummaryOnly({
      payload,
      identity,
      octokit,
      cfg: deps.config,
      hooks,
      reason: 'no_findings',
      reasonMessage: 'no analyzable files in PR after prefilter',
      rejections: [],
      resolvedHeadSha: deps.resolvedHeadSha,
    });
    logger.emit('publisher.published', {
      ...trace,
      mode: 'summary-only',
      reason: 'no_findings',
      inline_count: publication.published_inline.length,
      summary_count: publication.published_summary.length,
    });
    logger.emit('job.terminal', { ...trace, state: 'succeeded' });
    return {
      state: 'succeeded',
      publication,
      rejections: publication.rejections,
      outcome: { kind: 'no_findings' },
    };
  }

  // Stage: augmentation resolution.
  // Resolve custom guidance (path-instruction matching + context-file fetch)
  // after prefilter so we have the final changed-path list. Uses the trust-
  // anchor ref from the snapshot (D3): same-repo → head_sha; fork → default_branch.
  const augCaps: AugmentationCaps = {
    maxTokens: MAX_AUGMENTATION_TOKENS,
    maxContextFileBytes: MAX_CONTEXT_FILE_BYTES,
  };
  const configRef = snapshot.is_fork === true ? snapshot.default_branch : snapshot.head_sha;
  const changedPaths = prefilter.files.map((f) => f.path);
  const allNotes: string[] = [...(deps.configNotes ?? [])];
  let resolvedGuidance: CustomGuidance | undefined;
  if (deps.contentFetcher !== undefined) {
    const augResult = await resolveAugmentation({
      guidance: deps.config.review_guidance,
      changedPaths,
      fetcher: deps.contentFetcher,
      ref: configRef,
      caps: augCaps,
    });
    resolvedGuidance = augResult.guidance;
    allNotes.push(...augResult.notes);
  } else {
    // No content fetcher: resolve instructions + path_instructions locally
    // (no context-file fetch). The augmentation resolver handles a null fetcher
    // by returning skip notes; we simulate the no-fetch path inline.
    const augResult = await resolveAugmentation({
      guidance: deps.config.review_guidance,
      changedPaths,
      fetcher: {
        async fetchText() {
          return { ok: false as const, reason: 'error' as const };
        },
      },
      ref: configRef,
      caps: augCaps,
    });
    resolvedGuidance = augResult.guidance;
    // Don't surface "error" notes for the no-fetcher path; context files are
    // simply not requested when no fetcher is present.
    const contextFileNotes = augResult.notes.filter((n) => n.includes('skipped: error'));
    if (contextFileNotes.length === 0) {
      allNotes.push(...augResult.notes);
    } else {
      // Only surface non-error notes (e.g. truncation notes if any).
      allNotes.push(...augResult.notes.filter((n) => !n.includes('skipped: error')));
    }
  }

  // Stage: provider.
  const providerInput = buildProviderInput(prefilter.files, deps.config, resolvedGuidance);
  logger.emit('provider.called', { ...trace, provider: deps.provider.name });
  let providerOutput: ProviderReviewOutput;
  try {
    providerOutput = await deps.provider.review(providerInput);
    logger.emit('provider.output', { ...trace, findings_count: providerOutput.findings.length });
  } catch (err) {
    if (err instanceof ProviderErrorThrowable) {
      const kind = err.value.kind;
      // Log the safe message and retryable flag so operators can distinguish
      // e.g. `context_length_exceeded` from `model_not_found`. The message
      // originates from the provider adapter's `safeMessage` mapping and has
      // already been redaction-scrubbed (per docs/observability.md § Provider
      // error logging). `retryable` is optional on all ProviderError variants
      // (ProviderErrorSchema § ProviderErrorBase); include it when present.
      const providerErrorLogFields: Record<string, unknown> = {
        ...trace,
        kind,
        provider: deps.provider.name,
        message: err.value.message,
        ...(err.value.retryable !== undefined ? { retryable: err.value.retryable } : {}),
      };
      logger.emit('provider.error', providerErrorLogFields);
      if (kind === 'schema_validation') {
        // Drop with audit log; never downgrade.
        // Per `publication-policy.md` § Malformed ProviderReviewOutput we
        // publish a summary explaining the failure category but emit
        // `succeeded` here so the job is not retried (we already drained
        // the provider call).
        const rejection: RejectionLogEntry = {
          finding_id: null,
          stage: 'validator',
          reason_code: 'provider_output_zod_failed',
          reason_message: 'provider returned malformed output',
          provider_output_excerpt: '',
          timestamp: now(),
        };
        const publication = await publishSummaryOnly({
          payload,
          identity,
          octokit,
          cfg: deps.config,
          hooks,
          reason: 'malformed_provider_output',
          reasonMessage: 'review unavailable: provider returned malformed output',
          rejections: [rejection],
          resolvedHeadSha: deps.resolvedHeadSha,
        });
        logger.emit('publisher.published', {
          ...trace,
          mode: 'summary-only',
          reason: 'malformed_provider_output',
          inline_count: publication.published_inline.length,
          summary_count: publication.published_summary.length,
        });
        logger.emit('job.terminal', { ...trace, state: 'succeeded' });
        return {
          state: 'succeeded',
          publication,
          rejections: [rejection, ...publication.rejections],
          outcome: { kind: 'malformed_provider_output' },
        };
      }
      if (kind === 'auth' || kind === 'capability') {
        // Non-transient: publish a "review unavailable" summary so the user
        // sees a status, then re-throw so the consumer marks terminal.
        // Per `publication-policy.md` § Provider error (non-transient).
        //
        // Build a check-run notice that:
        //   - explains the failure category (auth vs capability) in plain English;
        //   - cites the safe message inline where available so operators can act;
        //   - for capability, explicitly states this is NOT a PR-size limit
        //     (per the real-world incident: tiny PR → model rejection → looked
        //      identical to the oversized path to the operator).
        // err.value.message is always non-empty (required by ProviderErrorSchema).
        // It originates from the provider adapter's safeMessage mapping and has
        // been redaction-scrubbed before being stored on the error value.
        const safeMsg = err.value.message;
        const providerNotice =
          kind === 'capability'
            ? `⚠️ Review unavailable — the AI provider rejected the request (capability: ${safeMsg}). This usually means the configured model is unavailable to your API key or incompatible with this integration. Check the model setting in \`.github/review-bot.yml\` (or the provider's model env var). This is not a PR-size limit.`
            : `⚠️ Review unavailable — the AI provider rejected the credentials (authentication failure: ${safeMsg}). Check the provider API key.`;
        try {
          await publishSummaryOnly({
            payload,
            identity,
            octokit,
            cfg: deps.config,
            hooks,
            reason: 'review_unavailable',
            reasonMessage:
              kind === 'auth'
                ? 'review unavailable: provider authentication failure'
                : 'review unavailable: provider capability missing',
            rejections: [],
            resolvedHeadSha: deps.resolvedHeadSha,
            notice: providerNotice,
          });
          logger.emit('publisher.published', {
            ...trace,
            mode: 'summary-only',
            reason: 'review_unavailable',
            provider_error_kind: kind,
          });
        } catch (publishErr) {
          // Best-effort publish; if it also fails, fall through and let the
          // outer caller record the terminal failure.
          logger.emit('publisher.dropped', {
            ...trace,
            reason: 'publish_failed_during_provider_error',
            provider_error_kind: kind,
            message: publishErr instanceof Error ? publishErr.message : 'unknown publish error',
          });
        }
        logger.emit('job.terminal', { ...trace, state: 'failed_terminal', reason: kind });
      }
      throw err;
    }
    // Unknown error: re-throw for retry classification by the consumer.
    logger.emit('provider.error', {
      ...trace,
      kind: 'unknown',
      message: err instanceof Error ? err.message : 'unknown',
    });
    throw err;
  }

  // Stage: validator.
  const validatorResult = runValidator(providerOutput, {
    snapshot,
    config: deps.config,
    run_id: payload.idempotency_key,
    ran_at: now(),
    ...(deps.generateId !== undefined ? { generateId: deps.generateId } : {}),
  });
  if (validatorResult.rejections.length > 0) {
    logger.emit('validator.rejected', {
      ...trace,
      count: validatorResult.rejections.length,
      rejections: validatorResult.rejections.map((r) => ({
        finding_id: r.finding_id,
        stage: r.stage,
        reason_code: r.reason_code,
        reason_message: r.reason_message,
        provider_output_excerpt: r.provider_output_excerpt,
        timestamp: r.timestamp,
      })),
    });
  }

  // Stage: ranker.
  const ranked = runRanker(validatorResult.findings);

  // Stage: publisher.
  const publishFn = hooks.runPublish ?? defaultPublish;
  const ctx = buildPublishContext(payload, identity, deps.resolvedHeadSha);
  const publisherDeps = publisherDepsFor(octokit);
  const publication = await publishFn(
    ranked,
    deps.config,
    ctx,
    publisherDeps,
    deps.roundIntent ?? 'incremental',
  );

  if (publication.dropped.length > 0) {
    logger.emit('publisher.dropped', { ...trace, count: publication.dropped.length });
  }
  logger.emit('publisher.published', {
    ...trace,
    mode: deps.config.mode,
    inline_count: publication.published_inline.length,
    summary_count: publication.published_summary.length,
  });
  logger.emit('job.terminal', { ...trace, state: 'succeeded' });

  return {
    state: 'succeeded',
    publication,
    rejections: [...validatorResult.rejections, ...publication.rejections],
    ...(allNotes.length > 0 ? { config_notes: allNotes } : {}),
    outcome: { kind: 'review_complete' },
  };
};
