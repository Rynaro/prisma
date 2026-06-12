import type { ContentFetcher, FetchTextResult } from '@prisma-bot/github';
import type { ReviewGuidance } from '@prisma-bot/shared';
import { MAX_AUGMENTATION_TOKENS, MAX_CONTEXT_FILE_BYTES } from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import { resolveAugmentation } from '../src/augmentation/index.js';

/**
 * Tests for `resolveAugmentation` per spec § S3 acceptance criteria.
 */

const CAPS = {
  maxTokens: MAX_AUGMENTATION_TOKENS,
  maxContextFileBytes: MAX_CONTEXT_FILE_BYTES,
};

/** Build a ContentFetcher that returns preset responses keyed by path. */
const buildFakeFetcher = (responses: Record<string, FetchTextResult>): ContentFetcher => ({
  async fetchText({ path }): Promise<FetchTextResult> {
    const response = responses[path];
    if (response !== undefined) return response;
    return { ok: false, reason: 'missing' };
  },
});

const emptyGuidance: ReviewGuidance = {
  path_instructions: [],
  context_files: [],
};

describe('resolveAugmentation', () => {
  it('returns undefined guidance for empty config (zero-config fast path)', async () => {
    const result = await resolveAugmentation({
      guidance: emptyGuidance,
      changedPaths: ['src/index.ts'],
      fetcher: buildFakeFetcher({}),
      ref: 'main',
      caps: CAPS,
    });
    expect(result.guidance).toBeUndefined();
    expect(result.notes).toEqual([]);
  });

  it('returns guidance when instructions are present', async () => {
    const result = await resolveAugmentation({
      guidance: { ...emptyGuidance, instructions: 'Focus on security.' },
      changedPaths: [],
      fetcher: buildFakeFetcher({}),
      ref: 'main',
      caps: CAPS,
    });
    expect(result.guidance).toBeDefined();
    expect(result.guidance?.instructions).toBe('Focus on security.');
    expect(result.notes).toEqual([]);
  });

  it('includes matched path_instructions and excludes non-matching ones', async () => {
    const result = await resolveAugmentation({
      guidance: {
        path_instructions: [
          { path: 'src/**', instructions: 'Check types.' },
          { path: 'docs/**', instructions: 'Review clarity.' },
        ],
        context_files: [],
      },
      changedPaths: ['src/api.ts', 'tests/api.test.ts'],
      fetcher: buildFakeFetcher({}),
      ref: 'main',
      caps: CAPS,
    });
    expect(result.guidance).toBeDefined();
    // 'src/**' matches 'src/api.ts' → included
    expect(result.guidance?.matched_path_instructions).toHaveLength(1);
    expect(result.guidance?.matched_path_instructions[0]?.path).toBe('src/**');
    // 'docs/**' does not match any changed path → excluded
  });

  it('returns undefined guidance when path_instructions do not match any changed path', async () => {
    const result = await resolveAugmentation({
      guidance: {
        path_instructions: [{ path: 'docs/**', instructions: 'Review clarity.' }],
        context_files: [],
      },
      changedPaths: ['src/api.ts'],
      fetcher: buildFakeFetcher({}),
      ref: 'main',
      caps: CAPS,
    });
    // No matches → guidance is undefined
    expect(result.guidance).toBeUndefined();
  });

  it('fetches and includes context files', async () => {
    const result = await resolveAugmentation({
      guidance: {
        ...emptyGuidance,
        context_files: [{ path: 'docs/arch.md' }],
      },
      changedPaths: [],
      fetcher: buildFakeFetcher({
        'docs/arch.md': { ok: true, text: '# Architecture', truncated: false },
      }),
      ref: 'abc123',
      caps: CAPS,
    });
    expect(result.guidance).toBeDefined();
    expect(result.guidance?.context_files).toHaveLength(1);
    expect(result.guidance?.context_files[0]?.content).toBe('# Architecture');
    expect(result.notes).toEqual([]);
  });

  it('skips missing context files and adds a note', async () => {
    const result = await resolveAugmentation({
      guidance: {
        ...emptyGuidance,
        instructions: 'Do something.',
        context_files: [{ path: 'docs/missing.md' }],
      },
      changedPaths: [],
      fetcher: buildFakeFetcher({
        'docs/missing.md': { ok: false, reason: 'missing' },
      }),
      ref: 'main',
      caps: CAPS,
    });
    expect(result.guidance).toBeDefined();
    expect(result.guidance?.context_files).toEqual([]);
    expect(result.notes.some((n) => n.includes('docs/missing.md'))).toBe(true);
    expect(result.notes.some((n) => n.includes('missing'))).toBe(true);
  });

  it('notes truncated context files but still includes them', async () => {
    const result = await resolveAugmentation({
      guidance: {
        ...emptyGuidance,
        instructions: 'Do something.',
        context_files: [{ path: 'docs/big.md' }],
      },
      changedPaths: [],
      fetcher: buildFakeFetcher({
        'docs/big.md': { ok: true, text: 'truncated content', truncated: true },
      }),
      ref: 'main',
      caps: CAPS,
    });
    expect(result.guidance?.context_files).toHaveLength(1);
    expect(result.notes.some((n) => n.includes('truncated'))).toBe(true);
  });

  it('drops context files last-first when over token budget', async () => {
    // Use a very tight cap to force dropping.
    const tightCaps = { maxTokens: 10, maxContextFileBytes: MAX_CONTEXT_FILE_BYTES };
    const result = await resolveAugmentation({
      guidance: {
        instructions: 'Short.',
        path_instructions: [],
        context_files: [{ path: 'docs/a.md' }, { path: 'docs/b.md' }],
      },
      changedPaths: [],
      fetcher: buildFakeFetcher({
        'docs/a.md': { ok: true, text: 'A content', truncated: false },
        'docs/b.md': { ok: true, text: 'B content', truncated: false },
      }),
      ref: 'main',
      caps: tightCaps,
    });
    // Notes should mention budget exceeded for dropped files.
    expect(result.notes.some((n) => n.includes('token budget exceeded'))).toBe(true);
  });

  it('passes the correct ref to the fetcher', async () => {
    const fetchedPaths: string[] = [];
    const fetchedRefs: string[] = [];
    const trackingFetcher: ContentFetcher = {
      async fetchText({ path, ref }): Promise<FetchTextResult> {
        fetchedPaths.push(path);
        fetchedRefs.push(ref);
        return { ok: true, text: 'content', truncated: false };
      },
    };
    await resolveAugmentation({
      guidance: {
        ...emptyGuidance,
        instructions: 'Do it.',
        context_files: [{ path: 'docs/arch.md' }],
      },
      changedPaths: [],
      fetcher: trackingFetcher,
      ref: 'sha-abc123',
      caps: CAPS,
    });
    expect(fetchedRefs[0]).toBe('sha-abc123');
  });
});
