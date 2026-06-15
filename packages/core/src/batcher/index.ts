import type { PrefilteredFile, ProviderReviewInput, TokenizerFamily } from '@prisma-bot/shared';
import { estimatePromptTokens, serializeForEstimate } from '@prisma-bot/shared';
import { splitFileByHunks } from './split-file.js';

// Re-export splitFileByHunks so the orchestrator can use it for Phase 4
// over_budget guard-trip hunk-splitting without importing from a sub-path.
export { splitFileByHunks } from './split-file.js';
export type { SplitFileResult } from './split-file.js';

/**
 * `planBatches` — pure, deterministic greedy bin-packer for diff chunking.
 *
 * Phase 2 changes (chunking-stability-spec.md § Phase 2):
 *   - `callTokenBudget` is the derived `hard_cap_in` from the orchestrator
 *     (computed via the reservation formula from the provider's context window).
 *     The old 60k literal is gone.
 *   - Token estimation per batch now uses `serializeForEstimate` + `estimatePromptTokens`
 *     over the BATCH's full `ProviderReviewInput` (system + line-numbered diff +
 *     guidance + tool schema) — not just raw content length. HOTSPOT-6 (line-span
 *     fallback divergence) is eliminated: there is now exactly ONE estimator code
 *     path for both the batcher and the per-call guard.
 *   - The `buildInputForBatch` callback (injected by the orchestrator) provides the
 *     guidance-aware `ProviderReviewInput` for a candidate file set. This keeps
 *     guidance/model-slug logic in the orchestrator and the batcher pure/deterministic.
 *   - `HARD_SAFETY_CAP_TOKENS` magic constant removed: the hard skip threshold is now
 *     `absoluteCapTokens` = `window - reserved_output - prompt_overhead` (true overflow).
 *     A single file over `callTokenBudget` but under `absoluteCapTokens` still gets
 *     its OWN batch (sent alone; the model's real context window may accept it).
 *     Only a file over `absoluteCapTokens` goes to `skippedFiles`.
 *
 * Algorithm:
 *   1. Sort files ascending by path (determinism).
 *   2. Estimate each candidate batch via `estimatePromptTokens(serializeForEstimate(batch), family)`.
 *   3. Skip if single-file estimate > `absoluteCapTokens` (true overflow — even alone it won't fit).
 *   4. Greedy pack: accumulate files into the current batch until adding the next file
 *      would push the batch estimate over `callTokenBudget`, then open a new batch.
 *   5. A single file whose estimate alone exceeds `callTokenBudget` gets its OWN batch
 *      (sent alone; provider may still accept it — the model's real window is authoritative).
 *   6. If the resulting batch count > `opts.maxCalls`, set `overCap: true`.
 *
 * Returns:
 *   batches         — ordered `PrefilteredFile[][]`; never contains an empty batch.
 *   skippedFiles    — files whose token estimate exceeded `absoluteCapTokens`.
 *   estTotalTokens  — sum of single-file estimates across all placed files.
 *   overCap         — true when `batches.length > opts.maxCalls`.
 *
 * Phase 3 changes (chunking-stability-spec.md § Phase 3):
 *   - Single-file-over-budget branch now calls `splitFileByHunks` (for files with
 *     >1 hunk) to produce N sub-files at hunk boundaries before bin-packing.
 *   - Each sub-file retains the SAME `path` so (path,category) dedupe (validator
 *     :97-100) and the orchestrator's allFindings flatten are unchanged.
 *   - A hunk whose estimate alone exceeds `absoluteCapTokens` (true overflow) goes
 *     to `skippedFiles` with a `note` — never silently dropped (AC3.3).
 *   - A single-hunk file over `callTokenBudget` still gets its own batch (no split
 *     possible with only one hunk).
 *
 * Per docs/_planning/diff-chunking/spec.md § Batcher algorithm.
 * Per chunking-stability-spec.md § Phase 2 "Batcher derived budget".
 * Per chunking-stability-spec.md § Phase 3 "Hunk-level splitting".
 */

/**
 * A single file (or hunk sub-file) excluded from all batches because its size
 * is too large for the provider's context window.
 *
 * Phase 3: the `note` field carries a human-readable explanation when a
 * specific hunk within a file is the overflow source. It is always set for
 * Phase-3 overflow-hunk skips so callers can surface a visible "not reviewed"
 * notice (AC3.3 — never silently drop an overflow hunk).
 */
