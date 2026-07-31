import { createHash } from 'node:crypto';
import {
  FINDING_TITLE_MAX_LENGTH,
  HIGHLIGHT_MESSAGE_MAX_LENGTH,
  HIGHLIGHT_RATIONALE_MAX_LENGTH,
  type NormalizedFinding,
  type PrSnapshot,
  type ProviderReviewOutput,
  type ProviderReviewOutputHighlight,
  ProviderReviewOutputSchema,
  type RejectionLogEntry,
  type RepoConfig,
  type ReviewHighlight,
} from '@prisma-bot/shared';

/**
 * Validator — the deterministic gate between the provider adapter and the
 * ranker. Implementation of `docs/api-contracts.md` § Validator contract and
 * `docs/architecture-decision-records/adr-003-validation-ranking.md` § Pipeline
 * shape (3. Validator).
 *
 * Per `docs/api-contracts.md` § Invariants item 6 and 7: every dropped finding
 * is accompanied by a `RejectionLogEntry` carrying a `reason_code` and the
 * pipeline `stage`. The validator only emits entries with `stage = 'validator'`.
 *
 * The validator is pure: no I/O, no clock reads, no random ids. The caller
 * supplies `ctx.ran_at` (ISO-8601) and an optional `ctx.generateId()`; in
 * production the worker passes the BullMQ job id and `Date#toISOString()`
 * computed once at job start, in tests fixtures pass deterministic strings.
 */

export interface ValidatorContext {
  snapshot: PrSnapshot;
  config: RepoConfig;
  /** stable run id (Phase 5.5 will pass the BullMQ job id; tests pass any string) */
  run_id: string;
  /** ISO-8601 timestamp produced once at the start of the run */
  ran_at: string;
  /** id generator; defaults to `${run_id}:${index}` for testability */
  generateId?: () => string;
}

export interface ValidatorResult {
  findings: NormalizedFinding[];
  rejections: RejectionLogEntry[];
  /** Validated, deduped, deterministically capped. `[]` when disabled or none. */
  highlights: ReviewHighlight[];
}

interface AnalyzableFile {
  path: string;
  hunks: ReadonlyArray<{ id: string; new_start: number; new_lines: number }>;
}

const buildAnalyzableFiles = (snapshot: PrSnapshot): Map<string, AnalyzableFile> => {
  const map = new Map<string, AnalyzableFile>();
  for (const file of snapshot.files) {
    if (file.status === 'removed') continue;
    map.set(file.path, {
      path: file.path,
      hunks: file.hunks.map((h) => ({
        id: `${file.path}#${h.new_start}-${h.new_start + h.new_lines}`,
        new_start: h.new_start,
        new_lines: h.new_lines,
      })),
    });
  }
  return map;
};

const findHunkForLine = (file: AnalyzableFile, line: number): { id: string } | undefined => {
  for (const hunk of file.hunks) {
    // Half-open interval [new_start, new_start + new_lines), per the
    // hunk-id arithmetic in the prefilter (`buildHunkId`).
    if (line >= hunk.new_start && line < hunk.new_start + hunk.new_lines) {
      return { id: hunk.id };
    }
  }
  return undefined;
};

/**
 * Derive the `dedupe_key` from a finding's stable structural identity:
 * `path` + `category`.
 *
 * The key is deliberately independent of both the model's free-text message
 * and the exact line number, because the previous message-derived key let two
 * failure modes through:
 *   - Same issue, reworded. The model phrases one concern (e.g. "missing
 *     authorization") differently across findings or rounds; a message hash
 *     gave each phrasing a distinct key, so the duplicates were never
 *     collapsed and were posted as separate inline comments.
 *   - Same issue, multiple sites. The model flags the same concern at several
 *     lines of a file; the cross-hunk dedupe contract requires these to
 *     collapse to one comment, so the key cannot depend on the line.
 *
 * Keying on (path, category) is the coarsest identity that satisfies both: it
 * yields one inline comment per (file, category). The publisher's planner keeps
 * the highest-confidence survivor inline and surfaces the collapsed siblings in
 * the Checks summary (`reason_code: dedupe_collapsed`), so no finding is lost —
 * only de-duplicated. The publisher consults the key to suppress duplicates
 * within a run and across webhook redeliveries.
 */
const computeDedupeKey = (path: string, category: string): string => {
  const canonical = `${path}:${category}`;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
};

const buildEvidence = (path: string, hunkId: string, line: number): string[] => [
  `${path}:${line}`,
  `hunk:${hunkId}`,
];

interface DerivedTitle {
  title: string;
  truncated: boolean;
}

