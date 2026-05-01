# Phase 6 — Quality and Evaluation — SPECTRA Specification

This is the binding contract for Phase 6 of the AI Code Review GitHub App. IDG composes the prose doc described in § File 1; APIVR implements the harness, fixtures, and scenario index described in § File 2 onward. Nothing in this spec is a doc body — it is the structure, content rules, and acceptance criteria those downstream agents will satisfy.

---

## Phase 6 Work Plan (≤ 300 words)

**Authoring order.**
1. **IDG composes `docs/evaluation-plan.md`** first. It encodes the methodology, metric definitions, and the canonical scenario list. Every later artifact depends on this list being frozen.
2. **APIVR composes `evals/scenarios.yaml`** next. Mechanical: it transcribes the canonical list (§ Scenario taxonomy) into the index file. No new IDs introduced here.
3. **APIVR composes the 9 per-scenario fixtures** (`evals/fixtures/<id>.yaml` + auxiliary payloads) one at a time, smallest-first: `harmless-refactor` → `generated-files` → `noisy-diff-with-lockfiles` → `oversized-pr` → `missing-tests` → `risky-migration` → `security-bug` → `duplicate-issue-across-hunks` → `malformed-provider-output`.
4. **APIVR composes `evals/runner/`** (the `@prisma-bot/eval-runner` workspace) and the `evals/README.md`. The harness is implemented last so it can typecheck against the materialized fixture set.
5. **APIVR wires `make eval`** into the root `Makefile` and adds the CI step.

**File dependencies.** `docs/evaluation-plan.md` defines the schema and pass/fail rules → `evals/scenarios.yaml` references those IDs verbatim → each `evals/fixtures/<id>.yaml` conforms to the schema and carries the metrics tags from the plan → `evals/runner/` reads the index and dispatches per-scenario expectations against `FakeProvider` + `OctokitLike` → `evals/README.md` points operators back to the plan.

**Consistency-check pass before exit.** Run, in order: (a) zod-validate every fixture against the schema; (b) confirm `evals/scenarios.yaml` order matches `docs/evaluation-plan.md` § Scenario taxonomy line-for-line; (c) `make test` (210 pre-existing tests still pass); (d) `make eval` (9 scenarios PASS); (e) grep every Phase 1–5 anchor identifier (`ProviderReviewOutput`, `NormalizedFinding`, `RankedFindings`, `PublicationResult`, mode names, `prefilter → provider → validator → ranker → publication cap`) in the new files for byte-equivalent reuse.

**Phase 6 exit gate (testable).** `make test` exits 0 with **210 + N** existing tests green (N = any tests added by APIVR for the harness itself); `make eval` exits 0 with **9** scenarios reporting PASS; `evals/scenarios.yaml` parses and contains exactly 9 entries with IDs in the canonical order; CI's GitHub Actions job runs `make test` then `make eval` and blocks on either failing.

---

## Resolution log entries for OQ-7 and OQ-9 (IDG copy targets)

These blocks are the verbatim text IDG copies into `docs/open-questions.md` § Resolution log **only if** Phase 6 work resolves them. If Phase 6 does not resolve an entry, the entry stays in its current section (Research gaps for OQ-7; Open questions for OQ-9).

### OQ-7 — Recommended disposition: **resolve as validated-architecturally**

Rationale: Phase 1's desk review of OpenReview, PR-Agent, ai-codereviewer, and Kodus made architectural claims about prefiltering posture, validation/ranking posture, and provider coupling. The Phase 6 evaluation harness exercises **our** pipeline at exactly those architectural layers — `prefilter → provider → validator → ranker → publication cap` — with deterministic scenarios that demonstrate prefilter gating (`generated-files`, `noisy-diff-with-lockfiles`, `oversized-pr`), schema-bounded provider output (`malformed-provider-output`), validator/ranker behavior (`harmless-refactor`, `duplicate-issue-across-hunks`), and the publication-cap arithmetic that distinguishes us from the surveyed projects. We are no longer relying on the desk-review claims as load-bearing — Phase 6 supersedes them with mechanical evidence about our own architecture. OQ-7 should move to the Resolution log.

**Resolution text (IDG copies this block under OQ-7 in the Resolution log):**

> **Resolution date.** 2026-05-01.
> **Resolution.** Resolved as validated-architecturally. The Phase 6 evaluation harness (`evals/runner/`, `docs/evaluation-plan.md`, 9 fixtures under `evals/fixtures/`) exercises every architectural property the Phase 1 desk review used to compare our design against OpenReview, PR-Agent, ai-codereviewer, and Kodus: deterministic prefilter gating, Zod-validated provider boundary, validator/ranker separation, and explicit publication caps. The desk-review claims are no longer load-bearing for Phase 2+ design — our pipeline's behavior is mechanically demonstrated by `make eval`.
> **Rationale.** Phase 6's harness is the empirical replacement for unverified comparative claims. Confirming external projects against authoritative public sources (the original OQ-7 question) is not required, because we no longer cite those projects' behavior as evidence for our own choices.

### OQ-9 — Recommended disposition: **defer to Phase 7**

Rationale: OQ-9 asks whether `ChangedFileSchema` should grow a `truncated: boolean` flag when the snapshotter truncates a per-file `patch`. None of the 9 Phase 6 scenarios depend on observing a `truncated` flag at the schema layer: the `oversized-pr` scenario tests the **prefilter's** size short-circuit (the `oversized` reason path), not per-file patch truncation. Therefore Phase 6 does not need to add the field, and adding it speculatively would violate the SPECTRA "do not invent technologies or claims unsupported by the brief" rule. Leave OQ-9 in § Open questions; mark "Phase 6 reviewed; not surfaced by any scenario" as a one-line note appended to OQ-9. If a future operational scenario surfaces the flag's necessity (e.g., a customer report that a finding cited a line in a truncated region), Phase 7 reopens.

**Append-only note text (IDG appends this single line to OQ-9 in § Open questions, not the Resolution log):**

> **Phase 6 review.** The Phase 6 evaluation harness's 9 scenarios do not depend on observing snapshotter truncation at the schema boundary; the oversized-PR path is exercised at the prefilter's `max_files`/`max_changed_lines` short-circuit, not at per-file `patch` truncation. OQ-9 remains open; revisit in Phase 7 if a surfaced incident requires the schema to expose the flag.

---

## Decision: 9 scenarios, not 8

The brief lists 8 scenarios and notes that adding `oversized-pr` as a 9th is acceptable. **This spec adopts the 9-scenario list.** Justification:

- "Large-diff degradation" is the metric in `docs/evaluation-plan.md` § What we measure. It cannot be exercised by `noisy-diff-with-lockfiles` because that scenario tests **selective** lockfile exclusion within an otherwise-normal diff; the prefilter does not return `oversized`. A scenario that drives the prefilter into `reason: 'oversized'` (per `data-flow.md` § Flow 2 — Oversized-diff fast-path) is required for mechanical coverage.
- The 9th scenario `oversized-pr` is small to author (no provider script — the provider is never called) and decisively covers `Flow 2` end to end including the **summary-only regardless of mode** rule from `docs/publication-policy.md` § Diff too large.

**Canonical scenario list (frozen — IDG and APIVR reuse this order verbatim):**

1. `security-bug`
2. `missing-tests`
3. `risky-migration`
4. `harmless-refactor`
5. `generated-files`
6. `noisy-diff-with-lockfiles`
7. `malformed-provider-output`
8. `duplicate-issue-across-hunks`
9. `oversized-pr`

---

# File 1 — `docs/evaluation-plan.md`

## Purpose

The methodology document for Phase 6. Defines what we measure, how we measure it, the canonical scenario taxonomy, the per-scenario YAML schema, the pass/fail rules, the local-run command, the CI integration, and the explicit out-of-scope boundary against Phase 7. IDG composes the prose; this section binds the structure and content.

## Required sections (exact, in order)

