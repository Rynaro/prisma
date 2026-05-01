# Observability

## Resolution of OQ-3 (recap)

OQ-3 — the choice of structured-logging backend / observability sink and the redaction policy at that boundary — is resolved as a vendor-neutral, OpenTelemetry-first design. Logs are emitted as structured JSON to stdout, one event per line, with a fixed top-level field set defined in § Top-level fields below; no log shipping is built into the App, and the deployment platform handles collection. Metrics and traces are produced by the OpenTelemetry SDK in-process and exported via OTLP/HTTP to an operator-supplied collector endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT`); no observability vendor is pinned. Sampling is parent-based with head-sample default `1.0` for the MVP, configurable via `OTEL_TRACES_SAMPLER_ARG`. An emission-time redactor strips disallowed payload (diff content, repo file bodies, provider raw output) against an explicit allowlist; only schema-derived fields and counts are exported. The redactor is fail-closed for installation tokens, webhook secrets, and provider API keys: if a secret-shaped value appears in a payload position, the entire event is dropped and counted.

This resolution closes the structured-logging concerns raised in `mvp-scope.md` § Observability and logging and the secret-leakage residual risk from `threat-model.md` § Mitigation matrix and § Residual risk and deferred items. It binds the validator, ranker, and publisher contracts in `api-contracts.md` (which emit `RejectionLogEntry` records by name) and the structured-log references in `publication-policy.md` to a concrete, vendor-neutral export path.

## Logs

### Top-level fields

Every structured log event carries the following top-level fields, in this exact order:

1. `ts` — UTC ISO-8601 timestamp.
2. `level` — one of `debug`, `info`, `warn`, `error`.
3. `service` — string; matches the value of `OTEL_SERVICE_NAME`.
4. `event` — string; the event name from § Event taxonomy.
5. `trace_id` — OpenTelemetry trace id (hex).
6. `span_id` — OpenTelemetry span id (hex).
7. `installation_id` — numeric GitHub installation id.
8. `repository_id` — numeric GitHub repository id.
9. `pull_request_number` — integer.
10. `idempotency_key` — output of `deriveIdempotencyKey`.
11. `payload` — object carrying the event-specific fields named in § Event taxonomy.

Fields not in this list and not on the redaction allowlist (§ Redaction allowlist) are dropped at emission time. This ordering is the only authoritative ordering; `system-design.md` § Cross-cutting concerns § Structured logging fields forward-references this section.

### Event taxonomy

Every event the App emits is defined exactly once in this table. Other Phase 3 documents reference these names verbatim; no document may invent an event name not present here.

| event name | trigger | fields beyond base | redaction notes | terminal? |
| --- | --- | --- | --- | --- |
| `webhook.received` | HTTP request arrives at `apps/github-app/webhook-ingress`. | `event_type` (the GitHub event name from `X-GitHub-Event`), `delivery_id` (the `X-GitHub-Delivery` header value). | The `X-Hub-Signature-256` header value is never logged; the raw body is never logged. | no |
| `webhook.signature_failed` | HMAC-SHA-256 verification of `X-Hub-Signature-256` fails. | `event_type`, `delivery_id`. | The signature itself is never logged; the raw body is never logged. | no |
| `job.enqueued` | `deriveIdempotencyKey` produces a key and the BullMQ queue accepts the `JobPayload`. | `head_sha`. | None beyond base. | no |
| `job.started` | The BullMQ worker picks up the job and begins the pipeline. | `head_sha`. | None beyond base. | no |
| `prefilter.skipped` | `packages/core/prefilter` short-circuits with `reason = 'oversized'` or `reason = 'all-excluded'`. | `reason` (`oversized` \| `all-excluded`), `file_count`, `changed_lines`. | File paths are allowed; file contents are never logged. | no |
| `prefilter.accepted` | `packages/core/prefilter` produces a `ProviderReviewInput`. | `file_count`, `hunk_count`, `total_changed_lines`. | Counts only; no diff content. | no |
| `provider.called` | `Provider.review` is invoked by `packages/providers/anthropic`. | `provider_id` (e.g., `anthropic`), `model`, `input_token_estimate`, `attempt`. | The `ProviderReviewInput` body is never logged; only counts and shape. | no |
| `provider.error` | `Provider.review` throws `ProviderError`. | `provider_id`, `variant` (`transport` \| `auth` \| `rate_limit` \| `capability` \| `schema_validation`), `attempt`, `retry_class` (`transient` \| `rate_limited` \| `non_transient`). | The provider API key is never logged; the provider raw response body is never logged. | no (unless retries exhausted, in which case `job.terminal` follows) |
| `validator.rejected` | `packages/core/validator-ranker` drops a finding or rejects the entire `ProviderReviewOutput`. | `RejectionLogEntry` shape inline (`finding_id`, `stage = 'validator'`, `reason_code` ∈ `{path_not_in_diff, line_outside_hunk, evidence_unverifiable, provider_output_zod_failed}`, `reason_message`, `provider_output_excerpt`, `timestamp`). | `provider_output_excerpt` is redacted at the source per `review-findings-schema.md` § Rejection log entry shape. | no |
| `ranker.dropped` | `packages/core/validator-ranker` emits a `RejectionLogEntry` with `stage = 'ranker'`. The ranker does not drop findings; this event exists for symmetry and informational entries. | `RejectionLogEntry` shape inline. | Same redaction discipline as `validator.rejected`. | no |
| `publisher.published` | The publisher creates a Checks run and (when `mode = summary-plus-inline`) inline review comments. | `mode` (`dry-run` \| `summary-only` \| `summary-plus-inline`), `inline_count`, `summary_count`, `dropped_count`, `checks_run_id`. | Finding bodies are never logged at this event (counts only). | no |
| `publisher.dropped` | The publisher emits a `RejectionLogEntry` with `stage = 'publisher'`. | `RejectionLogEntry` shape inline (`reason_code` ∈ `{per_file_cap_exhausted, per_pr_cap_exhausted, severity_below_floor, confidence_below_floor, dedupe_collapsed}`). | `provider_output_excerpt` is redacted. | no |
| `job.terminal` | The job reaches a terminal state. | `state` (`succeeded` \| `failed_terminal` \| `discarded_idempotent`), `failure_reason_code` (string or `null`), `duration_ms`. | None beyond base. | yes |

## Metrics

### Naming convention

Metric names use the prefix `prisma_`, lowercase snake_case, suffixed by unit when applicable: `_seconds` for time, `_bytes` for size, `_total` for monotonic counters. All labels are low-cardinality enums or fixed strings; high-cardinality identifiers do not appear as labels (see § Cardinality discipline).

### Metric inventory

| name | type | labels | description |
| --- | --- | --- | --- |
| `prisma_webhooks_received_total` | counter | `event_type`, `outcome` (`accepted` \| `signature_failed` \| `discarded_idempotent` \| `discarded_other_event` \| `enqueue_failed`) | Total webhook deliveries observed by `apps/github-app/webhook-ingress`, partitioned by GitHub event type and ingress outcome. |
| `prisma_jobs_inflight` | gauge | `service` (static) | Number of BullMQ jobs currently being processed by the worker process. |
| `prisma_jobs_terminal_total` | counter | `state` (`succeeded` \| `failed_terminal` \| `discarded_idempotent`), `failure_reason_code` (low-cardinality enum, bounded set) | Total jobs that reached a terminal state, partitioned by terminal state and (for `failed_terminal`) the failure reason code. |
| `prisma_provider_call_seconds` | histogram | `provider_id`, `outcome` (`success` \| `error.transport` \| `error.auth` \| `error.rate_limit` \| `error.capability` \| `error.schema_validation`) | Latency of `Provider.review` invocations, partitioned by adapter id and outcome. |
| `prisma_provider_retry_total` | counter | `provider_id`, `retry_class` (`transient` \| `rate_limited`) | Total provider retries attempted, partitioned by adapter id and retry class. |
| `prisma_findings_published_total` | counter | `mode` (`dry-run` \| `summary-only` \| `summary-plus-inline`), `surface` (`inline` \| `summary`) | Total findings the publisher emitted, partitioned by mode and publication surface. |
| `prisma_findings_dropped_total` | counter | `stage` (`validator` \| `ranker` \| `publisher`), `reason` (the `RejectionLogEntry.reason_code` enum) | Total findings dropped at each pipeline stage, partitioned by stage and reason code. |
| `prisma_prefilter_skipped_total` | counter | `reason` (`oversized` \| `all-excluded`) | Total times the prefilter short-circuited the pipeline. |
| `prisma_redactor_dropped_total` | counter | `event` (the event name that was dropped) | Total events the redactor refused to emit due to a fail-closed match against a secret-shape pattern. |
| `prisma_queue_lag_seconds` | histogram | `service` (static) | Distribution of (`job.started.ts` − `job.enqueued.ts`); how long jobs sit in the queue before pickup. |
| `prisma_job_duration_seconds` | histogram | `state` (`succeeded` \| `failed_terminal` \| `discarded_idempotent`) | Distribution of `job.terminal.duration_ms` converted to seconds; sources the job-to-publish latency SLI. |

### Cardinality discipline

The following identifiers **must not** appear as metric label values:

- `installation_id`
- `repository_id`
- `pull_request_number`
- `idempotency_key`
- `head_sha`
- `delivery_id`
- `checks_run_id`
- Trace IDs (`trace_id`, `span_id`).

These identifiers appear as structured-log fields (per § Top-level fields) and as trace span attributes (per § Span hierarchy) only. The reason: unbounded label values blow up time-series storage and turn metric queries into log queries. Operators who need per-installation breakdowns derive them from logs or traces, not from metrics.

## Traces

### Span hierarchy

Spans are organized as follows. The ingress tree is propagated to the worker tree via a `traceparent` value placed in the `JobPayload`; the worker's root span is linked to the ingress's root via that propagated context.

- `http.webhook` — root for the ingress. Opens at HTTP request entry to `apps/github-app/webhook-ingress`; closes after the `2xx` (or `4xx`/`5xx`) response is sent.
  - `queue.enqueue` — child of `http.webhook`. Wraps the BullMQ enqueue call.
- `worker.job` — root for the worker. Opens on BullMQ job pickup; closes on terminal job state. Linked to `http.webhook` via the propagated trace context (the worker reads `traceparent` from the `JobPayload` and sets it as the parent context for `worker.job`).
  - `pipeline.config_load` — child of `worker.job`. Wraps `packages/config/config-loader` resolution.
  - `pipeline.snapshotter` — child of `worker.job`. Wraps `packages/core/snapshotter`.
  - `pipeline.prefilter` — child of `worker.job`. Wraps `packages/core/prefilter`.
  - `pipeline.provider` — child of `worker.job`. Wraps `packages/providers/anthropic` (a single span across retries; retry attempts are recorded as span events on this span).
  - `pipeline.validator` — child of `worker.job`. Wraps the `validate(output, ctx)` call in `packages/core/validator-ranker`.
  - `pipeline.ranker` — child of `worker.job`. Wraps the `rank(findings, policy)` call in `packages/core/validator-ranker`.
  - `pipeline.publisher` — child of `worker.job`. Wraps the publisher's threshold-and-cap application and the GitHub Checks/Review-Comments writes by `packages/github/check-runs` and `packages/github/review-comments`.

The pipeline-stage order in the span tree (`pipeline.prefilter`, `pipeline.provider`, `pipeline.validator`, `pipeline.ranker`, `pipeline.publisher`) matches the pipeline stage order `prefilter → provider → validator → ranker → publication cap` declared in ADR-003 and reused in `system-design.md` § End-to-end sequence.

High-cardinality identifiers (`installation_id`, `repository_id`, `pull_request_number`, `head_sha`, `idempotency_key`) are recorded as **span attributes** on `worker.job` and inherited by children, and are **never** used as metric label values.

### Trace context propagation

A `traceparent` string is included in the `JobPayload`. This is the only addition Phase 3 makes to the Phase 2 `JobPayload` shape: the field is **optional**, carries trace context only — no semantic data, no secrets — and is forward-compatible. The wording is repeated for clarity: **Phase 3 additive extension — does not modify Phase 2 contracts**. The worker reads `traceparent` and uses it to start `worker.job` as a span whose parent context is the ingress's `http.webhook`. OpenTelemetry's propagator API handles the mechanics; this document names the convention.

## Sampling

Sampling is parent-based with a head-sample default of `1.0` for MVP single-tenant low-volume operation. The sampling rate is configurable via `OTEL_TRACES_SAMPLER_ARG` (a number in `[0,1]`). A parent-based sampler honors the upstream sampling decision: when a span is sampled at the ingress (`http.webhook`), the worker's `worker.job` (linked via the propagated `traceparent`) is sampled too; when the parent was not sampled, the worker span follows. Reduction below `1.0` is left to operator discretion when traffic grows; this document states the default and the knob, and `deployment.md` § Tunables lists the env var.

## Redaction allowlist

Only fields explicitly on this allowlist may leave the process. Anything not on the allowlist is **dropped or hashed** at emission time by the redactor in `packages/shared/audit-log`.

The allowlist:

1. The fixed top-level log fields listed in § Top-level fields: `ts`, `level`, `service`, `event`, `trace_id`, `span_id`, `installation_id`, `repository_id`, `pull_request_number`, `idempotency_key`, and the `payload` envelope.
2. The per-event fields named in § Event taxonomy under "fields beyond base" (counts, enums, ids that are not secrets, ISO timestamps).
3. For `RejectionLogEntry`: `finding_id`, `stage`, `reason_code`, `reason_message`, `provider_output_excerpt` (already redacted at the source per `review-findings-schema.md` § Rejection log entry shape), `timestamp`.
4. The span attributes named in § Span hierarchy.
5. The metric labels named in § Metric inventory.

The PII / secret guard is **fail-closed**. If a value matching a secret-shape pattern — PEM block markers (`-----BEGIN`), GitHub installation token shapes (per GitHub's documented prefixes; verify against current vendor docs in Phase 4), provider API key shapes (per Anthropic's documented prefixes; verify against current vendor docs in Phase 4), or webhook signature header shapes (`sha256=...`) — is detected in any payload position, the **entire event is dropped** (not partially emitted) and `prisma_redactor_dropped_total` is incremented with `event` set to the dropped event name.

This document is the single source of truth for the redaction allowlist; `system-design.md` § Cross-cutting concerns § Structured logging fields and `data-flow.md` § Data-at-rest boundaries reference this section without redefining it.

## SLI / SLO posture

The SLIs the App tracks in MVP are listed below. SLO numerics are deferred to operators in MVP; where a numeric target is needed, `operational-runbooks.md` § Numeric tunables provides starting values. The SLIs are:

- **Webhook 2xx-on-accept rate.** The fraction of `webhook.received` events whose ingress outcome is `accepted`, `discarded_idempotent`, or `discarded_other_event` (i.e., the App responded `2xx` within budget — per `api-contracts.md` § Webhook ingress contract). Sourced from `prisma_webhooks_received_total{outcome=...}`.
- **Job-to-publish latency p95.** The p95 of job duration for jobs whose `state = 'succeeded'`. Sourced from `prisma_job_duration_seconds{state="succeeded"}` (a histogram sourced from the `job.terminal.duration_ms` field).
- **Provider error rate.** The fraction of `prisma_provider_call_seconds` observations whose `outcome != 'success'`. The `error.rate_limit` outcome is reported separately because it is operationally distinct from an outage signal: a rate-limit hit indicates cost-control pressure, not a vendor failure.
- **Findings-published-per-PR distribution.** The distribution of finding counts published per PR, derived from `prisma_findings_published_total` partitioned by `mode` and `surface`. The distribution shape is the SLI; a target floor (for example, median `> 0` in `summary-plus-inline` deployments) is operator-set in MVP.
