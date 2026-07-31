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
    approvals_submitted: 0,
    approval_dismissals: 0,
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
    approvals_submitted: 0,
    approval_dismissals: 0,
    summary_not_contains: [],
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

  // --- S8: check_conclusion / approvals_submitted / approval_dismissals / summary_not_contains ---

  it('passes when check_conclusion matches', () => {
    const report = evaluateExpectations(
      baseOutcome({ publisher: { ...baseOutcome().publisher, check_conclusion: 'success' } }),
      baseExpectations({
        publisher: { ...baseExpectations().publisher, check_conclusion: 'success' },
      }),
    );
    expect(report.status).toBe('pass');
  });

  it('fails when check_conclusion mismatches', () => {
    const report = evaluateExpectations(
      baseOutcome({ publisher: { ...baseOutcome().publisher, check_conclusion: 'neutral' } }),
      baseExpectations({
        publisher: { ...baseExpectations().publisher, check_conclusion: 'success' },
      }),
    );
    expect(report.status).toBe('fail');
    expect(report.failures[0]?.path).toBe('expectations.publisher.check_conclusion');
  });

  it('fails when approvals_submitted mismatches the schema default of 0', () => {
    const report = evaluateExpectations(
      baseOutcome({ publisher: { ...baseOutcome().publisher, approvals_submitted: 1 } }),
      baseExpectations(),
    );
    expect(report.status).toBe('fail');
    expect(report.failures[0]?.path).toBe('expectations.publisher.approvals_submitted');
  });

  it('fails when approval_dismissals mismatches', () => {
    const report = evaluateExpectations(
      baseOutcome({ publisher: { ...baseOutcome().publisher, approval_dismissals: 1 } }),
      baseExpectations(),
    );
    expect(report.status).toBe('fail');
    expect(report.failures[0]?.path).toBe('expectations.publisher.approval_dismissals');
  });

  it('fails when summary_not_contains finds a forbidden substring present', () => {
    const report = evaluateExpectations(
      baseOutcome(),
      baseExpectations({
        publisher: {
          ...baseExpectations().publisher,
          summary_not_contains: ['security'],
        },
      }),
    );
    expect(report.status).toBe('fail');
    expect(report.failures[0]?.path).toBe('expectations.publisher.summary_not_contains');
  });

  it('passes when summary_not_contains substring is absent', () => {
    const report = evaluateExpectations(
      baseOutcome(),
      baseExpectations({
        publisher: {
          ...baseExpectations().publisher,
          summary_not_contains: ['this-substring-does-not-exist'],
        },
      }),
    );
    expect(report.status).toBe('pass');
  });
});
