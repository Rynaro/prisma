import type { RunOutcome } from './pipeline-runner.js';
import type { ScenarioExpectations } from './schema.js';

/**
 * Compares a `RunOutcome` against a fixture's `expectations` block and emits a
 * structured pass/fail report. Each unmet expectation is surfaced as a
 * separate `AssertionFailure` carrying the dotted path, the expected value,
 * and the actual value, so the report renderer can render a one-line diff per
 * failure.
 *
 * Comparison rules per `docs/_planning/phase-6-spec.md` § Pass/fail rules:
 *   - integer / boolean / enum equality is strict
 *   - skipped_paths / skipped_reasons / rejection_reasons / expected_categories
 *     use **subset** semantics (every expected element must appear in the actual)
 *   - summary_contains uses substring (`String.prototype.includes`) — no regex
 */

export interface AssertionFailure {
  path: string;
  expected: unknown;
  actual: unknown;
  message: string;
}

export interface AssertionReport {
  status: 'pass' | 'fail';
  failures: AssertionFailure[];
}

const equalityFailure = (path: string, expected: unknown, actual: unknown): AssertionFailure => ({
  path,
  expected,
  actual,
  message: `expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
});

const subsetFailure = (
  path: string,
  expected: readonly string[],
  actual: readonly string[],
  missing: string[],
): AssertionFailure => ({
  path,
  expected,
  actual,
  message: `expected ${path} to be a subset of actual; missing ${JSON.stringify(missing)}`,
});

const substringFailure = (path: string, needle: string, haystack: string): AssertionFailure => ({
  path,
  expected: needle,
  actual: haystack,
  message: `expected ${path} to include substring ${JSON.stringify(needle)}`,
});

const computeMissing = (expected: readonly string[], actual: readonly string[]): string[] => {
  const actualSet = new Set(actual);
  return expected.filter((e) => !actualSet.has(e));
};

export const evaluateExpectations = (
  outcome: RunOutcome,
  expectations: ScenarioExpectations,
): AssertionReport => {
  const failures: AssertionFailure[] = [];

  // prefilter
  if (outcome.prefilter.outcome !== expectations.prefilter.outcome) {
    failures.push(
      equalityFailure(
        'expectations.prefilter.outcome',
        expectations.prefilter.outcome,
        outcome.prefilter.outcome,
      ),
    );
  }
  {
    const missing = computeMissing(
      expectations.prefilter.skipped_paths,
      outcome.prefilter.skipped_paths,
    );
    if (missing.length > 0) {
      failures.push(
        subsetFailure(
          'expectations.prefilter.skipped_paths',
          expectations.prefilter.skipped_paths,
          outcome.prefilter.skipped_paths,
          missing,
        ),
      );
    }
  }
  {
    const missing = computeMissing(
      expectations.prefilter.skipped_reasons,
      outcome.prefilter.skipped_reasons,
    );
    if (missing.length > 0) {
      failures.push(
        subsetFailure(
          'expectations.prefilter.skipped_reasons',
          expectations.prefilter.skipped_reasons,
          outcome.prefilter.skipped_reasons,
          missing,
        ),
      );
    }
  }
  if (outcome.prefilter.files_sent_to_provider !== expectations.prefilter.files_sent_to_provider) {
    failures.push(
      equalityFailure(
        'expectations.prefilter.files_sent_to_provider',
        expectations.prefilter.files_sent_to_provider,
        outcome.prefilter.files_sent_to_provider,
      ),
    );
  }

  // provider
  if (outcome.provider.calls !== expectations.provider.calls) {
    failures.push(
      equalityFailure(
        'expectations.provider.calls',
        expectations.provider.calls,
        outcome.provider.calls,
      ),
    );
  }

  // validator
  if (outcome.validator.findings !== expectations.validator.findings) {
    failures.push(
      equalityFailure(
        'expectations.validator.findings',
        expectations.validator.findings,
        outcome.validator.findings,
      ),
    );
  }
  {
    const missing = computeMissing(
      expectations.validator.rejection_reasons,
      outcome.validator.rejection_reasons,
    );
    if (missing.length > 0) {
      failures.push(
        subsetFailure(
          'expectations.validator.rejection_reasons',
          expectations.validator.rejection_reasons,
          outcome.validator.rejection_reasons,
          missing,
        ),
      );
    }
  }

  // ranker
  if (expectations.ranker.output_size_eq_input) {
    if (outcome.ranker.output_size !== outcome.validator.findings) {
      failures.push(
        equalityFailure(
          'expectations.ranker.output_size_eq_input',
          outcome.validator.findings,
          outcome.ranker.output_size,
        ),
      );
    }
  }

  // publisher
  if (outcome.publisher.inline_count !== expectations.publisher.inline_count) {
    failures.push(
      equalityFailure(
        'expectations.publisher.inline_count',
        expectations.publisher.inline_count,
        outcome.publisher.inline_count,
      ),
    );
  }
  if (outcome.publisher.summary_count !== expectations.publisher.summary_count) {
    failures.push(
      equalityFailure(
        'expectations.publisher.summary_count',
        expectations.publisher.summary_count,
        outcome.publisher.summary_count,
      ),
    );
  }
  if (outcome.publisher.dropped_count !== expectations.publisher.dropped_count) {
    failures.push(
      equalityFailure(
        'expectations.publisher.dropped_count',
        expectations.publisher.dropped_count,
        outcome.publisher.dropped_count,
      ),
    );
  }
  if (outcome.publisher.publication_state !== expectations.publisher.publication_state) {
    failures.push(
      equalityFailure(
        'expectations.publisher.publication_state',
        expectations.publisher.publication_state,
        outcome.publisher.publication_state,
      ),
    );
  }
  for (const needle of expectations.publisher.summary_contains) {
    if (!outcome.publisher.summary_artifact.includes(needle)) {
      failures.push(
        substringFailure(
          'expectations.publisher.summary_contains',
          needle,
          outcome.publisher.summary_artifact,
        ),
      );
    }
  }
  {
    const missing = computeMissing(
      expectations.publisher.expected_categories,
      outcome.publisher.expected_categories,
    );
    if (missing.length > 0) {
      failures.push(
        subsetFailure(
          'expectations.publisher.expected_categories',
          expectations.publisher.expected_categories,
          outcome.publisher.expected_categories,
          missing,
        ),
      );
    }
  }
  {
    const missing = computeMissing(
      expectations.publisher.rejection_reasons,
      outcome.publisher.rejection_reasons,
    );
    if (missing.length > 0) {
      failures.push(
        subsetFailure(
          'expectations.publisher.rejection_reasons',
          expectations.publisher.rejection_reasons,
          outcome.publisher.rejection_reasons,
          missing,
        ),
      );
    }
  }

  return { status: failures.length === 0 ? 'pass' : 'fail', failures };
};
