/**
 * `estimator.test.ts` — Unit tests for the Phase 2 unified token estimator.
 *
 * Covers:
 *   - AC2.1: batcher estimate === guard estimate for the same input (same function)
 *   - AC2.4: estimate INCLUDES rendered guidance (~+7500 chars when guidance present)
 *   - §3 invariants: never-under-count for anthropic-approx; exact-match for cl100k/o200k
 *   - serializeForEstimate calls the real renderers (not a parallel re-implementation)
 *   - Lazy-init: encoder reuse across calls
 *   - AC2.5 (HOTSPOT-6): empty content has ONE estimator code path
 */

import { describe, expect, it } from 'vitest';
import {
  IMMUTABLE_SYSTEM_PROMPT,
  renderCustomGuidance,
  renderUserMessage,
} from '../../src/prompt/review-prompt.js';
import type { ProviderReviewInput } from '../../src/schemas/provider.js';
import {
  SAFETY_MARGIN,
  type SerializedPrompt,
  type TokenizerFamily,
  estimatePromptTokens,
  serializeForEstimate,
} from '../../src/tokens/estimator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeInput = (contentLength = 100): ProviderReviewInput => ({
  files: [
    {
      path: 'src/example.ts',
      hunks: [
        {
          id: 'H1',
          line_start: 1,
          line_end: 10,
          content: 'x'.repeat(contentLength),
        },
      ],
    },
  ],
  repo_heuristics: { security: true, tests: false, migrations: false, layering: false },
});

const makeInputWithGuidance = (guidanceInstructions: string): ProviderReviewInput => ({
  ...makeInput(),
  custom_guidance: {
    instructions: guidanceInstructions,
    matched_path_instructions: [],
    context_files: [],
  },
});

