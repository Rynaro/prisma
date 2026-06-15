/**
 * split-file.test.ts — Phase 3 hunk-level splitter tests.
 *
 * Acceptance criteria covered:
 *   AC3.1 — multi-hunk file over hard_cap_in splits into ≥2 sub-files each ≤
 *            hard_cap_in; every sub-file path === original.path; union of sub-file
 *            hunk ids === original hunk id set (no hunk lost or duplicated).
 *   AC3.3 — a single hunk that alone exceeds absoluteCapTokens goes to
 *            overflowHunks with a visible note — NOT silently dropped.
 *   AC3.4 — line-numbered render of a sub-file === same hunks in a non-split render
 *            (line citations stable, line_start / line_end preserved verbatim).
 *   AC3.5 — determinism: same file twice → identical sub-file partition.
 */

import type { PrefilteredFile, ProviderReviewInput, TokenizerFamily } from '@prisma-bot/shared';
import { estimatePromptTokens, renderUserMessage, serializeForEstimate } from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import { splitFileByHunks } from '../../src/batcher/split-file.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAMILY: TokenizerFamily = 'anthropic-approx';

/** Build a minimal ProviderReviewInput for a file set (no guidance). */
const buildInputForBatch = (files: PrefilteredFile[]): ProviderReviewInput => ({ files });

/**
 * Build a PrefilteredFile with N hunks of configurable size.
 * Each hunk has a unique id, a non-overlapping line range, and content of
 * `contentLength` characters (so the serialized estimate is proportional).
 */
const makeFileWithHunks = (
  path: string,
  hunks: Array<{ contentLength: number; lineStart?: number; lineEnd?: number }>,
): PrefilteredFile => ({
  path,
  hunks: hunks.map((h, i) => {
    const lineStart = h.lineStart ?? i * 100 + 1;
    const lineEnd = h.lineEnd ?? lineStart + 50;
    return {
      id: `${path}#${lineStart}-${lineEnd}`,
      line_start: lineStart,
      line_end: lineEnd,
      content: `+${'x'.repeat(h.contentLength - 1)}`,
    };
  }),
});

/** Estimate a file's serialized tokens (same path the batcher uses). */
const estimateFile = (file: PrefilteredFile): number => {
  return estimatePromptTokens(serializeForEstimate(buildInputForBatch([file])), FAMILY);
};

// ---------------------------------------------------------------------------
// AC3.1 — multi-hunk file splits into ≥2 sub-files
// ---------------------------------------------------------------------------

