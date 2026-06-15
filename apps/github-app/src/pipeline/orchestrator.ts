import {
  type AugmentationCaps,
  type BatcherSkippedFile,
  type SnapshotterOctokitLike,
  fetchPrSnapshot,
  planBatches,
  resolveAugmentation,
  runPrefilter,
  runRanker,
  runValidator,
  splitFileByHunks,
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
  isReasoningModel,
  parseModelSlug,
} from '@prisma-bot/shared';
import type { TokenizerFamily } from '@prisma-bot/shared';

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
  | 'job.terminal'
  | 'chunking.planned'
  | 'provider.batch.called'
  | 'provider.batch.output'
  | 'provider.batch.error'
  | 'provider.batch.truncation_exhausted'
  | 'provider.batch.split'
  | 'provider.batch.truncation_unsplittable'
  // Phase 4: new log events for over_budget degrade path and subset-and-note.
  | 'chunking.subset_selected'
  | 'provider.batch.budget_exhausted'
  | 'provider.batch.hunk_split'
  | 'provider.batch.budget_unsplittable';

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
 * Detail carried when a chunked review completes (all or some batches).
 * Exported from the pipeline index so callers (worker, tests) can reference
 * the type directly without importing the orchestrator module.
 */
export interface ReviewCompleteChunkedDetail {
  /** Total number of batches planned. */
  batch_count: number;
  /**
   * Indices of batches that returned `schema_validation` and whose findings
   * were dropped. When empty the review is complete; when non-empty it is a
   * partial review.
   */
  failed_batches: number[];
  /**
   * Files excluded from all batches because their individual token estimate
   * exceeded the hard safety cap (≈110,000 tokens).
   */
  skipped_files: BatcherSkippedFile[];
  /**
   * Paths of files that could not be fully reviewed because output truncation
   * persisted after all retry attempts were exhausted. These files are noted
   * in the check-run notice with a "not fully reviewed (output truncated)"
   * prefix. The PR is NOT aborted; surviving batches' findings are published.
   *
   * Per chunking-stability-spec.md § Phase 1 "Data-flow change".
   */
  truncated_files: string[];
  /**
   * Files that were not reviewed because the PR's plan exceeded the
   * `max_provider_calls_per_pr` budget (call-budget drops from the batcher's
   * subset-and-note logic) OR because a guard `over_budget` trip exhausted all
   * retries. Surfaced in the check-run notice as "Not reviewed (PR exceeds the
   * per-PR call budget of N)".
   *
   * Empty for happy-path PRs where every batch fits within both `hard_cap_in`
   * and `maxCalls` (AC4.5 no-regression).
   *
   * Per chunking-stability-spec.md § Phase 4 "Subset-and-note behavior".
   */
  not_reviewed_files: BatcherSkippedFile[];
}

/**
 * Detail attached to a no_findings outcome when the provider returned zero
 * findings on a non-trivial diff and the resolved model is a reasoning family
 * model (gpt-5+/o-series). Used to emit a model-aware notice and comment reply.
 * Absent when the prefilter excluded all files (provider not called) or when
 * a classic model produced a legitimately clean result.
 */
export interface NoFindingsReasoningHint {
  reasoning_model_empty: true;
  /** The bare model name (no provider prefix) that produced zero findings. */
  model: string;
}

/**
 * Discriminated outcome union surfaced by `runPipeline`. Callers use this to
 * compose user-visible messages that reflect what actually happened, rather than
 * treating every succeeded result as a completed review.
 *
 * - `'review_complete'`          — provider was called; findings (if any) were
 *   ranked and published. "Review complete!" is appropriate.
 * - `'review_complete_chunked'`  — PR was reviewed in multiple provider calls
 *   (diff chunking). `detail` carries batch_count, failed_batches, and any
 *   files skipped for size.
 * - `'oversized'`                — prefilter short-circuited; `oversized_detail`
 *   carries the specifics (reason, counts, limits). PR was not reviewed.
 * - `'no_findings'`              — provider returned zero findings. When
 *   `detail` is present, the provider was called on a non-trivial diff with a
 *   reasoning-family model — the hint drives a model-aware notice. When
 *   `detail` is absent, the diff was trivially empty (prefilter excluded all
 *   files) or the active model is a classic model (zero findings is clean).
 * - `'review_unavailable'`       — non-transient provider error (auth /
 *   capability). `detail` carries the provider_error_kind and the safe message.
 * - `'malformed_provider_output'` — provider output failed schema validation;
 *   job terminated cleanly without retry.
 */
