import type { Category, NormalizedFinding, RankedFindings, Severity } from '@prisma-bot/shared';

/**
 * Ranker — orders the validator's surviving findings. Per
 * `docs/api-contracts.md` § Ranker contract and § Invariants item 5: the
 * ranker MUST NOT drop findings, and MUST NOT set `render_target = 'dropped'`.
 * The output is therefore a permutation of the input.
 *
 * Ordering signal (lexicographic, lower wins):
 *   1. severity (`critical` → 0, `info` → 4)
 *   2. category priority (`security` → 0, `style` → 6 by default)
 *   3. confidence DESC
 *   4. path ASC
 *   5. line_start ASC
 *   6. id ASC (stable tiebreaker)
 *
 * The ranker does not mutate fields. A future slice may revise `render_target`
 * to `'summary'` for findings unlikely to be inline-publishable; the contract
 * permits that move (`render_target ∈ {inline, summary}`) but never `'dropped'`.
 */

export interface RankerOptions {
  /**
   * Optional category priority override (lower number = higher priority).
   * Default: security 0, correctness 1, tests 2, performance 3, dependency 4,
   * migration 5, style 6.
   */
  categoryPriority?: Partial<Record<Category, number>>;
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const DEFAULT_CATEGORY_PRIORITY: Record<Category, number> = {
  security: 0,
  correctness: 1,
  tests: 2,
  performance: 3,
  dependency: 4,
  migration: 5,
  style: 6,
};

export const runRanker = (
  findings: NormalizedFinding[],
  opts: RankerOptions = {},
): RankedFindings => {
  const categoryPriority: Record<Category, number> = {
    ...DEFAULT_CATEGORY_PRIORITY,
    ...opts.categoryPriority,
  };
  const indexed = findings.map((finding, index) => ({ finding, index }));
  indexed.sort((a, b) => {
    const sa = SEVERITY_RANK[a.finding.severity];
    const sb = SEVERITY_RANK[b.finding.severity];
    if (sa !== sb) return sa - sb;
    const ca = categoryPriority[a.finding.category];
    const cb = categoryPriority[b.finding.category];
    if (ca !== cb) return ca - cb;
    if (a.finding.confidence !== b.finding.confidence) {
      return b.finding.confidence - a.finding.confidence;
    }
    if (a.finding.path !== b.finding.path) {
      return a.finding.path < b.finding.path ? -1 : 1;
    }
    if (a.finding.line_start !== b.finding.line_start) {
      return a.finding.line_start - b.finding.line_start;
    }
    if (a.finding.id !== b.finding.id) {
      return a.finding.id < b.finding.id ? -1 : 1;
    }
    return a.index - b.index;
  });
  return indexed.map((entry) => entry.finding);
};