/** Ellipsis glyph — U+2026, exactly one character, counted inside the budget. */
const ELLIPSIS = '…';

/** First-sentence floor: below this, abbreviation-truncated stubs (`e.g.`) are rejected. */
const MIN_SENTENCE_LENGTH = 30;

/**
 * Match the leading sentence: text up to the first `.`, `!` or `?` that is
 * itself followed by whitespace or end-of-string. A lookahead (rather than a
 * consuming match) keeps the trailing separator out of the captured sentence.
 * Mid-word punctuation (`e.g.`, `Node.js`) is never followed by whitespace or
 * end-of-string, so it never matches here.
 */
const LEADING_SENTENCE_RE = /^(.+?[.!?])(?=\s|$)/;

/** Trim + collapse every whitespace run (incl. newlines) to a single space. */
const normalizeMessage = (message: string): string => message.trim().replace(/\s+/g, ' ');

/**
 * Returns `str` unchanged unless its last UTF-16 code unit is a lone high
 * surrogate (0xD800–0xDBFF), in which case that trailing unit is dropped.
 *
 * Every raw, length-based cut below (`slice(0, n)`) operates on UTF-16 code
 * units, not code points; an astral character (e.g. an emoji) is encoded as
 * a high+low surrogate pair, and a cut that lands between the two halves
 * leaves a lone high surrogate that GitHub renders as `�`. Word-boundary
 * cuts (which stop just before a plain space — always a single code unit,
 * never half of a pair) cannot themselves straddle a pair in well-formed
 * input, but the degenerate hard-cut path slices at a raw index and needs
 * this guard. Applied unconditionally at every cut site as cheap defense in
 * depth. Pure, O(1) beyond the slice itself.
 */
const dropDanglingHighSurrogate = (str: string): string => {
  const lastCode = str.charCodeAt(str.length - 1);
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? str.slice(0, -1) : str;
};

/**
 * Graceful, lossless title derivation — replaces the old hard mid-word slice.
 *
 * 1. Normalize: trim, then collapse every whitespace run (incl. newlines) to
 *    a single space, so the rendered bold title never breaks mid-line.
 * 2. Fits: normalized length within the cap → return verbatim, untruncated.
 * 3. Sentence preference: if the leading sentence is within
 *    [MIN_SENTENCE_LENGTH, FINDING_TITLE_MAX_LENGTH], prefer it. No ellipsis
 *    is appended — the returned text is a genuine complete sentence, not a
 *    truncation artifact — but `truncated` is still reported `true` so the
 *    explanation-prepend (no-information-loss mechanism) still fires.
 * 4/5. Word boundary (or, absent any space in the 120-character window, a
 *    degenerate hard cut): cut at the last space at or before
 *    `FINDING_TITLE_MAX_LENGTH - 1` (i.e. anywhere in the first
 *    `FINDING_TITLE_MAX_LENGTH` characters) and append the ellipsis; absent
 *    any such space, hard-cut at `FINDING_TITLE_MAX_LENGTH - 1` characters
 *    instead, reserving one character of the budget for the ellipsis.
 *
 * Post-condition: `title.length <= FINDING_TITLE_MAX_LENGTH` always; the
 * ellipsis is present iff the title was cut mid-message (word boundary or
 * degenerate hard cut) — never when the first-sentence path is taken.
 */
const deriveTitle = (message: string): DerivedTitle => {
  const normalized = normalizeMessage(message);

  if (normalized.length <= FINDING_TITLE_MAX_LENGTH) {
    return { title: normalized, truncated: false };
  }

  const sentenceMatch = normalized.match(LEADING_SENTENCE_RE);
  const sentence = sentenceMatch?.[1];
  if (
    sentence !== undefined &&
    sentence.length >= MIN_SENTENCE_LENGTH &&
    sentence.length <= FINDING_TITLE_MAX_LENGTH
  ) {
    return { title: sentence, truncated: true };
  }

  // Search the full 120-character window (indices 0..FINDING_TITLE_MAX_LENGTH-1)
  // for the last space, so a space sitting exactly at the final index is not
  // missed (an off-by-one there would forfeit the last few characters of
  // budget for no reason — see the regression test below).
  const searchWindow = normalized.slice(0, FINDING_TITLE_MAX_LENGTH);
  const lastSpace = searchWindow.lastIndexOf(' ');
  const rawCut =
    lastSpace === -1
      ? normalized.slice(0, FINDING_TITLE_MAX_LENGTH - 1)
      : normalized.slice(0, lastSpace);
  const cut = dropDanglingHighSurrogate(rawCut);
  return { title: `${cut}${ELLIPSIS}`, truncated: true };
};

