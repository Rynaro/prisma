/**
 * Unit tests for `packages/shared/src/model-slug.ts`.
 *
 * Covers every parsing case in spec § 4 (edge cases), AS-1..AS-4, and the
 * malformed-slug table from G2.
 *
 * See docs/_planning/config-dx/spec.md § 7.1 and § 4.
 */
import { describe, expect, it } from 'vitest';
import { isReasoningModel, parseModelSlug } from '../src/model-slug.js';

describe('parseModelSlug', () => {
  // ── AS-1: bare name → no provider prefix ──────────────────────────────────
  describe('AS-1: bare name → default provider', () => {
    it('bare name with no legacyProvider → model set, provider undefined, no notes', () => {
      const result = parseModelSlug('gpt-4o');
      expect(result.model).toBe('gpt-4o');
      expect(result.provider).toBeUndefined();
      expect(result.notes).toHaveLength(0);
    });

    it('bare name with legacyProvider → emits deprecation note', () => {
      const result = parseModelSlug('gpt-4o', 'openai');
      expect(result.model).toBe('gpt-4o');
      expect(result.provider).toBe('openai');
      expect(result.notes.length).toBeGreaterThan(0);
      expect(result.notes[0]).toContain('deprecated');
    });
  });

  // ── AS-2: qualified slug ──────────────────────────────────────────────────
  describe('AS-2: provider/name slug parses correctly', () => {
    it('openai/gpt-5.4-nano → provider=openai, model=gpt-5.4-nano, no notes', () => {
      const result = parseModelSlug('openai/gpt-5.4-nano');
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-5.4-nano');
      expect(result.notes).toHaveLength(0);
    });

    it('anthropic/claude-sonnet-4.5 → provider=anthropic, model=claude-sonnet-4.5', () => {
      const result = parseModelSlug('anthropic/claude-sonnet-4.5');
      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-sonnet-4.5');
      expect(result.notes).toHaveLength(0);
    });

    it('a/b → provider=a, model=b', () => {
      const result = parseModelSlug('a/b');
      expect(result.provider).toBe('a');
      expect(result.model).toBe('b');
      // Note: "a" is not a known provider, so a note is emitted
      expect(result.notes.length).toBeGreaterThan(0);
      expect(result.notes[0]).toContain('not a recognised provider');
    });
  });

  // ── AS-3: legacy provider + bare model ───────────────────────────────────
  describe('AS-3: legacy provider: + bare model: deprecated but functional', () => {
    it('emits deprecation note but returns correct model and provider', () => {
      const result = parseModelSlug('claude-sonnet-4.5', 'anthropic');
      expect(result.model).toBe('claude-sonnet-4.5');
      expect(result.provider).toBe('anthropic');
      expect(result.notes.some((n) => n.includes('deprecated'))).toBe(true);
    });
  });

  // ── AS-4: conflict: legacy provider ≠ slug provider → slug wins ──────────
  describe('AS-4: conflict legacy-provider vs slug-provider → slug wins + warning', () => {
    it('slug provider overrides legacy provider; warning note emitted; no throw', () => {
      const result = parseModelSlug('openai/gpt-5.4-nano', 'anthropic');
      // Slug wins
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-5.4-nano');
      // Warning note present
      expect(result.notes.some((n) => n.includes('overrides'))).toBe(true);
      expect(result.notes.some((n) => n.includes('anthropic'))).toBe(true);
    });

    it('matching legacy provider and slug provider → redundancy note only', () => {
      const result = parseModelSlug('openai/gpt-4o', 'openai');
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-4o');
      expect(result.notes.some((n) => n.includes('redundant'))).toBe(true);
    });
  });

  // ── Edge cases (spec § 4) ─────────────────────────────────────────────────
  describe('edge cases (spec § 4)', () => {
    it('"openai/" (trailing slash, empty name) → model undefined, warning note', () => {
      const result = parseModelSlug('openai/');
      expect(result.model).toBeUndefined();
      expect(result.notes.some((n) => n.includes('empty model name'))).toBe(true);
    });

    it('"/gpt-4o" (empty provider) → treated as bare name "gpt-4o", warning note', () => {
      const result = parseModelSlug('/gpt-4o');
      expect(result.model).toBe('gpt-4o');
      // provider falls back to undefined (legacyProvider not provided)
      expect(result.provider).toBeUndefined();
      expect(result.notes.some((n) => n.includes('empty provider'))).toBe(true);
    });

    it('"a/b/c" (>1 slash) → model undefined, warning note, no throw', () => {
      const result = parseModelSlug('a/b/c');
      expect(result.model).toBeUndefined();
      expect(result.notes.some((n) => n.includes('expected provider/name'))).toBe(true);
    });

    it('empty string → model undefined, provider undefined, no notes', () => {
      const result = parseModelSlug('');
      expect(result.model).toBeUndefined();
      expect(result.provider).toBeUndefined();
      expect(result.notes).toHaveLength(0);
    });

    it('undefined → model undefined, provider undefined, no notes', () => {
      const result = parseModelSlug(undefined);
      expect(result.model).toBeUndefined();
      expect(result.provider).toBeUndefined();
      expect(result.notes).toHaveLength(0);
    });

    it('"acme/foo" (unknown provider) → parses, emits unrecognised-provider note', () => {
      const result = parseModelSlug('acme/foo');
      expect(result.provider).toBe('acme');
      expect(result.model).toBe('foo');
      expect(result.notes.some((n) => n.includes('not a recognised provider'))).toBe(true);
    });

    it('known providers produce no unrecognised-provider note', () => {
      for (const provider of ['openai', 'anthropic', 'copilot', 'fake']) {
        const result = parseModelSlug(`${provider}/some-model`);
        expect(result.notes.some((n) => n.includes('not a recognised provider'))).toBe(false);
      }
    });
  });

  // ── G2: table tests ───────────────────────────────────────────────────────
  describe('G2: parsing table (spec § 7.1)', () => {
    const cases: Array<{
      raw: string;
      legacy?: string;
      expectedProvider: string | undefined;
      expectedModel: string | undefined;
      notesSubstr?: string;
    }> = [
      { raw: 'a/b', expectedProvider: 'a', expectedModel: 'b', notesSubstr: 'recognised' },
      { raw: 'b', expectedProvider: undefined, expectedModel: 'b' },
      { raw: 'openai/gpt-5.4-nano', expectedProvider: 'openai', expectedModel: 'gpt-5.4-nano' },
      {
        raw: 'openai/',
        expectedProvider: undefined,
        expectedModel: undefined,
        notesSubstr: 'empty model name',
      },
      {
        raw: '/gpt-4o',
        expectedProvider: undefined,
        expectedModel: 'gpt-4o',
        notesSubstr: 'empty provider',
      },
      {
        raw: 'a/b/c',
        expectedProvider: undefined,
        expectedModel: undefined,
        notesSubstr: 'expected provider/name',
      },
      // legacy provider + model
      {
        raw: 'claude-sonnet-4.5',
        legacy: 'anthropic',
        expectedProvider: 'anthropic',
        expectedModel: 'claude-sonnet-4.5',
        notesSubstr: 'deprecated',
      },
      // conflict
      {
        raw: 'openai/gpt-5.4-nano',
        legacy: 'anthropic',
        expectedProvider: 'openai',
        expectedModel: 'gpt-5.4-nano',
        notesSubstr: 'overrides',
      },
    ];

    for (const c of cases) {
      it(`parseModelSlug("${c.raw}", ${c.legacy ?? 'undefined'}) → provider=${String(c.expectedProvider)}, model=${String(c.expectedModel)}`, () => {
        const result = parseModelSlug(c.raw, c.legacy);
        expect(result.provider).toBe(c.expectedProvider);
        expect(result.model).toBe(c.expectedModel);
        if (c.notesSubstr !== undefined) {
          expect(result.notes.some((n) => n.includes(c.notesSubstr as string))).toBe(true);
        }
      });
    }
  });
});

