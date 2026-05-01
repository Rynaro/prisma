import {
  type Mode,
  type NormalizedFinding,
  type RankedFindings,
  type RepoConfig,
  RepoConfigSchema,
} from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import { type PriorDedupeState, planPublication } from '../../src/publisher/index.js';

const noPrior: PriorDedupeState = { published_inline_dedupe_keys: new Set<string>() };

const finding = (overrides: Partial<NormalizedFinding> & { id: string }): NormalizedFinding => ({
  id: overrides.id,
  path: overrides.path ?? 'src/a.ts',
  line_start: overrides.line_start ?? 10,
  line_end: overrides.line_end ?? 10,
  category: overrides.category ?? 'correctness',
  severity: overrides.severity ?? 'medium',
  confidence: overrides.confidence ?? 0.8,
  title: overrides.title ?? 'title',
  explanation: overrides.explanation ?? 'explanation body',
  evidence: overrides.evidence ?? ['src/a.ts:10', 'hunk:src/a.ts#10-15'],
  render_target: overrides.render_target ?? 'inline',
  source_artifacts_used: overrides.source_artifacts_used ?? ['pr_diff'],
  dedupe_key: overrides.dedupe_key ?? `dk-${overrides.id}`,
  ...(overrides.suggested_fix !== undefined ? { suggested_fix: overrides.suggested_fix } : {}),
  ...(overrides.validator_notes !== undefined
    ? { validator_notes: overrides.validator_notes }
    : {}),
});

const buildConfig = (overrides: Partial<RepoConfig> = {}): RepoConfig =>
  RepoConfigSchema.parse({ mode: 'summary-plus-inline', ...overrides });

const cfgWithMode = (mode: Mode): RepoConfig =>
  RepoConfigSchema.parse({
    mode,
    comment_cap: { per_pr: 5, per_file: 1 },
    thresholds: {
      severity_floor: { inline: 'medium' },
      confidence_floor: { inline: 0.7 },
    },
  });

const partitionInvariant = (
  ranked: RankedFindings,
  plan: {
    inline: NormalizedFinding[];
    summary: NormalizedFinding[];
    dropped: { finding: NormalizedFinding }[];
  },
): void => {
  expect(plan.inline.length + plan.summary.length + plan.dropped.length).toBe(ranked.length);
  // Disjointness: no id appears in more than one bucket.
  const ids = new Set<string>();
  for (const f of plan.inline) {
    expect(ids.has(f.id)).toBe(false);
    ids.add(f.id);
  }
  for (const f of plan.summary) {
    expect(ids.has(f.id)).toBe(false);
    ids.add(f.id);
  }
  for (const d of plan.dropped) {
    expect(ids.has(d.finding.id)).toBe(false);
    ids.add(d.finding.id);
  }
};

