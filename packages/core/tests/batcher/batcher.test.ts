import type { PrefilteredFile } from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import { planBatches } from '../../src/batcher/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal PrefilteredFile with specified path and hunk content length. */
const makeFile = (path: string, contentLength: number, lineSpan = 10): PrefilteredFile => ({
  path,
  hunks: [
    {
      id: `${path}#1-${lineSpan}`,
      line_start: 1,
      line_end: lineSpan,
      content: 'x'.repeat(contentLength),
    },
  ],
});

/** Make a file whose content is empty (triggers line-span fallback). */
const makeFileNoContent = (path: string, lineSpan: number): PrefilteredFile => ({
  path,
  hunks: [
    {
      id: `${path}#1-${lineSpan}`,
      line_start: 1,
      line_end: lineSpan,
      content: '',
    },
  ],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('planBatches', () => {
  describe('basic packing', () => {
    it('empty file list produces empty result', () => {
      const result = planBatches([], { callTokenBudget: 60_000, maxCalls: 6 });
      expect(result.batches).toHaveLength(0);
      expect(result.skippedFiles).toHaveLength(0);
      expect(result.estTotalTokens).toBe(0);
      expect(result.overCap).toBe(false);
    });

    it('single small file becomes a single batch', () => {
      const file = makeFile('src/a.ts', 400); // 400 chars → 100 tokens
      const result = planBatches([file], { callTokenBudget: 60_000, maxCalls: 6 });
      expect(result.batches).toHaveLength(1);
      expect(result.batches[0]).toHaveLength(1);
      expect(result.batches[0]?.[0]?.path).toBe('src/a.ts');
      expect(result.overCap).toBe(false);
    });

    it('files fitting within budget are packed into a single batch', () => {
      // Each file: 1000 chars → 250 tokens; 3 files = 750 tokens < 60000
      const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((p) => makeFile(p, 1000));
      const result = planBatches(files, { callTokenBudget: 60_000, maxCalls: 6 });
      expect(result.batches).toHaveLength(1);
      expect(result.batches[0]).toHaveLength(3);
      expect(result.overCap).toBe(false);
    });

    it('files exceeding budget split into multiple batches', () => {
      // 3 files of 100000 chars each → 25000 tokens each; budget = 30000
      // batch 1: a (25000), b would be 50000 > 30000 → new batch
      // batch 2: b (25000), c would be 50000 > 30000 → new batch
      // batch 3: c (25000)
      const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((p) => makeFile(p, 100_000));
      const result = planBatches(files, { callTokenBudget: 30_000, maxCalls: 6 });
      expect(result.batches).toHaveLength(3);
      expect(result.batches[0]).toHaveLength(1);
      expect(result.batches[1]).toHaveLength(1);
      expect(result.batches[2]).toHaveLength(1);
      expect(result.overCap).toBe(false);
    });

    it('files exactly at budget boundary fit in one batch', () => {
      // 2 files of 120000 chars each → 30000 tokens each; budget = 60000
      // a (30000) + b (30000) = 60000 = budget → fits in one batch
      const files = ['src/a.ts', 'src/b.ts'].map((p) => makeFile(p, 120_000));
      const result = planBatches(files, { callTokenBudget: 60_000, maxCalls: 6 });
      expect(result.batches).toHaveLength(1);
      expect(result.batches[0]).toHaveLength(2);
    });
  });

  describe('no-file-split invariant', () => {
    it('a file whose estimate exceeds budget gets its OWN batch', () => {
      // File A: 10000 tokens (fits); File B: 100000 chars = 25000 tokens > budget=20000
      // B can't share a batch with A but is still sent alone.
      const fileA = makeFile('src/a.ts', 40_000); // 10000 tokens
      const fileB = makeFile('src/b.ts', 400_000); // 100000 tokens > 20000 budget

      // B is below hard cap (110000) so it gets its own batch.
      const result = planBatches([fileA, fileB], { callTokenBudget: 20_000, maxCalls: 6 });
      // a.ts sorts before b.ts → batch 0 = [a], then b starts a new batch
      // a (10000) + b (100000) = 110000 > 20000 budget → b opens new batch
      expect(result.batches).toHaveLength(2);
      // Each batch contains exactly one file (no file is split).
      expect(result.batches[0]).toHaveLength(1);
      expect(result.batches[1]).toHaveLength(1);
    });

    it('a lone file that fits within its own batch is NOT split across batches', () => {
      // This is the fundamental invariant: we never split a file's hunks.
      const file = makeFile('src/large.ts', 200_000); // 50000 tokens > budget=40000
      const result = planBatches([file], { callTokenBudget: 40_000, maxCalls: 6 });
      // Must produce exactly one batch with exactly one file.
      expect(result.batches).toHaveLength(1);
      expect(result.batches[0]).toHaveLength(1);
      expect(result.skippedFiles).toHaveLength(0);
    });
  });

  describe('hard safety cap', () => {
    it('a file whose estimate exceeds 110000 tokens goes into skippedFiles', () => {
      // 440001 chars → Math.ceil(440001 / 4) = 110001 > 110000 cap
      const bigFile = makeFile('src/monster.ts', 440_001);
      const smallFile = makeFile('src/tiny.ts', 100);
      const result = planBatches([bigFile, smallFile], { callTokenBudget: 60_000, maxCalls: 6 });
      expect(result.skippedFiles).toHaveLength(1);
      expect(result.skippedFiles[0]?.path).toBe('src/monster.ts');
      // The small file is still batched.
      expect(result.batches).toHaveLength(1);
      expect(result.batches[0]).toHaveLength(1);
      expect(result.batches[0]?.[0]?.path).toBe('src/tiny.ts');
    });

    it('all files at hard cap → empty batches, all in skippedFiles', () => {
      const files = ['a.ts', 'b.ts'].map((p) => makeFile(p, 440_001));
      const result = planBatches(files, { callTokenBudget: 60_000, maxCalls: 6 });
      expect(result.batches).toHaveLength(0);
      expect(result.skippedFiles).toHaveLength(2);
      expect(result.overCap).toBe(false); // 0 batches ≤ 6 calls
    });
  });

  describe('overCap detection', () => {
    it('overCap is false when batch count equals maxCalls', () => {
      // 2 files of 30000 tokens each → 2 batches at budget=30000; maxCalls=2
      const files = ['src/a.ts', 'src/b.ts'].map((p) => makeFile(p, 120_000));
      const result = planBatches(files, { callTokenBudget: 30_000, maxCalls: 2 });
      expect(result.batches).toHaveLength(2);
      expect(result.overCap).toBe(false);
    });

    it('overCap is true when batch count exceeds maxCalls', () => {
      // 3 files of 30000 tokens each → 3 batches at budget=30000; maxCalls=2
      const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((p) => makeFile(p, 120_000));
      const result = planBatches(files, { callTokenBudget: 30_000, maxCalls: 2 });
      expect(result.batches).toHaveLength(3);
      expect(result.overCap).toBe(true);
    });
  });

  describe('determinism', () => {
    it('produces identical batches regardless of input order', () => {
      const files = ['src/z.ts', 'src/a.ts', 'src/m.ts'].map((p) => makeFile(p, 80_000));
      const shuffled = ['src/m.ts', 'src/z.ts', 'src/a.ts'].map((p) => makeFile(p, 80_000));

      const r1 = planBatches(files, { callTokenBudget: 30_000, maxCalls: 6 });
      const r2 = planBatches(shuffled, { callTokenBudget: 30_000, maxCalls: 6 });

      expect(r1.batches.length).toBe(r2.batches.length);
      for (let i = 0; i < r1.batches.length; i++) {
        const b1 = r1.batches[i] ?? [];
        const b2 = r2.batches[i] ?? [];
        expect(b1.map((f) => f.path)).toEqual(b2.map((f) => f.path));
      }
    });

    it('same input always produces same batches (idempotent)', () => {
      const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((p) => makeFile(p, 80_000));
      const r1 = planBatches(files, { callTokenBudget: 30_000, maxCalls: 6 });
      const r2 = planBatches(files, { callTokenBudget: 30_000, maxCalls: 6 });
      expect(r1.batches.map((b) => b.map((f) => f.path))).toEqual(
        r2.batches.map((b) => b.map((f) => f.path)),
      );
    });

    it('sorts files by path ascending within batches', () => {
      const files = ['src/z.ts', 'src/a.ts', 'src/b.ts'].map((p) => makeFile(p, 100));
      const result = planBatches(files, { callTokenBudget: 60_000, maxCalls: 6 });
      expect(result.batches).toHaveLength(1);
      const paths = (result.batches[0] ?? []).map((f) => f.path);
      expect(paths).toEqual(['src/a.ts', 'src/b.ts', 'src/z.ts']);
    });
  });

  describe('token estimation', () => {
    it('uses content.length / 4 when content is present', () => {
      // 400 chars → Math.ceil(400 / 4) = 100 tokens
      const file = makeFile('src/a.ts', 400);
      const result = planBatches([file], { callTokenBudget: 60_000, maxCalls: 6 });
      expect(result.estTotalTokens).toBe(100);
    });

    it('falls back to line span when content is empty', () => {
      // lineSpan = 50 → fallback estimate = 50 tokens
      const file = makeFileNoContent('src/a.ts', 50);
      const result = planBatches([file], { callTokenBudget: 60_000, maxCalls: 6 });
      expect(result.estTotalTokens).toBe(50);
    });

    it('estTotalTokens sums estimates for all placed files (not skipped)', () => {
      const placed = makeFile('src/a.ts', 400); // 100 tokens
      const skipped = makeFile('src/b.ts', 440_001); // > 110000 → skipped
      const result = planBatches([placed, skipped], { callTokenBudget: 60_000, maxCalls: 6 });
      expect(result.estTotalTokens).toBe(100); // only placed files
    });

    it('multiple hunks sum their content lengths', () => {
      const file: PrefilteredFile = {
        path: 'src/multi.ts',
        hunks: [
          { id: 'h1', line_start: 1, line_end: 5, content: 'a'.repeat(200) }, // 50 tokens
          { id: 'h2', line_start: 10, line_end: 20, content: 'b'.repeat(400) }, // 100 tokens
        ],
      };
      const result = planBatches([file], { callTokenBudget: 60_000, maxCalls: 6 });
      expect(result.estTotalTokens).toBe(150); // Math.ceil(600 / 4) = 150
    });
  });

  describe('edge inputs', () => {
    it('maxCalls=1 and one file fits → single batch, no overCap', () => {
      const file = makeFile('src/a.ts', 100);
      const result = planBatches([file], { callTokenBudget: 60_000, maxCalls: 1 });
      expect(result.batches).toHaveLength(1);
      expect(result.overCap).toBe(false);
    });

    it('maxCalls=1 and two files each fitting → two batches → overCap', () => {
      const files = ['src/a.ts', 'src/b.ts'].map((p) => makeFile(p, 100_000));
      const result = planBatches(files, { callTokenBudget: 30_000, maxCalls: 1 });
      expect(result.batches).toHaveLength(2);
      expect(result.overCap).toBe(true);
    });

    it('greedy pack correctly fills batches across more than 2 batches', () => {
      // budget = 10000 tokens; files of 8000 tokens each → 1 per batch
      // 4 files → 4 batches
      const files = ['a', 'b', 'c', 'd'].map((n) => makeFile(`src/${n}.ts`, 32_000)); // 8000 tokens
      const result = planBatches(files, { callTokenBudget: 10_000, maxCalls: 10 });
      expect(result.batches).toHaveLength(4);
      expect(result.overCap).toBe(false);
    });
  });
});