// ---------------------------------------------------------------------------
// isReasoningModel — unit tests (shared single source of truth)
// ---------------------------------------------------------------------------

describe('isReasoningModel', () => {
  // Reasoning-family models: should return true
  it('gpt-5.4-nano is a reasoning model', () => {
    expect(isReasoningModel('gpt-5.4-nano')).toBe(true);
  });

  it('gpt-5-nano is a reasoning model', () => {
    expect(isReasoningModel('gpt-5-nano')).toBe(true);
  });

  it('gpt-5 is a reasoning model', () => {
    expect(isReasoningModel('gpt-5')).toBe(true);
  });

  it('gpt-6 (future) is a reasoning model', () => {
    expect(isReasoningModel('gpt-6')).toBe(true);
  });

  it('gpt-10 (two-digit major) is a reasoning model', () => {
    expect(isReasoningModel('gpt-10')).toBe(true);
  });

  it('o1 is a reasoning model', () => {
    expect(isReasoningModel('o1')).toBe(true);
  });

  it('o3 is a reasoning model', () => {
    expect(isReasoningModel('o3')).toBe(true);
  });

  it('o4-mini is a reasoning model', () => {
    expect(isReasoningModel('o4-mini')).toBe(true);
  });

  // Classic-family models: should return false
  it('gpt-4o is NOT a reasoning model', () => {
    expect(isReasoningModel('gpt-4o')).toBe(false);
  });

  it('gpt-4.1 is NOT a reasoning model', () => {
    expect(isReasoningModel('gpt-4.1')).toBe(false);
  });

  it('gpt-4 is NOT a reasoning model', () => {
    expect(isReasoningModel('gpt-4')).toBe(false);
  });

  it('gpt-3.5-turbo is NOT a reasoning model', () => {
    expect(isReasoningModel('gpt-3.5-turbo')).toBe(false);
  });

  it('gpt-4-turbo is NOT a reasoning model', () => {
    expect(isReasoningModel('gpt-4-turbo')).toBe(false);
  });

  // Edge cases
  it('empty string is NOT a reasoning model', () => {
    expect(isReasoningModel('')).toBe(false);
  });

  it('case-insensitive: GPT-5 is a reasoning model', () => {
    expect(isReasoningModel('GPT-5')).toBe(true);
  });

  it('case-insensitive: O3 is a reasoning model', () => {
    expect(isReasoningModel('O3')).toBe(true);
  });
});
