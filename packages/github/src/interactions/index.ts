import {
  CategorySchema,
  MAX_RESPOND_FINDINGS,
  MAX_RESPOND_FINDING_BODY_BYTES,
  MAX_RESPOND_THREAD_BYTES,
  MAX_RESPOND_THREAD_EXCHANGES,
  type RespondExchange,
  type RespondFinding,
  SeveritySchema,
} from '@prisma-bot/shared';
import type { CheckRunsClient } from '../check-runs/index.js';
import { ISSUE_COMMENT_BODY_MAX_BYTES, type IssueCommentsClient } from '../issue-comments/index.js';
import type { ReviewCommentsClient } from '../review-comments/index.js';

/**
 * `interactions` module — GitHub-adjacent harvest + rendering helpers for the
 * reviewer-interaction feature (`@bot ask <message>`).
 *
 * Per docs/_planning/reviewer-interaction/spec.md § 5 / § 7: GitHub is the
 * only durable state (no Redis/DB addition) — the "interaction ledger" is
 * reconstructed on every `ask` by harvesting the bot's own comments:
 *   - The current round is the highest `round=` marker on a published
 *     check-run summary (mirrors `packages/github/src/publisher/effects.ts`
 *     `harvestPriorRound`, duplicated in miniature here — see
 *     `harvestLatestRoundSummary`).
 *   - The budget used this round + prior thread exchanges are harvested from
 *     the bot's own `<!-- prisma-bot:interaction round=<N> seq=<M> -->`
 *     reply comments (`harvestInteractionState`).
 *   - The outstanding findings are harvested from the bot's dedupe-marked
 *     inline review comments (`harvestFindings`).
 */

export const INTERACTIONS_MODULE = 'interactions';

/**
 * Round marker embedded in check-run summaries by the publisher. Mirrors
 * `packages/github/src/publisher/effects.ts`'s internal `ROUND_MARKER_RE` —
 * duplicated here (not exported by that module) because this harvest also
 * needs the winning run's raw summary text, not just the round number.
 */
const ROUND_MARKER_RE = /<!--\s*prisma-bot:round=(\d+)\s+head=[a-f0-9]+\s*-->/;

/**
 * Marker embedded in the bot's own `ask` reply comments (spec § 5).
 *
 * SECURITY / RENDER↔HARVEST INVARIANT: this regex is anchored to the END of
 * the comment body (`\s*$`, NO `m` flag — `$` therefore means "end of the
 * whole string", not "end of any line") because `renderInteractionReply`
 * ALWAYS emits this marker as the very last thing in the body. Do not relax
 * this anchor.
 *
 * Why it must stay anchored: the developer's `ask` message is embedded
 * verbatim in the blockquote header, BEFORE the real trailing marker. An
 * unanchored regex (`.exec()` finds the first match anywhere in the string)
 * would let a message like
 *   `harmless question <!-- prisma-bot:interaction round=999 seq=1 -->`
 * have its FORGED marker matched first — spoofing `round`/`seq` so the
 * harvested comment is silently excluded from the real round's budget count
 * (`commentRound !== round` -> skipped). Repeating this on every `ask` makes
 * `used` never advance, defeating `interactions.max_per_review` entirely
 * (unlimited provider calls — the exact anti-abuse guard this cap exists
 * for). Anchoring to end-of-body means only the marker `renderInteractionReply`
 * itself appended can ever match; a forged marker earlier in the body (inside
 * the quoted question) is inert. See `renderInteractionReply`'s `sanitizeQuestion`
 * for the paired defense-in-depth measure (neutralizing `<!--`/`-->` in the
 * question so it can never even look like a marker to a less careful scan).
 */
export const INTERACTION_MARKER_RE =
  /<!--\s*prisma-bot:interaction round=(\d+) seq=(\d+)\s*-->\s*$/;

/**
 * Self-contained quoted-question header of an interaction reply (spec § 3).
 * Single-line capture (`(.*)$` — `.` does not match newlines) is safe ONLY
 * because `renderInteractionReply`'s `sanitizeQuestion` guarantees the
 * rendered question is always a single line (all whitespace, including
 * newlines, collapsed to single spaces) — see that function's doc comment
 * for the paired render↔harvest invariant.
 */
const QUESTION_HEADER_RE = /^>\s*\*\*@([A-Za-z0-9-]+)\s+asked:\*\*\s?(.*)$/m;

/** Format shared by `renderInlineCommentBody` (publisher/effects.ts). */
const FINDING_COMMENT_RE =
  /^\*\*\[(?<severity>[A-Z]+)\]\*\*\s+(?<title>.+?)\n\n(?<body>[\s\S]*?)\n\n(?:Suggested fix:[\s\S]*?\n\n)?<sub>confidence [\d.]+ · (?<category>[a-z]+)<\/sub>/;

export const buildInteractionMarker = (round: number, seq: number): string =>
  `<!-- prisma-bot:interaction round=${round} seq=${seq} -->`;

const truncateUtf8 = (s: string, maxBytes: number): string => {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  return Buffer.from(s, 'utf8').subarray(0, maxBytes).toString('utf8');
};