describe('planPublication — worked example (publication-policy.md)', () => {
  it('12 findings → 5 inline, 7 summary (all per_file_cap_exhausted)', () => {
    const ranked: NormalizedFinding[] = [
      finding({ id: 'F-01', path: 'src/payments/charge.ts', severity: 'high', confidence: 0.92 }),
      finding({ id: 'F-02', path: 'src/payments/charge.ts', severity: 'high', confidence: 0.88 }),
      finding({ id: 'F-03', path: 'src/auth/session.ts', severity: 'high', confidence: 0.86 }),
      finding({ id: 'F-04', path: 'src/cart/coupon.ts', severity: 'medium', confidence: 0.84 }),
      finding({ id: 'F-05', path: 'src/cart/coupon.ts', severity: 'medium', confidence: 0.82 }),
      finding({ id: 'F-06', path: 'src/api/router.ts', severity: 'medium', confidence: 0.8 }),
      finding({ id: 'F-07', path: 'src/api/router.ts', severity: 'medium', confidence: 0.78 }),
      finding({ id: 'F-08', path: 'src/db/migrate.ts', severity: 'medium', confidence: 0.77 }),
      finding({ id: 'F-09', path: 'src/db/migrate.ts', severity: 'medium', confidence: 0.76 }),
      finding({ id: 'F-10', path: 'src/auth/session.ts', severity: 'medium', confidence: 0.75 }),
      finding({ id: 'F-11', path: 'src/payments/charge.ts', severity: 'medium', confidence: 0.74 }),
      finding({ id: 'F-12', path: 'src/api/router.ts', severity: 'medium', confidence: 0.72 }),
    ];
    const plan = planPublication(ranked, cfgWithMode('summary-plus-inline'), noPrior);
    expect(plan.inline.map((f) => f.id)).toEqual(['F-01', 'F-03', 'F-04', 'F-06', 'F-08']);
    expect(plan.summary.map((f) => f.id)).toEqual([
      'F-02',
      'F-05',
      'F-07',
      'F-09',
      'F-10',
      'F-11',
      'F-12',
    ]);
    expect(plan.dropped).toEqual([]);
    partitionInvariant(ranked, plan);

    // Every overflow finding has reason_code = per_file_cap_exhausted.
    for (const entry of plan.summary_rejections) {
      expect(entry.reason_code).toBe('per_file_cap_exhausted');
    }
    expect(plan.counts.input).toBe(12);
    expect(plan.counts.inline).toBe(5);
    expect(plan.counts.summary).toBe(7);
    expect(plan.counts.overflowed_per_file).toBe(7);
    expect(plan.counts.overflowed_per_pr).toBe(0);
  });
});

describe('planPublication — modes', () => {
  it('dry-run: inline.length === 0; summary is empty; survivors all in dropped', () => {
    const ranked = [
      finding({ id: 'A', severity: 'high', confidence: 0.9 }),
      finding({ id: 'B', severity: 'medium', confidence: 0.8, path: 'src/b.ts' }),
    ];
    const plan = planPublication(ranked, cfgWithMode('dry-run'), noPrior);
    expect(plan.inline).toEqual([]);
    expect(plan.summary).toEqual([]);
    expect(plan.dropped).toHaveLength(2);
    partitionInvariant(ranked, plan);
    expect(plan.summary_markdown).toMatch(/Mode: dry-run/);
  });

  it('summary-only: all eligible findings are in summary, none inline', () => {
    const ranked = [
      finding({ id: 'A', severity: 'high', confidence: 0.9 }),
      finding({ id: 'B', severity: 'high', confidence: 0.85, path: 'src/b.ts' }),
    ];
    const plan = planPublication(ranked, cfgWithMode('summary-only'), noPrior);
    expect(plan.inline).toEqual([]);
    expect(plan.summary.map((f) => f.id)).toEqual(['A', 'B']);
    expect(plan.dropped).toEqual([]);
    partitionInvariant(ranked, plan);
  });

  it('summary-plus-inline: caps applied per worked example shape', () => {
    const ranked = [
      finding({ id: 'A1', path: 'src/a.ts', severity: 'high', confidence: 0.9 }),
      finding({ id: 'A2', path: 'src/a.ts', severity: 'high', confidence: 0.85 }),
    ];
    const plan = planPublication(ranked, cfgWithMode('summary-plus-inline'), noPrior);
    expect(plan.inline.map((f) => f.id)).toEqual(['A1']);
    expect(plan.summary.map((f) => f.id)).toEqual(['A2']);
    expect(plan.summary_rejections[0]?.reason_code).toBe('per_file_cap_exhausted');
    partitionInvariant(ranked, plan);
  });
});

