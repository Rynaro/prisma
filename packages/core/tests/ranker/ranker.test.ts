import type { Category, NormalizedFinding, Severity } from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import { runRanker } from '../../src/validator-ranker/ranker/index.js';

const finding = (overrides: Partial<NormalizedFinding> & { id: string }): NormalizedFinding => ({
  id: overrides.id,
  path: overrides.path ?? 'src/a.ts',
  line_start: overrides.line_start ?? 10,
  line_end: overrides.line_end ?? 10,
  category: (overrides.category ?? 'correctness') as Category,
  severity: (overrides.severity ?? 'medium') as Severity,
  confidence: overrides.confidence ?? 0.7,
  title: overrides.title ?? 'title',
  explanation: overrides.explanation ?? 'explanation body',
  evidence: overrides.evidence ?? ['src/a.ts:10', 'hunk:src/a.ts#10-15'],
  render_target: overrides.render_target ?? 'inline',
  source_artifacts_used: overrides.source_artifacts_used ?? ['pr_diff'],
  dedupe_key: overrides.dedupe_key ?? 'dk-default',
  ...(overrides.suggested_fix !== undefined ? { suggested_fix: overrides.suggested_fix } : {}),
  ...(overrides.validator_notes !== undefined
    ? { validator_notes: overrides.validator_notes }
    : {}),
});

describe('runRanker', () => {
  it('orders critical-security ahead of high-correctness regardless of confidence', () => {
    const a = finding({ id: 'A', severity: 'high', category: 'correctness', confidence: 0.99 });
    const b = finding({ id: 'B', severity: 'critical', category: 'security', confidence: 0.5 });
    const ranked = runRanker([a, b]);
    expect(ranked.map((f) => f.id)).toEqual(['B', 'A']);
  });

  it('orders security ahead of style within the same severity', () => {
    const a = finding({ id: 'A', severity: 'medium', category: 'style' });
    const b = finding({ id: 'B', severity: 'medium', category: 'security' });
    const ranked = runRanker([a, b]);
    expect(ranked.map((f) => f.id)).toEqual(['B', 'A']);
  });

  it('sorts by higher confidence first within the same severity and category', () => {
    const a = finding({ id: 'A', severity: 'low', category: 'tests', confidence: 0.4 });
    const b = finding({ id: 'B', severity: 'low', category: 'tests', confidence: 0.9 });
    const c = finding({ id: 'C', severity: 'low', category: 'tests', confidence: 0.7 });
    const ranked = runRanker([a, b, c]);
    expect(ranked.map((f) => f.id)).toEqual(['B', 'C', 'A']);
  });

  it('breaks deeper ties stably by (path, line_start, id)', () => {
    const base = {
      severity: 'medium' as const,
      category: 'correctness' as const,
      confidence: 0.7,
    };
    const a = finding({ ...base, id: 'idz', path: 'src/a.ts', line_start: 10 });
    const b = finding({ ...base, id: 'ida', path: 'src/a.ts', line_start: 10 });
    const c = finding({ ...base, id: 'idb', path: 'src/a.ts', line_start: 5 });
    const d = finding({ ...base, id: 'idc', path: 'src/b.ts', line_start: 1 });
    const ranked = runRanker([a, b, c, d]);
    // src/a.ts line 5 first, then src/a.ts line 10 (ida before idz), then src/b.ts.
    expect(ranked.map((f) => f.id)).toEqual(['idb', 'ida', 'idz', 'idc']);
  });

  it('returns a permutation: output length equals input length and contents match', () => {
    const inputs = [
      finding({ id: '1', severity: 'low' }),
      finding({ id: '2', severity: 'high' }),
      finding({ id: '3', severity: 'critical' }),
      finding({ id: '4', severity: 'info' }),
    ];
    const ranked = runRanker(inputs);
    expect(ranked).toHaveLength(inputs.length);
    expect(new Set(ranked.map((f) => f.id))).toEqual(new Set(inputs.map((f) => f.id)));
  });

  it('returns an empty array for empty input', () => {
    const ranked = runRanker([]);
    expect(ranked).toEqual([]);
  });

  it('honours a categoryPriority override', () => {
    const a = finding({ id: 'A', severity: 'medium', category: 'security' });
    const b = finding({ id: 'B', severity: 'medium', category: 'style' });
    // Invert the default: style above security.
    const ranked = runRanker([a, b], { categoryPriority: { style: 0, security: 6 } });
    expect(ranked.map((f) => f.id)).toEqual(['B', 'A']);
  });
});
