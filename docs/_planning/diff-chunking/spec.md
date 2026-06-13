# Diff Chunking — Design Record

> Concise design record per the feature spec. Supplements `scout-report.md`.

## Problem

PRs larger than a single provider-call context window were permanently
hard-skipped as `oversized`. This prevented review of medium-to-large PRs that
are technically within the model's capability if batched.

## Solution summary

When a PR's kept-file set exceeds the single-call limits but stays within the
chunkable ceiling, the pipeline:

1. Batches the `PrefilteredFile[]` across multiple provider calls.
2. Merges all batch findings into a single `ProviderReviewOutput` **before** the
   validator.
3. Runs the existing validator → ranker → publisher chain once.

The result is transparent to the downstream pipeline: dedupe, ranking, and
per-PR caps apply to the full PR, not individual batches.

---

## Tiered limits

Three tiers govern large-PR routing:

| Tier | Condition | Outcome |
|---|---|---|
| Single-call | `kept ≤ max_files` AND `lines ≤ max_changed_lines` | `accepted` — one provider call (unchanged) |
| Chunkable | Above single-call limits AND `kept ≤ chunking.max_files` AND `lines ≤ chunking.max_changed_lines` AND `chunking.enabled` | `chunkable` — multi-call batch loop |
| Oversized | Above chunkable ceiling OR (`chunking.enabled=false` AND above single-call) | `oversized` — summary-only skip |

An additional cost guard applies within the chunkable tier: if `planBatches`
needs more than `chunking.max_provider_calls_per_pr` batches → oversized skip
with an explanatory notice.

---

## Batcher algorithm

**Pure function:** `planBatches(files, { callTokenBudget, maxCalls }) → PlanBatchesResult`

1. **Sort** files ascending by path (determinism — same input → same batches).
2. **Estimate** per-file tokens: `Σ(hunk.content.length) / 4`, falling back to
   `Σ(hunk.line_end − hunk.line_start + 1)` when all content strings are empty.
   Mirrors the `augmentation/index.ts:36` estimator pattern.
3. **Greedy pack**: accumulate files into the current batch until the next file
   would exceed `callTokenBudget`; then open a new batch.
4. **Lone-oversized-file rule**: a file whose estimate alone exceeds `callTokenBudget`
   gets its OWN batch (sent alone — the model's real window may still accept it).
5. **Hard safety cap** (`HARD_SAFETY_CAP_TOKENS = 110,000`): a file whose estimate
   exceeds this goes into `skippedFiles` and is excluded from all batches. This
   prevents a guaranteed context-overflow on the largest available models.
6. If `batches.length > maxCalls`, set `overCap: true`.

**No-file-split invariant**: a `PrefilteredFile` is never split across batches.
This preserves per-file dedupe key assumptions (the dedupe key is `(path,
normalized-message)`) and the per-file comment cap.

---

## Merge-before-validator rationale

The `dedupe_key` is `sha256(path + ":" + canonicalize(message)).slice(0, 16)`
(validator/index.ts) — **batch-agnostic**. Two batches surfacing the same issue
produce the same key. Merging all batch findings into one `ProviderReviewOutput`
before `runValidator` gives cross-batch dedup for free (the existing
`applyDedupe` in `planner.ts` handles it). This also ensures:

- `runValidator` validates all findings against the **full snapshot** (not just
  the batch subset), so a finding referencing any path in the real diff is valid.
- `runRanker` produces one globally-sorted ranked list.
- `planPublication` / `publish` run once: caps apply to the whole PR.

**Do NOT** validate/rank/publish per batch — this would double-publish and
break per-PR caps.

---

## Partial-failure policy

Error handling per batch:

| Error kind | Action |
|---|---|
| `schema_validation` | Drop that batch's findings; continue; set partial flag. |
| `auth` / `capability` | Abort loop; publish `review_unavailable` notice; re-throw (terminal). |
| `transport` / `rate_limit` | Abort loop; re-throw so BullMQ retries all batches. Partial-publish-then-retry would double-publish. |

If **all** batches fail `schema_validation` → route to the existing
`malformed_provider_output` path.

If **some** batches fail `schema_validation` → `review_complete_chunked` with
`failed_batches: [...]` and a partial review notice prepended to the check-run
summary via the v0.7.0 `notice` mechanism.

---

## New outcomes and notices

### `review_complete_chunked`

New `PipelineOutcome` variant. Detail: `{ batch_count, failed_batches, skipped_files }`.

### Notices (check-run preamble)

All notices use the existing `notice` param threading: `runPipeline` →
`publishSummaryOnly` → `publish` → `planPublication` → `renderSummary`.
No new publisher wiring.

| Scenario | Notice text (approximate) |
|---|---|
| Normal chunked | "Reviewed in N section(s) (large PR)." |
| Partial (some batches failed) | "…M of N sections couldn't be analyzed and were skipped." appended. |
| Files skipped for size | "K file(s) skipped (too large to analyze): …" appended. |
| overCap | "Review skipped — this PR is too large to review even in sections (would need N provider calls; cap is `chunking.max_provider_calls_per_pr=M`). Split the PR or raise `chunking.max_provider_calls_per_pr` in `.github/review-bot.yml`." |

### Worker reply

`handleCommentJob` branches on `review_complete_chunked`:
"Reviewed your large PR in N section(s). [partial/skipped notes] Check the AI
Code Review check run for results."

---

## Observability events (new)

| Event | Fields |
|---|---|
| `chunking.planned` | `batch_count`, `est_total_tokens`, `skipped_files` |
| `provider.batch.called` | `batch_index`, `batch_count`, `files_in_batch`, `provider` |
| `provider.batch.output` | `batch_index`, `batch_count`, `findings_count` |
| `provider.batch.error` | `batch_index`, `batch_count`, `kind`, `provider`, `message` |

---

## Config defaults summary

```yaml
chunking:
  enabled: true
  max_files: 200            # chunkable ceiling (above → oversized)
  max_changed_lines: 12000  # chunkable ceiling (above → oversized)
  max_provider_calls_per_pr: 6   # cost guard
  call_token_budget: 60000  # per-call input token budget
```

Existing `max_files: 50` and `max_changed_lines: 2000` remain as the
single-call threshold (unchanged behavior for PRs within those limits).
