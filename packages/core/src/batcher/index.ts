import type { PrefilteredFile } from '@prisma-bot/shared';

/**
 * `planBatches` — pure, deterministic greedy bin-packer for diff chunking.
 *
 * Splits a `PrefilteredFile[]` into ordered batches so each batch's estimated
 * token count stays within `opts.callTokenBudget`. Sorting files by path first
 * guarantees determinism (same input → same batches across runs), which pairs
 * correctly with `deterministic_seed` on provider adapters.
 *
 * Algorithm:
 *   1. Sort files ascending by path.
 *   2. Estimate per-file tokens: Σ(hunk.content.length) / 4, falling back to
 *      Σ(hunk.line_end − hunk.line_start + 1) when all content strings are
 *      empty (the Phase 5.4 no-hunk-content path). This mirrors the estimator
 *      pattern in `packages/core/src/augmentation/index.ts:36`.
 *   3. Greedy pack: accumulate files into the current batch until the next
 *      file would push the batch over `callTokenBudget`, then open a new batch.
 *   4. A single file whose estimate alone exceeds `callTokenBudget` gets its
 *      OWN batch (sent alone; the model's real context window may still accept
 *      it). Only if its estimate exceeds `HARD_SAFETY_CAP_TOKENS` (≈110,000)
 *      does it go into `skippedFiles` — this avoids a guaranteed context-
 *      overflow while preserving the no-file-split rule.
 *   5. If the resulting batch count > `opts.maxCalls`, set `overCap: true`.
 *      The orchestrator converts this into an oversized skip.
 *
 * Returns:
 *   batches         — ordered `PrefilteredFile[][]`; never contains an empty batch.
 *   skippedFiles    — files whose token estimate exceeded `HARD_SAFETY_CAP_TOKENS`.
 *   estTotalTokens  — sum of per-file estimates across all placed files (not skipped).
 *   overCap         — true when `batches.length > opts.maxCalls`.
 *
 * Per docs/_planning/diff-chunking/spec.md § Batcher algorithm.
 */

/** A single file excluded from all batches because its size is too large. */
export interface BatcherSkippedFile {
  path: string;
  est_tokens: number;
}

export interface PlanBatchesResult {
  batches: PrefilteredFile[][];
  skippedFiles: BatcherSkippedFile[];
  estTotalTokens: number;
  overCap: boolean;
}

export interface PlanBatchesOpts {
  /** Per-call input token budget for greedy bin-packing. */
  callTokenBudget: number;
  /** Maximum number of provider calls allowed for this PR. */
  maxCalls: number;
}

/**
 * Hard safety cap: a single file whose token estimate exceeds this value is
 * placed in `skippedFiles` rather than its own batch, because sending it
 * alone would virtually guarantee a context-overflow even on the largest
 * available models (128k–200k context minus output reserve minus guidance
 * overhead). Set to ≈110,000 tokens.
 */
const HARD_SAFETY_CAP_TOKENS = 110_000;

/**
 * Estimate the token cost of a single `PrefilteredFile`.
 *
 * Primary: Σ(hunk.content.length) / 4 — matches the augmentation module and
 * adapter pre-flight estimators that use `text.length / 4`.
 * Fallback: when all content strings are empty (Phase 5.4 path), estimate
 * from line spans instead: Σ(line_end − line_start + 1).
 */
const estimateFileTokens = (file: PrefilteredFile): number => {
  const totalContentLen = file.hunks.reduce((s, h) => s + h.content.length, 0);
  if (totalContentLen > 0) {
    return Math.ceil(totalContentLen / 4);
  }
  // Fallback: sum of hunk line spans (rough proxy when content is absent).
  const lineSpan = file.hunks.reduce((s, h) => s + (h.line_end - h.line_start + 1), 0);
  return Math.max(lineSpan, 1);
};

export const planBatches = (files: PrefilteredFile[], opts: PlanBatchesOpts): PlanBatchesResult => {
  const { callTokenBudget, maxCalls } = opts;

  // Step 1: sort ascending by path for determinism.
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

  const batches: PrefilteredFile[][] = [];
  const skippedFiles: BatcherSkippedFile[] = [];
  let estTotalTokens = 0;

  // Running total for the current batch.
  let currentBatch: PrefilteredFile[] = [];
  let currentBatchTokens = 0;

  for (const file of sorted) {
    const est = estimateFileTokens(file);

    // Hard cap: this file alone would overflow even the largest context window.
    if (est > HARD_SAFETY_CAP_TOKENS) {
      skippedFiles.push({ path: file.path, est_tokens: est });
      continue;
    }

    // If this file fits in the current batch, add it.
    if (currentBatch.length === 0 || currentBatchTokens + est <= callTokenBudget) {
      currentBatch.push(file);
      currentBatchTokens += est;
      estTotalTokens += est;
    } else {
      // Close the current batch and open a new one.
      batches.push(currentBatch);
      currentBatch = [file];
      currentBatchTokens = est;
      estTotalTokens += est;
    }
  }

  // Flush the last in-progress batch.
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  const overCap = batches.length > maxCalls;
  return { batches, skippedFiles, estTotalTokens, overCap };
};
