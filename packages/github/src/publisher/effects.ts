import type {
  NormalizedFinding,
  PublicationResult,
  RankedFindings,
  RejectionLogEntry,
  RepoConfig,
} from '@prisma-bot/shared';
import type { CheckRunsClient } from '../check-runs/index.js';
import type { ReviewCommentsClient } from '../review-comments/index.js';
import {
  type PriorDedupeState,
  type PublicationPlan,
  type PublicationPlanDropEntry,
  type PublicationPlanSummaryEntry,
  planPublication,
} from './planner.js';

/**
 * Effectful publisher. Combines the pure planner output with HTTP calls
 * against `CheckRunsClient` and `ReviewCommentsClient`. The seam between the
 * planner and the effects keeps unit tests simple: planner is exercised
 * without mocks; effects are exercised with hand-rolled fakes.
 *
 * Per `docs/api-contracts.md` § Publisher contract, returns a
 * `PublicationResult` whose three arrays plus `rejections` together account
 * for every input finding, with a matching `RejectionLogEntry` for every
 * dropped or summary-listed item (publisher-stage drops).
 */

export interface PublisherDeps {
  checkRuns: CheckRunsClient;
  reviewComments: ReviewCommentsClient;
}

/**
 * Regex for the round-counter marker in the check-run summary.
 * Format: `<!-- prisma-bot:round=N head=sha8 -->`
 */
const ROUND_MARKER_RE = /<!--\s*prisma-bot:round=(\d+)\s+head=[a-f0-9]+\s*-->/;

/**
 * Scan prior check-run summaries for the round-counter marker and return the
 * maximum round number found.  Returns 0 when no prior marker is present (the
 * first round will become round 1).
 *
 * Fail-open: if the listOurs call throws, returns 0 so the publish continues
 * with round = 1 (degraded, but not crashed).
 */
export const harvestPriorRound = async (
  deps: PublisherDeps,
  ctx: PublishContext,
): Promise<number> => {
  let runs: Array<{ output_summary: string | null }> = [];
  try {
    runs = await deps.checkRuns.listOurs({
      owner: ctx.owner,
      repo: ctx.repo,
      ref: ctx.head_sha,
      app_id: ctx.app_id,
    });
  } catch {
    return 0;
  }
  let maxRound = 0;
  for (const run of runs) {
    if (run.output_summary === null) continue;
    const m = ROUND_MARKER_RE.exec(run.output_summary);
    if (m === null) continue;
    const n = Number.parseInt(m[1] ?? '0', 10);
    if (Number.isFinite(n) && n > maxRound) maxRound = n;
  }
  return maxRound;
};

const buildRoundMarker = (round: number, headSha: string): string => {
  const sha8 = headSha.slice(0, 8) || 'unknown';
  return `<!-- prisma-bot:round=${round} head=${sha8} -->`;
};

/**
 * Build the round-summary line from set arithmetic.
 *
 * - `prior`: dedupe keys from prior inline comments still present on the PR.
 * - `current`: dedupe keys of findings produced this round (after ranker).
 *
 * Returns a rendered string like `Round 2 · 1 addressed · 2 still open · 1 new`
 * or an empty string when there are no prior keys and no current keys to diff.
 */
const buildRoundSummaryLine = (
  round: number,
  prior: ReadonlySet<string>,
  current: ReadonlySet<string>,
  full: boolean,
): string => {
  if (full) {
    return `Round ${round} (full)`;
  }
  if (prior.size === 0 && current.size === 0) {
    return `Round ${round}`;
  }
  const addressed = [...prior].filter((k) => !current.has(k)).length;
  const stillOpen = [...prior].filter((k) => current.has(k)).length;
  const newFindings = [...current].filter((k) => !prior.has(k)).length;
  return `Round ${round} · ${addressed} addressed · ${stillOpen} still open · ${newFindings} new`;
};

export interface PublishContext {
  owner: string;
  repo: string;
  installation_id: number;
  repository_id: number;
  pull_request_number: number;
  head_sha: string;
  app_id: number;
  app_login: string;
  details_url?: string;
  /** Identifier of this run (BullMQ job id from 5.6). */
  run_id: string;
}

const CHECK_RUN_NAME = 'AI Code Review';

