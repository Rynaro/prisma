# Evaluation Plan — Phase 6

## Goals and non-goals

The goal of Phase 6 is to demonstrate, mechanically and offline, that the App's pipeline `prefilter → provider → validator → ranker → publication cap` exhibits the contractually required behavior on a frozen taxonomy of nine deterministic scenarios.

The non-goals are reused verbatim from `docs/mvp-scope.md` § Non-goals (verbatim) and are not redeclared or reworded here:

- no auto-merge
- no autofix
- no Slack/ClickUp/Jira write-backs
- no org dashboards
- no full code-graph platform
- no multi-agent complexity beyond optional verifier/ranker
- no provider lock-in
- no comment-on-everything

Phase 6 evaluation is **deterministic and offline**: there are no live API calls. Every scenario runs against `FakeProvider`, `InMemoryReplayCache`, `InMemoryJobQueue`, and a hand-rolled `OctokitLike`. No `ANTHROPIC_API_KEY` and no GitHub token (beyond what CI's default workflow token already provides) is required to run the suite. The harness is correctness-only; latency, throughput, and token-cost assertions are out of scope (see § Future work / out of scope).

## What we measure

The suite measures seven metrics. Each metric carries a stable identifier reused verbatim in fixture `metrics:` arrays.

### `false_positive_rate`

Counts findings the validator, ranker, and publisher accepted (i.e., reached `published_inline` or `published_summary` in `PublicationResult`) that the scenario marks as "should-be-suppressed". The harness derives this from `PublicationResult.published_inline` and `PublicationResult.published_summary` against the scenario's `expectations.publisher.inline_count` and `expectations.publisher.summary_count`.

### `duplicate_suppression`

Within-run dedupe (multiple `dedupe_key` collisions in a single ranked list collapse to one) and across-run dedupe (a `dedupe_key` already present in `octokit_responses.prior_review_comments` is not re-published) correctness. The harness derives this from `PublicationResult.dropped` plus the publisher-stage `RejectionLogEntry` records whose `reason_code === 'dedupe_collapsed'`.

### `comment_usefulness`

Placeholder definition: the count of accepted findings whose `category` is a member of the scenario's `expectations.publisher.expected_categories` set. This is a placeholder until human qualitative review lands; full UX evaluation is post-MVP per OQ-8 and is explicitly out of scope for Phase 6.

### `large_diff_degradation`

The prefilter's `oversized` short-circuit fires at the right thresholds (`max_files` or `max_changed_lines` per `docs/config-spec.md` § `max_files` and § `max_changed_lines`) and the publisher emits **summary-only regardless of mode** per `docs/publication-policy.md` § Diff too large. The harness derives this from the prefilter return `{ input: null, reason: 'oversized' }` and from the assertion `PublicationResult.published_inline.length === 0` even when the configured `mode` is `summary-plus-inline`.

### `provider_schema_failure_handling`

A malformed `ProviderReviewOutput` (per `docs/api-contracts.md` § Provider adapter contract — `ProviderError.schema_validation`) produces a `failed_terminal` job state with a `RejectionLogEntry` whose `stage = 'validator'` and `reason_code = 'provider_output_zod_failed'`, and the publisher emits a Checks summary containing the **"no findings produced"** phrase from `docs/data-flow.md` § Flow 4. The harness derives this from `JobResult.state`, `PublicationResult.rejections[].reason_code`, and substring matching against `PublicationResult.summary_artifact`.

### `confidence_threshold_behavior`

Findings whose `confidence < confidence_floor.inline` are demoted: in `summary-plus-inline`, they receive a `RejectionLogEntry` with `reason_code = 'confidence_below_floor'` and do not appear in `published_inline`. The harness derives this from `PublicationResult.published_inline` (must not contain the demoted finding) and from `PublicationResult.rejections` (must contain the matching `confidence_below_floor` entry).

### `publication_cap_behavior`

The planner produces exactly N inline plus M summary entries per the worked example in `docs/publication-policy.md` § Worked example. Specifically: `comment_cap.per_file` then `comment_cap.per_pr` are applied in that order, and overflow is labeled with the matching `reason_code` (`per_file_cap_exhausted`, `per_pr_cap_exhausted`). The harness derives this from `PublicationResult.published_inline.length`, `PublicationResult.published_summary.length`, and the publisher-stage `RejectionLogEntry.reason_code` distribution.

## How we measure

For each metric the harness reads named fixture fields and asserts against the actual `PublicationResult` produced by running the orchestrator with `FakeProvider` and `OctokitLike`.

- `false_positive_rate` is operationalized via `expectations.publisher.inline_count` and `expectations.publisher.summary_count` (strict integer equality against `PublicationResult.published_inline.length` and `PublicationResult.published_summary.length`). For scenarios where the provider emits empty findings (`harmless-refactor`), both counts must be zero.
- `duplicate_suppression` is operationalized via `expectations.publisher.dropped_count` (strict integer equality against `PublicationResult.dropped.length`) and `expectations.publisher.rejection_reasons` (subset assertion against the publisher-stage reason-code set). For `duplicate-issue-across-hunks` the harness asserts a `dedupe_collapsed` reason on the dropped sibling and verifies `RankedFindings.length === validator.findings.length` via `expectations.ranker.output_size_eq_input`.
- `comment_usefulness` is operationalized via `expectations.publisher.expected_categories` (every accepted finding's `category` field must be a member of this set). Empty `expected_categories` means "no comment-usefulness assertion".
- `large_diff_degradation` is operationalized via `expectations.prefilter.outcome` (strict equality against the prefilter's `reason` field; `'oversized'` maps to `input: null`), `expectations.prefilter.skipped_paths` (subset of actual skipped paths), `expectations.prefilter.skipped_reasons` (subset of actual reason codes), and `expectations.publisher.summary_contains` (substring match against `PublicationResult.summary_artifact`).
- `provider_schema_failure_handling` is operationalized via `expectations.validator.rejection_reasons` (subset assertion containing `provider_output_zod_failed`), `expectations.publisher.publication_state` (strict equality against `JobResult.state` — `failed_terminal`), and `expectations.publisher.summary_contains` (substring match including `"no findings produced"`).
- `confidence_threshold_behavior` is operationalized via `expectations.publisher.inline_count` (the demoted finding must not appear) and `expectations.publisher.rejection_reasons` (subset containing `confidence_below_floor`).
- `publication_cap_behavior` is operationalized via `expectations.publisher.inline_count`, `expectations.publisher.summary_count`, and `expectations.publisher.rejection_reasons` (subset containing one of `per_file_cap_exhausted`, `per_pr_cap_exhausted`).

No metric paragraph references a fixture field that is not declared in § Scenario YAML schema.

## Scenario taxonomy

The nine canonical scenarios, in frozen order. IDs and order are reused byte-equivalent by `evals/scenarios.yaml` and by every `evals/fixtures/<id>.yaml`.

| ID | Name | What this exercises | Metrics |
| --- | --- | --- | --- |
| `security-bug` | Security bug — SQL injection in changed file | A high-severity `security`-category finding survives all gates and is published inline. | `comment_usefulness`, `publication_cap_behavior` |
| `missing-tests` | Missing tests for new public function | A `tests`-category finding at severity ≥ floor publishes inline (verifies severity-floor + category coverage). | `comment_usefulness`, `confidence_threshold_behavior` |
| `risky-migration` | Risky DB migration without rollback | A `migration`-category finding publishes inline. | `comment_usefulness`, `publication_cap_behavior` |
| `harmless-refactor` | Harmless rename refactor | No findings expected; provider returns empty. FP guard. | `false_positive_rate` |
| `generated-files` | Diff is only `dist/foo.js` | Prefilter excludes; provider not called. | `large_diff_degradation` (prefilter exclusion arm) |
| `noisy-diff-with-lockfiles` | Source code + `package-lock.json` | Lockfile path skipped, source path analyzed. | `false_positive_rate`, `large_diff_degradation` (selective-skip arm) |
| `malformed-provider-output` | Provider returns invalid JSON shape | Pipeline degrades to `failed_terminal` with summary-only. | `provider_schema_failure_handling` |
| `duplicate-issue-across-hunks` | Two findings share a `dedupe_key` | Within-run dedupe collapses to one. | `duplicate_suppression` |
| `oversized-pr` | PR exceeds `max_files` | Prefilter `oversized` short-circuit; provider not called; summary-only regardless of mode. | `large_diff_degradation` (oversized arm) |

## Scenario YAML schema

The per-scenario fixture YAML is shaped as a strict zod object exported from `@prisma-bot/eval-runner` at `evals/runner/src/scenario-schema.ts`. Unknown top-level keys are rejected (zod `.strict()`). The fixture's `id` field MUST equal the basename of the YAML file (without extension); the harness asserts this on load.

```yaml
id: <scenario-id>                          # required; equals filename basename
name: <human-readable name>                # required
description: <2-3 sentence rationale>      # required

config_overrides:                          # required; merged on top of DEFAULT_REPO_CONFIG
  mode: <Mode>                             # dry-run | summary-only | summary-plus-inline
  thresholds:
    severity_floor:
      inline: <Severity>                   # info | low | medium | high | critical
    confidence_floor:
      inline: <number 0..1>
  comment_cap:
    per_pr: <int>
    per_file: <int>
  exclude_generated: <bool>                # optional
  max_files: <int>                         # optional
  max_changed_lines: <int>                 # optional

pr_payload:                                # required; parsed JSON of the GitHub webhook body
  installation: { id: <int> }
  repository: { id: <int>, full_name: <string> }
  pull_request: { number: <int>, head: { sha: <string> } }
  action: opened | synchronize | reopened

octokit_responses:                         # required; what hand-rolled OctokitLike returns
  pulls_get: { ... PullsGetData ... }
  pulls_list_files:                        # array of pages; each page is array of files
    - [ { filename, status, additions, deletions, patch?, previous_filename? } ]
  prior_review_comments: [ { ... } ]       # default []; for across-run dedupe
  prior_check_runs: [ { ... } ]            # default []; for across-run dedupe

provider_script:                           # required; FakeProvider script (sequence of calls)
  - kind: output | error | output_lazy
    output: { findings: [ ... ProviderReviewOutput.findings entries ... ] }
    error: { kind: "transport|auth|rate_limit|capability|schema_validation", message: <string> }

expectations:                              # required
  prefilter:
    outcome: accepted | oversized | all-excluded   # strict equality
    skipped_paths: [ <path> ]                      # subset assertion
    skipped_reasons: [ <reason> ]                  # subset assertion
    files_sent_to_provider: <int>                  # strict equality
  provider:
    calls: <int>                                   # strict equality
  validator:
    findings: <int>                                # strict equality
    rejection_reasons: [ <reason_code> ]           # subset assertion
  ranker:
    output_size_eq_input: true | false             # invariant check
  publisher:
    inline_count: <int>                            # strict equality
    summary_count: <int>                           # strict equality
    dropped_count: <int>                           # strict equality
    publication_state: succeeded | failed_terminal # strict equality against JobResult.state
    summary_contains: [ <substring> ]              # substring match, case-sensitive, no regex
    expected_categories: [ <category> ]            # subset of categories on accepted findings
    rejection_reasons: [ <reason_code> ]           # optional; subset assertion (added in Phase 6
                                                   # to support duplicate-issue-across-hunks)

metrics:                                   # required; cross-ref § What we measure
  - <metric_identifier>                    # one or more of the 7 frozen identifiers
```

The schema is `.strict()`: any top-level key beyond `id`, `name`, `description`, `config_overrides`, `pr_payload`, `octokit_responses`, `provider_script`, `expectations`, `metrics` is rejected. Within `expectations.publisher`, the optional `rejection_reasons` field is a subset assertion (publisher-stage `RejectionLogEntry.reason_code` values); APIVR added it during Phase 6 to satisfy `duplicate-issue-across-hunks`.

## Pass/fail rules

For each fixture field under `expectations`, the comparison rule is:

- `expectations.prefilter.outcome` — strict equality against the actual prefilter return value's `reason` field (`accepted` | `oversized` | `all-excluded`). `'accepted'` maps to a non-null `input`; `'oversized'` and `'all-excluded'` map to `input: null` with the matching `reason`.
- `expectations.prefilter.skipped_paths` — subset assertion: every listed path must appear in the actual set of paths the prefilter excluded; the actual set may be larger.
- `expectations.prefilter.skipped_reasons` — subset assertion against the actual reason-code set (e.g., `generated`, `vendored`, `path_excluded`).
- `expectations.prefilter.files_sent_to_provider` — strict integer equality against `accepted.files.length`.
- `expectations.provider.calls` — strict integer equality against `FakeProvider.calls.length`.
- `expectations.validator.findings` — strict integer equality against the validator's `findings` length.
- `expectations.validator.rejection_reasons` — subset assertion against the actual `rejections[].reason_code` set.
- `expectations.ranker.output_size_eq_input` — boolean; when `true`, asserts `RankedFindings.length === validator.findings.length` (per the ranker invariant in `docs/api-contracts.md` § Ranker contract).
- `expectations.publisher.inline_count` — strict integer equality against `PublicationResult.published_inline.length`.
- `expectations.publisher.summary_count` — strict integer equality against `PublicationResult.published_summary.length`.
- `expectations.publisher.dropped_count` — strict integer equality against `PublicationResult.dropped.length`.
- `expectations.publisher.publication_state` — strict equality against `JobResult.state` (`succeeded` | `failed_terminal`).
- `expectations.publisher.summary_contains` — array of substrings; each must appear in `PublicationResult.summary_artifact` via case-sensitive `String.prototype.includes`. No regex.
- `expectations.publisher.expected_categories` — subset assertion: the `category` field of every accepted finding (`published_inline` ∪ `published_summary`) must be a member of this set when the set is non-empty. An empty array means "no assertion".
- `expectations.publisher.rejection_reasons` — optional; when present, subset assertion against publisher-stage `RejectionLogEntry.reason_code` values.

A scenario PASSES iff every assertion above evaluates true. A scenario FAILS as soon as any assertion fails; the harness emits a structured diff (expected vs actual) for the failing assertion(s) into both the JSON report and the Markdown report.

## How to run locally

The Phase 6 evaluation suite is container-first. Every concrete invocation goes through `make`. **Never run `pnpm` or `node` directly**; the harness lives inside the `tools` container and is dispatched through the `make eval` target in the root Makefile (added by APIVR in Phase 6).

```
# Run the full Phase 6 eval suite (9 scenarios)
make eval

# Run a single scenario
make eval -- --scenario security-bug

# Emit the Markdown report to a chosen path
make eval -- --report-md ./eval-report.md
```

The package implementing the harness is `@prisma-bot/eval-runner`, located at `evals/runner/`. The contract test suite (`make test`) is unaffected by the eval suite and continues to run independently.

## CI integration

Phase 6 adds a single GitHub Actions step **after** the existing `make test` step. The integration rules are:

- The job is named `eval` (or extends the existing test job with an `eval` step — APIVR chooses).
- The step runs `make eval`.
- The step blocks the workflow on any FAIL: the harness exits non-zero if any of the nine scenarios fails any assertion.
- The Markdown report (`./eval-report.md`) is uploaded as a workflow artifact for triage.
- No live secrets are used by the eval step — no `ANTHROPIC_API_KEY`, and no `GITHUB_TOKEN` beyond the default workflow token is required.

## Future work / out of scope

Phase 6 does **NOT** include:

- Phase 7 readme polishing or end-user docs (out of scope here; Phase 7 owns those).
- Manual qualitative review of finding bodies. The `comment_usefulness` metric is a placeholder; full UX review is post-MVP per OQ-8.
- Multi-provider comparison. A single `FakeProvider` is the only provider exercised; the Anthropic adapter is out of scope for evaluation in Phase 6.
- Live API replay or recording. No scenario calls a real GitHub or Anthropic endpoint.
- Performance benchmarking or load testing. The harness is correctness-only.