const excerptFor = (value: unknown): string => {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return '[unserializable]';
    return json.length > 240 ? `${json.slice(0, 240)}...` : json;
  } catch {
    return '[unserializable]';
  }
};

/**
 * Validate, dedupe and cap the provider's `highlights` array. Ordered rules
 * (each drop logged with its own `reason_code`), per spec § A.5:
 *   0. `positive_feedback.enabled !== true` → return empty, no rejections
 *      logged (a provider that emits highlights anyway is silently ignored).
 *   1. Normalize `message`/`rationale` (trim + collapse whitespace).
 *   2. Either normalized string empty → `highlight_blank`.
 *   3. `message` or `rationale` over its max length → `highlight_too_long`.
 *   4. `path` present and not an analyzable file → `highlight_path_not_in_diff`.
 *   5. Normalized `message` (lowercased) already seen → `highlight_duplicate`.
 *   6. Survivor index ≥ `max_items` → `highlight_over_cap`.
 *
 * Dedupe happens BEFORE the cap, so duplicates cannot consume cap slots.
 * Survivors keep provider order. Pure: no clock, no random, no I/O — the
 * caller supplies `ranAt`.
 */
const validateHighlights = (
  raw: ReadonlyArray<ProviderReviewOutputHighlight>,
  analyzableFiles: ReadonlyMap<string, AnalyzableFile>,
  cfg: RepoConfig,
  ranAt: string,
): { highlights: ReviewHighlight[]; rejections: RejectionLogEntry[] } => {
  if (cfg.positive_feedback.enabled !== true) {
    return { highlights: [], rejections: [] };
  }

  const highlights: ReviewHighlight[] = [];
  const rejections: RejectionLogEntry[] = [];
  const seenMessages = new Set<string>();

  for (const item of raw) {
    const message = normalizeMessage(item.message);
    const rationale = normalizeMessage(item.rationale);

    if (message.length === 0 || rationale.length === 0) {
      rejections.push({
        finding_id: null,
        stage: 'validator',
        reason_code: 'highlight_blank',
        reason_message: 'highlight message or rationale is blank after normalization',
        provider_output_excerpt: excerptFor(item),
        timestamp: ranAt,
      });
      continue;
    }

    if (
      message.length > HIGHLIGHT_MESSAGE_MAX_LENGTH ||
      rationale.length > HIGHLIGHT_RATIONALE_MAX_LENGTH
    ) {
      rejections.push({
        finding_id: null,
        stage: 'validator',
        reason_code: 'highlight_too_long',
        reason_message: 'highlight message or rationale exceeds the maximum allowed length',
        provider_output_excerpt: excerptFor(item),
        timestamp: ranAt,
      });
      continue;
    }

    if (item.path !== undefined && !analyzableFiles.has(item.path)) {
      rejections.push({
        finding_id: null,
        stage: 'validator',
        reason_code: 'highlight_path_not_in_diff',
        reason_message: `path ${item.path} is not present in the analyzable diff`,
        provider_output_excerpt: excerptFor(item),
        timestamp: ranAt,
      });
      continue;
    }

    const dedupeKey = message.toLowerCase();
    if (seenMessages.has(dedupeKey)) {
      rejections.push({
        finding_id: null,
        stage: 'validator',
        reason_code: 'highlight_duplicate',
        reason_message: 'duplicate of an earlier highlight (normalized message already seen)',
        provider_output_excerpt: excerptFor(item),
        timestamp: ranAt,
      });
      continue;
    }
    seenMessages.add(dedupeKey);

    if (highlights.length >= cfg.positive_feedback.max_items) {
      rejections.push({
        finding_id: null,
        stage: 'validator',
        reason_code: 'highlight_over_cap',
        reason_message: 'highlight count exceeds the configured positive_feedback.max_items',
        provider_output_excerpt: excerptFor(item),
        timestamp: ranAt,
      });
      continue;
    }

    highlights.push({
      message,
      rationale,
      ...(item.path !== undefined ? { path: item.path } : {}),
    });
  }

  return { highlights, rejections };
};