const MODE_TITLES: Record<string, string> = {
  'dry-run': 'AI Code Review — dry-run',
  'summary-only': 'AI Code Review — summary',
  'summary-plus-inline': 'AI Code Review — inline + summary',
};

const truncateTitle = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max));

const rejectionFromDrop = (
  ctx: PublishContext,
  entry: PublicationPlanDropEntry | PublicationPlanSummaryEntry,
  ranAt: string,
): RejectionLogEntry => ({
  finding_id: entry.finding.id,
  stage: 'publisher',
  reason_code: entry.reason_code,
  reason_message: entry.reason_message,
  // Per `review-findings-schema.md` the excerpt is short and PII-light. We
  // include only the bot-internal id + path:line, which carry no diff content.
  provider_output_excerpt: `${entry.finding.id}@${entry.finding.path}:${entry.finding.line_start}`,
  timestamp: ranAt,
});

const rejectionFromGithubError = (err: unknown, ranAt: string): RejectionLogEntry => ({
  finding_id: null,
  stage: 'publisher',
  reason_code: 'github.api_error',
  reason_message: err instanceof Error ? err.message.slice(0, 240) : 'unknown GitHub API error',
  provider_output_excerpt: '',
  timestamp: ranAt,
});

const collectAcrossRunDedupeKeys = async (
  deps: PublisherDeps,
  ctx: PublishContext,
): Promise<Set<string>> => {
  // Source 1: inline review comments authored by this App on this PR.
  // The `dedupe_key` is encoded in the comment body as a magic marker we
  // emit at post time; without it the only signal is the (path, line)
  // tuple, which is too coarse. We keep the marker convention internal to
  // this module: `<!-- prisma-bot:dedupe=<KEY> -->`.
  const result = new Set<string>();
  let comments: Array<{ body: string }> = [];
  try {
    comments = await deps.reviewComments.listOurs({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.pull_request_number,
      app_login: ctx.app_login,
    });
  } catch {
    // Fail-open on across-run dedupe lookup: degraded behaviour (we may
    // re-publish a finding) is preferable to dropping the whole run.
    return result;
  }
  const re = /<!--\s*prisma-bot:dedupe=([a-zA-Z0-9_-]+)\s*-->/;
  for (const c of comments) {
    const m = re.exec(c.body);
    if (m === null) continue;
    const key = m[1];
    if (key !== undefined && key.length > 0) result.add(key);
  }
  return result;
};

const dedupeMarker = (finding: NormalizedFinding): string =>
  `<!-- prisma-bot:dedupe=${finding.dedupe_key} -->`;

const renderInlineCommentBody = (finding: NormalizedFinding): string => {
  const sevTag = finding.severity.toUpperCase();
  const lines: string[] = [];
  lines.push(`**[${sevTag}]** ${finding.title}`);
  lines.push('');
  lines.push(finding.explanation);
  if (finding.suggested_fix !== undefined && finding.suggested_fix.length > 0) {
    lines.push('');
    lines.push(`Suggested fix: ${finding.suggested_fix}`);
  }
  lines.push('');
  lines.push(`<sub>confidence ${finding.confidence.toFixed(2)} · ${finding.category}</sub>`);
  lines.push(dedupeMarker(finding));
  return lines.join('\n');
};