export type PipelineOutcome =
  | { kind: 'review_complete' }
  | { kind: 'review_complete_chunked'; detail: ReviewCompleteChunkedDetail }
  | { kind: 'oversized'; detail: OversizedDetail }
  | { kind: 'no_findings'; detail?: NoFindingsReasoningHint }
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

/**
 * Build a notice explaining why a review surfaced zero publishable findings, so
 * the check-run summary never shows a bare "_No findings._" with no context.
 *
 * Returns '' when findings survived validation (the summary already lists them
 * or their drop reasons). Otherwise distinguishes the two zero-finding causes,
 * which are indistinguishable from the summary alone:
 *   - `providerFindingCount === 0` — the model reported nothing above the floors
 *     (a clean PR, or an under-producing model). Appends the reasoning-model
 *     hint when the configured model is a reasoning family.
 *   - `providerFindingCount > 0` — the model reported findings but all fell
 *     outside the changed lines (wrong path/line) and were dropped in
 *     validation; surfaced so lost comments don't read as "nothing found".
 *
 * Applied on both the single-call and chunked paths (the chunked path
 * previously had no empty-review diagnostic at all).
 */
const buildEmptyReviewNotice = (
  config: RepoConfig,
  providerFindingCount: number,
  validatedFindingCount: number,
): string => {
  if (validatedFindingCount > 0) return '';
  const sevFloor = config.thresholds.severity_floor.inline;
  const confFloor = config.thresholds.confidence_floor.inline;
  if (providerFindingCount > 0) {
    return `ℹ️ The model reported ${providerFindingCount} finding(s), but none could be anchored to the changed lines (they referenced a path or line outside the diff) and were dropped.`;
  }
  let notice = `ℹ️ No issues were reported at or above your configured inline floors (severity ≥ ${sevFloor}, confidence ≥ ${confFloor.toFixed(2)}). The PR looks clean to the model, or the bar is set high for it — lower \`confidence_floor.inline\` / \`severity_floor.inline\` if you expected more.`;
  const slug = parseModelSlug(config.model, config.provider);
  if (slug.model !== undefined && isReasoningModel(slug.model)) {
    notice += ` Note: \`${slug.model}\` is a reasoning model and may be under-producing with this review flow — try \`openai/gpt-4.1\` or set \`OPENAI_TOOL_CHOICE=required\` (see docs/model-compatibility.md).`;
  }
  return notice;
};

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

/**
 * `buildProviderInput` — construct the `ProviderReviewInput` for a single
 * provider call, threading all config-driven shaping fields.
 *
 * Spec: docs/_planning/config-dx/spec.md § 5.4.
 *
 * @param files          - Prefiltered files for this call (single-call or one batch).
 * @param cfg            - The effective repo config.
 * @param activeProvider - The active provider's `name` (e.g. "openai"). Used to
 *                         select the correct sub-bag from `cfg.provider_options`
 *                         (AS-10, G9) and for the R1 mismatch check.
 * @param allNotes       - Mutable notes array; slug-parse warnings are pushed here
 *                         so they flow into the check-run summary via the caller.
 * @param guidance       - Resolved custom guidance (optional).
 */