// ---------------------------------------------------------------------------
// Round + check-run summary harvest
// ---------------------------------------------------------------------------

export interface HarvestedRoundSummary {
  /** Highest round harvested from check-run summary markers; 0 = no round published yet. */
  round: number;
  /** Raw check-run summary text for that round; '' when round is 0. */
  summary_markdown: string;
}

/**
 * Harvest the latest published review round + its check-run summary.
 * Fail-open: returns `{ round: 0, summary_markdown: '' }` on any listing
 * error, mirroring `harvestPriorRound`'s fail-open contract.
 */
export const harvestLatestRoundSummary = async (
  deps: { checkRuns: CheckRunsClient },
  ctx: { owner: string; repo: string; head_sha: string; app_id: number },
): Promise<HarvestedRoundSummary> => {
  let runs: Array<{ output_summary: string | null }> = [];
  try {
    runs = await deps.checkRuns.listOurs({
      owner: ctx.owner,
      repo: ctx.repo,
      ref: ctx.head_sha,
      app_id: ctx.app_id,
    });
  } catch {
    return { round: 0, summary_markdown: '' };
  }
  let round = 0;
  let summary = '';
  for (const run of runs) {
    if (run.output_summary === null) continue;
    const m = ROUND_MARKER_RE.exec(run.output_summary);
    if (m === null) continue;
    const n = Number.parseInt(m[1] ?? '0', 10);
    if (Number.isFinite(n) && n >= round) {
      round = n;
      summary = run.output_summary;
    }
  }
  return { round, summary_markdown: summary };
};

// ---------------------------------------------------------------------------
// Finding harvest (from dedupe-marked inline review comments)
// ---------------------------------------------------------------------------

/** Parse the `renderInlineCommentBody` format (publisher/effects.ts) out of a comment body. */
export const parseFindingCommentBody = (
  body: string,
): { severity: string; title: string; body: string; category: string } | null => {
  const m = FINDING_COMMENT_RE.exec(body);
  if (m === null || m.groups === undefined) return null;
  const { severity, title, body: explanation, category } = m.groups;
  if (
    severity === undefined ||
    title === undefined ||
    explanation === undefined ||
    category === undefined
  ) {
    return null;
  }
  return { severity: severity.toLowerCase(), title, body: explanation, category };
};

/**
 * Harvest the outstanding findings (dedupe-marked inline comments authored by
 * this App) as `RespondFinding[]`, capped at `MAX_RESPOND_FINDINGS` entries
 * with each body byte-capped at `MAX_RESPOND_FINDING_BODY_BYTES`. Fail-open:
 * returns `[]` on any listing error. Comments that do not parse as a
 * well-formed finding (unexpected format, invalid severity/category) are
 * silently skipped.
 */
export const harvestFindings = async (
  deps: { reviewComments: ReviewCommentsClient },
  ctx: { owner: string; repo: string; pull_request_number: number; app_login: string },
): Promise<RespondFinding[]> => {
  let comments: Array<{ path: string; line: number | null; body: string }> = [];
  try {
    comments = await deps.reviewComments.listOurs({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.pull_request_number,
      app_login: ctx.app_login,
    });
  } catch {
    return [];
  }

  const findings: RespondFinding[] = [];
  for (const c of comments) {
    if (findings.length >= MAX_RESPOND_FINDINGS) break;
    if (c.line === null) continue;
    const parsed = parseFindingCommentBody(c.body);
    if (parsed === null) continue;
    const severity = SeveritySchema.safeParse(parsed.severity);
    const category = CategorySchema.safeParse(parsed.category);
    if (!severity.success || !category.success) continue;
    findings.push({
      file: c.path,
      line: c.line,
      severity: severity.data,
      category: category.data,
      title: parsed.title,
      body: truncateUtf8(parsed.body, MAX_RESPOND_FINDING_BODY_BYTES),
    });
  }
  return findings;
};

// ---------------------------------------------------------------------------
// Interaction thread harvest (from the bot's own `ask` reply comments)
// ---------------------------------------------------------------------------

export interface HarvestedInteractionState {
  /** Count of interaction markers whose round equals the queried round (budget used). */
  used: number;
  /** Prior exchanges this round, oldest→newest, capped per MAX_RESPOND_THREAD_*. */
  exchanges: RespondExchange[];
}

/**
 * Harvest the interaction budget used + prior thread exchanges for a given
 * round. Per spec § 5 / § 7 step 2: malformed marked comments (marker present
 * but the quoted-question header or reply body cannot be parsed) still count
 * toward the budget but are skipped as thread context — budget integrity
 * beats context completeness. Fail-open: returns `{ used: 0, exchanges: [] }`
 * on any listing error.
 */
