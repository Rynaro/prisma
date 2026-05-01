# Review Findings Schema — `NormalizedFinding`

## Purpose and position in the pipeline

`NormalizedFinding` is the output of the validator stage in the pipeline `prefilter → provider → validator → ranker → publication cap` (per ADR-003 § Pipeline shape). It is the input of the ranker and the publisher. It is **strictly richer** than `ProviderReviewOutput` (the schema defined in ADR-002): it carries audit fields that the provider does not produce (`id`, `evidence`, `render_target`, `source_artifacts_used`, `dedupe_key`, `validator_notes`). Every downstream stage reads `NormalizedFinding`; no downstream stage reads `ProviderReviewOutput` directly.

This document defines the schema by name, field-by-field, and specifies the rejection log entry shape (`RejectionLogEntry`) that the validator, ranker, and publisher emit when they drop or block a finding.

## Schema name and identity

The schema is named `NormalizedFinding`. It is a Phase 2 schema identifier; full Zod implementation lands in Phase 4.

Other schema identifiers introduced in Phase 2 and referenced by this document:

- `RankedFindings` — the ranker's output. An ordered list of `NormalizedFinding`. Defined in `api-contracts.md` § Ranker contract.
- `PublicationResult` — the publisher's output. Defined in `api-contracts.md` § Publisher contract.
- `RejectionLogEntry` — defined below in § Rejection log entry shape and reused by `api-contracts.md` (validator/ranker/publisher contracts) and by `publication-policy.md` (fallbacks and worked example).

Identifiers reused verbatim from Phase 1: `ProviderReviewInput`, `ProviderReviewOutput`, `ProviderError`, `ProviderCapabilities`. None of these is aliased.

## Field reference

### id

- **Type.** String (UUID, content-addressed hash, or other stable identifier).
- **Allowed values / range.** Non-empty; unique within the PR processing run.
- **Required.** Required.
- **Validation rule (plain English).** Non-empty string. Stable across re-runs for the same content (i.e., the same finding produced from the same diff content yields the same `id`); the validator computes it.
- **Audit purpose.** Ties a finding to its rejection log entry (`RejectionLogEntry.finding_id`) and to the publisher's per-finding inline-comment dedupe state.

### path

- **Type.** String.
- **Allowed values / range.** Repository-root-relative path.
- **Required.** Required.
- **Validation rule (plain English).** Must reference a path present in the prefiltered diff context. The validator rejects findings whose `path` is not in the diff.
- **Audit purpose.** Anchor for inline comment placement; provenance to a touched file.

### line_start

- **Type.** Integer.
- **Allowed values / range.** Positive integer; 1-indexed.
- **Required.** Required.
- **Validation rule (plain English).** Must fall within a touched hunk in the prefiltered diff for `path`. The validator rejects findings whose `line_start` is outside any touched hunk.
- **Audit purpose.** Structural-soundness check; required to anchor inline comments.

### line_end

- **Type.** Integer.
- **Allowed values / range.** Positive integer; 1-indexed; ≥ `line_start`.
- **Required.** Required.
- **Validation rule (plain English).** Must satisfy `line_end >= line_start` and must fall within a touched hunk in the prefiltered diff for `path`. Equal to `line_start` when the finding is single-line.
- **Audit purpose.** Same as `line_start`; defines the inclusive line range the finding covers.

### category

- **Type.** String enum.
- **Allowed values / range.** Member of the category vocabulary defined in § Category vocabulary.
- **Required.** Required.
- **Validation rule (plain English).** Must be one of the closed-vocabulary values; otherwise the finding is rejected.
- **Audit purpose.** Drives the ranker's category weighting and per-category configuration in `config-spec.md` (`categories_enabled`, `severity`).

### severity

- **Type.** String enum.
- **Allowed values / range.** Member of the severity vocabulary defined in § Severity vocabulary.
- **Required.** Required.
- **Validation rule (plain English).** Must be one of `info`, `low`, `medium`, `high`, `critical`; otherwise the finding is rejected.
- **Audit purpose.** Drives the publisher's `severity_floor.inline` enforcement.

### confidence

- **Type.** Number.
- **Allowed values / range.** Finite number in `[0,1]`.
- **Required.** Required.
- **Validation rule (plain English).** Must be a finite number in `[0,1]`. Provider-reported. The validator does not gate on `confidence`; the publisher applies `confidence_floor.inline` later.
- **Audit purpose.** Ranker signal and inline-eligibility input for the publisher.

### title

- **Type.** String.
- **Allowed values / range.** Non-empty string; length cap declared by Phase 4.
- **Required.** Required.
- **Validation rule (plain English).** Non-empty. Length cap declared by Phase 4.
- **Audit purpose.** Short rendered headline used in inline comments and Checks summary entries.

### explanation

- **Type.** String.
- **Allowed values / range.** Non-empty.
- **Required.** Required.
- **Validation rule (plain English).** Non-empty. The model's narrative, post-validation; the validator does not edit it but may reject the finding if other fields fail.
- **Audit purpose.** Rendered body of an inline comment or summary entry.