1. `# Evaluation Plan — Phase 6`
2. `## Goals and non-goals`
3. `## What we measure`
4. `## How we measure`
5. `## Scenario taxonomy`
6. `## Scenario YAML schema`
7. `## Pass/fail rules`
8. `## How to run locally`
9. `## CI integration`
10. `## Future work / out of scope`

## Required content per section

### `## Goals and non-goals`

- A one-sentence goal naming the pipeline anchor `prefilter → provider → validator → ranker → publication cap` byte-equivalent.
- A non-goals list that **references `docs/mvp-scope.md` § Non-goals (verbatim)** — IDG must not duplicate or reword the bullet text; reference by section name and reuse the exact bullet shape: `no auto-merge`, `no autofix`, `no Slack/ClickUp/Jira write-backs`, `no org dashboards`, `no full code-graph platform`, `no multi-agent complexity beyond optional verifier/ranker`, `no provider lock-in`, `no comment-on-everything`.
- An explicit declaration that Phase 6 evaluation is **deterministic and offline** — no live API calls.

### `## What we measure`

The 7 metrics, listed with stable identifiers. Each metric appears as a sub-heading; each sub-heading carries a one-paragraph definition that names the artifact the harness derives the metric from.

The 7 metric identifiers (used verbatim in fixture `metrics:` arrays):

1. `false_positive_rate` — Findings the validator/ranker/publisher accepted (i.e., reached `published_inline` or `published_summary` in `PublicationResult`) that the scenario marks as "should-be-suppressed".
2. `duplicate_suppression` — Within-run dedupe (multiple `dedupe_key` collisions in a single ranked list collapse to one) and across-run dedupe (a `dedupe_key` already in `octokit_responses.prior_review_comments` is not re-published) correctness.
3. `comment_usefulness` — Placeholder definition: the count of accepted findings whose `category` is a member of the scenario's `expectations.publisher.expected_categories` set. The plan must call this out as a placeholder until human qualitative review lands (Phase 7 / post-MVP).
4. `large_diff_degradation` — The prefilter's `oversized` short-circuit fires at the right thresholds (`max_files` or `max_changed_lines` per `docs/config-spec.md` § `max_files` and § `max_changed_lines`) and the publisher emits **summary-only regardless of mode** (per `docs/publication-policy.md` § Diff too large).
5. `provider_schema_failure_handling` — A malformed `ProviderReviewOutput` (per `docs/api-contracts.md` § Provider adapter contract `ProviderError.schema_validation`) produces a `failed_terminal` job state with a `RejectionLogEntry` whose `stage = 'validator'` and `reason_code = 'provider_output_zod_failed'`, and the publisher emits a Checks summary containing the **"no findings produced"** phrase from `docs/data-flow.md` § Flow 4.
6. `confidence_threshold_behavior` — Findings with `confidence < confidence_floor.inline` are demoted (in `summary-plus-inline`, they receive `RejectionLogEntry.reason_code = 'confidence_below_floor'` and do not appear in `published_inline`).
7. `publication_cap_behavior` — The planner produces exactly N inline + M summary entries per the worked example in `docs/publication-policy.md` § Worked example. Specifically: `comment_cap.per_file` then `comment_cap.per_pr` are applied in that order, and overflow is labeled with the matching `reason_code` (`per_file_cap_exhausted`, `per_pr_cap_exhausted`).

### `## How we measure`

For each of the 7 metrics, a one-paragraph operationalization. Each paragraph names the fixture field(s) the harness reads (`expectations.publisher.inline_count`, `expectations.publisher.summary_count`, `expectations.validator.rejection_reasons`, etc.) and the assertion the harness performs against the actual `PublicationResult` produced by running the orchestrator with `FakeProvider` and `OctokitLike`. No metric paragraph may invent a fixture field not declared in § Scenario YAML schema.

### `## Scenario taxonomy`

The 9 canonical scenarios, in the order frozen in this spec, each with: ID (verbatim, kebab-case), name (human-readable), one-line "what this exercises", and the metric identifiers it covers (subset of the 7 above).

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

### `## Scenario YAML schema`

A zod-shaped declaration of the per-scenario fixture YAML. Every field, its type, required/optional, validation rule. The schema **must include at minimum** the fields listed in § File 4 below. The plan must declare that:

- The schema is implemented as a zod object exported from `@prisma-bot/eval-runner` at `evals/runner/src/scenario-schema.ts`.
- Unknown top-level keys are rejected (zod `.strict()`); the plan calls this out so APIVR implements it.
- The fixture's `id` field MUST equal the basename of the YAML file (without extension); the harness asserts this on load.

### `## Pass/fail rules`

For each fixture field under `expectations`, the comparison rule. Mandatory rules:

- `expectations.prefilter.outcome` — strict equality against the actual `prefilter` return value's `reason` field (`accepted` | `oversized` | `all-excluded`). Note that `'accepted'` in the fixture maps to the prefilter returning a non-null `input`; `'oversized'` and `'all-excluded'` map to `input: null` with the matching `reason`.
- `expectations.prefilter.skipped_paths` — subset of the actual paths the prefilter excluded (the actual set may be larger; the assertion is "all listed paths were excluded").
- `expectations.prefilter.skipped_reasons` — subset of the actual reason codes (e.g., `generated`, `vendored`, `path_excluded`).
- `expectations.prefilter.files_sent_to_provider` — strict integer equality against `accepted.files.length`.
- `expectations.provider.calls` — strict integer equality against `FakeProvider.calls.length`.
- `expectations.validator.findings` — strict integer equality against the validator's `findings` length.
- `expectations.validator.rejection_reasons` — subset of the actual `rejections[].reason_code` set.
- `expectations.ranker.output_size_eq_input` — boolean; when `true`, asserts that `RankedFindings.length === validator.findings.length` (per the ranker invariant in `docs/api-contracts.md` § Ranker contract).
- `expectations.publisher.inline_count` — strict integer equality against `PublicationResult.published_inline.length`.
- `expectations.publisher.summary_count` — strict integer equality against `PublicationResult.published_summary.length`.
- `expectations.publisher.dropped_count` — strict integer equality against `PublicationResult.dropped.length`.
- `expectations.publisher.publication_state` — strict equality against `JobResult.state` (`succeeded` | `failed_terminal`).
- `expectations.publisher.summary_contains` — array of substrings; each must appear in `PublicationResult.summary_artifact` (case-sensitive `String.prototype.includes`). No regex.

A scenario PASSES iff every assertion above evaluates true. A scenario FAILS as soon as any assertion fails; the harness emits a structured diff (expected vs actual) for the failing assertion(s) into both the JSON report and the Markdown report.

### `## How to run locally`

Container-first commands only. Required content:

```
# Run the full Phase 6 eval suite (9 scenarios)
make eval

# Run a single scenario
make eval -- --scenario security-bug

# Emit the Markdown report to a chosen path
make eval -- --report-md ./eval-report.md
```

The plan must explicitly state: **never run `pnpm` or `node` directly**; every command goes through `make`. The plan must point at the new `make eval` target in the root Makefile (added by APIVR in Phase 6).

### `## CI integration`

Phase 6 adds a single GitHub Actions job step **after** the existing `make test` step. The plan declares:

- The job is named `eval` (or extends the existing test job with an `eval` step — APIVR chooses).
- The step runs `make eval`.
- The step blocks the workflow on any FAIL (the harness exits non-zero).
- The Markdown report (`./eval-report.md`) is uploaded as a workflow artifact for triage.
- No live secrets are used by the eval step (no `ANTHROPIC_API_KEY`, no `GITHUB_TOKEN` beyond the default workflow token).

### `## Future work / out of scope`

Explicit boundary. The plan must state that Phase 6 does **NOT** include:

