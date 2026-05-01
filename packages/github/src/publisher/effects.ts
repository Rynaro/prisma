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
): Promise<PublicationResult> => {
  const ranAt = new Date().toISOString();

  // Across-run dedupe state, sourced from prior inline review comments.
  const acrossRunKeys = await collectAcrossRunDedupeKeys(deps, ctx);
  const prior: PriorDedupeState = { published_inline_dedupe_keys: acrossRunKeys };

  const plan: PublicationPlan = planPublication(ranked, cfg, prior);

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
    try {
      await deps.checkRuns.finalize({
        owner: ctx.owner,
        repo: ctx.repo,
        check_run_id: checkRunId,
        conclusion,
        title,
        summary: plan.summary_markdown,
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

  const dropped: NormalizedFinding[] = plan.dropped.map((d) => d.finding);
  const result: PublicationResult = {
    published_inline: inlinePosted,
    published_summary: plan.summary,
    dropped,
    rejections,
    checks_run_id: checkRunId === 0 ? '' : String(checkRunId),
    summary_artifact: plan.summary_markdown,
  };
  return result;
};