describe('planPublication — thresholds and dedupe', () => {
  it('below-threshold findings → all in dropped (not in summary), in summary-plus-inline', () => {
    const ranked = [
      // High severity but low confidence: confidence_below_floor.
      finding({ id: 'L1', severity: 'high', confidence: 0.5 }),
      // Below severity floor.
      finding({ id: 'L2', severity: 'low', confidence: 0.99 }),
      // Eligible.
      finding({ id: 'OK', severity: 'high', confidence: 0.9, path: 'src/ok.ts' }),
    ];
    const plan = planPublication(ranked, cfgWithMode('summary-plus-inline'), noPrior);
    expect(plan.inline.map((f) => f.id)).toEqual(['OK']);
    expect(plan.summary).toEqual([]);
    expect(plan.dropped.map((d) => d.finding.id).sort()).toEqual(['L1', 'L2']);
    const reasons = plan.dropped.map((d) => d.reason_code).sort();
    expect(reasons).toEqual(['confidence_below_floor', 'severity_below_floor'].sort());
    partitionInvariant(ranked, plan);
  });

  it('within-run dedupe collapses identical dedupe_key, keeping the highest confidence', () => {
    const ranked = [
      // Both share dk-shared. Keep the higher-confidence one.
      finding({ id: 'A', severity: 'high', confidence: 0.92, dedupe_key: 'dk-shared' }),
      finding({
        id: 'B',
        severity: 'high',
        confidence: 0.85,
        dedupe_key: 'dk-shared',
        path: 'src/b.ts',
      }),
    ];
    const plan = planPublication(ranked, cfgWithMode('summary-plus-inline'), noPrior);
    expect(plan.inline.map((f) => f.id)).toEqual(['A']);
    expect(plan.dropped.map((d) => d.finding.id)).toEqual(['B']);
    expect(plan.dropped[0]?.reason_code).toBe('dedupe_collapsed');
    partitionInvariant(ranked, plan);
  });

  it('within-run dedupe: equal confidence → first-ranked wins', () => {
    const ranked = [
      finding({ id: 'first', severity: 'high', confidence: 0.9, dedupe_key: 'dk-eq' }),
      finding({
        id: 'second',
        severity: 'high',
        confidence: 0.9,
        dedupe_key: 'dk-eq',
        path: 'src/b.ts',
      }),
    ];
    const plan = planPublication(ranked, cfgWithMode('summary-plus-inline'), noPrior);
    expect(plan.inline.map((f) => f.id)).toEqual(['first']);
    expect(plan.dropped.map((d) => d.finding.id)).toEqual(['second']);
  });

  it('across-run dedupe: prior keys are excluded from inline; appear in summary with reason dedupe_collapsed_across_run', () => {
    const ranked = [
      finding({ id: 'X', severity: 'high', confidence: 0.92, dedupe_key: 'prior-key' }),
      finding({
        id: 'Y',
        severity: 'high',
        confidence: 0.9,
        path: 'src/b.ts',
        dedupe_key: 'fresh',
      }),
    ];
    const prior: PriorDedupeState = {
      published_inline_dedupe_keys: new Set(['prior-key']),
    };
    const plan = planPublication(ranked, cfgWithMode('summary-plus-inline'), prior);
    expect(plan.inline.map((f) => f.id)).toEqual(['Y']);
    expect(plan.summary.map((f) => f.id)).toEqual(['X']);
    expect(plan.summary_rejections[0]?.reason_code).toBe('dedupe_collapsed_across_run');
    partitionInvariant(ranked, plan);
  });
});

