# Data Flow

## Conventions

- Flows are described as ordered numbered steps. ASCII diagrams are permitted as supplements but are not required.
- Each step names the component touching it using the path string from `system-design.md` § Component map and the schema produced or consumed.
- Each step that emits a structured log identifies the event name from `observability.md` § Event taxonomy by exact string. Event names invented in this document but not present in `observability.md` § Event taxonomy are not permitted.
- Each flow ends with a single line stating the terminal `JobResult.state` (per `api-contracts.md` § Async job contract — `succeeded`, `failed_terminal`, `discarded_idempotent`) and the highest-level span that closes.
- Trace span names and the parent-child structure are defined in `observability.md` § Span hierarchy. Span names referenced in the flows below are exactly: `http.webhook`, `queue.enqueue`, `worker.job`, `pipeline.config_load`, `pipeline.snapshotter`, `pipeline.prefilter`, `pipeline.provider`, `pipeline.validator`, `pipeline.ranker`, `pipeline.publisher`.
- Mode names appear with identical casing across all flows: `dry-run`, `summary-only`, `summary-plus-inline`.
- The redaction allowlist is the single source of truth on what may leave the process; this document references `observability.md` § Redaction allowlist without redefining it.
- The five flows below collectively reference every event named in `observability.md` § Event taxonomy: `webhook.received`, `webhook.signature_failed`, `job.enqueued`, `job.started`, `prefilter.skipped`, `prefilter.accepted`, `provider.called`, `provider.error`, `validator.rejected`, `ranker.dropped`, `publisher.published`, `publisher.dropped`, `job.terminal`.

## Flow 1 — Happy path

A PR is opened or synchronized; `.github/review-bot.yml` does not disable the App; the prefilter accepts the diff; the provider returns a valid `ProviderReviewOutput`; the publisher creates a Checks run and (when `mode = summary-plus-inline`) inline review comments.

1. GitHub delivers a `pull_request.opened` webhook to `apps/github-app/webhook-ingress`. The ingress span `http.webhook` opens. `apps/github-app/webhook-ingress` constructs a `WebhookIngressRequest` and emits `webhook.received`.
2. `apps/github-app/webhook-ingress` verifies `X-Hub-Signature-256` against the webhook secret read from `SecretSource`. Verification succeeds. (If verification had failed, `apps/github-app/webhook-ingress` would emit `webhook.signature_failed` and return `4xx` without enqueue; that branch is detailed in Flow 5 Case 5a.)
3. `apps/github-app/webhook-ingress` calls `deriveIdempotencyKey` (per `api-contracts.md` § Webhook ingress contract) over `X-GitHub-Delivery` and `(installation_id, repository_id, pull_request_number, head_sha)`.
4. The child span `queue.enqueue` opens. `apps/github-app/webhook-ingress` enqueues a `JobPayload` (with the Phase 3 additive `traceparent` field carrying the `http.webhook` context) onto the BullMQ `pr-review` queue. The ingress emits `job.enqueued`. `queue.enqueue` closes.
5. `apps/github-app/webhook-ingress` returns a `WebhookIngressResponse` with status `2xx` and code `accepted`. `http.webhook` closes.
6. The BullMQ worker picks up the `JobPayload`. The worker reads `traceparent` and opens `worker.job` linked to the ingress's `http.webhook` parent. The worker emits `job.started`.
7. `pipeline.config_load` opens. `packages/config/config-loader` resolves effective configuration from `.github/review-bot.yml` on the head ref; `pipeline.config_load` closes.
8. `packages/github/installation-auth` mints an installation token via `getInstallationToken(installation_id)`.
9. `pipeline.snapshotter` opens. `packages/core/snapshotter` fetches the diff for `(installation_id, repository_id, pull_request_number, head_sha)` and produces a `DiffSnapshot`. `pipeline.snapshotter` closes.
10. `pipeline.prefilter` opens. `packages/core/prefilter` produces a `ProviderReviewInput`; the prefilter emits `prefilter.accepted` with `file_count`, `hunk_count`, `total_changed_lines`. `pipeline.prefilter` closes.
11. `pipeline.provider` opens. `packages/providers/anthropic` invokes `Provider.review(ProviderReviewInput)` and emits `provider.called` with `provider_id`, `model`, `input_token_estimate`, `attempt`. The adapter returns a `ProviderReviewOutput`, Zod-validated at the adapter boundary. `pipeline.provider` closes.
12. `pipeline.validator` opens (the structural completion signal for the validator stage). `packages/core/validator-ranker` runs `validate(output, ctx)` and produces a `NormalizedFinding[]` plus any `RejectionLogEntry` records with `stage = 'validator'`. In the happy path no findings are dropped, so no `validator.rejected` event is emitted. `pipeline.validator` closes.
13. `pipeline.ranker` opens (the structural completion signal for the ranker stage). `packages/core/validator-ranker` runs `rank(findings, policy)` and produces `RankedFindings`. The ranker does not drop findings; if it emits an informational `RejectionLogEntry` (e.g., a tie-break note), `ranker.dropped` carries that entry. In the happy path no `ranker.dropped` is emitted. `pipeline.ranker` closes.
14. `pipeline.publisher` opens. The publisher applies `PublicationPolicy` (per `publication-policy.md` § Threshold and cap application order — the publication cap stage). `packages/github/check-runs` creates the Checks run with conclusion `success` (or `neutral` if no findings cleared the floors); when `mode = summary-plus-inline` and inline-eligible findings remain after the caps, `packages/github/review-comments` creates line-anchored review comments. The publisher emits `publisher.published` with `mode`, `inline_count`, `summary_count`, `dropped_count`, `checks_run_id`, and emits `publisher.dropped` (with a `RejectionLogEntry`) per finding excluded by caps or floors. The publisher returns a `PublicationResult`. `pipeline.publisher` closes.
15. `packages/shared/audit-log` writes the terminal job record. The worker emits `job.terminal` with `state = 'succeeded'`, `failure_reason_code = null`, `duration_ms`. `worker.job` closes.

