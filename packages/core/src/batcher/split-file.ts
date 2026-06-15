import type { PrefilteredFile, ProviderReviewInput, TokenizerFamily } from '@prisma-bot/shared';
import { estimatePromptTokens, serializeForEstimate } from '@prisma-bot/shared';

/**
 * `splitFileByHunks` — hunk-level file splitter for the diff-chunking subsystem.
 *
 * Phase 3 of chunking-stability-spec.md § Phase 3 — Hunk-level splitting.
 *
 * PURPOSE
 * -------
 * When a single file's serialized token estimate exceeds `hard_cap_in` (the
 * per-call input budget), this function divides it into sub-files at hunk
 * boundaries. Each sub-file:
 *   - shares the SAME `path` as the original (so validator (path,category) dedupe
 *     and the orchestrator's allFindings flatten work unchanged)
 *   - carries a SUBSET of the original file's hunks
 *   - preserves ALL hunk fields verbatim (id, line_start, line_end, content) so
 *     the renderer's `<n>: ` line citations are byte-stable vs a non-split render
 *
 * ALGORITHM (spec §Phase 3 steps 1–5)
 * ------------------------------------
 * 1. Sort hunks by `line_start` (deterministic).
 * 2. Greedy-pack hunks into sub-files: accumulate until adding the next hunk
 *    would push the sub-file's SERIALIZED estimate (via estimatePromptTokens
 *    over buildInputForBatch([subFile])) over `budgetTokens`; then open a new
 *    sub-file with the same `path`.
 * 3. Context-trimming NOT performed — the splitter operates on existing hunk
 *    boundaries produced upstream by the prefilter. `core` lacks the raw patch;
 *    re-diffing belongs to a future prefilter change. The `hunk_context_lines`
 *    config knob (default 10) is a forward-compat record only.
 * 4. A single hunk whose own serialized estimate alone exceeds `budgetTokens`
 *    goes in its OWN sub-file regardless (sent alone; the model's real window
 *    may accept it). Only if it ALSO exceeds `absoluteCapTokens`
 *    (window − reserved_output − prompt_overhead, i.e. true overflow) does it
 *    land in `overflowHunks` (caller routes to skippedFiles with a note).
 * 5. Determinism: same file + same budget → identical sub-file partition (pure
 *    function; sorted input; no randomness).
 *
 * RENDERER COMPATIBILITY
 * ----------------------
 * `renderUserMessage` / `renderHunkBody` (review-prompt.ts :99-146) already
 * iterate `file.hunks`, so a sub-file with a hunk subset renders correctly.
 * Line numbering (`<n>: `) is derived from each hunk's `line_start` which is
 * preserved verbatim — citations are byte-stable across split and non-split
 * renders (AC3.4).
 *
 * Per chunking-stability-spec.md § Phase 3.
 */

export interface SplitFileResult {
  /**
   * Sub-files to bin-pack. Each has the same `path` as the original and a
   * non-empty subset of the original's hunks. May contain sub-files whose
   * estimate alone exceeds `budgetTokens` (single-hunk-over-budget case);
   * the batcher handles those with its own-batch branch.
   */
  subFiles: PrefilteredFile[];
  /**
   * Hunks whose estimate ALONE exceeds `absoluteCapTokens` (true overflow —
   * even dedicated alone they cannot fit in the provider's context window).
   * The caller routes these to `skippedFiles` with a visible note.
   * Never silently dropped.
   */
  overflowHunks: Array<{ hunkId: string; estTokens: number }>;
}

/**
 * Split a single `PrefilteredFile` into sub-files at hunk boundaries so that
 * each sub-file's serialized token estimate fits within `budgetTokens`.
 *
 * @param file              - The original file to split (has ≥1 hunk).
 * @param budgetTokens      - Per-call input budget (`hard_cap_in`). Sub-files
 *                            are packed to stay under this limit.
 * @param absoluteCapTokens - True-overflow threshold (window − reserved_output
 *                            − prompt_overhead). A hunk exceeding this even
 *                            alone goes to `overflowHunks`.
 * @param family            - Tokenizer family for `estimatePromptTokens`.
 * @param buildInputForBatch - Callback (injected by the orchestrator) that
 *                            builds a `ProviderReviewInput` for a candidate
 *                            file set. Keeps guidance/model-slug logic in the
 *                            orchestrator; the splitter stays pure.
 * @returns SplitFileResult with sub-files and any overflow hunks.
 */
export function splitFileByHunks(
  file: PrefilteredFile,
  budgetTokens: number,
  absoluteCapTokens: number,
  family: TokenizerFamily,
  buildInputForBatch: (files: PrefilteredFile[]) => ProviderReviewInput,
): SplitFileResult {
  // Step 1: sort hunks by line_start for determinism.
  const sortedHunks = [...file.hunks].sort((a, b) => a.line_start - b.line_start);

  const subFiles: PrefilteredFile[] = [];
  const overflowHunks: SplitFileResult['overflowHunks'] = [];

  // Current sub-file accumulator.
  let currentHunks: PrefilteredFile['hunks'] = [];
  let currentEst = 0;

  /**
   * Close the current accumulator and push it as a sub-file.
   * No-op if empty (guards against double-flush).
   */
  const flushCurrentSubFile = () => {
    if (currentHunks.length > 0) {
      subFiles.push({ ...file, hunks: currentHunks });
      currentHunks = [];
      currentEst = 0;
    }
  };

  /**
   * Estimate the serialized token cost of a candidate sub-file
   * containing exactly `hunks` from the original file.
   */
  const estimateSubFile = (hunks: PrefilteredFile['hunks']): number => {
    const candidate: PrefilteredFile = { ...file, hunks };
    const input = buildInputForBatch([candidate]);
    return estimatePromptTokens(serializeForEstimate(input), family);
  };

  for (const hunk of sortedHunks) {
    // Step 4: check whether this single hunk alone would exceed absoluteCapTokens.
    const singleHunkEst = estimateSubFile([hunk]);

    if (singleHunkEst > absoluteCapTokens) {
      // True overflow: even alone this hunk cannot fit in the provider window.
      // Flush the current accumulator first, then record the overflow hunk.
      flushCurrentSubFile();
      overflowHunks.push({ hunkId: hunk.id, estTokens: singleHunkEst });
      continue;
    }

    // Step 2: greedy-pack.
    if (currentHunks.length === 0) {
      // Start a new sub-file with this hunk.
      currentHunks = [hunk];
      currentEst = singleHunkEst;
    } else {
      // Try adding this hunk to the current sub-file.
      const candidateHunks = [...currentHunks, hunk];
      const candidateEst = estimateSubFile(candidateHunks);

      if (candidateEst <= budgetTokens) {
        // Fits: extend the current sub-file.
        currentHunks = candidateHunks;
        currentEst = candidateEst;
      } else {
        // Doesn't fit: close the current sub-file and start a new one.
        // The new sub-file starts with only this hunk.
        // Note: singleHunkEst may exceed budgetTokens (single-hunk-over-budget
        // case from spec step 4). We put it in its own sub-file regardless;
        // the batcher's own-batch branch handles it (sent alone; provider may
        // accept it since its real window is authoritative, not our estimate).
        flushCurrentSubFile();
        currentHunks = [hunk];
        currentEst = singleHunkEst;
      }
    }
  }

  // Flush the last in-progress sub-file.
  flushCurrentSubFile();

  return { subFiles, overflowHunks };
}