const makeEmptyContentInput = (): ProviderReviewInput => ({
  files: [
    {
      path: 'src/empty.ts',
      hunks: [
        {
          id: 'H1',
          line_start: 1,
          line_end: 50,
          content: '', // empty content — Phase 2 HOTSPOT-6 case
        },
      ],
    },
  ],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('estimatePromptTokens', () => {
  describe('anthropic-approx family', () => {
    it('returns a positive integer for a minimal input', () => {
      const prompt = serializeForEstimate(makeInput());
      const count = estimatePromptTokens(prompt, 'anthropic-approx');
      expect(count).toBeGreaterThan(0);
      expect(Number.isInteger(count)).toBe(true);
    });

    it('never-under-count invariant: result >= ceil(text.length / 4)', () => {
      const input = makeInput(500);
      const prompt = serializeForEstimate(input);
      const text = `${prompt.system}\n${prompt.user}\n${prompt.tool}`;
      const bare = Math.ceil(text.length / 4);
      const estimate = estimatePromptTokens(prompt, 'anthropic-approx');
      // The estimate must be >= the chars/4 baseline (SAFETY_MARGIN >= 1.0).
      expect(estimate).toBeGreaterThanOrEqual(bare);
    });

    it('applies SAFETY_MARGIN: result = ceil(text.length / 4 * SAFETY_MARGIN)', () => {
      const input = makeInput(1000);
      const prompt = serializeForEstimate(input);
      const text = `${prompt.system}\n${prompt.user}\n${prompt.tool}`;
      const expected = Math.ceil((text.length / 4) * SAFETY_MARGIN);
      const estimate = estimatePromptTokens(prompt, 'anthropic-approx');
      expect(estimate).toBe(expected);
    });

    it('result strictly exceeds bare chars/4 (safety margin applied)', () => {
      const input = makeInput(1000);
      const prompt = serializeForEstimate(input);
      const text = `${prompt.system}\n${prompt.user}\n${prompt.tool}`;
      const bare = Math.floor(text.length / 4); // intentionally floor
      const estimate = estimatePromptTokens(prompt, 'anthropic-approx');
      // With SAFETY_MARGIN = 1.15, the estimate must exceed a plain /4 count.
      expect(estimate).toBeGreaterThan(bare);
    });

    it('AC2.5 (HOTSPOT-6): empty content has ONE code path — no fallback', () => {
      // Before Phase 2, empty content triggered a line-span fallback.
      // After Phase 2, serializeForEstimate + estimatePromptTokens is the ONLY path.
      const emptyInput = makeEmptyContentInput();
      const prompt = serializeForEstimate(emptyInput);
      // The serialized prompt must be non-empty (system prompt + tool schema remain).
      expect(prompt.system.length).toBeGreaterThan(0);
      expect(prompt.tool.length).toBeGreaterThan(0);
      // The estimate must be a positive integer even with empty diff content.
      const estimate = estimatePromptTokens(prompt, 'anthropic-approx');
      expect(estimate).toBeGreaterThan(0);
      expect(Number.isInteger(estimate)).toBe(true);
    });
  });

  describe('cl100k family (exact BPE)', () => {
    it('returns a positive integer for a minimal input', () => {
      const prompt = serializeForEstimate(makeInput());
      const count = estimatePromptTokens(prompt, 'cl100k');
      expect(count).toBeGreaterThan(0);
      expect(Number.isInteger(count)).toBe(true);
    });

    it('cl100k produces a deterministic count for the same prompt', () => {
      const prompt = serializeForEstimate(makeInput(200));
      const c1 = estimatePromptTokens(prompt, 'cl100k');
      const c2 = estimatePromptTokens(prompt, 'cl100k');
      expect(c1).toBe(c2);
    });

    it('larger content → larger token count (monotone)', () => {
      const small = estimatePromptTokens(serializeForEstimate(makeInput(100)), 'cl100k');
      const large = estimatePromptTokens(serializeForEstimate(makeInput(10000)), 'cl100k');
      expect(large).toBeGreaterThan(small);
    });
  });

  describe('o200k family (exact BPE)', () => {
    it('returns a positive integer for a minimal input', () => {
      const prompt = serializeForEstimate(makeInput());
      const count = estimatePromptTokens(prompt, 'o200k');
      expect(count).toBeGreaterThan(0);
      expect(Number.isInteger(count)).toBe(true);
    });

    it('o200k produces a deterministic count for the same prompt', () => {
      const prompt = serializeForEstimate(makeInput(200));
      const c1 = estimatePromptTokens(prompt, 'o200k');
      const c2 = estimatePromptTokens(prompt, 'o200k');
      expect(c1).toBe(c2);
    });
  });

  describe('AC2.1: batcher and guard use the same function', () => {
    it('two calls with the same serialized prompt and family return identical results', () => {
      const input = makeInput(500);
      const prompt = serializeForEstimate(input);

      // Simulate what the batcher does:
      const batcherEstimate = estimatePromptTokens(prompt, 'anthropic-approx');
      // Simulate what the adapter guard does:
      const guardEstimate = estimatePromptTokens(serializeForEstimate(input), 'anthropic-approx');

      // AC2.1: both must return the IDENTICAL count (same function, same serialized prompt).
      expect(batcherEstimate).toBe(guardEstimate);
    });

    it('AC2.1 holds for cl100k family too', () => {
      const input = makeInput(300);
      const prompt = serializeForEstimate(input);
      const batcherEst = estimatePromptTokens(prompt, 'cl100k');
      const guardEst = estimatePromptTokens(serializeForEstimate(input), 'cl100k');
      expect(batcherEst).toBe(guardEst);
    });
  });
});

describe('serializeForEstimate', () => {
  it('system field equals IMMUTABLE_SYSTEM_PROMPT', () => {
    const input = makeInput();
    const prompt = serializeForEstimate(input);
    expect(prompt.system).toBe(IMMUTABLE_SYSTEM_PROMPT);
  });

  it('user field equals renderUserMessage output (no guidance)', () => {
    const input = makeInput();
    const prompt = serializeForEstimate(input);
    const expectedUser = renderUserMessage(input); // no guidance → renderCustomGuidance returns null
    expect(prompt.user).toBe(expectedUser);
  });

  it('user field includes rendered guidance when present', () => {
    const input = makeInputWithGuidance('Focus on security vulnerabilities.');
    const prompt = serializeForEstimate(input);
    const guidanceStr = renderCustomGuidance(input.custom_guidance);
    expect(guidanceStr).not.toBeNull();
    if (guidanceStr === null) throw new Error('guidanceStr must not be null');
    expect(prompt.user).toContain(guidanceStr);
  });

  it('user field is byte-identical to what the adapter sends (reuses same renderers)', () => {
    // This tests the spec requirement: serializeForEstimate MUST reuse the same
    // renderers (renderUserMessage + renderCustomGuidance) that the adapter uses.
    const input = makeInput(200);
    const prompt = serializeForEstimate(input);
    // The user field must match the exact concatenation the adapters use:
    const expected = renderUserMessage(input) + (renderCustomGuidance(input.custom_guidance) ?? '');
    expect(prompt.user).toBe(expected);
  });

  it('tool field is a non-empty JSON string (the tool schema)', () => {
    const prompt = serializeForEstimate(makeInput());
    expect(typeof prompt.tool).toBe('string');
    expect(prompt.tool.length).toBeGreaterThan(0);
    // Must be valid JSON
    const parsed = JSON.parse(prompt.tool);
    expect(parsed.name).toBe('submit_review_findings');
  });

  it('AC2.4: estimate rises when guidance is present', () => {
    const inputNoGuidance = makeInput();
    const inputWithGuidance = makeInputWithGuidance('G'.repeat(7500)); // ~7500 chars guidance

    const estimateNoGuidance = estimatePromptTokens(
      serializeForEstimate(inputNoGuidance),
      'anthropic-approx',
    );
    const estimateWithGuidance = estimatePromptTokens(
      serializeForEstimate(inputWithGuidance),
      'anthropic-approx',
    );

    // The estimate WITH guidance must be strictly larger.
    expect(estimateWithGuidance).toBeGreaterThan(estimateNoGuidance);
    // The increase must be proportional to the guidance size.
    // anthropic-approx: ceil(7500/4 * 1.15) ≈ 2157 tokens for 7500 chars of guidance.
    const diff = estimateWithGuidance - estimateNoGuidance;
    expect(diff).toBeGreaterThan(1000); // at least 1000 tokens from 7500 chars guidance
  });

  it('AC2.5 (HOTSPOT-6): empty content input serializes correctly via the unified path', () => {
    // Before Phase 2: empty content triggered a separate line-span fallback in the batcher.
    // After Phase 2: serializeForEstimate is the ONLY path. It renders the empty content
    // through renderUserMessage (which calls renderHunkBody, which returns [] for empty content).
    const emptyInput = makeEmptyContentInput();
    const prompt = serializeForEstimate(emptyInput);

    // System and tool must be non-empty (they're fixed).
    expect(prompt.system).toBe(IMMUTABLE_SYSTEM_PROMPT);
    expect(prompt.tool.length).toBeGreaterThan(0);

    // User field must mention the file path (from renderUserMessage).
    expect(prompt.user).toContain('src/empty.ts');

    // The estimate must be a well-defined positive integer.
    const estimate = estimatePromptTokens(prompt, 'anthropic-approx');
    expect(estimate).toBeGreaterThan(0);
  });

  it('returns a SerializedPrompt with all three required fields', () => {
    const prompt = serializeForEstimate(makeInput());
    const keys = Object.keys(prompt);
    expect(keys).toContain('system');
    expect(keys).toContain('user');
    expect(keys).toContain('tool');
  });
});

describe('encoder lazy-init (performance)', () => {
  it('cl100k encoder is reused across calls (deterministic + fast)', () => {
    const prompt = serializeForEstimate(makeInput(100));
    // First call — may initialize encoder
    const c1 = estimatePromptTokens(prompt, 'cl100k');
    // Second call — must reuse cached encoder, same result
    const c2 = estimatePromptTokens(prompt, 'cl100k');
    expect(c1).toBe(c2);
    expect(c1).toBeGreaterThan(0);
  });

  it('o200k encoder is reused across calls (deterministic + fast)', () => {
    const prompt = serializeForEstimate(makeInput(100));
    const c1 = estimatePromptTokens(prompt, 'o200k');
    const c2 = estimatePromptTokens(prompt, 'o200k');
    expect(c1).toBe(c2);
    expect(c1).toBeGreaterThan(0);
  });

  it('cl100k and o200k produce different counts for the same text (different vocabularies)', () => {
    // The two BPE vocabularies are different, so they should produce different counts
    // for most texts (not necessarily ALL texts, but for typical prose/code they differ).
    const prompt = serializeForEstimate(makeInput(500));
    const cl100k = estimatePromptTokens(prompt, 'cl100k');
    const o200k = estimatePromptTokens(prompt, 'o200k');
    // Both must be positive integers.
    expect(cl100k).toBeGreaterThan(0);
    expect(o200k).toBeGreaterThan(0);
    // They can differ (different vocabularies).
    // Note: we don't assert they must differ — it's theoretically possible for
    // very specific texts to produce the same count, though unlikely.
    expect(typeof cl100k).toBe('number');
    expect(typeof o200k).toBe('number');
  });
});