- Phase 7 readme polishing or end-user docs (out of scope here).
- Manual qualitative review of finding bodies (placeholder `comment_usefulness` metric only; full UX review is post-MVP per OQ-8).
- Multi-provider comparison (a single `FakeProvider` is the only provider exercised; the Anthropic adapter is out of scope for evaluation in Phase 6).
- Live API replay or recording (no scenario calls a real GitHub or Anthropic endpoint).
- Performance benchmarking or load testing (the harness is correctness-only).

## Acceptance criteria (≥ 4 GIVEN/WHEN/THEN, mechanically checkable)

1. **GIVEN** `docs/evaluation-plan.md` exists, **WHEN** a reader greps for `prefilter → provider → validator → ranker → publication cap`, **THEN** the exact byte-equivalent string appears at least once.
2. **GIVEN** `docs/evaluation-plan.md` exists, **WHEN** the reader counts entries in § Scenario taxonomy, **THEN** there are exactly 9 rows in the canonical order frozen above.
3. **GIVEN** `docs/evaluation-plan.md` exists, **WHEN** the reader counts metric sub-headings under § What we measure, **THEN** there are exactly 7 metrics with the identifiers `false_positive_rate`, `duplicate_suppression`, `comment_usefulness`, `large_diff_degradation`, `provider_schema_failure_handling`, `confidence_threshold_behavior`, `publication_cap_behavior`.
4. **GIVEN** `docs/evaluation-plan.md` exists, **WHEN** the reader greps for the run-command block, **THEN** every command is prefixed with `make eval`; **AND** there is no occurrence of `pnpm test` or `node ./evals` or `npx vitest` in any run-command block.
5. **GIVEN** `docs/evaluation-plan.md` exists, **WHEN** the reader inspects § Future work / out of scope, **THEN** the document explicitly names "Phase 7", "manual qualitative review", and "multi-provider comparison" as out of scope.

## Cross-file consistency requirements

- Mode names spelled exactly: `dry-run`, `summary-only`, `summary-plus-inline`. No casing variants.
- Schema chain spelled exactly: `ProviderReviewInput → ProviderReviewOutput → NormalizedFinding → RankedFindings → PublicationResult`.
- Pipeline spelled exactly: `prefilter → provider → validator → ranker → publication cap`.
- Config defaults referenced (not redeclared): `comment_cap.per_pr = 5`, `comment_cap.per_file = 1`, `severity_floor.inline = medium`, `confidence_floor.inline = 0.7`, default `mode = dry-run`. All references must point at `docs/config-spec.md` § Key reference and `docs/publication-policy.md` § Defaults (per OQ-2).
- Repo-local config path spelled exactly: `.github/review-bot.yml`.
- Reason codes used verbatim from `docs/review-findings-schema.md` § Rejection log entry shape: `path_not_in_diff`, `line_outside_hunk`, `evidence_unverifiable`, `per_file_cap_exhausted`, `per_pr_cap_exhausted`, `confidence_below_floor`, `severity_below_floor`, `dedupe_collapsed`, `provider_output_zod_failed`.

## Out of scope

- Doc body prose. IDG composes that.
- Implementation of the harness or the fixtures. APIVR composes those.
- Adding new metrics beyond the 7 enumerated. Any addition is Phase 7+.
- Renaming or reordering the 9 canonical scenarios. They are frozen.

---

# File 2 — `evals/README.md`

## Purpose

Operator-facing readme. Replaces the Phase 4 stub. Pointers and run instructions only; no methodology (the methodology lives in `docs/evaluation-plan.md`).

## Required sections (exact, in order)

1. `# Evaluation Suite`
2. `## Purpose`
3. `## How to run`
4. `## Scenario index`
5. `## Adding a new scenario`
6. `## CI`

## Required content per section

### `## Purpose`

One paragraph. Names the harness package `@prisma-bot/eval-runner`, names the entry-point command `make eval`, and forward-references `docs/evaluation-plan.md` for methodology. Must declare: **no live API calls; no provider key required**. Must name the fakes the harness uses: `FakeProvider`, `InMemoryReplayCache`, `InMemoryJobQueue`, hand-rolled `OctokitLike`.

### `## How to run`

Concrete `make` commands only. Required commands (verbatim):

```
make eval
make eval -- --scenario <id>
make eval -- --report-md <path>
make eval -- --all --report-md <path>
```

The readme must explicitly forbid `pnpm` and `node` invocations. A note: "The harness runs inside the `tools` container via `docker compose`; no host node install is required."

### `## Scenario index`

A Markdown table mapping each scenario ID to a one-line description. The IDs and order must match the canonical list. The descriptions match the "What this exercises" column from `docs/evaluation-plan.md` § Scenario taxonomy verbatim. Exactly 9 rows.

### `## Adding a new scenario`

Numbered steps. Mandatory steps:

1. Pick an ID (kebab-case) not present in `evals/scenarios.yaml`.
2. Add a new entry at the end of `evals/scenarios.yaml` with `id`, `name`, `fixture: fixtures/<id>.yaml`, and `tags`.
3. Create `evals/fixtures/<id>.yaml` against the schema in `docs/evaluation-plan.md` § Scenario YAML schema.
4. Create `evals/fixtures/<id>/` and add any auxiliary payload files (`pr_data.json`, `files.json`, etc.) that the YAML references.
5. Run `make eval -- --scenario <id>` and iterate until PASS.
6. Add the scenario to `docs/evaluation-plan.md` § Scenario taxonomy with its name, "what this exercises", and metric identifiers.
7. Open a PR; CI will run `make eval` and block on FAIL.

### `## CI`

One paragraph. Forward-reference to `docs/evaluation-plan.md` § CI integration. Names the workflow step `eval` and confirms the step blocks the merge.

## Acceptance criteria (≥ 4 GIVEN/WHEN/THEN, mechanically checkable)

1. **GIVEN** `evals/README.md` exists, **WHEN** the reader counts rows in § Scenario index's table, **THEN** there are exactly 9 rows whose `id` column matches the canonical list in this spec, in order.
2. **GIVEN** `evals/README.md` exists, **WHEN** the reader greps for `pnpm` or `npx ` or `node ./` in the file, **THEN** there are zero matches.
3. **GIVEN** `evals/README.md` exists, **WHEN** the reader greps for `make eval`, **THEN** the string appears at least 4 times (one per required command + the CI mention).
4. **GIVEN** `evals/README.md` exists, **WHEN** the reader inspects § Adding a new scenario, **THEN** the steps include adding the scenario to both `evals/scenarios.yaml` and `docs/evaluation-plan.md` § Scenario taxonomy (consistency requirement).

## Cross-file consistency requirements

- Scenario IDs and descriptions must match `docs/evaluation-plan.md` § Scenario taxonomy byte-equivalent.
- The fakes named (`FakeProvider`, `InMemoryReplayCache`, `InMemoryJobQueue`, `OctokitLike`) must be the names actually exported by Phase 4–5 packages.

## Out of scope

- Methodology. Lives in `docs/evaluation-plan.md`.
- Per-scenario YAML examples. Fixture YAML files are linked, not inlined.

---

# File 3 — `evals/scenarios.yaml`

## Purpose

The index file the harness loads first. Lists all 9 scenarios, their fixture paths, and their tags. Schema-defined; zod-validated by the harness on load.

## Required shape (exact)

