# Publication Policy

## Inputs and outputs

The publisher consumes `RankedFindings` (the ranker's output, defined in `api-contracts.md` § Ranker contract) plus `PublicationPolicy` (the resolved-config view defined in `api-contracts.md` § Publisher contract) plus `PublishContext` (defined in `api-contracts.md` § Publisher contract). It emits `PublicationResult`, defined in `api-contracts.md` § Publisher contract. The schema chain `ProviderReviewOutput` → `NormalizedFinding` → `RankedFindings` → `PublicationResult` is named identically across files.

This document specifies the deterministic ruleset the publisher applies. It does not redefine schemas, configuration keys, or pipeline contracts.

## Defaults (per OQ-2)

The OQ-2 defaults, declared in `config-spec.md` § Key reference and reused here without redeclaration:

- `comment_cap.per_pr` = 5
- `comment_cap.per_file` = 1
- `severity_floor.inline` = `medium`
- `confidence_floor.inline` = 0.7
- Default `mode` for newly installed repos is `dry-run`.

Override semantics live in `config-spec.md` § Resolution order; this document does not redefine them.

## Mode behavior

### dry-run

- **What is published.** Nothing PR-visible. `RankedFindings` and `RejectionLogEntry[]` are emitted to the structured log only. A single Checks run with `neutral` conclusion and a body of "dry-run; no findings published" is acceptable as an attribution surface; no inline comments are created and no findings-bearing summary is rendered.
- **Where (Checks summary / inline review comment / both / neither).** Neither.
- **Severity floor applied.** `severity_floor.inline` from policy is computed for audit (so the structured log contains the eligibility decision per finding) but not enforced as a publication gate, because nothing is published.
- **Confidence floor applied.** `confidence_floor.inline` from policy is computed for audit but not enforced as a publication gate.
- **Per-PR cap applied.** `comment_cap.per_pr` is computed for audit but not enforced.
- **Per-file cap applied.** `comment_cap.per_file` is computed for audit but not enforced.
- **Dedupe behavior reference.** See § Dedupe behavior. Dedupe is computed (within-run and across-run) and recorded in the structured log so a debugger can confirm what would have been suppressed in a publishing mode.

### summary-only

- **What is published.** A Checks run with a Markdown summary. The summary lists findings whose `severity ≥ severity_floor.inline` and whose `confidence ≥ confidence_floor.inline`. The full `RankedFindings` (including findings under either floor) appears in the structured log.
- **Where (Checks summary / inline review comment / both / neither).** Checks summary only. No inline review comments are created regardless of cap state.
- **Severity floor applied.** `severity_floor.inline` gates summary inclusion in this mode.
- **Confidence floor applied.** `confidence_floor.inline` gates summary inclusion in this mode.
- **Per-PR cap applied.** `comment_cap.per_pr` is computed for audit only; it does not gate summary entries (the cap exists to bound inline comments).
- **Per-file cap applied.** `comment_cap.per_file` is computed for audit only; it does not gate summary entries.
- **Dedupe behavior reference.** See § Dedupe behavior. Within-run dedupe collapses identical `dedupe_key` findings before the summary is rendered.

### summary-plus-inline

- **What is published.** Both a Checks run summary and inline review comments. Inline candidates are findings whose `severity ≥ severity_floor.inline` AND `confidence ≥ confidence_floor.inline`. Findings excluded by caps remain in the summary with a reason annotation referencing their `RejectionLogEntry`.
- **Where (Checks summary / inline review comment / both / neither).** Both.
- **Severity floor applied.** `severity_floor.inline` gates both inline eligibility and summary inclusion.
- **Confidence floor applied.** `confidence_floor.inline` gates both inline eligibility and summary inclusion.
- **Per-PR cap applied.** `comment_cap.per_pr` is enforced against inline-eligible findings in ranker order, after the per-file cap.
- **Per-file cap applied.** `comment_cap.per_file` is enforced first against inline-eligible findings in ranker order, before the per-PR cap.
- **Dedupe behavior reference.** See § Dedupe behavior. Both within-run and across-run dedupe apply.

## Threshold and cap application order

The publisher applies thresholds and caps in this exact order. Steps later in the list operate on the output of earlier steps.

1. **Compute eligibility.** For each finding in `RankedFindings`, compute:
   - Inline-eligible: `severity ≥ severity_floor.inline` AND `confidence ≥ confidence_floor.inline`.
   - Summary-eligible (in `summary-only`): `severity ≥ severity_floor.inline` AND `confidence ≥ confidence_floor.inline`.
   - Summary-eligible (in `summary-plus-inline`): the union of inline-eligible findings and any other findings the publisher chooses to surface in the summary; in MVP the union equals the inline-eligibility set, so summary-eligible equals inline-eligible.
   Findings under either floor receive a `RejectionLogEntry` with `stage = 'publisher'` and `reason_code` of `severity_below_floor` or `confidence_below_floor`.
2. **Apply dedupe.** Drop any finding whose `dedupe_key` was already published as an inline comment on this PR (across-run dedupe). Within the current ranked list, collapse multiple findings with the same `dedupe_key` into a single representative — the highest-`confidence` finding, with ties broken by ranker order. Collapsed siblings receive a `RejectionLogEntry` with `reason_code = 'dedupe_collapsed'`.
3. **Apply `comment_cap.per_file`.** Walk the inline-eligible set in ranker order. For each file, accept up to `comment_cap.per_file` inline candidates; mark the rest as overflow with `reason_code = 'per_file_cap_exhausted'`.
4. **Apply `comment_cap.per_pr`.** Walk the survivors in ranker order. Accept up to `comment_cap.per_pr` inline candidates; mark the rest as overflow with `reason_code = 'per_pr_cap_exhausted'`.
5. **Move overflow into the summary list.** Findings excluded by caps (steps 3 and 4) have `render_target = summary` set on the `NormalizedFinding`, and their `RejectionLogEntry` records are produced with `stage = 'publisher'` and the appropriate `reason_code`. They are not lost; they appear in the Checks summary.
6. **Render the Checks summary.** For each finding included in the summary, the rendered entry indicates whether it is `published inline`, `dropped from inline due to caps` (with the `reason_code`), or `below floors` (with the relevant floor name).

## Dedupe behavior

`dedupe_key` is computed by the validator and is defined in `review-findings-schema.md` § `dedupe_key`. This document does not redefine the field; it specifies the publisher's use of it.

Dedupe is applied at two scopes:

- **Within the current run.** When the ranked list contains more than one finding sharing a `dedupe_key`, the publisher collapses them to a single representative — the highest-`confidence` finding, with ties broken by ranker order. Collapsed siblings receive a `RejectionLogEntry` with `stage = 'publisher'` and `reason_code = 'dedupe_collapsed'`.
- **Across runs.** Any `dedupe_key` already published as an inline comment on this PR is not re-published. The prior comment is considered authoritative.

The "already published" set is sourced from the GitHub Checks/Review-Comments history of this App on this PR. The publisher consults that history by querying the Checks runs and inline review comments authored by the App's identity for the current PR. Implementation (caching, query shape, ETag handling) is Phase 4; this document names the source.

On `pull_request.synchronize`, across-run dedupe ensures that a finding still valid on the new head is not duplicated. A finding no longer valid (its line is no longer in the diff) is dropped at the validator stage with `stage = 'validator'`, not by the publisher.

## Fallbacks

### Malformed ProviderReviewOutput

When `ProviderReviewOutput` fails Zod validation at the adapter boundary, no `NormalizedFinding` is emitted for that PR. The job terminates with `failed_terminal`. The publisher emits a Checks run with `neutral` conclusion and a Markdown summary explaining the failure category — category names only, no provider error detail beyond a redacted excerpt. A `RejectionLogEntry` with `stage = 'validator'` (or, when the failure is at the adapter boundary itself, `stage = 'validator'` with `reason_code = 'provider_output_zod_failed'` referencing the adapter-side rejection) is written to the structured log.

The policy is **drop with audit log**, never downgrade. Partially valid provider output is not silently kept; the entire output is rejected if it fails Zod validation.

### Diff too large

When the prefilter detects that the PR exceeds `max_files` or `max_changed_lines` (defined in `config-spec.md` § `max_files` and § `max_changed_lines`) AND also exceeds the chunkable ceiling (`chunking.max_files` / `chunking.max_changed_lines`, or `chunking.enabled = false`), the prefilter short-circuits before any provider call. No `ProviderReviewOutput` is requested.

The publisher emits **summary-only output regardless of the configured `mode`**. The summary states which limit was hit (`max_files` or `max_changed_lines` or both) and lists the affected paths in aggregate (no per-finding inline comments, no per-finding rendering — there are no findings). No inline comments are created even if the configured `mode` is `summary-plus-inline`.

The same oversized path applies when greedy bin-packing would need more provider calls than `chunking.max_provider_calls_per_pr`. The Checks summary states the required call count and the current cap value.

### Diff too large — chunked review

When the prefilter detects that the PR exceeds `max_files` / `max_changed_lines` but fits within the chunkable ceiling (`chunking.max_files` / `chunking.max_changed_lines`) and `chunking.enabled = true`, the pipeline performs a chunked review:

1. Files are sorted by path (deterministic order) and packed into batches using a greedy algorithm bounded by `chunking.call_token_budget` per batch.
2. Each batch is sent as an independent provider call.
3. All batch findings are merged into a single `ProviderReviewOutput` **before** the validator runs.
4. The existing validator → ranker → publisher chain runs once on the merged findings.

The result is a `review_complete_chunked` pipeline outcome. The Checks summary includes a preamble notice: "Reviewed in N section(s) (large PR)." Dedupe, ranking, and per-PR caps apply to the full merged finding set — not per batch.

### Partial review

When some (but not all) batches in a chunked review return a `schema_validation` error, those batches are dropped and the review continues with the remaining findings. The outcome is still `review_complete_chunked` and the Checks summary preamble is extended with: "M of N section(s) could not be analyzed and were skipped."

If all batches fail `schema_validation`, the pipeline routes to the existing `malformed_provider_output` path — no partial summary is published.

Files whose individual token estimate exceeds the hard safety cap (≈110,000 tokens) are excluded from all batches. If any files are skipped for this reason, the Checks summary preamble includes: "K file(s) were too large to analyze individually and were skipped."

`auth` and `capability` errors in any batch abort the entire chunked review and route to `review_unavailable`. `transport` and `rate_limit` errors abort the loop and re-throw so the BullMQ job is retried from scratch (partial-publish-then-retry would cause double-publication).

### Provider error (non-transient)

When the provider returns a non-transient `ProviderError` — `auth`, `capability`, or `schema_validation` — the job ends `failed_terminal`. The publisher emits a Checks run with `neutral` conclusion and a brief category-only failure message ("provider authentication failure", "provider capability missing", "provider output failed validation"). No inline comments are created. A `RejectionLogEntry` with `stage = 'validator'` (for `schema_validation`) or with `stage = 'publisher'` and the appropriate `reason_code` (for `auth` and `capability`, which are surfaced through the publisher's failure path) is written.

## Re-run behavior on synchronize

The accepted webhook events are `pull_request.opened`, `pull_request.synchronize`, `pull_request.reopened`, matching `api-contracts.md` § Webhook ingress contract. Re-run behavior on `pull_request.synchronize`:

- The pipeline re-runs end-to-end: `prefilter → provider → validator → ranker → publication cap` against the new `head_sha`.
- The publisher consults the per-PR "already published" dedupe set sourced from the App's prior Checks runs and inline review comments on this PR. Any candidate inline finding whose `dedupe_key` is already present in that set is not re-published.
- Findings that disappear from the new diff (their line is no longer touched, or their file was reverted) are dropped at the validator stage, not by the publisher.
- Stale inline comments are not edited or deleted by the publisher in MVP. Reviewers and PR authors may see App comments anchored to lines that are no longer in the diff; cleanup is post-MVP.
- The Checks summary is updated (or replaced) for the latest run; prior summaries are not retroactively edited.

## Worked example

Given `12` valid `NormalizedFinding` entries surfaced by the ranker on a single PR, with `mode = summary-plus-inline`, the OQ-2 defaults applied (`severity_floor.inline = medium`, `confidence_floor.inline = 0.7`, `comment_cap.per_file = 1`, `comment_cap.per_pr = 5`), all `12` findings have `severity ≥ medium` and `confidence ≥ 0.7`, and the ranker order produces a per-file distribution with multiple findings on some files. Suppose, for concreteness, the ranker order is:

| Rank | Finding id | Path | Severity | Confidence |
| --- | --- | --- | --- | --- |
| 1 | F-01 | `src/payments/charge.ts` | high | 0.92 |
| 2 | F-02 | `src/payments/charge.ts` | high | 0.88 |
| 3 | F-03 | `src/auth/session.ts` | high | 0.86 |
| 4 | F-04 | `src/cart/coupon.ts` | medium | 0.84 |
| 5 | F-05 | `src/cart/coupon.ts` | medium | 0.82 |
| 6 | F-06 | `src/api/router.ts` | medium | 0.80 |
| 7 | F-07 | `src/api/router.ts` | medium | 0.78 |
| 8 | F-08 | `src/db/migrate.ts` | medium | 0.77 |
| 9 | F-09 | `src/db/migrate.ts` | medium | 0.76 |
| 10 | F-10 | `src/auth/session.ts` | medium | 0.75 |
| 11 | F-11 | `src/payments/charge.ts` | medium | 0.74 |
| 12 | F-12 | `src/api/router.ts` | medium | 0.72 |

The publisher applies the threshold and cap application order:

1. **Compute eligibility.** All `12` findings pass both floors (every `severity ≥ medium`, every `confidence ≥ 0.7`); all are inline-eligible.
2. **Apply dedupe.** Assume no `dedupe_key` collisions and no prior publications on this PR; all `12` findings survive.
3. **Apply `comment_cap.per_file = 1`.** Walking ranker order, accept the first finding per file; mark subsequent findings on the same file as overflow with `reason_code = per_file_cap_exhausted`:
   - Rank 1, F-01 (`src/payments/charge.ts`) — accepted.
   - Rank 2, F-02 (`src/payments/charge.ts`) — overflow (`per_file_cap_exhausted`).
   - Rank 3, F-03 (`src/auth/session.ts`) — accepted.
   - Rank 4, F-04 (`src/cart/coupon.ts`) — accepted.
   - Rank 5, F-05 (`src/cart/coupon.ts`) — overflow (`per_file_cap_exhausted`).
   - Rank 6, F-06 (`src/api/router.ts`) — accepted.
   - Rank 7, F-07 (`src/api/router.ts`) — overflow (`per_file_cap_exhausted`).
   - Rank 8, F-08 (`src/db/migrate.ts`) — accepted.
   - Rank 9, F-09 (`src/db/migrate.ts`) — overflow (`per_file_cap_exhausted`).
   - Rank 10, F-10 (`src/auth/session.ts`) — overflow (`per_file_cap_exhausted`).
   - Rank 11, F-11 (`src/payments/charge.ts`) — overflow (`per_file_cap_exhausted`).
   - Rank 12, F-12 (`src/api/router.ts`) — overflow (`per_file_cap_exhausted`).
   After step 3: `5` survivors (F-01, F-03, F-04, F-06, F-08), `7` overflow with `per_file_cap_exhausted`.
4. **Apply `comment_cap.per_pr = 5`.** Walking the survivors in ranker order: accept up to `5`. Survivors count is exactly `5`, so all `5` are accepted. No additional overflow is produced at this step. (Arithmetic: `5 ≤ 5`, so `5 − 5 = 0` further overflows.)
5. **Move overflow into the summary list.** The `7` overflow findings from step 3 (F-02, F-05, F-07, F-09, F-10, F-11, F-12) have `render_target = summary` set; their `RejectionLogEntry` records have `stage = 'publisher'` and `reason_code = 'per_file_cap_exhausted'`.
6. **Render the Checks summary.** The summary lists all `12` findings:
   - `5` are marked `published inline`: F-01, F-03, F-04, F-06, F-08.
   - `7` are marked with their `RejectionLogEntry` reason codes:
     - F-02 — `per_file_cap_exhausted`
     - F-05 — `per_file_cap_exhausted`
     - F-07 — `per_file_cap_exhausted`
     - F-09 — `per_file_cap_exhausted`
     - F-10 — `per_file_cap_exhausted`
     - F-11 — `per_file_cap_exhausted`
     - F-12 — `per_file_cap_exhausted`

Arithmetic summary: `12` valid findings → eligibility filter passes `12` → dedupe passes `12` → per-file cap accepts `5` and overflows `12 − 5 = 7` → per-PR cap accepts `5` (no further overflow because `5 ≤ 5`). Final result: exactly `5` published inline, `12` listed in the summary, `7` labeled with `per_file_cap_exhausted` (and `0` labeled with `per_pr_cap_exhausted` in this particular distribution; under a different distribution where more than `5` survivors emerge from step 3, the surplus beyond `5` would be labeled `per_pr_cap_exhausted` at step 4). The literal counts `12` and `5` are the input and inline-publication numbers respectively.
