/**
 * `interactions.ts` — reviewer-interaction orchestration (`@bot ask <message>`).
 *
 * Extracted from `worker.ts`'s dispatch (mirrors the `repo-config.ts`
 * extraction pattern) so the dispatch order in
 * docs/_planning/reviewer-interaction/spec.md § 7 is unit-testable without
 * booting the worker (no Redis/BullMQ import).
 *
 * `runAsk` performs steps 1–7 of the spec:
 *   1. `interactions.enabled` gate (no I/O).
 *   2. Harvest the latest published round + its check-run summary.
 *   3. No round found → `{ kind: 'no_round' }`.
 *   4. Harvest the budget used + prior thread exchanges for that round;
 *      `used >= max_per_review` → `{ kind: 'cap_exceeded' }`.
 *   5. Harvest outstanding findings (dedupe-marked inline comments).
 *   6. Thread context included only when `max_per_review > 1` (requirement 4).
 *   7. Call `provider.respond()` (errors PROPAGATE — the caller applies the
 *      existing command-path error-reply semantics, per spec § 3 "Provider
 *      failure"); on success, render the self-contained reply (blockquoted
 *      question + reply + marker), truncated to the issue-comment ceiling.
 *
 * Budget integrity invariant: a failed `provider.respond()` call never posts
 * an interaction marker (the caller only posts `result.body` on the
 * `'replied'` branch), so failed calls never consume budget.
 */
import type {
  CheckRunsClient,
  IssueCommentsClient,
  ReviewCommentsClient,
} from '@prisma-bot/github';
import {
  harvestFindings,
  harvestInteractionState,
  harvestLatestRoundSummary,
  renderInteractionReply,
} from '@prisma-bot/github';
import {
  type InteractionsConfig,
  MAX_RESPOND_SUMMARY_BYTES,
  type Provider,
  type RespondPrMeta,
} from '@prisma-bot/shared';

export interface AskDeps {
  checkRuns: CheckRunsClient;
  reviewComments: ReviewCommentsClient;
  issueComments: IssueCommentsClient;
  provider: Provider;
}

export interface AskContext {
  owner: string;
  repo: string;
  pull_request_number: number;
  head_sha: string;
  app_id: number;
  app_login: string;
}

export interface AskRequest {
  /** Login of the developer who posted the `ask` comment. */
  author_login: string;
  /** The free-text message per `parseCommand`'s `{ kind: 'ask' }` variant. */
  message: string;
  interactions: InteractionsConfig;
  /** PR metadata for `ProviderRespondInput.pr` (fetched by the caller via `pulls.get`). */
  pr: RespondPrMeta;
  /** `config.review_guidance.instructions`, when configured. */
  guidance?: string;
}

export type AskResult =
  | { kind: 'disabled' }
  | { kind: 'no_round' }
  | { kind: 'cap_exceeded'; used: number; max: number }
  | { kind: 'replied'; body: string; round: number; seq: number };

const truncateUtf8 = (s: string, maxBytes: number): string => {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  return Buffer.from(s, 'utf8').subarray(0, maxBytes).toString('utf8');
};

/**
 * Run the `ask` dispatch per spec § 7. Does not log or post any GitHub
 * effect itself (the caller — `worker.ts` — owns the ack protocol, the log
 * taxonomy, and posting `result.body`); this keeps the module a pure(ish)
 * orchestration function over the injected deps.
 *
 * Provider errors (`ProviderErrorThrowable`) are NOT caught here — they
 * propagate to the caller, which applies the existing command-path error-reply
 * semantics (auth/capability get operator-actionable replies, per
 * `worker.ts`'s `handleCommentJob` catch block).
 */
export const runAsk = async (
  deps: AskDeps,
  ctx: AskContext,
  req: AskRequest,
): Promise<AskResult> => {
  // Step 1: disabled gate — zero I/O, no provider call.
  if (!req.interactions.enabled) {
    return { kind: 'disabled' };
  }

  // Step 2/3: current round + its check-run summary.
  const { round, summary_markdown } = await harvestLatestRoundSummary(
    { checkRuns: deps.checkRuns },
    ctx,
  );
  if (round === 0) {
    return { kind: 'no_round' };
  }

  // Step 4: budget used + prior exchanges this round.
  const { used, exchanges } = await harvestInteractionState(
    { issueComments: deps.issueComments },
    ctx,
    round,
  );
  const max = req.interactions.max_per_review;
  if (used >= max) {
    return { kind: 'cap_exceeded', used, max };
  }

  // Step 5: outstanding findings (dedupe-marked inline comments).
  const findings = await harvestFindings({ reviewComments: deps.reviewComments }, ctx);

  // Step 6: thread context only when max_per_review > 1 (requirement 4).
  const thread = max > 1 ? exchanges : [];

  const input = {
    pr: req.pr,
    review_context: {
      round,
      summary_markdown: truncateUtf8(summary_markdown, MAX_RESPOND_SUMMARY_BYTES),
      findings,
    },
    thread,
    message: { author_login: req.author_login, text: req.message },
    ...(req.guidance !== undefined ? { guidance: req.guidance } : {}),
  };

  // Step 7: provider call. Errors propagate — caller applies command-path
  // error-reply semantics; no interaction marker is posted on failure.
  const output = await deps.provider.respond(input);

  const seq = used + 1;
  const body = renderInteractionReply({
    author_login: req.author_login,
    question: req.message,
    reply_markdown: output.reply_markdown,
    round,
    seq,
  });

  return { kind: 'replied', body, round, seq };
};