```yaml
scenarios:
  - id: security-bug
    name: "Security bug — SQL injection in changed file"
    fixture: fixtures/security-bug.yaml
    tags: ["security", "publication_cap_behavior", "comment_usefulness"]
  - id: missing-tests
    name: "Missing tests for new public function"
    fixture: fixtures/missing-tests.yaml
    tags: ["tests", "comment_usefulness", "confidence_threshold_behavior"]
  - id: risky-migration
    name: "Risky DB migration without rollback"
    fixture: fixtures/risky-migration.yaml
    tags: ["migration", "comment_usefulness", "publication_cap_behavior"]
  - id: harmless-refactor
    name: "Harmless rename refactor"
    fixture: fixtures/harmless-refactor.yaml
    tags: ["false_positive_rate"]
  - id: generated-files
    name: "Diff is only generated files"
    fixture: fixtures/generated-files.yaml
    tags: ["large_diff_degradation"]
  - id: noisy-diff-with-lockfiles
    name: "Source code plus package-lock.json"
    fixture: fixtures/noisy-diff-with-lockfiles.yaml
    tags: ["false_positive_rate", "large_diff_degradation"]
  - id: malformed-provider-output
    name: "Provider returns invalid JSON shape"
    fixture: fixtures/malformed-provider-output.yaml
    tags: ["provider_schema_failure_handling"]
  - id: duplicate-issue-across-hunks
    name: "Two findings share a dedupe_key"
    fixture: fixtures/duplicate-issue-across-hunks.yaml
    tags: ["duplicate_suppression"]
  - id: oversized-pr
    name: "PR exceeds max_files"
    fixture: fixtures/oversized-pr.yaml
    tags: ["large_diff_degradation"]
```

## Required constraints

- Exactly 9 entries.
- IDs and order match the canonical list frozen above.
- Each `fixture` path resolves to an existing file on disk after APIVR composes the fixtures.
- Each `id` matches the basename of its `fixture` (without extension).
- Top-level structure is a single key `scenarios`; no other top-level keys.
- Each entry's required fields: `id`, `name`, `fixture`, `tags`. No optional fields in this index — all four are required.
- Tags are an array of strings; each string is either a metric identifier from § What we measure or a category-of-coverage word like `security`, `tests`, `migration`. Validation is permissive on tags (no closed enum); validation is strict on the other fields.

## Acceptance criteria (≥ 4 GIVEN/WHEN/THEN, mechanically checkable)

1. **GIVEN** `evals/scenarios.yaml` exists, **WHEN** the harness loads it, **THEN** it parses without error and contains exactly 9 entries.
2. **GIVEN** `evals/scenarios.yaml` exists, **WHEN** the harness extracts the `id` field of each entry in order, **THEN** the result equals `['security-bug', 'missing-tests', 'risky-migration', 'harmless-refactor', 'generated-files', 'noisy-diff-with-lockfiles', 'malformed-provider-output', 'duplicate-issue-across-hunks', 'oversized-pr']`.
3. **GIVEN** `evals/scenarios.yaml` exists, **WHEN** the harness reads each entry's `fixture` path, **THEN** every referenced path exists on disk and ends with `.yaml`.
4. **GIVEN** `evals/scenarios.yaml` exists, **WHEN** the harness validates each entry against the index schema, **THEN** every entry has all four required fields (`id`, `name`, `fixture`, `tags`), `tags` is a non-empty string array, and `id` equals `basename(fixture, '.yaml')`.

## Cross-file consistency requirements

- IDs in this index must equal IDs in `docs/evaluation-plan.md` § Scenario taxonomy.
- IDs in this index must equal the basenames of files in `evals/fixtures/`.

## Out of scope

- Per-scenario `expectations`. They live in the per-scenario fixture file.
- Schema definition. The zod schema lives in `evals/runner/src/scenario-schema.ts` (composed by APIVR).

---

# File 4 — `evals/fixtures/<scenario-id>.yaml` (per-scenario fixtures)

## Purpose

The 9 binding fixture files. Each carries the configuration overrides, simulated PR payload, simulated Octokit responses, scripted FakeProvider behavior, and the expectations the harness compares against actual orchestrator output.

## Required shape (the APIVR contract)

```yaml
id: <scenario-id>                          # MUST equal filename basename
name: <human-readable name>
description: <2-3 sentence rationale>

config_overrides:                          # merged on top of DEFAULT_REPO_CONFIG
  mode: <Mode>                             # dry-run | summary-only | summary-plus-inline
  thresholds:
    severity_floor:
      inline: <Severity>                   # info | low | medium | high | critical
    confidence_floor:
      inline: <number 0..1>
  comment_cap:
    per_pr: <int>
    per_file: <int>
  # any other RepoConfig key from docs/config-spec.md § Key reference

pr_payload:                                # parsed JSON of the GitHub webhook body
  installation: { id: <int> }
  repository: { id: <int>, full_name: <string> }
  pull_request: { number: <int>, head: { sha: <string> } }
  action: opened | synchronize | reopened

octokit_responses:                         # what hand-rolled OctokitLike returns
  pulls_get: { ... PullsGetData ... }
  pulls_list_files:                        # array of pages; each page is array of files
    - [ { filename, status, additions, deletions, patch?, previous_filename? } ]
  prior_review_comments: [ { ... } ]       # for across-run dedupe; default []
  prior_check_runs: [ { ... } ]            # for across-run dedupe; default []

provider_script:                           # FakeProvider script (sequence of calls)
  - kind: output | error | output_lazy
    # exactly one of:
    output: { findings: [ ... ProviderReviewOutput.findings entries ... ] }
    error: { kind: "transport|auth|rate_limit|capability|schema_validation", message: <string> }

expectations:
  prefilter:
    outcome: accepted | oversized | all-excluded
    skipped_paths: [ <path> ]              # subset assertion
    skipped_reasons: [ <reason> ]          # subset assertion
    files_sent_to_provider: <int>          # exact
  provider:
    calls: <int>                           # exact
  validator:
    findings: <int>                        # exact
    rejection_reasons: [ <reason_code> ]   # subset assertion
  ranker:
    output_size_eq_input: true | false
  publisher:
    inline_count: <int>                    # exact
    summary_count: <int>                   # exact
    dropped_count: <int>                   # exact
    publication_state: succeeded | failed_terminal
    summary_contains: [ <substring> ]      # contains, case-sensitive, no regex
    expected_categories: [ <category> ]    # for comment_usefulness; subset of categories on accepted findings

metrics:                                   # cross-ref docs/evaluation-plan.md § What we measure
  - <metric_identifier>                    # one or more of the 7 identifiers
```

## Per-scenario constrained content

For each of the 9 scenarios, the spec constrains `config_overrides`, `provider_script`, and `expectations` outcomes (and where relevant, `octokit_responses` shape). APIVR fills in the exact PR/Octokit-payload byte content; this spec binds the outcomes.

### 4.1 `security-bug`

- **`config_overrides.mode`**: `summary-plus-inline`.
- **`config_overrides.thresholds.severity_floor.inline`**: `medium`.
- **`config_overrides.thresholds.confidence_floor.inline`**: `0.7`.
- **`config_overrides.comment_cap`**: `{ per_pr: 5, per_file: 1 }` (defaults explicit).
- **`pr_payload.action`**: `opened`.
- **`octokit_responses.pulls_list_files`**: at least one TypeScript file (e.g., `src/db/queries.ts`) whose `patch` includes a SQL-injection-shaped change. No prior comments or check runs.
- **`provider_script`**: exactly one call returning `kind: output` with one finding: `category: security`, `severity: high`, `confidence: 0.92`, `path` matching the file above, `line` within a touched hunk, non-empty `message` and `rationale`.
- **`expectations.prefilter.outcome`**: `accepted`.
- **`expectations.prefilter.files_sent_to_provider`**: `1`.
- **`expectations.provider.calls`**: `1`.
- **`expectations.validator.findings`**: `1`.
- **`expectations.validator.rejection_reasons`**: `[]`.
- **`expectations.ranker.output_size_eq_input`**: `true`.
- **`expectations.publisher.inline_count`**: `1`.
- **`expectations.publisher.summary_count`**: `1` (the inline finding is also listed in the summary, marked `published inline` per `docs/publication-policy.md` § Threshold and cap application order step 6).
- **`expectations.publisher.dropped_count`**: `0`.
- **`expectations.publisher.publication_state`**: `succeeded`.
- **`expectations.publisher.summary_contains`**: `["security"]`.
- **`expectations.publisher.expected_categories`**: `["security"]`.
- **`metrics`**: `[comment_usefulness, publication_cap_behavior]`.