**Event sequence (in order):** `webhook.received`, `job.enqueued`, `job.started`, `prefilter.accepted`, `provider.called`, `publisher.published`, `job.terminal`. (`validator.rejected`, `ranker.dropped`, and `publisher.dropped` are emitted only when there are per-finding drops or informational entries.)

**Pipeline stage order (verbatim):** prefilter → provider → validator → ranker → publication cap.

**Terminal state:** `succeeded`. **Highest-level span that closes last:** `worker.job`.

## Flow 2 — Oversized-diff fast-path

A PR exceeds the configured size limits; `packages/core/prefilter` short-circuits before any provider call.

1. `apps/github-app/webhook-ingress` receives the webhook. `http.webhook` opens. `webhook.received` is emitted.
2. Signature verification succeeds; `deriveIdempotencyKey` produces a key.
3. `queue.enqueue` opens; the `JobPayload` is enqueued onto `pr-review`. `job.enqueued` is emitted. `queue.enqueue` closes; `http.webhook` closes after the `2xx` response.
4. The worker picks up the job. `worker.job` opens; `job.started` is emitted.
5. `pipeline.config_load` opens and closes (config resolved from `.github/review-bot.yml`); `pipeline.snapshotter` opens and closes (`DiffSnapshot` produced).
6. `pipeline.prefilter` opens. `packages/core/prefilter` detects that the diff exceeds `max_files` or `max_changed_lines` (defined in `config-spec.md` § `max_files` and § `max_changed_lines`). The prefilter emits `prefilter.skipped` with `reason = 'oversized'`, `file_count`, `changed_lines`. The prefilter returns `{ input: null, reason: 'oversized' }`. `pipeline.prefilter` closes.
7. `pipeline.provider` **does not open**. The provider is not called; no `provider.called` event is emitted.
8. `pipeline.publisher` opens. The publisher emits a summary-only Checks run regardless of the configured `mode` (per `publication-policy.md` § Diff too large). The Checks summary names the limit hit (`max_files`, `max_changed_lines`, or both) and lists the affected paths in aggregate; no per-finding rendering is produced because there are no findings. No inline comments are created even if `mode = summary-plus-inline`. The publisher emits `publisher.published` with `mode = 'summary-only'`, `inline_count = 0`, `summary_count = 0`, `dropped_count = 0`. `pipeline.publisher` closes.
9. The worker emits `job.terminal` with `state = 'succeeded'`. `worker.job` closes.

**Event sequence (in order):** `webhook.received`, `job.enqueued`, `job.started`, `prefilter.skipped`, `publisher.published`, `job.terminal`.

**Terminal state:** `succeeded`. **Highest-level span that closes last:** `worker.job`. The provider span `pipeline.provider` never opens.

## Flow 3 — Provider failure

The provider returns a non-transient `ProviderError` (`auth` or `capability`), or transient retries (`transport`, `rate_limit`) are exhausted.