### suggested_fix

- **Type.** String.
- **Allowed values / range.** Non-empty when present.
- **Required.** Optional.
- **Validation rule (plain English).** When present, non-empty. Does not imply autofix (an explicit non-goal); the App never opens follow-up PRs or applies the fix.
- **Audit purpose.** Improves actionability for the PR author without crossing the autofix non-goal.

### evidence

- **Type.** Array of strings (file:line snippets or symbol references).
- **Allowed values / range.** Non-empty array; every entry references content in the prefiltered diff context.
- **Required.** Required.
- **Validation rule (plain English).** Non-empty. Every entry must reference content present in the prefiltered diff context (the validator extracts and verifies these references). A finding without verifiable evidence is rejected.
- **Audit purpose.** Traceability — proves the finding is grounded in the diff, not invented.

### render_target

- **Type.** String enum.
- **Allowed values / range.** One of `inline`, `summary`, `dropped` (see § Render target vocabulary).
- **Required.** Required.
- **Validation rule (plain English).** Must be one of the three vocabulary values. Initially set by the validator to `summary`; the ranker may revise to `inline` for inline-eligible findings; the publisher may revise to `summary` or `dropped` when caps push items out.
- **Audit purpose.** Explicit publication intent for each finding.

### source_artifacts_used

- **Type.** Array of strings.
- **Allowed values / range.** Identifiers of prefiltered hunks, files, or `repo_heuristics` signals that contributed to producing this finding.
- **Required.** Required.
- **Validation rule (plain English).** Non-empty. Every entry must identify a real artifact in the validator context (e.g., a hunk id, a file id, a heuristic flag name).
- **Audit purpose.** Provenance: lets a debugger trace which input artifacts produced this finding.

### dedupe_key

- **Type.** String.
- **Allowed values / range.** Non-empty deterministic string.
- **Required.** Required.
- **Validation rule (plain English).** Deterministic hash derived from `path`, `line_start`, `line_end`, `category`, and a normalized form of `title` (or a content fingerprint). Equal across runs for findings the publisher should consider "the same".
- **Audit purpose.** The key the publisher consults to suppress duplicates within a run, across runs, and across webhook redeliveries (per `publication-policy.md` § Dedupe behavior).

### validator_notes

- **Type.** Array of strings.
- **Allowed values / range.** Non-empty entries when present.
- **Required.** Optional.
- **Validation rule (plain English).** When present, every entry is a non-empty string. Validator-emitted commentary (e.g., "evidence references hunk H3").
- **Audit purpose.** Explains validator decisions in the structured log without changing the finding's user-visible content.

## Vocabularies

### Severity vocabulary

The severity vocabulary is a closed, ordered list, ascending in severity:

1. `info`
2. `low`
3. `medium`
4. `high`
5. `critical`

Comparisons such as "`severity ≥ medium`" use this ordering. The list is closed: no other values are accepted by the schema.

### Category vocabulary

The category vocabulary is a closed list (Phase 2 may extend it; removals are not permitted in Phase 2):

- `security`
- `correctness`
- `performance`
- `tests`
- `style`
- `migration`
- `dependency`

Any addition to this list must also appear in `config-spec.md` § `categories_enabled` validation rule.

### Render target vocabulary

The render target vocabulary is a closed list:

- `inline` — the publisher will create an inline review comment for this finding.
- `summary` — the finding appears only in the Checks summary, not as an inline comment.
- `dropped` — the finding survived validation but did not reach publication (e.g., dedupe collapsed it; cap excluded it).

## Mapping from `ProviderReviewOutput` to `NormalizedFinding`

The validator constructs each `NormalizedFinding` from a single `ProviderReviewOutput` finding plus context derived from the prefilter. The mapping is:

| `NormalizedFinding` field | Source |
| --- | --- |
| `id` | Added by the validator. No `ProviderReviewOutput` source. |
| `path` | Carried from `ProviderReviewOutput.path`. |
| `line_start` | Derived from `ProviderReviewOutput.line` (single line) or the start of the provider-reported line range. |
| `line_end` | Derived from `ProviderReviewOutput.line` (single line — equal to `line_start`) or the end of the provider-reported line range. |
| `category` | Carried from `ProviderReviewOutput.category`. |
| `severity` | Carried from `ProviderReviewOutput.severity`. |
| `confidence` | Carried from `ProviderReviewOutput.confidence`. |
| `title` | Derived from `ProviderReviewOutput.message`. |
| `explanation` | Derived from `ProviderReviewOutput.rationale`. |
| `suggested_fix` | Carried from `ProviderReviewOutput.suggested_fix` when the provider returns one; otherwise absent. |
| `evidence` | Added by the validator from the prefiltered diff context. No `ProviderReviewOutput` source. |
| `render_target` | Added by the validator (initial value `summary`); the ranker and publisher may revise. No `ProviderReviewOutput` source. |
| `source_artifacts_used` | Added by the validator. No `ProviderReviewOutput` source. |
| `dedupe_key` | Added by the validator. No `ProviderReviewOutput` source. |
| `validator_notes` | Added by the validator. No `ProviderReviewOutput` source. |