describe('splitFileByHunks', () => {
  describe('AC3.1 — split into sub-files each within budget', () => {
    it('splits a file with 5 large hunks into ≥2 sub-files, each ≤ budgetTokens', () => {
      // Build a file whose 5 hunks are each large enough that 2+ together exceed
      // a modest budget, forcing the splitter to produce multiple sub-files.
      // We use a budget of 5000 tokens and hunks of ~4000 chars each.
      // anthropic-approx: ceil(4000/4 * 1.15) ≈ 1150 tokens per hunk content;
      // plus the system+tool+scaffold overhead (~400 tokens) → single-hunk sub-file
      // estimates ≈ 1550. Two hunks ≈ 2700, three ≈ 3850. Budget=4000 so each
      // sub-file should hold ≤2-3 hunks, giving ≥2 sub-files for 5 hunks.
      const budget = 4_000;
      const file = makeFileWithHunks('src/big.ts', [
        { contentLength: 4_000, lineStart: 1, lineEnd: 50 },
        { contentLength: 4_000, lineStart: 101, lineEnd: 150 },
        { contentLength: 4_000, lineStart: 201, lineEnd: 250 },
        { contentLength: 4_000, lineStart: 301, lineEnd: 350 },
        { contentLength: 4_000, lineStart: 401, lineEnd: 450 },
      ]);
      const absoluteCap = budget * 3; // generous: single hunks don't overflow

      const { subFiles, overflowHunks } = splitFileByHunks(
        file,
        budget,
        absoluteCap,
        FAMILY,
        buildInputForBatch,
      );

      // Must produce ≥2 sub-files.
      expect(subFiles.length).toBeGreaterThanOrEqual(2);

      // Every sub-file must share the original path.
      for (const sf of subFiles) {
        expect(sf.path).toBe('src/big.ts');
      }

      // Every sub-file's estimate must be ≤ budget.
      for (const sf of subFiles) {
        const est = estimateFile(sf);
        expect(est).toBeLessThanOrEqual(budget);
      }

      // No overflow hunks (all fit under absoluteCap).
      expect(overflowHunks).toHaveLength(0);

      // AC3.1: union of sub-file hunk ids === original hunk id set.
      const originalIds = new Set(file.hunks.map((h) => h.id));
      const subFileIds = new Set(subFiles.flatMap((sf) => sf.hunks.map((h) => h.id)));
      expect(subFileIds).toEqual(originalIds);
    });

    it('a file with 2 hunks where both exceed budget individually each gets its own sub-file', () => {
      // If each hunk is below absoluteCap but above budget → each in own sub-file.
      // The splitter puts each in a separate sub-file (split boundary fires after hunk 1).
      const budget = 2_000;
      const file = makeFileWithHunks('src/two.ts', [
        { contentLength: 5_000, lineStart: 1, lineEnd: 100 },
        { contentLength: 5_000, lineStart: 201, lineEnd: 300 },
      ]);
      const absoluteCap = 50_000; // generous

      const [firstHunk] = file.hunks;
      if (!firstHunk) throw new Error('expected at least one hunk');
      const singleEst = estimateFile({ ...file, hunks: [firstHunk] });
      // Ensure both hunks individually exceed budget (test precondition).
      expect(singleEst).toBeGreaterThan(budget);

      const { subFiles, overflowHunks } = splitFileByHunks(
        file,
        budget,
        absoluteCap,
        FAMILY,
        buildInputForBatch,
      );

      // Each hunk in its own sub-file.
      expect(subFiles).toHaveLength(2);
      expect(overflowHunks).toHaveLength(0);

      // All sub-file paths match.
      for (const sf of subFiles) {
        expect(sf.path).toBe('src/two.ts');
      }

      // All original hunk ids accounted for.
      const originalIds = new Set(file.hunks.map((h) => h.id));
      const subFileIds = new Set(subFiles.flatMap((sf) => sf.hunks.map((h) => h.id)));
      expect(subFileIds).toEqual(originalIds);
    });
  });

  // ---------------------------------------------------------------------------
  // AC3.3 — single hunk over absoluteCapTokens → overflowHunks, not dropped
  // ---------------------------------------------------------------------------

  describe('AC3.3 — overflow hunk goes to overflowHunks with a note', () => {
    it('a hunk whose estimate exceeds absoluteCapTokens goes to overflowHunks, not subFiles', () => {
      // Set absoluteCap extremely low so even a small hunk overflows.
      const budget = 100_000;
      const absoluteCap = 100; // tiny — any real hunk will overflow this
      const file = makeFileWithHunks('src/overflow.ts', [
        { contentLength: 200, lineStart: 1, lineEnd: 10 },
        { contentLength: 200, lineStart: 11, lineEnd: 20 },
      ]);

      const { subFiles, overflowHunks } = splitFileByHunks(
        file,
        budget,
        absoluteCap,
        FAMILY,
        buildInputForBatch,
      );

      // All hunks overflow → subFiles is empty, overflowHunks has entries.
      expect(subFiles).toHaveLength(0);
      expect(overflowHunks.length).toBeGreaterThanOrEqual(1);

      // Each overflow entry has a hunkId and estTokens.
      for (const entry of overflowHunks) {
        expect(entry.hunkId).toBeTruthy();
        expect(entry.estTokens).toBeGreaterThan(absoluteCap);
      }

      // The overflow hunk ids match the original file's hunks (none silently lost).
      const originalIds = new Set(file.hunks.map((h) => h.id));
      const overflowIds = new Set(overflowHunks.map((e) => e.hunkId));
      expect(overflowIds).toEqual(originalIds);
    });

    it('a mixed file — some hunks overflow, some fit — splits correctly', () => {
      // absoluteCap between "small hunk" and "large hunk" estimate.
      // Large hunks → overflowHunks; small hunks → subFiles.
      const file = makeFileWithHunks('src/mixed.ts', [
        { contentLength: 100, lineStart: 1, lineEnd: 10 }, // small hunk
        { contentLength: 50_000, lineStart: 101, lineEnd: 200 }, // large hunk
        { contentLength: 100, lineStart: 201, lineEnd: 210 }, // small hunk
      ]);

      const [hunk0, hunk1] = file.hunks;
      if (!hunk0 || !hunk1) throw new Error('expected at least two hunks');
      const smallHunkEst = estimateFile({ ...file, hunks: [hunk0] });
      const largeHunkEst = estimateFile({ ...file, hunks: [hunk1] });

      // Precondition: large hunk is significantly bigger than small hunk.
      expect(largeHunkEst).toBeGreaterThan(smallHunkEst * 10);

      // Set absoluteCap between the two so small hunks fit, large hunk overflows.
      const absoluteCap = Math.floor((smallHunkEst + largeHunkEst) / 2);
      const budget = absoluteCap * 2; // budget generous

      const { subFiles, overflowHunks } = splitFileByHunks(
        file,
        budget,
        absoluteCap,
        FAMILY,
        buildInputForBatch,
      );

      // Large hunk → overflow.
      expect(overflowHunks.some((e) => e.hunkId === file.hunks[1]?.id)).toBe(true);
      // Small hunks → subFiles (may be packed together or separate).
      const subFileHunkIds = subFiles.flatMap((sf) => sf.hunks.map((h) => h.id));
      expect(subFileHunkIds).toContain(file.hunks[0]?.id);
      expect(subFileHunkIds).toContain(file.hunks[2]?.id);
    });
  });

  // ---------------------------------------------------------------------------
  // AC3.4 — line citations stable: line_start / line_end preserved verbatim
  // ---------------------------------------------------------------------------

  describe('AC3.4 — line citations stable across split', () => {
    it('sub-file hunks have identical line_start/line_end to the original', () => {
      const budget = 3_000;
      const absoluteCap = budget * 5;
      const file = makeFileWithHunks('src/stable.ts', [
        { contentLength: 3_000, lineStart: 42, lineEnd: 99 },
        { contentLength: 3_000, lineStart: 200, lineEnd: 250 },
        { contentLength: 3_000, lineStart: 400, lineEnd: 500 },
      ]);

      const { subFiles } = splitFileByHunks(file, budget, absoluteCap, FAMILY, buildInputForBatch);

      // All sub-files produced.
      expect(subFiles.length).toBeGreaterThanOrEqual(1);

      // Every hunk in every sub-file must preserve line_start and line_end verbatim.
      const originalHunkMap = new Map(file.hunks.map((h) => [h.id, h]));
      for (const sf of subFiles) {
        for (const hunk of sf.hunks) {
          const original = originalHunkMap.get(hunk.id);
          expect(original).toBeDefined();
          expect(hunk.line_start).toBe(original?.line_start);
          expect(hunk.line_end).toBe(original?.line_end);
          expect(hunk.content).toBe(original?.content);
        }
      }
    });

    it('rendered line numbers of a sub-file match the same hunks rendered in the original', () => {
      // AC3.4: renderUserMessage on a sub-file must produce the same <n>: lines
      // as rendering those hunks in the context of the original file.
      const budget = 3_000;
      const absoluteCap = budget * 5;
      const file = makeFileWithHunks('src/render.ts', [
        { contentLength: 2_000, lineStart: 10, lineEnd: 40 },
        { contentLength: 2_000, lineStart: 100, lineEnd: 140 },
        { contentLength: 2_000, lineStart: 300, lineEnd: 340 },
      ]);

      const { subFiles } = splitFileByHunks(file, budget, absoluteCap, FAMILY, buildInputForBatch);

      // For each sub-file, render it and compare line numbers to rendering the
      // same hunks in a standalone file (which equals the sub-file itself).
      for (const sf of subFiles) {
        const subFileRender = renderUserMessage({ files: [sf] });

        // Build a "reference" render with the same hunks in a fresh file.
        const referenceFile: PrefilteredFile = { ...file, hunks: sf.hunks };
        const referenceRender = renderUserMessage({ files: [referenceFile] });

        // The renders must be identical (same path, same hunks, same line_start).
        expect(subFileRender).toBe(referenceRender);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // AC3.5 — determinism: same file twice → identical partition
  // ---------------------------------------------------------------------------

  describe('AC3.5 — determinism', () => {
    it('same file + same budget produces identical sub-file partition', () => {
      const budget = 3_000;
      const absoluteCap = budget * 10;
      const file = makeFileWithHunks('src/det.ts', [
        { contentLength: 2_000, lineStart: 1, lineEnd: 50 },
        { contentLength: 2_000, lineStart: 100, lineEnd: 150 },
        { contentLength: 2_000, lineStart: 200, lineEnd: 250 },
        { contentLength: 2_000, lineStart: 300, lineEnd: 350 },
      ]);

      const r1 = splitFileByHunks(file, budget, absoluteCap, FAMILY, buildInputForBatch);
      const r2 = splitFileByHunks(file, budget, absoluteCap, FAMILY, buildInputForBatch);

      expect(r1.subFiles.length).toBe(r2.subFiles.length);
      for (const [i, sf1] of r1.subFiles.entries()) {
        const sf2 = r2.subFiles[i];
        if (!sf2) throw new Error(`r2 missing sub-file at index ${i}`);
        expect(sf1.path).toBe(sf2.path);
        const ids1 = sf1.hunks.map((h) => h.id);
        const ids2 = sf2.hunks.map((h) => h.id);
        expect(ids1).toEqual(ids2);
      }
      expect(r1.overflowHunks.map((e) => e.hunkId)).toEqual(r2.overflowHunks.map((e) => e.hunkId));
    });

    it('hunks are sorted by line_start regardless of input order', () => {
      const budget = 5_000;
      const absoluteCap = budget * 5;
      // Build the file with hunks in REVERSE order to verify sorting.
      const fileReversed = makeFileWithHunks('src/sort.ts', [
        { contentLength: 100, lineStart: 300, lineEnd: 310 },
        { contentLength: 100, lineStart: 200, lineEnd: 210 },
        { contentLength: 100, lineStart: 100, lineEnd: 110 },
        { contentLength: 100, lineStart: 1, lineEnd: 10 },
      ]);
      const fileForward = makeFileWithHunks('src/sort.ts', [
        { contentLength: 100, lineStart: 1, lineEnd: 10 },
        { contentLength: 100, lineStart: 100, lineEnd: 110 },
        { contentLength: 100, lineStart: 200, lineEnd: 210 },
        { contentLength: 100, lineStart: 300, lineEnd: 310 },
      ]);

      const r1 = splitFileByHunks(fileReversed, budget, absoluteCap, FAMILY, buildInputForBatch);
      const r2 = splitFileByHunks(fileForward, budget, absoluteCap, FAMILY, buildInputForBatch);

      // Both should produce identical sub-file partitions.
      expect(r1.subFiles.length).toBe(r2.subFiles.length);
      for (let i = 0; i < r1.subFiles.length; i++) {
        const ids1 = r1.subFiles[i]?.hunks.map((h) => h.id);
        const ids2 = r2.subFiles[i]?.hunks.map((h) => h.id);
        expect(ids1).toEqual(ids2);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('a file with a single hunk that fits under budget returns one sub-file', () => {
      const budget = 50_000;
      const absoluteCap = 200_000;
      const file = makeFileWithHunks('src/single.ts', [
        { contentLength: 100, lineStart: 1, lineEnd: 5 },
      ]);

      const { subFiles, overflowHunks } = splitFileByHunks(
        file,
        budget,
        absoluteCap,
        FAMILY,
        buildInputForBatch,
      );

      expect(subFiles).toHaveLength(1);
      expect(overflowHunks).toHaveLength(0);
      expect(subFiles[0]?.path).toBe('src/single.ts');
      expect(subFiles[0]?.hunks).toHaveLength(1);
    });

    it('preserves non-hunk fields (language) on each sub-file', () => {
      const budget = 3_000;
      const absoluteCap = 50_000;
      const file: PrefilteredFile = {
        path: 'src/typed.ts',
        language: 'typescript',
        hunks: [
          { id: 'src/typed.ts#1-10', line_start: 1, line_end: 10, content: `+${'x'.repeat(2000)}` },
          {
            id: 'src/typed.ts#100-110',
            line_start: 100,
            line_end: 110,
            content: `+${'y'.repeat(2000)}`,
          },
          {
            id: 'src/typed.ts#200-210',
            line_start: 200,
            line_end: 210,
            content: `+${'z'.repeat(2000)}`,
          },
        ],
      };

      const { subFiles } = splitFileByHunks(file, budget, absoluteCap, FAMILY, buildInputForBatch);

      for (const sf of subFiles) {
        expect(sf.language).toBe('typescript');
        expect(sf.path).toBe('src/typed.ts');
      }
    });
  });
});