1. `apps/github-app/webhook-ingress` receives the webhook. `http.webhook` opens. `webhook.received` is emitted.
2. Signature verification succeeds; `deriveIdempotencyKey` produces a key. `queue.enqueue` opens, the `JobPayload` is enqueued, `job.enqueued` is emitted, `queue.enqueue` closes, `http.webhook` closes.
3. The worker picks up the job; `worker.job` opens; `job.started` is emitted.
4. `pipeline.config_load`, `pipeline.snapshotter`, `pipeline.prefilter` open and close in turn. `prefilter.accepted` is emitted; a `ProviderReviewInput` is produced.
5. `pipeline.provider` opens. `packages/providers/anthropic` invokes `Provider.review(ProviderReviewInput)`; `provider.called` is emitted with `attempt = 1`. The provider throws `ProviderError`.
   - **Non-transient case** (`variant = 'auth'` or `variant = 'capability'`). `provider.error` is emitted with `variant`, `attempt = 1`, `retry_class = 'non_transient'`. Per the **Non-transient** retry class defined in `system-design.md` § Error taxonomy mapping, no retry is attempted. `pipeline.provider` closes.
   - **Transient case** (`variant = 'transport'`). `provider.error` is emitted with `retry_class = 'transient'`. The worker retries with bounded exponential backoff (`RETRY_TRANSIENT_MAX_ATTEMPTS`, base `RETRY_TRANSIENT_BACKOFF_BASE_MS`, cap `RETRY_TRANSIENT_BACKOFF_MAX_MS`); each retry emits a fresh `provider.called` with the next `attempt` value and, on failure, a fresh `provider.error`. After the final attempt fails, the loop exits. `pipeline.provider` closes.
   - **Rate-limited case** (`variant = 'rate_limit'`). `provider.error` is emitted with `retry_class = 'rate_limited'`. The worker retries honoring `Retry-After` up to `RETRY_RATELIMIT_MAX_ATTEMPTS`; each retry emits `provider.called` and on failure `provider.error`. After the final attempt fails, the loop exits. `pipeline.provider` closes.
6. `pipeline.publisher` opens. The publisher emits a Checks run with `neutral` conclusion and a brief category-only failure body containing the phrase **"review unavailable"**. No inline comments are created. `publisher.published` is emitted with `mode = 'summary-only'` (forced for the failure surface), `inline_count = 0`, `summary_count = 0`, `dropped_count = 0`. `pipeline.publisher` closes.
7. The worker emits `job.terminal` with `state = 'failed_terminal'` and `failure_reason_code` set to the offending `ProviderError` variant (`auth`, `capability`, `transport`, or `rate_limit`). `worker.job` closes.

**Event sequence (in order):** `webhook.received`, `job.enqueued`, `job.started`, `prefilter.accepted`, `provider.called`, `provider.error` (one or more, per retry class), `publisher.published`, `job.terminal`.

**Terminal state:** `failed_terminal`. **Highest-level span that closes last:** `worker.job`.

## Flow 4 — Malformed provider output

The provider returns a response that fails Zod validation at the adapter boundary (`ProviderError.schema_validation`).

1. `apps/github-app/webhook-ingress` receives the webhook; `http.webhook` opens; `webhook.received`, signature verify, `deriveIdempotencyKey`, `queue.enqueue`, `job.enqueued`, `2xx` response, `http.webhook` closes.
2. `worker.job` opens; `job.started` is emitted.
3. `pipeline.config_load`, `pipeline.snapshotter`, `pipeline.prefilter` open and close. `prefilter.accepted` is emitted; a `ProviderReviewInput` is produced.
4. `pipeline.provider` opens. `packages/providers/anthropic` invokes `Provider.review(ProviderReviewInput)`; `provider.called` is emitted. The wire response fails the `ProviderReviewOutput` Zod schema at the adapter boundary; the adapter throws `ProviderError` with `variant = 'schema_validation'`. The adapter is the only place a vendor-shaped raw body is observed; the raw body is not forwarded. `pipeline.provider` closes.
5. `pipeline.validator` opens (the validator stage records the rejection even though the adapter raised it; this is the **drop-with-audit-log** policy). `packages/core/validator-ranker` emits `validator.rejected` carrying a `RejectionLogEntry` with `stage = 'validator'`, `reason_code = 'provider_output_zod_failed'`, `reason_message`, `provider_output_excerpt` (already redacted at the source per `review-findings-schema.md` § Rejection log entry shape — credential-bearing content is stripped), `timestamp`. The entire provider response is dropped; partially valid output is not silently kept (per `publication-policy.md` § Malformed `ProviderReviewOutput`). `pipeline.validator` closes.
6. `pipeline.publisher` opens. The publisher emits a Checks run with `neutral` conclusion and a Markdown summary body containing the phrase **"no findings produced"**. No inline comments are created. `publisher.published` is emitted with `mode = 'summary-only'`, `inline_count = 0`, `summary_count = 0`, `dropped_count = 0`. `pipeline.publisher` closes.
7. The worker emits `job.terminal` with `state = 'failed_terminal'`, `failure_reason_code = 'provider_output_zod_failed'`. `worker.job` closes.

**Event sequence (in order):** `webhook.received`, `job.enqueued`, `job.started`, `prefilter.accepted`, `provider.called`, `validator.rejected`, `publisher.published`, `job.terminal`.

**Terminal state:** `failed_terminal`. **Highest-level span that closes last:** `worker.job`.