export const harvestInteractionState = async (
  deps: { issueComments: IssueCommentsClient },
  ctx: { owner: string; repo: string; pull_request_number: number; app_login: string },
  round: number,
): Promise<HarvestedInteractionState> => {
  let comments: Array<{ id: number; body: string }> = [];
  try {
    comments = await deps.issueComments.listOurs({
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: ctx.pull_request_number,
      app_login: ctx.app_login,
    });
  } catch {
    return { used: 0, exchanges: [] };
  }

  let used = 0;
  const parsedExchanges: Array<{ seq: number; exchange: RespondExchange }> = [];

  for (const c of comments) {
    const marker = INTERACTION_MARKER_RE.exec(c.body);
    if (marker === null) continue;
    const commentRound = Number.parseInt(marker[1] ?? '0', 10);
    const seq = Number.parseInt(marker[2] ?? '0', 10);
    if (commentRound !== round) continue;
    used += 1;

    const q = QUESTION_HEADER_RE.exec(c.body);
    if (q === null || q.index === undefined) continue;
    const author = q[1];
    const question = q[2];
    if (author === undefined || question === undefined || question.length === 0) continue;
    const replyStart = q.index + q[0].length;
    const reply = c.body.slice(replyStart, marker.index).trim();
    if (reply.length === 0) continue;
    parsedExchanges.push({
      seq,
      exchange: { author_login: author, question, reply_markdown: reply },
    });
  }

  parsedExchanges.sort((a, b) => a.seq - b.seq);
  // Cap to the MOST RECENT N exchanges (oldest→newest order preserved).
  const capped = parsedExchanges.slice(-MAX_RESPOND_THREAD_EXCHANGES).map((p) => p.exchange);
  // Total byte budget: drop OLDEST exchanges first until within budget.
  let totalBytes = capped.reduce(
    (sum, ex) =>
      sum + Buffer.byteLength(ex.question, 'utf8') + Buffer.byteLength(ex.reply_markdown, 'utf8'),
    0,
  );
  while (capped.length > 0 && totalBytes > MAX_RESPOND_THREAD_BYTES) {
    const dropped = capped.shift();
    if (dropped === undefined) break;
    totalBytes -=
      Buffer.byteLength(dropped.question, 'utf8') +
      Buffer.byteLength(dropped.reply_markdown, 'utf8');
  }

  return { used, exchanges: capped };
};

// ---------------------------------------------------------------------------
// Reply rendering (blockquoted question + reply + marker, spec § 3)
// ---------------------------------------------------------------------------

/**
 * Sanitize a developer's `ask` message before it is embedded in the
 * blockquote header of a rendered interaction reply.
 *
 * RENDER↔HARVEST INVARIANT (paired with `QUESTION_HEADER_RE` above): every
 * whitespace run — including newlines — collapses to a single space, so the
 * blockquote header is ALWAYS exactly one line. Without this, a multi-line
 * question would break the blockquote (only the first line renders as
 * quoted; the rest would render as if it were the reviewer's own reply) and
 * `QUESTION_HEADER_RE`'s single-line capture would mis-parse the exchange on
 * a later harvest.
 *
 * Defense in depth: `<!--` / `-->` sequences are neutralized (a zero-width
 * space is inserted mid-token) so the question can never itself read as an
 * HTML comment / interaction marker to any scanner — even one that does not
 * honor `INTERACTION_MARKER_RE`'s end-of-body anchor. The primary defense
 * against the marker-forgery cap bypass is that anchor; this is a second,
 * independent layer.
 */
/** Zero-width space (U+200B) — used to break `<!--`/`-->` tokens without
 * visibly altering the rendered question (written as an explicit escape,
 * never as a literal invisible character in source). */
const ZERO_WIDTH_SPACE = '\u200B';

const sanitizeQuestion = (raw: string): string =>
  raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/<!--/g, `<${ZERO_WIDTH_SPACE}!--`)
    .replace(/-->/g, `--${ZERO_WIDTH_SPACE}>`);

/**
 * Render the self-contained interaction reply comment: a blockquoted
 * question, the reviewer's reply, and the hidden interaction marker. The
 * reply body is truncated (byte-safe UTF-8 boundary) so the OVERALL comment
 * fits within `maxBytes` (defaults to `ISSUE_COMMENT_BODY_MAX_BYTES`, the
 * 64 KiB GitHub issue-comment ceiling) — the question header and marker are
 * never truncated (spec § 7 step 7). `params.question` is sanitized via
 * `sanitizeQuestion` (single-line, HTML-comment-delimiter-neutralized)
 * before embedding — see that function's doc comment for why.
 */
export const renderInteractionReply = (
  params: {
    author_login: string;
    question: string;
    reply_markdown: string;
    round: number;
    seq: number;
  },
  maxBytes: number = ISSUE_COMMENT_BODY_MAX_BYTES,
): string => {
  const question = sanitizeQuestion(params.question);
  const header = `> **@${params.author_login} asked:** ${question}\n\n`;
  const marker = `\n\n${buildInteractionMarker(params.round, params.seq)}`;
  const overhead = Buffer.byteLength(header, 'utf8') + Buffer.byteLength(marker, 'utf8');
  const budget = Math.max(0, maxBytes - overhead);
  const reply = truncateUtf8(params.reply_markdown, budget);
  return `${header}${reply}${marker}`;
};