export interface BatcherSkippedFile {
  path: string;
  est_tokens: number;
  /** Optional human-readable note about WHY this file/hunk was skipped. */
  note?: string;
}

export interface PlanBatchesResult {
  batches: PrefilteredFile[][];
  skippedFiles: BatcherSkippedFile[];
  estTotalTokens: number;
  /**
   * Files in batches that were dropped because the plan exceeded `maxCalls`.
   * Phase 4: replaces the all-or-nothing `overCap` cliff. The orchestrator
   * surfaces these in the check-run notice as "not reviewed (call budget exceeded)".
   *
   * Empty when all planned batches fit within `maxCalls` (AC4.5 no-regression).
   *
   * Per chunking-stability-spec.md § Phase 4 "Batcher — priority ordering".
   */
  notReviewed: BatcherSkippedFile[];
  /**
   * `true` when the plan's batch count exceeds `maxCalls`.
   * Kept for back-compat (existing tests and callers may read it).
   * No longer gates a PR-wide skip — the orchestrator now uses `notReviewed`
   * to apply subset-and-note instead (Phase 4 D3).
   *
   * @deprecated prefer checking `notReviewed.length > 0` in new code.
   */
  overCap: boolean;
}

export interface PlanBatchesOpts {
  /**
   * Per-call input token budget for greedy bin-packing.
   * Phase 2: this is the DERIVED `hard_cap_in` from the orchestrator
   * (reservation formula: window − reserved_output − prompt_overhead − safety).
   * The orchestrator also applies `min(call_token_budget, hard_cap_in)` before
   * passing this value, so existing per-call_token_budget caps still work.
   */
  callTokenBudget: number;
  /**
   * Hard absolute cap: a file whose single-file serialized estimate exceeds this
   * value goes to `skippedFiles` (true overflow — even alone it cannot fit in the
   * provider's context window). Defaults to `callTokenBudget` when not provided.
   *
   * Phase 2: this replaces the old `HARD_SAFETY_CAP_TOKENS=110000` constant.
   * The orchestrator computes it as `window - reserved_output - prompt_overhead`
   * (no safety fraction, because a file that is truly larger than this CANNOT fit
   * even in a dedicated call).
   *
   * Files over `callTokenBudget` but under `absoluteCapTokens` still get their
   * OWN batch (sent alone; provider may accept them — the real context window
   * is authoritative, not our estimate).
   */
  absoluteCapTokens?: number;
  /** Maximum number of provider calls allowed for this PR. */
  maxCalls: number;
  /**
   * Tokenizer family for the active provider/model.
   * Used by `estimatePromptTokens` to pick cl100k/o200k/anthropic-approx.
   * Per chunking-stability-spec.md § Phase 2 "Provider capabilities".
   */
  tokenizerFamily: TokenizerFamily;
  /**
   * Callback that builds the full `ProviderReviewInput` for a given file set.
   * Injected by the orchestrator so guidance/model-slug logic stays there;
   * the batcher remains pure and deterministic (no guidance knowledge).
   *
   * The batcher calls this for EACH candidate file (and batch) before estimating
   * tokens, so the estimate includes system + diff + guidance + tool schema — the
   * same payload the adapter will send on the wire.
   *
   * Per chunking-stability-spec.md § Phase 2 data-flow:
   *   "a thin injected callback `buildInputForBatch: (files) => ProviderReviewInput`"
   */
  buildInputForBatch: (files: PrefilteredFile[]) => ProviderReviewInput;
}

/**
 * Estimate the token cost of a `ProviderReviewInput` (a candidate batch).
 * This is THE single estimator for the batcher — no other token math exists.
 *
 * Uses `serializeForEstimate` to build the exact serialized prompt, then
 * `estimatePromptTokens` to count tokens. Same function the adapter guard
 * calls, so batcher and guard are always in agreement (AC2.1).
 */
function estimateBatchTokens(input: ProviderReviewInput, family: TokenizerFamily): number {
  return estimatePromptTokens(serializeForEstimate(input), family);
}