## Flow 5 — Re-run on synchronize (dedupe across runs)

The App receives a `pull_request.synchronize` for a PR it previously reviewed. Two sub-cases.

### Case 5a — Duplicate delivery (same `idempotency_key` and same `head_sha`)

GitHub redelivers the same delivery (or a delivery whose `(installation_id, repository_id, pull_request_number, head_sha)` resolves to an `idempotency_key` already present in the per-installation replay-window cache).

1. `apps/github-app/webhook-ingress` receives the webhook; `http.webhook` opens; `webhook.received` is emitted. (If signature verification had failed, the ingress would instead emit `webhook.signature_failed` and return `4xx` per `api-contracts.md` § Webhook ingress contract; that branch is recorded here as the alternate first-step exit and is out of scope for the rest of Case 5a.)
2. Signature verification succeeds; `deriveIdempotencyKey` produces a key matching one already cached for this installation within the `INSTALLATION_REPLAY_WINDOW_SECONDS` window (or a BullMQ job id that already has an active or completed job).
3. The ingress short-circuits enqueue; the queue is not re-enqueued. The ingress returns `2xx` with code `accepted` (the body's job state resolves to `discarded_idempotent` in the async layer per `api-contracts.md` § Webhook ingress contract). `http.webhook` closes.
4. The async resolution emits `job.terminal` with `state = 'discarded_idempotent'`, `failure_reason_code = null`. **No `provider.called` event is emitted; `pipeline.provider` does not open.**

**Event sequence:** `webhook.received` (or `webhook.signature_failed` on the alternate first-step exit), `job.terminal`.

**Terminal state:** `discarded_idempotent`.

### Case 5b — New `head_sha`

The PR head moved; the `idempotency_key` differs (it incorporates `head_sha`). The pipeline re-runs end-to-end.

1. The pipeline runs as in Flow 1 from steps 1–13.
2. At the publisher, `pipeline.publisher` opens. The publisher consults the per-PR already-published dedupe set sourced from the **GitHub Checks/Review-Comments history of this App on this PR** (per `publication-policy.md` § Dedupe behavior). Any candidate inline finding whose `dedupe_key` is present in that set is dropped with a `RejectionLogEntry` whose `reason_code = 'dedupe_collapsed'` (across-run dedupe). Findings whose line is no longer in the diff have already been dropped at the validator stage (per `publication-policy.md` § Re-run behavior on synchronize). `publisher.dropped` is emitted per dropped finding; `publisher.published` is emitted once with the surviving counts. `pipeline.publisher` closes.
3. The worker emits `job.terminal` with `state = 'succeeded'`. `worker.job` closes. Stale inline comments are not edited or deleted by the publisher in MVP (per `publication-policy.md` § Re-run behavior on synchronize).

**Event sequence (in order):** `webhook.received`, `job.enqueued`, `job.started`, `prefilter.accepted`, `provider.called`, `publisher.dropped` (one per across-run dedupe collapse), `publisher.published`, `job.terminal`.

**Terminal state:** `succeeded`.

## Data-at-rest boundaries

What the App persists, what it never persists, and what its logs may contain. The redaction allowlist that governs log emission lives in `observability.md` § Redaction allowlist; this section references it without redefining it.

1. **Persisted.**
   - Normalized findings — the `NormalizedFinding` records the publisher kept and published (the `published_inline` and `published_summary` arrays of `PublicationResult`). These are persisted to the App's audit store.
   - The audit log — structured `RejectionLogEntry` records (validator-, ranker-, and publisher-emitted) and terminal job records carrying `JobResult` shape.
   - The per-installation idempotency-key state record (per `api-contracts.md` § Async job contract) — used to resolve duplicate deliveries to `discarded_idempotent`.
   - The per-installation `X-GitHub-Delivery` replay-window cache, sized by `INSTALLATION_REPLAY_WINDOW_SECONDS`.
2. **Never persisted.**
   - Raw `ProviderReviewOutput` — only the validated, normalized findings persist; the raw response is discarded after Zod validation at the adapter boundary.
   - Repo file bodies — the snapshotter holds them only in worker memory for the duration of a job.
   - Raw diff content beyond what the validator's `evidence` field references (the `evidence` strings are persisted as part of `NormalizedFinding`; the surrounding diff body is not).
   - Installation tokens — minted at job execution time per `api-contracts.md` § Async job contract; not stored.
   - The GitHub App private key — read from `SecretSource` per call; never written to disk by the App.
   - Webhook secrets and provider API keys — read from `SecretSource`; never written to disk by the App.
3. **Logs.**
   - Logs contain redacted log events only, against the allowlist defined in `observability.md` § Redaction allowlist. Diff content, repo file bodies, and provider raw output are stripped at emission time by the redactor (`packages/shared/audit-log`); the redactor is fail-closed for secret-shaped values.