describe('planPublication — boundary cases', () => {
  it('empty input → empty result with no errors', () => {
    const plan = planPublication([], cfgWithMode('summary-plus-inline'), noPrior);
    expect(plan.inline).toEqual([]);
    expect(plan.summary).toEqual([]);
    expect(plan.dropped).toEqual([]);
    expect(plan.counts.input).toBe(0);
  });

  it('per_pr_cap_exhausted is set when survivors exceed per_pr cap (not per_file)', () => {
    // Make per_file = 5 and per_pr = 2, with 4 distinct files: per_pr is the binding cap.
    const ranked = [
      finding({ id: 'A', severity: 'high', confidence: 0.9, path: 'src/a.ts' }),
      finding({ id: 'B', severity: 'high', confidence: 0.85, path: 'src/b.ts' }),
      finding({ id: 'C', severity: 'high', confidence: 0.8, path: 'src/c.ts' }),
      finding({ id: 'D', severity: 'high', confidence: 0.75, path: 'src/d.ts' }),
    ];
    const plan = planPublication(
      ranked,
      buildConfig({
        mode: 'summary-plus-inline',
        comment_cap: { per_pr: 2, per_file: 5 },
        thresholds: { severity_floor: { inline: 'medium' }, confidence_floor: { inline: 0.7 } },
      }),
      noPrior,
    );
    expect(plan.inline.map((f) => f.id)).toEqual(['A', 'B']);
    expect(plan.summary.map((f) => f.id)).toEqual(['C', 'D']);
    for (const entry of plan.summary_rejections) {
      expect(entry.reason_code).toBe('per_pr_cap_exhausted');
    }
    partitionInvariant(ranked, plan);
  });

  it('partition invariant holds across a mix of below-floors, dedupe, and caps', () => {
    const ranked = [
      finding({
        id: '1',
        severity: 'high',
        confidence: 0.95,
        path: 'src/a.ts',
        dedupe_key: 'dk-1',
      }),
      finding({ id: '2', severity: 'high', confidence: 0.9, path: 'src/a.ts', dedupe_key: 'dk-2' }),
      finding({ id: '3', severity: 'low', confidence: 0.99, path: 'src/b.ts', dedupe_key: 'dk-3' }),
      finding({
        id: '4',
        severity: 'high',
        confidence: 0.85,
        path: 'src/b.ts',
        dedupe_key: 'dk-1',
      }),
      finding({ id: '5', severity: 'high', confidence: 0.8, path: 'src/c.ts', dedupe_key: 'dk-5' }),
    ];
    const plan = planPublication(ranked, cfgWithMode('summary-plus-inline'), noPrior);
    partitionInvariant(ranked, plan);
  });

  it('exactly per_pr cap of survivors → no per_pr_cap overflow', () => {
    const ranked = [
      finding({ id: 'A', severity: 'high', confidence: 0.9, path: 'src/a.ts' }),
      finding({ id: 'B', severity: 'high', confidence: 0.85, path: 'src/b.ts' }),
      finding({ id: 'C', severity: 'high', confidence: 0.8, path: 'src/c.ts' }),
      finding({ id: 'D', severity: 'high', confidence: 0.75, path: 'src/d.ts' }),
      finding({ id: 'E', severity: 'high', confidence: 0.74, path: 'src/e.ts' }),
    ];
    const plan = planPublication(ranked, cfgWithMode('summary-plus-inline'), noPrior);
    expect(plan.inline.map((f) => f.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(plan.summary).toEqual([]);
    partitionInvariant(ranked, plan);
  });

  it('summary_markdown is bounded to ≤ 60 KB even for thousand-finding plans', () => {
    const ranked: NormalizedFinding[] = [];
    for (let i = 0; i < 1000; i += 1) {
      ranked.push(
        finding({
          id: `F${i}`,
          severity: 'high',
          confidence: 0.9,
          path: `src/p${i}.ts`,
          dedupe_key: `dk-${i}`,
          title: `finding ${i} ${'x'.repeat(100)}`,
        }),
      );
    }
    const plan = planPublication(ranked, cfgWithMode('summary-plus-inline'), noPrior);
    expect(Buffer.byteLength(plan.summary_markdown, 'utf8')).toBeLessThanOrEqual(60 * 1024);
  });

  it('mode_applied reflects the resolved config mode', () => {
    const ranked = [finding({ id: 'A', severity: 'high', confidence: 0.9 })];
    expect(planPublication(ranked, cfgWithMode('dry-run'), noPrior).mode_applied).toBe('dry-run');
    expect(planPublication(ranked, cfgWithMode('summary-only'), noPrior).mode_applied).toBe(
      'summary-only',
    );
    expect(planPublication(ranked, cfgWithMode('summary-plus-inline'), noPrior).mode_applied).toBe(
      'summary-plus-inline',
    );
  });
});