const buildProviderInput = (
  files: PrefilteredFile[],
  cfg: RepoConfig,
  activeProvider: string,
  allNotes: string[],
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

  // ── Model slug resolution (spec § 5.4 steps 1–2) ───────────────────────────
  // Parse `cfg.model` as a `provider/name` slug (or bare name).  Any parse
  // warnings are pushed into `allNotes` so they surface in the check-run
  // summary and the `configuration` reply.
  const slug = parseModelSlug(cfg.model, cfg.provider);
  allNotes.push(...slug.notes);

  // R1 mismatch check (design-review refinement R1):
  // When the slug names a provider DIFFERENT from the active adapter, the
  // model name from the slug would 404 on the active provider.  Emit a clear
  // config note and fall back to the active provider's default model (do NOT
  // pass the foreign model name through).
  let resolvedModel: string | undefined = slug.model;
  if (slug.provider !== undefined && slug.provider !== activeProvider) {
    allNotes.push(
      `model "${cfg.model}" names provider "${slug.provider}", but this deployment runs "${activeProvider}" — using the active provider's default model. Set an "${activeProvider}/…" model or configure the correct API key to use ${slug.provider}.`,
    );
    resolvedModel = undefined; // fall back to the adapter's default
  }

  // Build request_shaping if there is anything to shape.
  const hasModel = resolvedModel !== undefined;
  const generationConfig = cfg.generation;
  const hasGeneration =
    generationConfig.max_output_tokens !== undefined ||
    generationConfig.temperature !== undefined ||
    generationConfig.top_p !== undefined ||
    generationConfig.seed !== undefined;

  // Narrow provider_options to the active provider's sub-bag (AS-10, G9).
  // Key by `activeProvider` (the actually-running adapter) — not the slug's
  // provider — because adapter selection is env-driven this release (OQ-1).
  const activeProviderOptions = cfg.provider_options[activeProvider];
  const hasProviderOptions =
    activeProviderOptions !== undefined && Object.keys(activeProviderOptions).length > 0;

  if (hasModel || hasGeneration || hasProviderOptions) {
    input.request_shaping = {};

    // Step 2 (spec § 5.4): set resolved bare model name.
    if (hasModel && resolvedModel !== undefined) {
      input.request_shaping.model = resolvedModel;
    }

    // Steps 3–4 (spec § 5.4): forward generation block and map seed →
    // deterministic_seed (single seed source; the OpenAI adapter does NOT
    // re-read generation.seed directly).
    if (hasGeneration) {
      input.request_shaping.generation = generationConfig;
      if (typeof generationConfig.seed === 'number') {
        input.request_shaping.deterministic_seed = generationConfig.seed;
      }
    }

    // Step 5 (spec § 5.4): narrow to the active provider's bag.
    if (hasProviderOptions) {
      input.request_shaping.provider_options = activeProviderOptions;
    }
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

  // Stage: prefilter. Thread each hunk's diff body through to the provider
  // input so the model reviews actual code (and can cite real line numbers)
  // rather than path + heuristics alone.
  const prefilter = runPrefilter({
    snapshot,
    config: deps.config,
    hunkContent: (_path, hunk) => hunk.content ?? '',
  });
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

  // Determine the working file set and whether chunking is in play.
  // Both 'accepted' and 'chunkable' carry `files`; we unify the downstream
  // augmentation + provider + validator path over a single `activeFiles`.
  const isChunkable = prefilter.kind === 'chunkable';

  logger.emit('prefilter.accepted', {
    ...trace,
    files: prefilter.files.length,
    skipped: prefilter.skipped.length,
    chunkable: isChunkable,
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

  // -------------------------------------------------------------------------
  // Helper: handle a non-transient provider error (auth/capability).
  // Publishes a review_unavailable summary and re-throws so the consumer
  // marks the job terminal. Reused in both the single-call and batch paths.
  // -------------------------------------------------------------------------
  const handleAuthCapabilityError = async (err: ProviderErrorThrowable): Promise<never> => {
    const kind = err.value.kind as 'auth' | 'capability';
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
    throw err;
  };

  // -------------------------------------------------------------------------
  // Chunked path: plan batches and call provider once per batch.
  // -------------------------------------------------------------------------
  if (isChunkable) {
    const chunking = deps.config.chunking;

    // Phase 2: compute `hard_cap_in` from the provider's context window using
    // the reservation formula (chunking-stability-spec.md § Phase 2):
    //   window          = provider.capabilities.max_context_tokens
    //   reserved_output = chunking.reserved_output_tokens   (default 4096)
    //   prompt_overhead = chunking.prompt_overhead_tokens   (default 9000)
    //   safety          = ceil(safety_fraction × window)    (default 0.07)
    //   hard_cap_in     = window − reserved_output − prompt_overhead − safety
    //
    // Backward compat: effective budget = min(call_token_budget, hard_cap_in).
    // When `call_token_budget` is at its default sentinel (1_000_000) the
    // derived `hard_cap_in` dominates. When operators set a lower value, that
    // lower value is still respected.
    const window = deps.provider.capabilities.max_context_tokens;
    const reservedOutput = chunking.reserved_output_tokens;
    const promptOverhead = chunking.prompt_overhead_tokens;
    const safety = Math.ceil(chunking.safety_fraction * window);
    const hard_cap_in = window - reservedOutput - promptOverhead - safety;
    const effectiveBudget = Math.min(chunking.call_token_budget, hard_cap_in);

    // The tokenizer family comes from the provider's capabilities (set by each
    // adapter: anthropic→'anthropic-approx', openai→'o200k'/'cl100k', copilot→'cl100k').
    const tokenizerFamily: TokenizerFamily = deps.provider.capabilities.tokenizer_family;

    // `buildInputForBatch` is the thin callback the batcher uses to build a
    // `ProviderReviewInput` for any candidate file set. It delegates to
    // `buildProviderInput` (which carries guidance, model-slug, generation
    // settings) so the batcher's estimate includes the same guidance and tool
    // schema that the adapter will send on the wire.
    const buildInputForBatch = (files: PrefilteredFile[]): ProviderReviewInput =>
      buildProviderInput(files, deps.config, deps.provider.name, allNotes, resolvedGuidance);

    // `absoluteCapTokens`: the true-overflow threshold (replaces HARD_SAFETY_CAP_TOKENS).
    // A file whose single-file estimate exceeds this value CANNOT fit even alone
    // (the context window minus required non-content overhead). Files over
    // `effectiveBudget` but under `absoluteCapTokens` get their own batch;
    // only files over `absoluteCapTokens` go to `skippedFiles`.
    // Per chunking-stability-spec.md § Phase 2 "HARD_SAFETY_CAP_TOKENS replaced".
    const absoluteCapTokens = window - reservedOutput - promptOverhead;

    const batchPlan = planBatches(prefilter.files, {
      callTokenBudget: effectiveBudget,
      absoluteCapTokens,
      maxCalls: chunking.max_provider_calls_per_pr,
      tokenizerFamily,
      buildInputForBatch,
    });

    // Phase 4: subset-and-note (D3, AC4.1). The batcher already applied
    // priority ordering and populated `notReviewed` with any files in batches
    // that were dropped to honor `max_provider_calls_per_pr`. We collect those
    // here and will add any guard-trip-exhausted files later.
    //
    // The old `overCap` cliff (skip the whole PR) is GONE. Even when
    // `batchPlan.overCap` is true, we still proceed with the KEPT batches.
    // The dropped files surface in the check-run notice (AC4.1).
    if (batchPlan.overCap) {
      logger.emit('chunking.subset_selected', {
        ...trace,
        kept_batches: batchPlan.batches.length,
        max_calls: chunking.max_provider_calls_per_pr,
        not_reviewed_count: batchPlan.notReviewed.length,
      });
    }

    // Plan is within the cap (or we're reviewing the highest-risk subset).
    // Emit an observability event before starting.
    logger.emit('chunking.planned', {
      ...trace,
      batch_count: batchPlan.batches.length,
      est_total_tokens: batchPlan.estTotalTokens,
      skipped_files: batchPlan.skippedFiles.length,
      not_reviewed_files: batchPlan.notReviewed.length,
    });

    // Loop over batches, accumulating findings and recording which failed.
    // Uses a work-queue (instead of a simple index loop) so output_truncated
    // batches can be split into two halves and re-enqueued without an extra
    // outer loop (chunking-stability-spec.md § Phase 1 "Data-flow change").
    const allFindings: ProviderReviewOutput['findings'] = [];
    const failedBatches: number[] = [];
    const truncatedFiles: string[] = [];

    // Phase 4: files that could not be reviewed because of call-budget drops
    // (from batchPlan.notReviewed) or guard-trip exhaustion. Both surfaces
    // contribute to the "not reviewed" notice section (AC4.1).
    const notReviewedFiles: BatcherSkippedFile[] = [...batchPlan.notReviewed];

    // Config for split-and-retry:
    //   maxRetries  — per-batch retry depth cap (default 2).
    //   globalCap   — total provider calls never exceed
    //                 max_provider_calls_per_pr × (max_truncation_retries + 1).
    const maxRetries = chunking.max_truncation_retries;
    const globalCallCap = chunking.max_provider_calls_per_pr * (maxRetries + 1);

    // Each queue entry: { batch, batchIdx, retryDepth }
    // retryDepth 0 = original batch, 1 = first split, 2 = second split, …
    interface WorkItem {
      batch: PrefilteredFile[];
      batchIdx: number;
      retryDepth: number;
    }

    const workQueue: WorkItem[] = batchPlan.batches.map((batch, idx) => ({
      batch,
      batchIdx: idx,
      retryDepth: 0,
    }));

    // Global counter: counts ACTUAL provider calls (not queue items).
    let globalCallCount = 0;

    while (workQueue.length > 0) {
      const item = workQueue.shift();
      if (item === undefined) break;
      const { batch, batchIdx, retryDepth } = item;

      // Global call cap guard: if we have already hit the cap, record the
      // batch's files as truncated and continue without calling the provider.
      if (globalCallCount >= globalCallCap) {
        logger.emit('provider.batch.error', {
          ...trace,
          batch_index: batchIdx,
          batch_count: batchPlan.batches.length,
          kind: 'output_truncated',
          provider: deps.provider.name,
          message: 'global call cap exhausted; batch not retried',
          retry_depth: retryDepth,
        });
        for (const f of batch) {
          if (!truncatedFiles.includes(f.path)) truncatedFiles.push(f.path);
        }
        failedBatches.push(batchIdx);
        continue;
      }

      const batchInput = buildProviderInput(
        batch,
        deps.config,
        deps.provider.name,
        allNotes,
        resolvedGuidance,
      );
      logger.emit('provider.batch.called', {
        ...trace,
        batch_index: batchIdx,
        batch_count: batchPlan.batches.length,
        files_in_batch: batch.length,
        provider: deps.provider.name,
        retry_depth: retryDepth,
      });
      globalCallCount += 1;

      try {
        const batchOutput = await deps.provider.review(batchInput);
        logger.emit('provider.batch.output', {
          ...trace,
          batch_index: batchIdx,
          batch_count: batchPlan.batches.length,
          findings_count: batchOutput.findings.length,
        });
        allFindings.push(...batchOutput.findings);
      } catch (batchErr) {
        if (batchErr instanceof ProviderErrorThrowable) {
          const kind = batchErr.value.kind;
          logger.emit('provider.batch.error', {
            ...trace,
            batch_index: batchIdx,
            batch_count: batchPlan.batches.length,
            kind,
            provider: deps.provider.name,
            message: batchErr.value.message,
            retry_depth: retryDepth,
          });

          if (kind === 'output_truncated') {
            // Split-and-retry logic per chunking-stability-spec.md § Phase 1.
            if (retryDepth >= maxRetries) {
              // Retry depth exhausted → record as truncated/failed, do NOT abort.
              logger.emit('provider.batch.truncation_exhausted', {
                ...trace,
                batch_index: batchIdx,
                files_in_batch: batch.length,
                retry_depth: retryDepth,
              });
              for (const f of batch) {
                if (!truncatedFiles.includes(f.path)) truncatedFiles.push(f.path);
              }
              failedBatches.push(batchIdx);
              continue;
            }

            if (batch.length > 1) {
              // Case 1: batch has >1 file → split into two ~equal halves.
              // Split by estimated tokens: use content length as a proxy (same
              // estimator as the batcher) so the two halves are roughly balanced.
              // Phase 1 splits by file count (floor/ceil) to stay simple and
              // input-budget-agnostic (the real estimator is Phase 2).
              const mid = Math.ceil(batch.length / 2);
              const leftHalf = batch.slice(0, mid);
              const rightHalf = batch.slice(mid);
              logger.emit('provider.batch.split', {
                ...trace,
                batch_index: batchIdx,
                original_files: batch.length,
                left_files: leftHalf.length,
                right_files: rightHalf.length,
                retry_depth: retryDepth + 1,
              });
              // Prepend both halves so they're processed next (depth-first).
              workQueue.unshift(
                { batch: leftHalf, batchIdx, retryDepth: retryDepth + 1 },
                { batch: rightHalf, batchIdx, retryDepth: retryDepth + 1 },
              );
              continue;
            }

            // batch.length === 1 (single file):
            const singleFile = batch[0];
            if (singleFile !== undefined && singleFile.hunks.length > 1) {
              // Case 2: single file with >1 hunk → Phase 1 cannot split hunks
              // (that is Phase 3). Record as failed/truncated with a note.
              logger.emit('provider.batch.truncation_unsplittable', {
                ...trace,
                batch_index: batchIdx,
                path: singleFile.path,
                hunk_count: singleFile.hunks.length,
                note: 'single-file multi-hunk truncation: hunk-level split deferred to Phase 3',
              });
            } else {
              // Case 3: single file / single hunk → cannot split at all.
              logger.emit('provider.batch.truncation_unsplittable', {
                ...trace,
                batch_index: batchIdx,
                path: singleFile?.path ?? 'unknown',
                hunk_count: singleFile?.hunks.length ?? 0,
                note: 'single-file single-hunk truncation: cannot split further',
              });
            }
            // Both unsplittable cases: record as truncated, continue.
            for (const f of batch) {
              if (!truncatedFiles.includes(f.path)) truncatedFiles.push(f.path);
            }
            failedBatches.push(batchIdx);
            continue;
          }

          if (kind === 'over_budget') {
            // Phase 4: the per-call guard tripped (batch estimated over the
            // hard_cap_in). DEGRADE, not abort: split and retry via the same
            // work-queue logic as output_truncated.
            //
            // AC4.3: on exhaustion, files go to notReviewedFiles; PR continues.
            // AC4.4: genuine auth/capability STILL aborts (handled below).
            if (retryDepth >= maxRetries) {
              logger.emit('provider.batch.budget_exhausted', {
                ...trace,
                batch_index: batchIdx,
                files_in_batch: batch.length,
                retry_depth: retryDepth,
                estimated_tokens:
                  batchErr.value.kind === 'over_budget'
                    ? batchErr.value.estimated_tokens
                    : undefined,
              });
              for (const f of batch) {
                notReviewedFiles.push({
                  path: f.path,
                  est_tokens:
                    batchErr.value.kind === 'over_budget' ? batchErr.value.estimated_tokens : 0,
                  note: 'guard trip exhausted: batch over token budget after max retries',
                });
              }
              failedBatches.push(batchIdx);
              continue;
            }

            if (batch.length > 1) {
              // Multi-file batch: split into two halves (Phase 1 strategy).
              const mid = Math.ceil(batch.length / 2);
              const leftHalf = batch.slice(0, mid);
              const rightHalf = batch.slice(mid);
              logger.emit('provider.batch.split', {
                ...trace,
                batch_index: batchIdx,
                split_reason: 'over_budget',
                original_files: batch.length,
                left_files: leftHalf.length,
                right_files: rightHalf.length,
                retry_depth: retryDepth + 1,
              });
              workQueue.unshift(
                { batch: leftHalf, batchIdx, retryDepth: retryDepth + 1 },
                { batch: rightHalf, batchIdx, retryDepth: retryDepth + 1 },
              );
              continue;
            }

            // Single-file batch: attempt hunk-level split (Phase 3 strategy).
            const singleFileOb = batch[0];
            if (singleFileOb !== undefined && singleFileOb.hunks.length > 1) {
              // Phase 3: split at hunk boundaries and re-enqueue each sub-file.
              const { subFiles, overflowHunks } = splitFileByHunks(
                singleFileOb,
                effectiveBudget,
                absoluteCapTokens,
                tokenizerFamily,
                buildInputForBatch,
              );
              // Overflow hunks: truly unsplittable → notReviewedFiles.
              for (const { hunkId, estTokens } of overflowHunks) {
                notReviewedFiles.push({
                  path: singleFileOb.path,
                  est_tokens: estTokens,
                  note: `hunk ${hunkId} exceeds the absolute token cap; cannot be reviewed`,
                });
              }
              if (subFiles.length > 0) {
                logger.emit('provider.batch.hunk_split', {
                  ...trace,
                  batch_index: batchIdx,
                  split_reason: 'over_budget',
                  path: singleFileOb.path,
                  sub_file_count: subFiles.length,
                  retry_depth: retryDepth + 1,
                });
                workQueue.unshift(
                  ...subFiles.map((sf) => ({
                    batch: [sf],
                    batchIdx,
                    retryDepth: retryDepth + 1,
                  })),
                );
                continue;
              }
            }

            // Single-file / single-hunk or all hunks overflowed: cannot split further.
            logger.emit('provider.batch.budget_unsplittable', {
              ...trace,
              batch_index: batchIdx,
              path: singleFileOb?.path ?? 'unknown',
              hunk_count: singleFileOb?.hunks.length ?? 0,
            });
            for (const f of batch) {
              notReviewedFiles.push({
                path: f.path,
                est_tokens:
                  batchErr.value.kind === 'over_budget' ? batchErr.value.estimated_tokens : 0,
                note: 'over_budget: cannot split further (single hunk or all hunks overflow)',
              });
            }
            failedBatches.push(batchIdx);
            continue;
          }

          if (kind === 'schema_validation') {
            // Partial failure: drop this batch's findings, continue.
            // The merged output will be marked partial in the notice.
            failedBatches.push(batchIdx);
            continue;
          }
          if (kind === 'auth' || kind === 'capability') {
            // Non-transient: abort and publish review_unavailable (same as
            // single-call path). Re-throws — does not return.
            // AC4.4: genuine auth / model-unavailable capability STILL aborts.
            await handleAuthCapabilityError(batchErr);
          }
          // transport / rate_limit / retryable: abort and re-throw so
          // BullMQ retries the whole job (all batches). Partial-publish-
          // then-retry would double-publish; preserving today's retry
          // semantics is safer.
          throw batchErr;
        }
        // Unknown error: re-throw for consumer retry classification.
        logger.emit('provider.error', {
          ...trace,
          kind: 'unknown',
          batch_index: batchIdx,
          message: batchErr instanceof Error ? batchErr.message : 'unknown',
        });
        throw batchErr;
      }
    }

    // All batches attempted. If ALL failed schema_validation → malformed path.
    if (failedBatches.length === batchPlan.batches.length) {
      const rejection: RejectionLogEntry = {
        finding_id: null,
        stage: 'validator',
        reason_code: 'provider_output_zod_failed',
        reason_message: 'all batches returned malformed output',
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
        reasonMessage: 'review unavailable: all batches returned malformed output',
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

    // Merge all successful batch findings → ONE ProviderReviewOutput before
    // the validator so dedupe, ranking, and caps apply to the full PR.
    // The dedupe key is (path, category) — batch-, line- and wording-agnostic —
    // so merging before the validator gives cross-batch dedup for free.
    const mergedProviderOutput: ProviderReviewOutput = { findings: allFindings };

    // Build a notice describing the chunked run. Prepended to the check-run
    // summary via the existing v0.7.0 `notice` param (does NOT alter the
    // plan partition invariant).
    const partialNote =
      failedBatches.length > 0
        ? ` — ${failedBatches.length} of ${batchPlan.batches.length} sections could not be analyzed and were skipped.`
        : '';
    const skippedFileNote =
      batchPlan.skippedFiles.length > 0
        ? ` ${batchPlan.skippedFiles.length} file(s) skipped (too large to analyze): ${batchPlan.skippedFiles.map((f) => f.path).join(', ')}.`
        : '';
    // Per chunking-stability-spec.md § Phase 1 AC1.3: truncated files that
    // could not be split further are listed as "not fully reviewed" so
    // operators can see which paths need attention.
    const truncatedFileNote =
      truncatedFiles.length > 0
        ? ` not fully reviewed (output truncated): ${truncatedFiles.join(', ')}.`
        : '';
    // Phase 4: "not reviewed" section for files dropped by the call-budget
    // subset-and-note logic OR exhausted guard-trip retries.
    // Spec § Phase 4 "Subset-and-note behavior (D3)" notice format:
    //   "Reviewed the N highest-risk sections. Not reviewed (PR exceeds the
    //    per-PR call budget of M): <files>. Raise chunking.max_provider_calls_per_pr
    //    or split the PR."
    const notReviewedNote =
      notReviewedFiles.length > 0
        ? ` Not reviewed (PR exceeds the per-PR call budget of ${chunking.max_provider_calls_per_pr}): ${notReviewedFiles.map((f) => f.path).join(', ')}. Raise \`chunking.max_provider_calls_per_pr\` or split the PR.`
        : '';
    const reviewedSectionsPrefix =
      notReviewedFiles.length > 0
        ? `Reviewed the ${batchPlan.batches.length} highest-risk section(s) (large PR).`
        : `Reviewed in ${batchPlan.batches.length} section(s) (large PR).`;
    const chunkedNotice = `${reviewedSectionsPrefix}${partialNote}${skippedFileNote}${truncatedFileNote}${notReviewedNote}`;

    // Feed the merged output into the EXISTING validator → ranker → publisher
    // tail. This is unchanged — dedupe and caps apply to the whole PR.
    const validatorResultChunked = runValidator(mergedProviderOutput, {
      snapshot,
      config: deps.config,
      run_id: payload.idempotency_key,
      ran_at: now(),
      ...(deps.generateId !== undefined ? { generateId: deps.generateId } : {}),
    });
    if (validatorResultChunked.rejections.length > 0) {
      logger.emit('validator.rejected', {
        ...trace,
        count: validatorResultChunked.rejections.length,
        rejections: validatorResultChunked.rejections.map((r) => ({
          finding_id: r.finding_id,
          stage: r.stage,
          reason_code: r.reason_code,
          reason_message: r.reason_message,
          provider_output_excerpt: r.provider_output_excerpt,
          timestamp: r.timestamp,
        })),
      });
    }

    const rankedChunked = runRanker(validatorResultChunked.findings);

    // Explain a zero-finding chunked review instead of a bare "_No findings._"
    // (this path previously had no empty-review diagnostic at all).
    const emptyNoticeChunked = buildEmptyReviewNotice(
      deps.config,
      allFindings.length,
      validatorResultChunked.findings.length,
    );
    const chunkedNoticeFull =
      emptyNoticeChunked.length > 0 ? `${chunkedNotice} ${emptyNoticeChunked}` : chunkedNotice;

    const publishFnChunked = hooks.runPublish ?? defaultPublish;
    const ctxChunked = buildPublishContext(payload, identity, deps.resolvedHeadSha);
    const publisherDepsChunked = publisherDepsFor(octokit);
    const publicationChunked = await publishFnChunked(
      rankedChunked,
      deps.config,
      ctxChunked,
      publisherDepsChunked,
      deps.roundIntent ?? 'incremental',
      chunkedNoticeFull,
    );

    if (publicationChunked.dropped.length > 0) {
      logger.emit('publisher.dropped', { ...trace, count: publicationChunked.dropped.length });
    }
    logger.emit('publisher.published', {
      ...trace,
      mode: deps.config.mode,
      inline_count: publicationChunked.published_inline.length,
      summary_count: publicationChunked.published_summary.length,
      batch_count: batchPlan.batches.length,
      failed_batches: failedBatches.length,
    });
    logger.emit('job.terminal', { ...trace, state: 'succeeded' });

    const chunkedDetail: ReviewCompleteChunkedDetail = {
      batch_count: batchPlan.batches.length,
      failed_batches: failedBatches,
      skipped_files: batchPlan.skippedFiles,
      truncated_files: truncatedFiles,
      // Phase 4: files dropped by call-budget subset-and-note or guard-trip exhaustion.
      not_reviewed_files: notReviewedFiles,
    };

    return {
      state: 'succeeded',
      publication: publicationChunked,
      rejections: [...validatorResultChunked.rejections, ...publicationChunked.rejections],
      ...(allNotes.length > 0 ? { config_notes: allNotes } : {}),
      outcome: { kind: 'review_complete_chunked', detail: chunkedDetail },
    };
  }

  // -------------------------------------------------------------------------
  // Single-call path (prefilter.kind === 'accepted').
  // -------------------------------------------------------------------------

  // Stage: provider.
  const providerInput = buildProviderInput(
    prefilter.files,
    deps.config,
    deps.provider.name,
    allNotes,
    resolvedGuidance,
  );
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
        await handleAuthCapabilityError(err);
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

  // ── Reasoning-model empty-review safety net ────────────────────────────────
  // When the provider was called on a non-trivial diff (we are past the
  // `prefilter.files.length === 0` short-circuit) but returned ZERO findings,
  // AND the resolved config model is a reasoning-family model (gpt-5*/o-series),
  // enrich the `no_findings` outcome with a model-incompatibility hint.
  //
  // Classic models returning zero findings on a real diff is a legitimately
  // clean PR — no hint is emitted in that case.
  //
  // The "provider was called" signal is implicit: this code is only reached
  // when `prefilter.files.length > 0` (files were sent) AND the provider
  // returned without throwing.
  if (providerOutput.findings.length === 0) {
    // Parse the configured model slug to get the bare model name.
    // We check the bare model name (not the resolved/adapter name) because
    // the operator configured this model and the hint should tell them about
    // the model they chose, regardless of which adapter is running.
    const slug = parseModelSlug(deps.config.model, deps.config.provider);
    const resolvedModelName = slug.model;

    const isReasoning = resolvedModelName !== undefined && isReasoningModel(resolvedModelName);

    if (isReasoning && resolvedModelName !== undefined) {
      // Build the reasoning-model notice text.
      const reasoningNotice = `ℹ️ Review produced no findings. The configured model (\`${resolvedModelName}\`) is a reasoning model and may be under-producing with this review flow. If you expected findings, try \`openai/gpt-4.1\`, or set \`OPENAI_TOOL_CHOICE=required\`. See docs/model-compatibility.md.`;

      const publication = await publishSummaryOnly({
        payload,
        identity,
        octokit,
        cfg: deps.config,
        hooks,
        reason: 'no_findings',
        reasonMessage: `no findings: reasoning model ${resolvedModelName} returned empty findings`,
        rejections: [],
        resolvedHeadSha: deps.resolvedHeadSha,
        notice: reasoningNotice,
      });
      logger.emit('publisher.published', {
        ...trace,
        mode: 'summary-only',
        reason: 'no_findings',
        reasoning_model_empty: true,
        model: resolvedModelName,
        inline_count: publication.published_inline.length,
        summary_count: publication.published_summary.length,
      });
      logger.emit('job.terminal', { ...trace, state: 'succeeded' });
      return {
        state: 'succeeded',
        publication,
        rejections: publication.rejections,
        ...(allNotes.length > 0 ? { config_notes: allNotes } : {}),
        outcome: {
          kind: 'no_findings',
          detail: { reasoning_model_empty: true as const, model: resolvedModelName },
        },
      };
    }
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
  // Explain a zero-finding review instead of a bare "_No findings._". The
  // reasoning-model empty case already returned early above; this covers a
  // classic model that simply found nothing, plus the all-dropped case.
  const emptyNotice = buildEmptyReviewNotice(
    deps.config,
    providerOutput.findings.length,
    validatorResult.findings.length,
  );
  const publication = await publishFn(
    ranked,
    deps.config,
    ctx,
    publisherDeps,
    deps.roundIntent ?? 'incremental',
    emptyNotice.length > 0 ? emptyNotice : undefined,
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