### 4.2 `missing-tests`

- **`config_overrides.mode`**: `summary-plus-inline`.
- **`config_overrides.thresholds.severity_floor.inline`**: `medium` (so a `medium` `tests` finding is inline-eligible).
- **`config_overrides.thresholds.confidence_floor.inline`**: `0.7`.
- **`pr_payload.action`**: `opened`.
- **`octokit_responses.pulls_list_files`**: a source file with a new exported function (e.g., `src/util/calc.ts`); no corresponding `*.test.ts` file in the diff.
- **`provider_script`**: one call, `kind: output`, one finding: `category: tests`, `severity: medium`, `confidence: 0.78`, `path: src/util/calc.ts`, line within a touched hunk.
- **`expectations.prefilter.outcome`**: `accepted`.
- **`expectations.provider.calls`**: `1`.
- **`expectations.validator.findings`**: `1`.
- **`expectations.publisher.inline_count`**: `1`.
- **`expectations.publisher.summary_count`**: `1`.
- **`expectations.publisher.dropped_count`**: `0`.
- **`expectations.publisher.publication_state`**: `succeeded`.
- **`expectations.publisher.summary_contains`**: `["tests"]`.
- **`expectations.publisher.expected_categories`**: `["tests"]`.
- **`metrics`**: `[comment_usefulness, confidence_threshold_behavior]`.

### 4.3 `risky-migration`

- **`config_overrides.mode`**: `summary-plus-inline`.
- **`config_overrides.thresholds.severity_floor.inline`**: `medium`.
- **`config_overrides.thresholds.confidence_floor.inline`**: `0.7`.
- **`pr_payload.action`**: `opened`.
- **`octokit_responses.pulls_list_files`**: a migration file (e.g., `migrations/20260501_add_index.sql` or `db/migrate/2026_05_01_add_index.rb`) with an `ALTER TABLE` or `DROP COLUMN` shape and no rollback statement.
- **`provider_script`**: one call, `kind: output`, one finding: `category: migration`, `severity: high`, `confidence: 0.85`, line within a touched hunk.
- **`expectations.prefilter.outcome`**: `accepted`.
- **`expectations.provider.calls`**: `1`.
- **`expectations.validator.findings`**: `1`.
- **`expectations.publisher.inline_count`**: `1`.
- **`expectations.publisher.summary_count`**: `1`.
- **`expectations.publisher.publication_state`**: `succeeded`.
- **`expectations.publisher.summary_contains`**: `["migration"]`.
- **`expectations.publisher.expected_categories`**: `["migration"]`.
- **`metrics`**: `[comment_usefulness, publication_cap_behavior]`.

### 4.4 `harmless-refactor`

- **`config_overrides.mode`**: `summary-plus-inline`.
- **`config_overrides.thresholds`**: defaults.
- **`pr_payload.action`**: `opened`.
- **`octokit_responses.pulls_list_files`**: a file rename plus an internal symbol rename whose semantics are unchanged.
- **`provider_script`**: one call, `kind: output`, with `findings: []` (provider correctly emits nothing).
- **`expectations.prefilter.outcome`**: `accepted`.
- **`expectations.provider.calls`**: `1`.
- **`expectations.validator.findings`**: `0`.
- **`expectations.validator.rejection_reasons`**: `[]`.
- **`expectations.publisher.inline_count`**: `0`.
- **`expectations.publisher.summary_count`**: `0`.
- **`expectations.publisher.dropped_count`**: `0`.
- **`expectations.publisher.publication_state`**: `succeeded`.
- **`expectations.publisher.summary_contains`**: `[]` (no finding-related substring required; harness allows empty array meaning "no contains assertions").
- **`expectations.publisher.expected_categories`**: `[]`.
- **`metrics`**: `[false_positive_rate]`.

### 4.5 `generated-files`

- **`config_overrides.mode`**: `summary-plus-inline`.
- **`config_overrides.exclude_generated`**: `true` (default; explicit for clarity).
- **`pr_payload.action`**: `opened`.
- **`octokit_responses.pulls_list_files`**: a single file `dist/foo.js` (or `build/bundle.js`) with non-trivial `patch`. Nothing else in the diff.
- **`provider_script`**: empty (no calls expected; the spec asserts `provider.calls == 0`). Use `provider_script: []`.
- **`expectations.prefilter.outcome`**: `all-excluded`.
- **`expectations.prefilter.skipped_paths`**: `["dist/foo.js"]`.
- **`expectations.prefilter.skipped_reasons`**: `["generated"]`.
- **`expectations.prefilter.files_sent_to_provider`**: `0`.
- **`expectations.provider.calls`**: `0`.
- **`expectations.validator.findings`**: `0`.
- **`expectations.publisher.inline_count`**: `0`.
- **`expectations.publisher.summary_count`**: `0`.
- **`expectations.publisher.dropped_count`**: `0`.
- **`expectations.publisher.publication_state`**: `succeeded`.
- **`metrics`**: `[large_diff_degradation]`.

### 4.6 `noisy-diff-with-lockfiles`

- **`config_overrides.mode`**: `summary-plus-inline`.
- **`config_overrides.exclude_generated`**: `true`.
- **`pr_payload.action`**: `opened`.
- **`octokit_responses.pulls_list_files`**: two files — `package-lock.json` (large diff) and a TypeScript source file (`src/api/users.ts`) with a small change.
- **`provider_script`**: one call. The harness asserts the `ProviderReviewInput.files` array contains only `src/api/users.ts` (lockfile excluded by prefilter). Provider returns a single finding on the source file (`category: correctness`, `severity: medium`, `confidence: 0.75`).
- **`expectations.prefilter.outcome`**: `accepted`.
- **`expectations.prefilter.skipped_paths`**: `["package-lock.json"]`.
- **`expectations.prefilter.skipped_reasons`**: `["generated"]` (lockfiles are matched by built-in generated-file detection per `docs/config-spec.md` § `exclude_generated`).
- **`expectations.prefilter.files_sent_to_provider`**: `1`.
- **`expectations.provider.calls`**: `1`.
- **`expectations.validator.findings`**: `1`.
- **`expectations.publisher.inline_count`**: `1`.
- **`expectations.publisher.summary_count`**: `1`.
- **`expectations.publisher.publication_state`**: `succeeded`.
- **`expectations.publisher.expected_categories`**: `["correctness"]`.
- **`metrics`**: `[false_positive_rate, large_diff_degradation]`.

### 4.7 `malformed-provider-output`

- **`config_overrides.mode`**: `summary-plus-inline`.
- **`pr_payload.action`**: `opened`.
- **`octokit_responses.pulls_list_files`**: any single source file with a non-trivial `patch`. The exact content is irrelevant; the provider error is what matters.
- **`provider_script`**: one call, `kind: error`, `error.kind: schema_validation`, `error.message: "ProviderReviewOutput failed Zod validation"`.
- **`expectations.prefilter.outcome`**: `accepted`.
- **`expectations.provider.calls`**: `1`.
- **`expectations.validator.findings`**: `0`.
- **`expectations.validator.rejection_reasons`**: `["provider_output_zod_failed"]`.
- **`expectations.publisher.inline_count`**: `0`.
- **`expectations.publisher.summary_count`**: `0`.
- **`expectations.publisher.dropped_count`**: `0`.
- **`expectations.publisher.publication_state`**: `failed_terminal`.
- **`expectations.publisher.summary_contains`**: `["no findings produced"]` (verbatim per `docs/data-flow.md` § Flow 4).
- **`metrics`**: `[provider_schema_failure_handling]`.

### 4.8 `duplicate-issue-across-hunks`

