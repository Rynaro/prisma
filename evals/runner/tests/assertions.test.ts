import { describe, expect, it } from 'vitest';
import { evaluateExpectations } from '../src/assertions.js';
import type { RunOutcome } from '../src/pipeline-runner.js';
import type { ScenarioExpectations } from '../src/schema.js';

const baseOutcome = (overrides: Partial<RunOutcome> = {}): RunOutcome => ({
  prefilter: {
    outcome: 'accepted',
    skipped_paths: ['package-lock.json'],
    skipped_reasons: ['lockfile'],
    files_sent_to_provider: 1,
  },
  provider: { calls: 1 },
  validator: { findings: 1, rejection_reasons: [] },
  ranker: { output_size: 1 },
  publisher: {
    inline_count: 1,
    summary_count: 0,
    dropped_count: 0,
    publication_state: 'succeeded',
    summary_artifact: 'this summary mentions security and dedupe_collapsed',
    rejection_reasons: ['dedupe_collapsed'],
    expected_categories: ['security'],
  },
  ...overrides,
});

const baseExpectations = (overrides: Partial<ScenarioExpectations> = {}): ScenarioExpectations => ({
  prefilter: {
    outcome: 'accepted',
    skipped_paths: [],
    skipped_reasons: [],
    files_sent_to_provider: 1,
  },
  provider: { calls: 1 },
  validator: { findings: 1, rejection_reasons: [] },
  ranker: { output_size_eq_input: true },
  publisher: {
    inline_count: 1,
    summary_count: 0,
    dropped_count: 0,
    publication_state: 'succeeded',
    summary_contains: [],
    expected_categories: [],
    rejection_reasons: [],
  },
  ...overrides,
});

describe('evaluateExpectations', () => {
  it('passes when every expectation matches the outcome', () => {
    const report = evaluateExpectations(baseOutcome(), baseExpectations());
    expect(report.status).toBe('pass');
    expect(report.failures).toEqual([]);
  });

  it('fails on inline_count mismatch with a precise diff', () => {
    const report = evaluateExpectations(
      baseOutcome({
        publisher: {
          ...baseOutcome().publisher,
          inline_count: 2,
        },
      }),
      baseExpectations(),
    );
    expect(report.status).toBe('fail');
    expect(report.failures).toHaveLength(1);
    const failure = report.failures[0];
    expect(failure?.path).toBe('expectations.publisher.inline_count');
    expect(failure?.expected).toBe(1);
    expect(failure?.actual).toBe(2);
  });

  it('fails on summary_contains substring miss', () => {
    const report = evaluateExpectations(
      baseOutcome(),
      baseExpectations({
        publisher: {
          ...baseExpectations().publisher,
          summary_contains: ['this-substring-does-not-exist'],
        },
      }),
    );
    expect(report.status).toBe('fail');
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.path).toBe('expectations.publisher.summary_contains');
  });

  it('passes on subset assertion: expected rejection_reasons is a subset of actual', () => {
    const report = evaluateExpectations(
      baseOutcome({
        publisher: {
          ...baseOutcome().publisher,
          rejection_reasons: ['dedupe_collapsed', 'per_pr_cap_exhausted'],
        },
      }),
      baseExpectations({
        publisher: {
          ...baseExpectations().publisher,
          rejection_reasons: ['dedupe_collapsed'],
        },
      }),
    );
    expect(report.status).toBe('pass');
  });

  it('fails when expected rejection_reasons contains a code missing from actual', () => {
    const report = evaluateExpectations(
      baseOutcome({
        publisher: {
          ...baseOutcome().publisher,
          rejection_reasons: ['per_pr_cap_exhausted'],
        },
      }),
      baseExpectations({
        publisher: {
          ...baseExpectations().publisher,
          rejection_reasons: ['dedupe_collapsed'],
        },
      }),
    );
    expect(report.status).toBe('fail');
    expect(report.failures[0]?.path).toBe('expectations.publisher.rejection_reasons');
  });

  it('handles ranker.output_size_eq_input invariant', () => {
    const report = evaluateExpectations(
      baseOutcome({
        ranker: { output_size: 2 },
        validator: { findings: 1, rejection_reasons: [] },
      }),
      baseExpectations({ ranker: { output_size_eq_input: true } }),
    );
    expect(report.status).toBe('fail');
    expect(report.failures[0]?.path).toBe('expectations.ranker.output_size_eq_input');
  });

  it('subset semantics on prefilter.skipped_reasons (expected ⊆ actual)', () => {
    const report = evaluateExpectations(
      baseOutcome(),
      baseExpectations({
        prefilter: {
          ...baseExpectations().prefilter,
          skipped_reasons: ['lockfile'],
        },
      }),
    );
    expect(report.status).toBe('pass');
  });
});