export const publish = async (
  ranked: RankedFindings,
  cfg: RepoConfig,
  ctx: PublishContext,
  deps: PublisherDeps,
  roundIntent: 'incremental' | 'full' = 'incremental',
  /**
   * Optional notice/preamble prepended to the check-run summary body. Used
   * for outcomes like `oversized` where the publisher needs to explain _why_
   * the review was skipped. Forwarded verbatim to `planPublication` → the
   * `renderSummary` step. Does not alter the plan partition invariant.
   */
  notice?: string,
): Promise<PublicationResult> => {
  const ranAt = new Date().toISOString();

  // Across-run dedupe state, sourced from prior inline review comments.
  const rawAcrossRunKeys = await collectAcrossRunDedupeKeys(deps, ctx);
  // For a 'full' round: ignore prior dedupe keys (fresh review), but still
  // track them for the round-summary set arithmetic.
  const acrossRunKeys: Set<string> = roundIntent === 'full' ? new Set<string>() : rawAcrossRunKeys;
  const prior: PriorDedupeState = { published_inline_dedupe_keys: acrossRunKeys };

  // Round number: harvest from prior check-run summary markers (fail-open → 0).
  const priorRound = await harvestPriorRound(deps, ctx);
  const currentRound = priorRound + 1;

  // Build the set of current finding dedupe keys for round-summary arithmetic.
  const currentKeys = new Set<string>(ranked.map((f) => f.dedupe_key));

  const plan: PublicationPlan = planPublication(ranked, cfg, prior, notice);

  // Start the Checks run.
  let checkRunId = 0;
  let checksError: unknown;
  try {
    const startArgs: Parameters<CheckRunsClient['startInProgress']>[0] = {
      owner: ctx.owner,
      repo: ctx.repo,
      head_sha: ctx.head_sha,
      name: CHECK_RUN_NAME,
    };
    if (ctx.details_url !== undefined) {
      startArgs.details_url = ctx.details_url;
    }
    const started = await deps.checkRuns.startInProgress(startArgs);
    checkRunId = started.check_run_id;
  } catch (err) {
    checksError = err;
  }

  const inlinePosted: NormalizedFinding[] = [];
  const inlineFailures: RejectionLogEntry[] = [];

  if (plan.mode_applied === 'summary-plus-inline' && checksError === undefined) {
    for (const finding of plan.inline) {
      try {
        await deps.reviewComments.postInline({
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number: ctx.pull_request_number,
          commit_sha: ctx.head_sha,
          path: finding.path,
          line: finding.line_start,
          body: renderInlineCommentBody(finding),
        });
        inlinePosted.push(finding);
      } catch (err) {
        inlineFailures.push(rejectionFromGithubError(err, ranAt));
      }
    }
  }

  // Finalize the Checks run with the rendered summary.
  let finalizeError: unknown;
  if (checksError === undefined) {
    const conclusion: 'success' | 'neutral' | 'failure' =
      plan.mode_applied === 'dry-run' || plan.inline.length === 0 ? 'neutral' : 'success';
    const title = truncateTitle(MODE_TITLES[plan.mode_applied] ?? 'AI Code Review', 60);

    // Build round-summary header and append round marker.
    const roundSummaryLine = buildRoundSummaryLine(
      currentRound,
      rawAcrossRunKeys,
      currentKeys,
      roundIntent === 'full',
    );
    const roundMarker = buildRoundMarker(currentRound, ctx.head_sha);
    const summaryWithRound = `${roundSummaryLine}\n\n${plan.summary_markdown}\n\n${roundMarker}`;

    try {
      await deps.checkRuns.finalize({
        owner: ctx.owner,
        repo: ctx.repo,
        check_run_id: checkRunId,
        conclusion,
        title,
        summary: summaryWithRound,
      });
    } catch (err) {
      finalizeError = err;
    }
  }

  // Build the rejection log: every plan.dropped + plan.summary_rejections +
  // any GitHub-API failures we hit on the way.
  const rejections: RejectionLogEntry[] = [];
  for (const drop of plan.dropped) {
    rejections.push(rejectionFromDrop(ctx, drop, ranAt));
  }
  for (const summaryEntry of plan.summary_rejections) {
    rejections.push(rejectionFromDrop(ctx, summaryEntry, ranAt));
  }
  for (const f of inlineFailures) rejections.push(f);
  if (checksError !== undefined) rejections.push(rejectionFromGithubError(checksError, ranAt));
  if (finalizeError !== undefined) rejections.push(rejectionFromGithubError(finalizeError, ranAt));

  // Build the round summary for the artifact (same as what was sent to GitHub).
  const roundSummaryLine = buildRoundSummaryLine(
    currentRound,
    rawAcrossRunKeys,
    currentKeys,
    roundIntent === 'full',
  );
  const roundMarker = buildRoundMarker(currentRound, ctx.head_sha);
  const summaryArtifact = `${roundSummaryLine}\n\n${plan.summary_markdown}\n\n${roundMarker}`;

  const dropped: NormalizedFinding[] = plan.dropped.map((d) => d.finding);
  const result: PublicationResult = {
    published_inline: inlinePosted,
    published_summary: plan.summary,
    dropped,
    rejections,
    checks_run_id: checkRunId === 0 ? '' : String(checkRunId),
    summary_artifact: summaryArtifact,
  };
  return result;
};