export const runValidator = (
  output: ProviderReviewOutput,
  ctx: ValidatorContext,
): ValidatorResult => {
  // Belt-and-suspenders re-validation: the adapter already validated, but
  // `docs/api-contracts.md` § Invariants item 8 requires every drop to be
  // logged. This branch surfaces a structured rejection if a malformed
  // ProviderReviewOutput slips past the adapter (e.g., during refactors).
  const parsed = ProviderReviewOutputSchema.safeParse(output);
  if (!parsed.success) {
    const rejections: RejectionLogEntry[] = parsed.error.issues.map((issue) => ({
      finding_id: null,
      stage: 'validator',
      reason_code: 'provider_output_zod_failed',
      reason_message: issue.message,
      provider_output_excerpt: excerptFor({ path: issue.path, message: issue.message }),
      timestamp: ctx.ran_at,
    }));
    if (rejections.length === 0) {
      rejections.push({
        finding_id: null,
        stage: 'validator',
        reason_code: 'provider_output_zod_failed',
        reason_message: 'provider output failed schema validation',
        provider_output_excerpt: excerptFor(output),
        timestamp: ctx.ran_at,
      });
    }
    return { findings: [], rejections, highlights: [] };
  }

  const validated: ProviderReviewOutput = parsed.data;
  const analyzableFiles = buildAnalyzableFiles(ctx.snapshot);
  const findings: NormalizedFinding[] = [];
  const rejections: RejectionLogEntry[] = [];

  for (const [index, providerFinding] of validated.findings.entries()) {
    const file = analyzableFiles.get(providerFinding.path);
    if (file === undefined) {
      rejections.push({
        finding_id: null,
        stage: 'validator',
        reason_code: 'path_not_in_diff',
        reason_message: `path ${providerFinding.path} is not present in the analyzable diff`,
        provider_output_excerpt: excerptFor(providerFinding),
        timestamp: ctx.ran_at,
      });
      continue;
    }

    const hunk = findHunkForLine(file, providerFinding.line);
    if (hunk === undefined) {
      rejections.push({
        finding_id: null,
        stage: 'validator',
        reason_code: 'line_not_in_diff',
        reason_message: `line ${providerFinding.line} is outside any touched hunk in ${providerFinding.path}`,
        provider_output_excerpt: excerptFor(providerFinding),
        timestamp: ctx.ran_at,
      });
      continue;
    }

    if (!Number.isFinite(providerFinding.confidence)) {
      rejections.push({
        finding_id: null,
        stage: 'validator',
        reason_code: 'invalid_confidence',
        reason_message: 'confidence is not a finite number',
        provider_output_excerpt: excerptFor(providerFinding),
        timestamp: ctx.ran_at,
      });
      continue;
    }

    // `message: z.string().min(1)` admits whitespace-only strings (e.g. "   ").
    // Normalizing collapses those to '', which would otherwise silently
    // produce a NormalizedFinding with an empty title — reject explicitly
    // instead, per `NormalizedFindingSchema.title.min(1)`.
    if (normalizeMessage(providerFinding.message).length === 0) {
      rejections.push({
        finding_id: null,
        stage: 'validator',
        reason_code: 'blank_message',
        reason_message:
          'provider message is blank (whitespace-only) and normalizes to an empty title',
        provider_output_excerpt: excerptFor(providerFinding),
        timestamp: ctx.ran_at,
      });
      continue;
    }

    const id = ctx.generateId ? ctx.generateId() : `${ctx.run_id}:${index}`;
    const evidence = buildEvidence(providerFinding.path, hunk.id, providerFinding.line);
    const dedupe_key = computeDedupeKey(providerFinding.path, providerFinding.category);
    const { title, truncated } = deriveTitle(providerFinding.message);
    // No-information-loss mechanism (H-A, spec § Approach — Layer B): when the
    // rendered title is truncated, prepend the full trimmed provider message as
    // the first paragraph of `explanation` so nothing the model wrote is lost.
    const explanation = truncated
      ? `${providerFinding.message.trim()}\n\n${providerFinding.rationale}`
      : providerFinding.rationale;
    const finding: NormalizedFinding = {
      id,
      path: providerFinding.path,
      line_start: providerFinding.line,
      line_end: providerFinding.line,
      category: providerFinding.category,
      severity: providerFinding.severity,
      confidence: providerFinding.confidence,
      title,
      explanation,
      evidence,
      render_target: 'inline',
      source_artifacts_used: ['pr_diff'],
      dedupe_key,
      ...(providerFinding.suggested_fix !== undefined
        ? { suggested_fix: providerFinding.suggested_fix }
        : {}),
      ...(truncated
        ? { validator_notes: ['title truncated: full message preserved in explanation'] }
        : {}),
    };
    findings.push(finding);
  }

  const { highlights, rejections: highlightRejections } = validateHighlights(
    validated.highlights ?? [],
    analyzableFiles,
    ctx.config,
    ctx.ran_at,
  );
  rejections.push(...highlightRejections);

  return { findings, rejections, highlights };
};