/**
 * Priority-ordering risk proxy for Phase 4 subset-and-note (AC4.2, D3).
 *
 * This is DETERMINISTIC TRIAGE ORDERING — not finding scoring. Same input
 * always produces the same order (pure function over file metadata).
 *
 * Proxy (in priority order, first discriminates):
 *   1. HIGH-RISK PATH KEYWORDS — files whose path contains a security, auth, or
 *      migration keyword sort first (risk = 0). Keywords are lower-cased for
 *      case-insensitive matching. This uses patterns already present in the
 *      prefilter's skip-rule logic (e.g. lockfile/vendored), extended to the
 *      positive-risk direction.
 *      Keywords: 'security', 'auth', 'migration', 'migrate', 'secret', 'crypto',
 *                'password', 'credential', 'permission', 'access', 'token', 'key'.
 *   2. LARGER CHANGE SIZE — files with more hunks sort earlier (more hunks = larger
 *      change = more likely to contain issues).
 *   3. PATH ASCENDING — stable alphabetical tie-break for determinism.
 *
 * The ordering is applied BEFORE bin-packing so the batcher greedily fills the
 * highest-risk files first. When `batches.length > maxCalls`, the dropped batches
 * (lowest-risk) are collected into `notReviewed` (AC4.1).
 *
 * Per chunking-stability-spec.md § Phase 4 "Batcher — priority ordering".
 */
const HIGH_RISK_PATH_KEYWORDS = [
  'security',
  'auth',
  'migration',
  'migrate',
  'secret',
  'crypto',
  'password',
  'credential',
  'permission',
  'access',
  'token',
  'key',
] as const;

function riskScore(file: PrefilteredFile): number {
  // Returns 0 for high-risk paths (sorts first), 1 for normal paths.
  const lowerPath = file.path.toLowerCase();
  for (const kw of HIGH_RISK_PATH_KEYWORDS) {
    if (lowerPath.includes(kw)) return 0;
  }
  return 1;
}

/**
 * Comparator for priority ordering. Returns negative if `a` should come before
 * `b` (higher risk = lower index = reviewed first).
 */
function priorityCompare(a: PrefilteredFile, b: PrefilteredFile): number {
  // 1. Risk score (0 = high risk first).
  const riskDiff = riskScore(a) - riskScore(b);
  if (riskDiff !== 0) return riskDiff;
  // 2. More hunks = larger change = higher risk = sort first.
  const hunkDiff = b.hunks.length - a.hunks.length;
  if (hunkDiff !== 0) return hunkDiff;
  // 3. Stable alphabetical tie-break.
  return a.path.localeCompare(b.path);
}

