import type { AskRunOutcome } from './ask-runner.js';
import type { AssertionFailure, AssertionReport } from './assertions.js';
import type { AskExpectations } from './schema.js';

/**
 * Compares an `AskRunOutcome` against a fixture's `ask_expectations` block.
 * Mirrors `evaluateExpectations` (assertions.ts) in shape/comparison rules:
 *   - `kind` equality is strict.
 *   - `reply_contains` / `reply_not_contains` use substring semantics against
 *     the rendered reply body (`result.kind === 'replied'` only — the body
 *     is `''` on template-reply outcomes since those don't carry a `body`
 *     field on the `AskResult` union; a `reply_contains` assertion against a
 *     non-`replied` outcome will therefore correctly fail if misconfigured).
 *   - `provider_calls` equality is strict — the anti-abuse cap invariant
 *     (spec § 9): disabled / no_round / cap_exceeded scenarios MUST assert
 *     `provider_calls: 0`.
 */

const equalityFailure = (path: string, expected: unknown, actual: unknown): AssertionFailure => ({
  path,
  expected,
  actual,
  message: `expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
});

const substringFailure = (path: string, needle: string, haystack: string): AssertionFailure => ({
  path,
  expected: needle,
  actual: haystack,
  message: `expected ${path} to include substring ${JSON.stringify(needle)}`,
});

const negatedSubstringFailure = (
  path: string,
  needle: string,
  haystack: string,
): AssertionFailure => ({
  path,
  expected: `NOT ${needle}`,
  actual: haystack,
  message: `expected ${path} to NOT include substring ${JSON.stringify(needle)}`,
});

export const evaluateAskExpectations = (
  outcome: AskRunOutcome,
  expectations: AskExpectations,
): AssertionReport => {
  const failures: AssertionFailure[] = [];

  if (outcome.result.kind !== expectations.kind) {
    failures.push(equalityFailure('ask_expectations.kind', expectations.kind, outcome.result.kind));
  }

  const replyBody = outcome.result.kind === 'replied' ? outcome.result.body : '';

  for (const needle of expectations.reply_contains) {
    if (!replyBody.includes(needle)) {
      failures.push(substringFailure('ask_expectations.reply_contains', needle, replyBody));
    }
  }
  for (const needle of expectations.reply_not_contains) {
    if (replyBody.includes(needle)) {
      failures.push(
        negatedSubstringFailure('ask_expectations.reply_not_contains', needle, replyBody),
      );
    }
  }

  if (outcome.provider_calls !== expectations.provider_calls) {
    failures.push(
      equalityFailure(
        'ask_expectations.provider_calls',
        expectations.provider_calls,
        outcome.provider_calls,
      ),
    );
  }

  return { status: failures.length === 0 ? 'pass' : 'fail', failures };
};