- **`config_overrides.mode`**: `summary-plus-inline`.
- **`config_overrides.thresholds`**: defaults (severity floor `medium`, confidence floor `0.7`).
- **`pr_payload.action`**: `opened`.
- **`octokit_responses.pulls_list_files`**: a single file (e.g., `src/lib/parse.ts`) with two separate hunks that share the same logical bug.
- **`provider_script`**: one call, `kind: output`, two findings emitted on the same file. Both must produce the SAME `dedupe_key` after validator computation — this requires the SAME `category`, the SAME normalized `title`, and `(line_start, line_end)` ranges that the validator's `dedupe_key` derivation collapses to identical values. APIVR is responsible for crafting `message` strings and line ranges such that the validator's `dedupe_key` formula (per `docs/review-findings-schema.md` § `dedupe_key`) yields the same hash for both findings.
- **`expectations.prefilter.outcome`**: `accepted`.
- **`expectations.provider.calls`**: `1`.
- **`expectations.validator.findings`**: `2` (the validator emits both; dedupe is a publisher-stage operation per `docs/publication-policy.md` § Threshold and cap application order step 2).
- **`expectations.ranker.output_size_eq_input`**: `true` (the ranker does not drop, per ranker invariant).
- **`expectations.publisher.inline_count`**: `1`.
- **`expectations.publisher.summary_count`**: `1`.
- **`expectations.publisher.dropped_count`**: `1` (the collapsed sibling).
- **`expectations.publisher.publication_state`**: `succeeded`.
- **NOTE for APIVR**: assert (via the harness's structured diff) that the dropped finding's `RejectionLogEntry.reason_code` is `dedupe_collapsed` and `stage` is `publisher`. Add the assertion as `expectations.validator.rejection_reasons: []` (validator emits both findings) and a publisher-side assertion in the harness (the spec acknowledges this requires extending the schema with a `publisher.rejection_reasons` subset assertion; APIVR adds it).
- **`expectations.publisher.summary_contains`**: `["dedupe_collapsed"]` (the summary entry for the collapsed sibling lists its rejection reason per `docs/publication-policy.md` § Threshold and cap application order step 6).
- **`metrics`**: `[duplicate_suppression]`.

> Schema extension note: APIVR adds an optional `expectations.publisher.rejection_reasons: [<reason_code>]` (subset assertion) to the schema during File 1's "Scenario YAML schema" composition, since `duplicate-issue-across-hunks` requires it. The optional field appears in both `docs/evaluation-plan.md` § Scenario YAML schema and the zod definition.

### 4.9 `oversized-pr`

- **`config_overrides.mode`**: `summary-plus-inline` (chosen so the **summary-only-regardless-of-mode** rule from `docs/publication-policy.md` § Diff too large is testable).
- **`config_overrides.max_files`**: `5` (deliberately tight so the fixture can trip it without enormous payload files).
- **`config_overrides.max_changed_lines`**: `200`.
- **`pr_payload.action`**: `opened`.
- **`octokit_responses.pulls_list_files`**: 6 source files (one above `max_files`), each with a small `patch`. Or alternatively, fewer files but with combined `additions + deletions > 200`. APIVR picks one arm and documents it in the fixture's `description`.
- **`provider_script`**: empty (`provider_script: []`); the provider must NOT be called.
- **`expectations.prefilter.outcome`**: `oversized`.
- **`expectations.prefilter.files_sent_to_provider`**: `0`.
- **`expectations.provider.calls`**: `0`.
- **`expectations.validator.findings`**: `0`.
- **`expectations.publisher.inline_count`**: `0`.
- **`expectations.publisher.summary_count`**: `0`.
- **`expectations.publisher.dropped_count`**: `0`.
- **`expectations.publisher.publication_state`**: `succeeded`.
- **`expectations.publisher.summary_contains`**: `["max_files"]` OR `["max_changed_lines"]` depending on the arm chosen by APIVR; the summary must name the limit hit per `docs/publication-policy.md` § Diff too large.
- **`metrics`**: `[large_diff_degradation]`.

## Acceptance criteria (≥ 4 GIVEN/WHEN/THEN per the file family, mechanically checkable)

1. **GIVEN** every `evals/fixtures/<id>.yaml` exists, **WHEN** the harness loads each one, **THEN** every fixture parses against the zod schema (declared in `docs/evaluation-plan.md` § Scenario YAML schema and implemented in `evals/runner/src/scenario-schema.ts`) without error.
2. **GIVEN** `evals/fixtures/security-bug.yaml` exists, **WHEN** the harness runs it, **THEN** `expectations.publisher.inline_count === 1`, `expectations.publisher.publication_state === 'succeeded'`, and the actual `PublicationResult.summary_artifact` contains the substring `security`.
3. **GIVEN** `evals/fixtures/generated-files.yaml` exists, **WHEN** the harness runs it, **THEN** `FakeProvider.calls.length === 0`, `expectations.prefilter.outcome === 'all-excluded'`, and `expectations.prefilter.skipped_paths` is a subset of the actual prefilter-skipped paths.
4. **GIVEN** `evals/fixtures/malformed-provider-output.yaml` exists, **WHEN** the harness runs it, **THEN** the validator emits a `RejectionLogEntry` with `stage = 'validator'` and `reason_code = 'provider_output_zod_failed'`, the publisher emits a Checks summary containing `no findings produced`, and `JobResult.state === 'failed_terminal'`.
5. **GIVEN** `evals/fixtures/duplicate-issue-across-hunks.yaml` exists, **WHEN** the harness runs it, **THEN** the validator emits exactly 2 `NormalizedFinding` records, the publisher's `published_inline.length === 1`, and exactly 1 finding lives in `PublicationResult.dropped` with a publisher-stage `RejectionLogEntry.reason_code === 'dedupe_collapsed'`.
6. **GIVEN** `evals/fixtures/oversized-pr.yaml` exists, **WHEN** the harness runs it, **THEN** `FakeProvider.calls.length === 0`, the prefilter's reason is `oversized`, and the publisher emits summary-only output (`inline_count === 0`) regardless of `mode = summary-plus-inline`.
7. **GIVEN** `evals/fixtures/<id>.yaml` exists, **WHEN** the harness asserts `id === basename(filename, '.yaml')`, **THEN** the assertion holds for all 9 fixtures.

## Cross-file consistency requirements

- Every `id` in fixture frontmatter equals the filename basename and equals the `id` in `evals/scenarios.yaml`.
- Every `metrics:` entry is one of the 7 metric identifiers from `docs/evaluation-plan.md` § What we measure.
- Every reason code referenced (`provider_output_zod_failed`, `dedupe_collapsed`, etc.) is one declared in `docs/review-findings-schema.md` § Rejection log entry shape.
- Every mode value is exactly one of `dry-run`, `summary-only`, `summary-plus-inline`.
- Every severity value is exactly one of `info`, `low`, `medium`, `high`, `critical`.
- Every category value is one of `security`, `correctness`, `performance`, `tests`, `style`, `migration`, `dependency` (per `docs/review-findings-schema.md` § Category vocabulary).

## Out of scope

- Exact byte content of `pr_payload`, `octokit_responses.pulls_get`, `octokit_responses.pulls_list_files[*].patch`. APIVR composes those; this spec binds outcomes only.
- Performance assertions, latency budgets, token-cost assertions. Phase 6 is correctness-only.

---

# File 5 — `evals/fixtures/<scenario-id>/` (per-scenario auxiliary payload directories)

## Purpose

Per-scenario directory holding any binary or large auxiliary payload files referenced by the YAML. Keeps the YAML file size bounded and lets large `patch` strings, multi-page `pulls_list_files` arrays, or representative diff samples live as separate files the YAML references by relative path.

## Required convention

- The directory `evals/fixtures/<id>/` is **optional** — it exists iff the YAML references at least one external payload.
- File naming convention (recommended; APIVR picks):
  - `pr_data.json` — the parsed `pr_payload` if it grows beyond ~30 lines.
  - `files.json` — the parsed `octokit_responses.pulls_list_files` array (single page) when the patches are large.
  - `prior_review_comments.json` and `prior_check_runs.json` for across-run dedupe scenarios.
- The YAML references external files via a single convention: a string value of the form `@file:<relative-path>` triggers harness-side substitution. E.g.:

  ```yaml
  octokit_responses:
    pulls_list_files: "@file:noisy-diff-with-lockfiles/files.json"
  ```

- The harness resolves `@file:...` relative to `evals/fixtures/`.

## Required content (per scenario)

- For scenarios where the in-line YAML is sufficient (small patches, <50 lines), the directory may be empty or absent.
- For `noisy-diff-with-lockfiles`, `oversized-pr`, and `malformed-provider-output`, the directory likely exists because the lockfile patch, the 6-file list, and the malformed JSON sample (respectively) are large. APIVR decides; this spec only requires that **whichever convention is used is internally consistent across the 9 fixtures**.

## Acceptance criteria (≥ 4 GIVEN/WHEN/THEN, mechanically checkable)

1. **GIVEN** any `evals/fixtures/<id>/` directory exists, **WHEN** the harness scans `evals/fixtures/<id>.yaml` for `@file:` references, **THEN** every referenced file resolves under `evals/fixtures/` and exists on disk.
2. **GIVEN** an `@file:` reference resolves to a `.json` file, **WHEN** the harness loads it, **THEN** it parses as valid JSON.
3. **GIVEN** a fixture YAML contains an `@file:` reference, **WHEN** the harness substitutes the file's parsed value, **THEN** the resulting in-memory fixture object validates against the zod scenario schema.
4. **GIVEN** an `evals/fixtures/<id>/` directory exists for some `<id>`, **WHEN** the harness runs the fixture, **THEN** the auxiliary files are referenced by the YAML (no orphan files); orphan files cause a harness warning (not a failure) and are listed in the JSON report.

## Cross-file consistency requirements

- The `@file:` resolution must happen before zod validation, so the fully-substituted object is what is validated.
- No fixture references files outside `evals/fixtures/`.

## Out of scope

- Caching, content hashing, or compression of auxiliary files. Plain JSON / plain text only.

---

## Cross-cutting consistency-check pass (run before Phase 6 exit)

The following checks must all pass before Phase 6 is considered complete. Run in order:

1. `make test` exits 0 with the pre-existing 210 tests + any harness-internal tests APIVR added all green.
2. `make eval` exits 0 with all 9 scenarios reporting PASS.
3. `evals/scenarios.yaml` has exactly 9 entries; the IDs match the canonical list in this spec; every `fixture` path resolves to a file on disk.
4. Every fixture YAML's `id` field equals the basename of its filename without extension.
5. Every fixture's `metrics:` list contains only members of the 7 frozen metric identifiers.
6. Every fixture references mode/severity/category values from the closed vocabularies in `docs/product-spec.md`, `docs/review-findings-schema.md`, and `docs/config-spec.md`.
7. `docs/evaluation-plan.md` § Scenario taxonomy table has exactly 9 rows in the canonical order.
8. `evals/README.md` § Scenario index table has exactly 9 rows in the canonical order.
9. No file in `evals/` or `docs/_planning/` references `pnpm` or `node` as a direct command (only `make` targets).
10. The Phase 1–5 anchor identifiers (`ProviderReviewInput`, `ProviderReviewOutput`, `NormalizedFinding`, `RankedFindings`, `PublicationResult`, mode names, pipeline stage names) appear byte-equivalent in every Phase 6 file that references them.

---

## Phase 6 exit gate (testable restatement)

- `make test` exits 0 with **210 + N** existing tests green (N = harness-internal tests APIVR added; 0 if APIVR adds none).
- `make eval` exits 0 with **9** scenarios reporting PASS.
- `docs/evaluation-plan.md`, `evals/README.md`, `evals/scenarios.yaml`, and 9 `evals/fixtures/<id>.yaml` files all exist.
- The CI workflow runs `make test` then `make eval` and blocks merge on either failing.
- `docs/open-questions.md` § Resolution log has been updated for OQ-7 (per the recommended disposition above) by IDG; OQ-9 has the one-line append-only Phase 6 review note appended in § Open questions.

---

## Machine-readable acceptance criteria (YAML)

```yaml
phase: 6
scenarios_canonical_order:
  - security-bug
  - missing-tests
  - risky-migration
  - harmless-refactor
  - generated-files
  - noisy-diff-with-lockfiles
  - malformed-provider-output
  - duplicate-issue-across-hunks
  - oversized-pr

metrics_frozen:
  - false_positive_rate
  - duplicate_suppression
  - comment_usefulness
  - large_diff_degradation
  - provider_schema_failure_handling
  - confidence_threshold_behavior
  - publication_cap_behavior

oq_dispositions:
  OQ-7:
    recommendation: resolve
    target_section: "docs/open-questions.md § Resolution log"
    rationale: "Phase 6 harness validates our pipeline at the architectural layer the desk review used."
  OQ-9:
    recommendation: defer
    target_section: "docs/open-questions.md § Open questions (append-only Phase 6 review note)"
    rationale: "No Phase 6 scenario surfaces snapshotter patch truncation at the schema boundary."

files:
  "docs/evaluation-plan.md":
    purpose: "Phase 6 methodology — IDG composes prose."
    required_sections:
      - "# Evaluation Plan — Phase 6"
      - "## Goals and non-goals"
      - "## What we measure"
      - "## How we measure"
      - "## Scenario taxonomy"
      - "## Scenario YAML schema"
      - "## Pass/fail rules"
      - "## How to run locally"
      - "## CI integration"
      - "## Future work / out of scope"
    acceptance:
      - id: AC-EP-1
        given: "docs/evaluation-plan.md exists"
        when: "reader greps for 'prefilter → provider → validator → ranker → publication cap'"
        then: "exact byte-equivalent string appears at least once"
      - id: AC-EP-2
        given: "docs/evaluation-plan.md exists"
        when: "reader counts entries in § Scenario taxonomy"
        then: "exactly 9 rows in the canonical order"
      - id: AC-EP-3
        given: "docs/evaluation-plan.md exists"
        when: "reader counts metric sub-headings under § What we measure"
        then: "exactly 7 metrics with the frozen identifiers"
      - id: AC-EP-4
        given: "docs/evaluation-plan.md exists"
        when: "reader greps run-command blocks"
        then: "every command starts with 'make eval' and there is no 'pnpm test', 'node ./evals', or 'npx vitest'"
      - id: AC-EP-5
        given: "docs/evaluation-plan.md exists"
        when: "reader inspects § Future work / out of scope"
        then: "document explicitly names Phase 7, manual qualitative review, and multi-provider comparison as out of scope"

  "evals/README.md":
    purpose: "Operator-facing readme; replaces Phase 4 stub."
    required_sections:
      - "# Evaluation Suite"
      - "## Purpose"
      - "## How to run"
      - "## Scenario index"
      - "## Adding a new scenario"
      - "## CI"
    acceptance:
      - id: AC-RM-1
        given: "evals/README.md exists"
        when: "reader counts rows in § Scenario index table"
        then: "exactly 9 rows whose id column matches the canonical order"
      - id: AC-RM-2
        given: "evals/README.md exists"
        when: "reader greps for 'pnpm', 'npx ', or 'node ./'"
        then: "zero matches"
      - id: AC-RM-3
        given: "evals/README.md exists"
        when: "reader greps for 'make eval'"
        then: "string appears at least 4 times"
      - id: AC-RM-4
        given: "evals/README.md exists"
        when: "reader inspects § Adding a new scenario"
        then: "steps include adding the scenario to both evals/scenarios.yaml and docs/evaluation-plan.md § Scenario taxonomy"

  "evals/scenarios.yaml":
    purpose: "Index of all 9 scenarios; loaded first by the harness."
    required_shape:
      top_level_key: scenarios
      entry_required_fields: [id, name, fixture, tags]
    acceptance:
      - id: AC-SC-1
        given: "evals/scenarios.yaml exists"
        when: "harness loads it"
        then: "parses without error and contains exactly 9 entries"
      - id: AC-SC-2
        given: "evals/scenarios.yaml exists"
        when: "harness extracts id of each entry in order"
        then: "result equals the canonical scenarios_canonical_order array"
      - id: AC-SC-3
        given: "evals/scenarios.yaml exists"
        when: "harness reads each fixture path"
        then: "every referenced path exists on disk and ends with .yaml"
      - id: AC-SC-4
        given: "evals/scenarios.yaml exists"
        when: "harness validates each entry"
        then: "every entry has all four required fields, tags is a non-empty string array, and id == basename(fixture, '.yaml')"

  "evals/fixtures/<scenario-id>.yaml":
    purpose: "Per-scenario binding fixture (9 files)."
    schema_required_top_level_fields: [id, name, description, config_overrides, pr_payload, octokit_responses, provider_script, expectations, metrics]
    schema_strict: true
    schema_extension_note: "expectations.publisher.rejection_reasons (optional, subset assertion) added during Phase 6 to support duplicate-issue-across-hunks"
    per_scenario_outcomes:
      security-bug:
        mode: summary-plus-inline
        provider_calls: 1
        validator_findings: 1
        inline_count: 1
        summary_count: 1
        dropped_count: 0
        publication_state: succeeded
        summary_contains: ["security"]
        metrics: [comment_usefulness, publication_cap_behavior]
      missing-tests:
        mode: summary-plus-inline
        provider_calls: 1
        validator_findings: 1
        inline_count: 1
        summary_count: 1
        dropped_count: 0
        publication_state: succeeded
        summary_contains: ["tests"]
        metrics: [comment_usefulness, confidence_threshold_behavior]
      risky-migration:
        mode: summary-plus-inline
        provider_calls: 1
        validator_findings: 1
        inline_count: 1
        summary_count: 1
        dropped_count: 0
        publication_state: succeeded
        summary_contains: ["migration"]
        metrics: [comment_usefulness, publication_cap_behavior]
      harmless-refactor:
        mode: summary-plus-inline
        provider_calls: 1
        validator_findings: 0
        inline_count: 0
        summary_count: 0
        dropped_count: 0
        publication_state: succeeded
        summary_contains: []
        metrics: [false_positive_rate]
      generated-files:
        mode: summary-plus-inline
        prefilter_outcome: all-excluded
        provider_calls: 0
        validator_findings: 0
        inline_count: 0
        summary_count: 0
        dropped_count: 0
        publication_state: succeeded
        skipped_reasons: [generated]
        metrics: [large_diff_degradation]
      noisy-diff-with-lockfiles:
        mode: summary-plus-inline
        prefilter_outcome: accepted
        files_sent_to_provider: 1
        provider_calls: 1
        validator_findings: 1
        inline_count: 1
        summary_count: 1
        publication_state: succeeded
        skipped_reasons: [generated]
        metrics: [false_positive_rate, large_diff_degradation]
      malformed-provider-output:
        mode: summary-plus-inline
        provider_calls: 1
        validator_findings: 0
        validator_rejection_reasons: [provider_output_zod_failed]
        inline_count: 0
        summary_count: 0
        dropped_count: 0
        publication_state: failed_terminal
        summary_contains: ["no findings produced"]
        metrics: [provider_schema_failure_handling]
      duplicate-issue-across-hunks:
        mode: summary-plus-inline
        provider_calls: 1
        validator_findings: 2
        ranker_output_size_eq_input: true
        inline_count: 1
        summary_count: 1
        dropped_count: 1
        publisher_rejection_reasons: [dedupe_collapsed]
        publication_state: succeeded
        summary_contains: ["dedupe_collapsed"]
        metrics: [duplicate_suppression]
      oversized-pr:
        mode: summary-plus-inline
        prefilter_outcome: oversized
        files_sent_to_provider: 0
        provider_calls: 0
        validator_findings: 0
        inline_count: 0
        summary_count: 0
        dropped_count: 0
        publication_state: succeeded
        summary_contains_one_of: ["max_files", "max_changed_lines"]
        metrics: [large_diff_degradation]
    acceptance:
      - id: AC-FX-1
        given: "every evals/fixtures/<id>.yaml exists"
        when: "harness loads each one"
        then: "every fixture parses against the zod schema without error"
      - id: AC-FX-2
        given: "evals/fixtures/security-bug.yaml exists"
        when: "harness runs it"
        then: "publisher.inline_count === 1, publication_state === 'succeeded', summary_artifact contains 'security'"
      - id: AC-FX-3
        given: "evals/fixtures/generated-files.yaml exists"
        when: "harness runs it"
        then: "FakeProvider.calls.length === 0, prefilter outcome === 'all-excluded', skipped_paths is subset of actual"
      - id: AC-FX-4
        given: "evals/fixtures/malformed-provider-output.yaml exists"
        when: "harness runs it"
        then: "validator emits RejectionLogEntry with stage='validator' and reason_code='provider_output_zod_failed', summary contains 'no findings produced', JobResult.state === 'failed_terminal'"
      - id: AC-FX-5
        given: "evals/fixtures/duplicate-issue-across-hunks.yaml exists"
        when: "harness runs it"
        then: "validator emits 2 NormalizedFinding records, published_inline.length === 1, dropped contains 1 finding with publisher-stage RejectionLogEntry.reason_code === 'dedupe_collapsed'"
      - id: AC-FX-6
        given: "evals/fixtures/oversized-pr.yaml exists"
        when: "harness runs it"
        then: "FakeProvider.calls.length === 0, prefilter reason === 'oversized', publisher emits summary-only output regardless of mode === 'summary-plus-inline'"
      - id: AC-FX-7
        given: "evals/fixtures/<id>.yaml exists"
        when: "harness asserts id === basename(filename, '.yaml')"
        then: "assertion holds for all 9 fixtures"

  "evals/fixtures/<scenario-id>/":
    purpose: "Optional auxiliary payload directories; one per scenario where YAML inlining is impractical."
    convention:
      reference_syntax: "@file:<relative-path>"
      resolution_root: "evals/fixtures/"
      resolution_order: "before zod validation"
    acceptance:
      - id: AC-AUX-1
        given: "any evals/fixtures/<id>/ directory exists"
        when: "harness scans <id>.yaml for @file: references"
        then: "every referenced file resolves under evals/fixtures/ and exists on disk"
      - id: AC-AUX-2
        given: "an @file: reference resolves to a .json file"
        when: "harness loads it"
        then: "parses as valid JSON"
      - id: AC-AUX-3
        given: "a fixture YAML contains @file: references"
        when: "harness substitutes them"
        then: "resulting in-memory fixture validates against the zod scenario schema"
      - id: AC-AUX-4
        given: "an evals/fixtures/<id>/ directory exists"
        when: "harness runs the fixture"
        then: "auxiliary files are referenced by the YAML; orphan files cause a warning (not a failure) and are listed in the JSON report"

exit_gate:
  - "make test exits 0 with 210 + N tests green"
  - "make eval exits 0 with 9 scenarios PASS"
  - "evals/scenarios.yaml parses with exactly 9 entries in canonical order"
  - "all 9 evals/fixtures/<id>.yaml files exist and validate against the zod schema"
  - "docs/evaluation-plan.md exists with 10 required sections in order, 9-row taxonomy, 7 frozen metrics"
  - "evals/README.md exists with 6 required sections in order, 9-row index"
  - "CI workflow runs make test then make eval and blocks merge on either failing"
  - "docs/open-questions.md § Resolution log updated for OQ-7; OQ-9 has Phase 6 review note appended"

acceptance_criteria_count:
  evaluation_plan: 5
  readme: 4
  scenarios_yaml: 4
  fixture_yaml_family: 7
  fixture_aux_dirs: 4
  total: 24
```