`NormalizedFinding` is therefore strictly richer than `ProviderReviewOutput`: every provider field is reflected, and six additional audit fields (`id`, `evidence`, `render_target`, `source_artifacts_used`, `dedupe_key`, `validator_notes`) are added. No provider field is required only on the provider side.

## Rejection log entry shape

`RejectionLogEntry` is the structured-log shape emitted whenever the validator, ranker, or publisher drops a finding (or rejects an upstream output that fails to produce a finding). It is consumed by `api-contracts.md` (the validator, ranker, and publisher contracts each emit a list of these) and by `publication-policy.md` (worked example and fallbacks).

Fields:

- `finding_id` — string or `null`. The `id` of the dropped `NormalizedFinding`. `null` when the finding had not yet been assigned an `id` (e.g., a `ProviderReviewOutput` finding rejected at the validator's structural check before `id` assignment).
- `stage` — string enum. One of `validator`, `ranker`, `publisher`. The pipeline stage that emitted the entry.
- `reason_code` — short stable string. Examples: `path_not_in_diff`, `line_outside_hunk`, `evidence_unverifiable`, `per_file_cap_exhausted`, `per_pr_cap_exhausted`, `confidence_below_floor`, `severity_below_floor`, `dedupe_collapsed`, `provider_output_zod_failed`. The stable code is the field a debugger pivots on; the human-readable explanation is in `reason_message`.
- `reason_message` — string. Human-readable explanation suitable for log review.
- `provider_output_excerpt` — string. A short excerpt of the underlying provider output (or the offending portion thereof), redacted of any credential-bearing content. The redaction discipline is the structured-logging discipline declared in `mvp-scope.md` § Observability and logging; the sink is OQ-3 and not chosen here.
- `timestamp` — string. ISO-8601 timestamp.

## Examples

The following examples are non-normative; they illustrate field shapes only.

### Example A — `NormalizedFinding` published inline

A finding that survives all gates and is published as an inline review comment in `summary-plus-inline` mode:

```
NormalizedFinding {
  id: "f8b1e2c4-9a01-4d31-8f3a-1e2b3c4d5e6f",
  path: "src/payments/charge.ts",
  line_start: 142,
  line_end: 144,
  category: "security",
  severity: "high",
  confidence: 0.86,
  title: "Unbounded user input passed into SQL builder",
  explanation: "The string in `req.body.query` is interpolated into the SQL builder's `where()` argument without parameterization. This is reachable from the public route handler defined in this file's hunk H2 and bypasses the parameterization helper used elsewhere in this module.",
  suggested_fix: "Pass `req.body.query` as a bound parameter to `where('?', value)` rather than interpolating it.",
  evidence: [
    "src/payments/charge.ts:142-144",
    "src/payments/charge.ts:118 (helper `paramQuery` defined)"
  ],
  render_target: "inline",
  source_artifacts_used: ["hunk:H2", "file:src/payments/charge.ts", "heuristic:security"],
  dedupe_key: "sha256:1a2b3c...payments-charge-142-144-security-unbounded-input",
  validator_notes: ["evidence references hunk H2 and a sibling definition at line 118"]
}
```

### Example B — `NormalizedFinding` dropped by the publisher; paired `RejectionLogEntry`

A finding that survives validation and ranking but is excluded by the per-PR cap:

```
NormalizedFinding {
  id: "a7c2d6e1-3b04-4ee0-9f12-7d8e9a0b1c2d",
  path: "src/cart/coupon.ts",
  line_start: 88,
  line_end: 88,
  category: "correctness",
  severity: "medium",
  confidence: 0.74,
  title: "Off-by-one in expiry comparison",
  explanation: "The `<=` should be `<` for an exclusive expiry boundary; the boundary handling in `applyCoupon` returns the wrong result on the exact-expiry second.",
  evidence: [
    "src/cart/coupon.ts:88",
    "src/cart/coupon.ts:71-79 (definition of expiry semantics)"
  ],
  render_target: "dropped",
  source_artifacts_used: ["hunk:H4", "file:src/cart/coupon.ts"],
  dedupe_key: "sha256:9e8d7c...cart-coupon-88-correctness-off-by-one",
  validator_notes: ["confidence above floor; severity above floor; dropped by publisher"]
}

RejectionLogEntry {
  finding_id: "a7c2d6e1-3b04-4ee0-9f12-7d8e9a0b1c2d",
  stage: "publisher",
  reason_code: "per_pr_cap_exhausted",
  reason_message: "Per-PR cap of 5 inline comments was reached before this finding's rank position; the finding is published in the Checks summary only.",
  provider_output_excerpt: "[redacted excerpt of provider output for finding rank #6]",
  timestamp: "2026-04-30T17:03:21Z"
}
```
