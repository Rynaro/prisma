import { createHash } from 'node:crypto';
import {
  type NormalizedFinding,
  type PrSnapshot,
  type ProviderReviewOutput,
  ProviderReviewOutputSchema,
  type RejectionLogEntry,
  type RepoConfig,
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
 * Canonicalize a provider message for dedupe-key derivation.
 *
 * Lowercases, strips ASCII punctuation, and collapses whitespace so that
 * cosmetic differences in the model's wording do not produce distinct
 * `dedupe_key` values. The publisher (Phase 5.5) consults the resulting key
 * to suppress duplicates within a run and across webhook redeliveries.
 */
const PUNCTUATION_CHARS = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const PUNCTUATION_SET = new Set(PUNCTUATION_CHARS.split(''));

const canonicalizeMessage = (msg: string): string => {
  let stripped = '';
  for (const ch of msg.toLowerCase()) {
    stripped += PUNCTUATION_SET.has(ch) ? ' ' : ch;
  }
  return stripped.replace(/\s+/g, ' ').trim();
};

const computeDedupeKey = (path: string, message: string): string => {
  const canonical = `${path}:${canonicalizeMessage(message)}`;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
};

const buildEvidence = (path: string, hunkId: string, line: number): string[] => [
  `${path}:${line}`,
  `hunk:${hunkId}`,
];

const truncateTitle = (msg: string): string => (msg.length <= 120 ? msg : msg.slice(0, 120));

const excerptFor = (value: unknown): string => {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return '[unserializable]';
    return json.length > 240 ? `${json.slice(0, 240)}...` : json;
  } catch {
    return '[unserializable]';
  }
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
    return { findings: [], rejections };
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

    const id = ctx.generateId ? ctx.generateId() : `${ctx.run_id}:${index}`;
    const evidence = buildEvidence(providerFinding.path, hunk.id, providerFinding.line);
    const dedupe_key = computeDedupeKey(providerFinding.path, providerFinding.message);
    const finding: NormalizedFinding = {
      id,
      path: providerFinding.path,
      line_start: providerFinding.line,
      line_end: providerFinding.line,
      category: providerFinding.category,
      severity: providerFinding.severity,
      confidence: providerFinding.confidence,
      title: truncateTitle(providerFinding.message),
      explanation: providerFinding.rationale,
      evidence,
      render_target: 'inline',
      source_artifacts_used: ['pr_diff'],
      dedupe_key,
      ...(providerFinding.suggested_fix !== undefined
        ? { suggested_fix: providerFinding.suggested_fix }
        : {}),
    };
    findings.push(finding);
  }

  return { findings, rejections };
};