export const planBatches = (files: PrefilteredFile[], opts: PlanBatchesOpts): PlanBatchesResult => {
  const { callTokenBudget, maxCalls, tokenizerFamily, buildInputForBatch } = opts;
  // absoluteCapTokens: the true-overflow threshold. Files above this CANNOT
  // fit in any provider call even alone. Defaults to callTokenBudget (i.e.,
  // anything over budget is skipped) when not provided by the orchestrator.
  const absoluteCapTokens = opts.absoluteCapTokens ?? callTokenBudget;

  // Phase 4: sort files by the DETERMINISTIC risk proxy BEFORE bin-packing so
  // the batcher greedily fills the highest-risk files first. When the plan
  // exceeds `maxCalls`, the DROPPED batches are the lowest-risk ones.
  //
  // Risk proxy: security/migration path keywords > more hunks > path ascending.
  // See `priorityCompare` above for the documented proxy.
  //
  // This is TRIAGE ORDERING, not finding scoring (spec §9 Out of Scope).
  const sorted = [...files].sort(priorityCompare);

  const batches: PrefilteredFile[][] = [];
  const skippedFiles: BatcherSkippedFile[] = [];
  let estTotalTokens = 0;

  // Running accumulator for the current batch.
  let currentBatch: PrefilteredFile[] = [];
  let currentBatchEst = 0;

  const flushCurrentBatch = () => {
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchEst = 0;
    }
  };

  /**
   * Pack a single `PrefilteredFile` (or sub-file) into the batch plan.
   * Shared by both the direct-file path and the post-split sub-file path.
   *
   * - If `singleEst > absoluteCapTokens`: record as skipped (true overflow).
   * - If `singleEst > callTokenBudget`: own batch (sent alone; provider may accept).
   * - Otherwise: greedy-pack into the current batch.
   */
  const packUnit = (unit: PrefilteredFile, singleEst: number) => {
    if (singleEst > absoluteCapTokens) {
      skippedFiles.push({ path: unit.path, est_tokens: singleEst });
      return;
    }

    if (singleEst > callTokenBudget) {
      // Soft over-budget: own batch (sent alone; provider may accept it).
      flushCurrentBatch();
      batches.push([unit]);
      estTotalTokens += singleEst;
      return;
    }

    // File fits within budget. Try to add it to the current batch.
    if (currentBatch.length === 0) {
      currentBatch = [unit];
      currentBatchEst = singleEst;
      estTotalTokens += singleEst;
    } else {
      const candidateBatch = [...currentBatch, unit];
      const candidateInput = buildInputForBatch(candidateBatch);
      const candidateEst = estimateBatchTokens(candidateInput, tokenizerFamily);

      if (candidateEst <= callTokenBudget) {
        // Fits: add to current batch.
        estTotalTokens = estTotalTokens - currentBatchEst + candidateEst;
        currentBatch = candidateBatch;
        currentBatchEst = candidateEst;
      } else {
        // Doesn't fit: close the current batch and start a new one.
        batches.push(currentBatch);
        currentBatch = [unit];
        currentBatchEst = singleEst;
        estTotalTokens += singleEst;
      }
    }
  };

  for (const file of sorted) {
    // Estimate this file alone to check both thresholds.
    const singleFileInput = buildInputForBatch([file]);
    const singleFileEst = estimateBatchTokens(singleFileInput, tokenizerFamily);

    // Phase 3: if the file's single-file estimate exceeds callTokenBudget, attempt
    // hunk-level splitting before falling back to own-batch or skip.
    // A file whose estimate is ALREADY within budget skips splitting entirely.
    if (singleFileEst > callTokenBudget && file.hunks.length > 1) {
      // Split at hunk boundaries. Sub-files share `path` so (path,category)
      // dedupe in the validator is unchanged (validator/index.ts :97-100).
      const { subFiles, overflowHunks } = splitFileByHunks(
        file,
        callTokenBudget,
        absoluteCapTokens,
        tokenizerFamily,
        buildInputForBatch,
      );

      // Overflow hunks: single hunk exceeds absoluteCapTokens → skip with note.
      for (const { hunkId, estTokens } of overflowHunks) {
        skippedFiles.push({
          path: file.path,
          est_tokens: estTokens,
          // Include the hunk id so callers can surface a visible "not reviewed" note.
          // The BatcherSkippedFile type is extended below with an optional note field.
          note: `hunk ${hunkId} exceeds the absolute token cap (${estTokens} tokens) and cannot be reviewed`,
        });
      }

      // Bin-pack each sub-file as an independent unit.
      for (const subFile of subFiles) {
        const subFileInput = buildInputForBatch([subFile]);
        const subFileEst = estimateBatchTokens(subFileInput, tokenizerFamily);
        packUnit(subFile, subFileEst);
      }
      continue;
    }

    // No split needed (or single-hunk file over budget): use the standard path.
    packUnit(file, singleFileEst);
  }

  // Flush the last in-progress batch.
  flushCurrentBatch();

  // Phase 4: subset-and-note (D3, AC4.1). Instead of the all-or-nothing
  // `overCap` cliff, keep the first `maxCalls` batches (the highest-risk ones,
  // because we sorted by risk before bin-packing) and collect every file in the
  // dropped batches into `notReviewed`.
  //
  // When `batches.length <= maxCalls`: `notReviewed` is empty (AC4.5 no-regression).
  // When `batches.length > maxCalls`: the dropped batches' files go to `notReviewed`;
  //   the orchestrator surfaces them in the check-run notice.
  const notReviewed: BatcherSkippedFile[] = [];
  let keptBatches = batches;

  if (batches.length > maxCalls) {
    keptBatches = batches.slice(0, maxCalls);
    const droppedBatches = batches.slice(maxCalls);
    for (const droppedBatch of droppedBatches) {
      for (const file of droppedBatch) {
        notReviewed.push({
          path: file.path,
          // est_tokens: 0 because the file was dropped at the plan level,
          // not because of a per-file estimate. The orchestrator surfaces the
          // drop reason via the notice, not the per-file token count.
          est_tokens: 0,
          note: `dropped: PR exceeds the per-PR call budget of ${maxCalls}`,
        });
      }
    }
  }

  const overCap = batches.length > maxCalls;
  return { batches: keptBatches, skippedFiles, estTotalTokens, overCap, notReviewed };
};
