# Phase 3 Specification — Technical Design

> **Audience:** IDG (the agent that will compose the Phase 3 documents).
> **Status:** Contract only. IDG fills the bodies; SPECTRA defines structure, content requirements, and acceptance gates.
> **Source of truth for prior decisions:** Phase 1 docs (`docs/research-summary.md`, ADRs 001/002/003, `docs/threat-model.md`, `docs/mvp-scope.md`, `docs/open-questions.md`) and Phase 2 docs (`docs/product-spec.md`, `docs/config-spec.md`, `docs/review-findings-schema.md`, `docs/api-contracts.md`, `docs/publication-policy.md`). Phase 3 must not contradict any of them.

---

## Phase 3 Work Plan (≤ 300 words)

**Authoring order (strict):**

1. `docs/system-design.md` — establishes the canonical component map (apps/packages boundaries), the end-to-end sequence, and cross-cutting concerns. Every later Phase 3 doc references its component names verbatim.
2. `docs/data-flow.md` — depends on `system-design.md` for component names and on Phase 2 schemas (`ProviderReviewInput → ProviderReviewOutput → NormalizedFinding → RankedFindings → PublicationResult`). Specifies the five named flows (happy path, oversized-diff fast-path, provider failure, malformed output, re-run on synchronize).
3. `docs/observability.md` — depends on the component map and the data-flow events. Defines the OQ-3 OpenTelemetry-first design: log fields, event taxonomy, metrics inventory, trace span hierarchy, redaction allowlist, SLI posture.
4. `docs/deployment.md` — depends on `observability.md` (for OTLP env var) and `system-design.md` (for component topology). Defines topology, env vars (with classification), networking, secret abstraction, health surfaces, and the verbatim `.env.example` block.
5. `docs/operational-runbooks.md` — depends on every prior Phase 3 doc: each runbook's Detection step references metric/event names from `observability.md`; each Mitigation references env vars from `deployment.md` and components from `system-design.md`. Closes with the numeric-tunables table.

**File dependencies (claim flow):** system-design → data-flow → observability → deployment → operational-runbooks.

**Consistency-check pass before exit:** A name-level diff confirms (a) every component named in `system-design.md` is referenced by name in at least one runbook; (b) every event name in `observability.md` § Event taxonomy is the trigger of at least one log emission in `data-flow.md` and the Detection signal of at least one runbook; (c) every metric name in `observability.md` is referenced in at least one runbook's Detection step; (d) every env var in `deployment.md` § Environment variables is classified as `secret` / `config` / `tunable` and the tunables appear in `operational-runbooks.md` § Numeric tunables; (e) Phase 2 identifiers (`ProviderReviewInput`, `ProviderReviewOutput`, `NormalizedFinding`, `RankedFindings`, `PublicationResult`, `RejectionLogEntry`, `JobPayload`, `JobResult`, `PublicationPolicy`, `PublishContext`, `WebhookIngressRequest`, `WebhookIngressResponse`) and Phase 1 identifiers (`ProviderError`, `ProviderCapabilities`) are reused verbatim; (f) `docs/open-questions.md` § Resolution log contains the OQ-3 entry dated `2026-04-30`.

**Phase 3 exit gate (testable):** All 5 files exist at their specified paths; every acceptance criterion in the YAML block at the end of this spec evaluates true; every consistency check produces zero violations; OQ-3 is recorded in the Resolution log of `docs/open-questions.md` with resolution date `2026-04-30`; OQ-4, OQ-5, OQ-6, OQ-7, OQ-8 remain in `## Open questions` / `## Deferred decisions` / `## Research gaps` unchanged.

---

## Resolution log entry for OQ-3

IDG must remove OQ-3 from `## Open questions` and append the block below verbatim to `docs/open-questions.md` § Resolution log, preserving the original entry shape with the resolution appended.

```
### OQ-3 — Structured-logging backend / observability sink

- **ID.** OQ-3.
- **Question.** Which structured-logging backend / observability sink does the hosted App emit to, and what is the redaction policy at the sink boundary?
- **Raised in.** `mvp-scope.md` § In scope > Observability and logging; `threat-model.md` § Secret leakage, § Mitigation matrix, § Residual risk and deferred items.
- **Blocking?** No for Phase 1 exit; yes for Phase 2 hosting cutover, since the secret-leakage mitigation depends on the sink honoring the redaction policy.
- **Owner.** TBD.
- **Target phase.** Phase 3. Phase 2 deferral note: Phase 2 contracts (validator, ranker, publisher) emit structured-log events and `RejectionLogEntry` records by name; the sink they emit to is Phase 3's concern, recorded in `docs/observability.md`.
- **Resolution date.** 2026-04-30.
- **Resolution.** Vendor-neutral, OpenTelemetry-first design. Logs are emitted as structured JSON to stdout (one event per line) with a fixed top-level field set (`ts`, `level`, `service`, `event`, `trace_id`, `span_id`, `installation_id`, `repository_id`, `pull_request_number`, `idempotency_key`, plus event-specific payload); no log shipping is built in (the deployment platform handles collection). Metrics and traces use the OpenTelemetry SDK in-process and export via OTLP/HTTP to an operator-supplied collector endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT`); no observability vendor is pinned. Sampling is parent-based with head-sample default `1.0` for the MVP (single-tenant, low volume). An emission-time redactor strips diff content, repo file bodies, and provider raw output from log/event payloads; only schema-derived fields and counts are exported, against an explicit allowlist documented in `docs/observability.md`. The redactor is fail-closed for installation tokens, webhook secrets, and provider API keys: if a secret-shaped value appears where it should not, the event is dropped.
- **Rationale.** (a) OpenTelemetry as the export protocol keeps the operator free to point traces and metrics at any vendor (Honeycomb, Datadog, Tempo, Jaeger, etc.) without code changes; (b) stdout JSON for logs preserves portability across container platforms and avoids coupling the App to a logging SDK; (c) head-sample `1.0` is acceptable for MVP single-tenant volumes and trivially reducible later via `OTEL_TRACES_SAMPLER_ARG`; (d) the redactor is the mechanical enforcer of the secret-leakage mitigation listed as `partially mitigated` in `threat-model.md`, moving that risk to `mitigated`. Implementation rule: Phase 4 imports `@opentelemetry/*` packages; no other observability SDK is hard-coded.
```

---

## File 1 — `docs/system-design.md`

### 1. Purpose

The single canonical design document for the App: the component map, the end-to-end sequence, the apps/packages boundaries, and the cross-cutting concerns (logging, tracing, error taxonomy, multitenancy posture). Every other Phase 3 doc names components and concerns defined here.

### 2. Required sections (exact H2/H3 in order)

- `## Overview`
- `## Component map`
  - `### apps/github-app/webhook-ingress`
  - `### packages/github/installation-auth`
  - `### packages/core/snapshotter`
  - `### packages/core/prefilter`
  - `### packages/providers (provider abstraction surface)`
  - `### packages/providers/anthropic`
  - `### packages/core/validator-ranker`
  - `### packages/github/check-runs`
  - `### packages/github/review-comments`
  - `### packages/config/config-loader`
  - `### packages/shared/audit-log`
- `## End-to-end sequence`
- `## Apps vs packages boundaries`
- `## Cross-cutting concerns`
  - `### Structured logging fields`
  - `### Trace propagation across the queue`
  - `### Error taxonomy mapping`
- `## Multitenancy posture`
- `## Queue and async model`
- `## Secret storage abstraction`
- `## Back-pressure controls`

### 3. Research questions answered (concrete, falsifiable)

- What is the exact component map of the App, and what does each component own?
- Which schemas does each component own, and which does it depend on (read-only)?
- What is the public surface of each component (the functions or types it exposes to neighbors)?
- What invariant is each component responsible for upholding?
- What is the end-to-end sequence from webhook arrival to terminal job state, naming every component the request passes through?
- Why does GitHub-API code live in `packages/github/*` rather than in `packages/core/*`?
- What goes in `apps/` vs `packages/`?
- How is trace context propagated across the BullMQ boundary?
- Which error types map to which terminal `JobResult.state` (`succeeded` / `failed_terminal` / `discarded_idempotent`)?
- How does the App stay multitenant-ready while running single-tenant in MVP?
- What queue technology is used, what interface does the worker depend on, and how is it swapped?
- How are secrets read at runtime, and what interface lets operators substitute a managed secret manager later?
- What back-pressure controls protect the worker from cost and latency blowups?

### 4. Required content per section

- **Overview:** one paragraph. Must mention: the App is a single Fastify webhook ingress plus one or more BullMQ workers backed by Redis; the pipeline `prefilter → provider → validator → ranker → publication cap` is preserved; the schema chain `ProviderReviewInput → ProviderReviewOutput → NormalizedFinding → RankedFindings → PublicationResult` is preserved; the App is single-tenant in MVP but namespaces every persistence and routing key by `installation_id` from day one.
- **Component map:** one subsection per component, in the exact order above. Each subsection must contain, in this order: `Responsibility`, `Owns-which-schemas`, `Depends-on`, `Public surface`, `Invariants`. Required content per component:
  - `apps/github-app/webhook-ingress` — Responsibility: receive `POST /webhooks/github`, verify `X-Hub-Signature-256`, derive idempotency key, enqueue. Owns: `WebhookIngressRequest`, `WebhookIngressResponse`. Depends on: `packages/config/config-loader` (for app-level config, not repo config), `packages/shared/audit-log`, queue client. Public surface: HTTP route handler, `deriveIdempotencyKey` function. Invariants: signature verification precedes idempotency derivation precedes enqueue precedes 2xx (per `api-contracts.md` § Webhook ingress contract); 2xx budget ≤ 1 s; no PR-visible artifact created here.
  - `packages/github/installation-auth` — Responsibility: mint and cache installation tokens scoped by App manifest permissions. Owns: an internal `InstallationToken` record (not a Phase 2 schema). Depends on: `SecretSource` for the GitHub App private key. Public surface: `getInstallationToken(installation_id): Promise<InstallationToken>`. Invariants: tokens are minted at job execution time, never embedded in `JobPayload`; expired tokens are not returned; the App private key never appears in any log or trace.
  - `packages/core/snapshotter` — Responsibility: fetch the PR diff and metadata for a `(installation_id, repository_id, pull_request_number, head_sha)` tuple from GitHub. Owns: an internal `DiffSnapshot` record. Depends on: `packages/github/installation-auth`, GitHub Pull Requests API. Public surface: `snapshot(ctx): Promise<DiffSnapshot>`. Invariants: the snapshot is bounded (per `max_files` / `max_changed_lines` from `config-spec.md`); raw file contents do not leave the worker beyond what the prefilter forwards.
  - `packages/core/prefilter` — Responsibility: scope the diff context per ADR-003 (paths, globs, generated-file detection, vendored detection, size rules). Owns: `ProviderReviewInput` (constructed). Depends on: `packages/core/snapshotter`, `packages/config/config-loader`. Public surface: `prefilter(snapshot, config): { input: ProviderReviewInput | null; reason: 'ok' | 'oversized' | 'all-excluded' }`. Invariants: prefilter runs before any provider call; on `oversized`, the worker takes the fast-path defined in `data-flow.md`; on `all-excluded`, the pipeline ends without invoking the provider.
  - `packages/providers (provider abstraction surface)` — Responsibility: expose the typed Provider interface from ADR-002 / `api-contracts.md` § Provider adapter contract. Owns: re-exports `ProviderReviewInput`, `ProviderReviewOutput`, `ProviderError`, `ProviderCapabilities` (Phase 1 identifiers). Depends on: nothing vendor-specific. Public surface: the `Provider` interface (`review`, `capabilities`). Invariants: no vendor SDK type appears in this package's signatures; this package is the only place downstream code imports the provider types from.
  - `packages/providers/anthropic` — Responsibility: implement `Provider` against the Anthropic Claude wire (per OQ-1). Owns: an internal Anthropic-specific request/response shape (private to the package). Depends on: `SecretSource` for the provider API key, the Anthropic SDK. Public surface: a factory that returns a `Provider`. Invariants: no Anthropic SDK type, response shape, or error class crosses the package boundary; `ProviderReviewOutput` is Zod-validated at the adapter boundary; on Zod failure the adapter throws `ProviderError` with variant `schema_validation`.
  - `packages/core/validator-ranker` — Responsibility: implement the validator and ranker contracts per `api-contracts.md`. Owns: `NormalizedFinding`, `RankedFindings`, `RejectionLogEntry` (constructed). Depends on: `packages/core/prefilter` (for diff context shape), `packages/config/config-loader` (for `repo_heuristics`, `severity` overrides). Public surface: `validate(output, ctx)`, `rank(findings, policy)`. Invariants: per `api-contracts.md` § Validator contract and § Ranker contract — every emitted `NormalizedFinding` has `path` in the diff and `[line_start, line_end]` within a touched hunk; the ranker never sets `render_target = 'dropped'` and never drops findings.
  - `packages/github/check-runs` — Responsibility: create and update Checks runs on the PR `head_sha`; render the Markdown summary. Owns: an internal `CheckRunRequest` record. Depends on: `packages/github/installation-auth`, GitHub Checks API. Public surface: `createCheckRun(ctx, body): Promise<{ checks_run_id: string }>`, `updateCheckRun(...)`. Invariants: the Checks run is owned by the App identity; conclusion is one of `success` / `neutral` / `failure` per `publication-policy.md`.
  - `packages/github/review-comments` — Responsibility: create line-anchored review comments when `mode = summary-plus-inline`. Owns: an internal `ReviewCommentRequest` record. Depends on: `packages/github/installation-auth`, GitHub Pull Request Review Comments API. Public surface: `createReviewComment(ctx, finding): Promise<void>`. Invariants: only invoked for findings whose `render_target = 'inline'` after caps and thresholds; the publisher does not edit or delete prior inline comments in MVP (per `publication-policy.md` § Re-run behavior on synchronize).
  - `packages/config/config-loader` — Responsibility: resolve effective configuration per `config-spec.md` § Resolution order: built-in defaults, repo-local `.github/review-bot.yml`, per-PR overrides slot. Owns: the resolved config object. Depends on: `packages/github/installation-auth` (to fetch the file from the head ref). Public surface: `loadConfig(ctx): Promise<ResolvedConfig>`. Invariants: malformed files reject and fall back to defaults (per `config-spec.md` § Failure modes); unknown keys warn and ignore.
  - `packages/shared/audit-log` — Responsibility: structured-log emission with the redaction allowlist defined in `observability.md`. Owns: the emitter and the redactor. Depends on: nothing component-specific. Public surface: `emit(event, payload)`, `emitRejection(entry: RejectionLogEntry)`. Invariants: the redactor is fail-closed for secret-shaped values; only fields on the allowlist (defined in `observability.md` § Redaction allowlist) leave the process; no diff content, no repo file bodies, no provider raw output is ever emitted.
- **End-to-end sequence:** an ordered list, must include in this order: (1) webhook arrival at `apps/github-app/webhook-ingress`; (2) signature verify; (3) `deriveIdempotencyKey`; (4) enqueue to BullMQ; (5) 2xx response; (6) worker pickup; (7) `packages/config/config-loader` resolves effective config from `.github/review-bot.yml`; (8) `packages/github/installation-auth` mints installation token; (9) `packages/core/snapshotter` fetches diff; (10) `packages/core/prefilter` short-circuits on `all-excluded` (terminal `succeeded` with no findings) or `oversized` (oversized-diff fast-path: skip provider, emit summary-only Checks run, terminal `succeeded`); (11) provider call via `packages/providers/anthropic`; (12) Zod validation at the adapter boundary; (13) `packages/core/validator-ranker` validate; (14) `packages/core/validator-ranker` rank; (15) publisher applies `PublicationPolicy` (per `publication-policy.md` § Threshold and cap application order); (16) `packages/github/check-runs` and (when `mode = summary-plus-inline`) `packages/github/review-comments` publish; (17) `packages/shared/audit-log` writes terminal state and any `RejectionLogEntry` records. Every step must reference the component or schema it touches by name.
- **Apps vs packages boundaries:** must state: `apps/` contains the runtime entry points (the Fastify HTTP server, the BullMQ worker process); `packages/` contains pure-logic and IO-shaped libraries that the apps compose; `packages/github/*` exists separately from `packages/core/*` because GitHub-API code is IO-shaped and credential-bearing — it must be testable with fakes, isolated from pure pipeline logic, and substitutable behind the `Provider`-style seams. No `apps/` contains pipeline logic; pipeline logic lives in `packages/core/*` and is invoked by the worker app.
- **Cross-cutting concerns:**
  - `### Structured logging fields` — must restate the fixed top-level field list (`ts`, `level`, `service`, `event`, `trace_id`, `span_id`, `installation_id`, `repository_id`, `pull_request_number`, `idempotency_key`) and reference `observability.md` § Logs as the canonical source. Forward-reference only; do not redefine.
  - `### Trace propagation across the queue` — must state that a `traceparent` header is carried in the `JobPayload` (extending the Phase 2 `JobPayload` shape with an optional `traceparent: string` field for trace context only; no semantic data, no secrets) and consumed by the worker to reconstruct the parent span. Forward-reference `observability.md` § Traces.
  - `### Error taxonomy mapping` — must map: `ProviderError.transport` → Transient retry class → potentially `failed_terminal` after retries exhausted; `ProviderError.rate_limit` → Rate-limited retry class → potentially `failed_terminal` after retries exhausted; `ProviderError.auth`, `ProviderError.capability`, `ProviderError.schema_validation` → Non-transient → `failed_terminal` immediately; validator `RejectionLogEntry.reason_code` values (`path_not_in_diff`, `line_outside_hunk`, `evidence_unverifiable`, `provider_output_zod_failed`) → per-finding drops, do not fail the job; publisher `RejectionLogEntry.reason_code` values (`per_file_cap_exhausted`, `per_pr_cap_exhausted`, `severity_below_floor`, `confidence_below_floor`, `dedupe_collapsed`) → per-finding drops, do not fail the job; redactor fail-closed → drop the event, do not retry, audit; webhook signature failure → `4xx`, no enqueue; idempotency replay → `2xx` with `discarded_idempotent` async resolution. Must reference Phase 2 § Invariants and error semantics for the underlying invariants.
- **Multitenancy posture:** must state: single-tenant in MVP (one App registration), but every persistence key (`idempotency_key` storage, dedupe lookup keys, replay-protection keys, queue job ids) and every routing key is namespaced by `installation_id` from day one. The phrase `namespaced by installation_id` must appear verbatim. Adding a second tenant later is additive (new App registration, new `installation_id`s), not a refactor.
- **Queue and async model:** must state: BullMQ on Redis; a single queue named `pr-review`; a single concurrency knob; a single per-job timeout; ack-on-receive plus visibility timeout. Operators may swap to another queue later — the worker code depends on a `JobQueue` interface (declared by name here; field-by-field shape is Phase 4). No file in `packages/core/*` imports BullMQ directly; only the worker app and a thin adapter in `packages/shared` (or equivalent) does. The idempotency key from `api-contracts.md` § Webhook ingress contract is the BullMQ job id; re-enqueue of the same key is a no-op when an active or completed job exists. Replay protection: `X-GitHub-Delivery` is cached per installation for a bounded window; a duplicate delivery short-circuits to `discarded_idempotent`.
- **Secret storage abstraction:** must state: all secrets (GitHub App private key, webhook secret, provider API key) are read via a `SecretSource` interface with a single method `getSecret(name): Promise<string>`. The MVP implementation reads from process env. Operators are expected to wrap this with a managed secret manager (e.g., AWS Secrets Manager, Vault, GCP Secret Manager) — the choice is theirs; do not pin a vendor. The interface name `SecretSource` must appear verbatim and be referenced from `deployment.md` § Secret management abstraction.
- **Back-pressure controls:** must enumerate three classes:
  - **Webhook ingress.** 2xx-on-accept always (≤ 1 s budget); enqueue-then-return; reject only on bad signature or unsupported event.
  - **Worker.** Queue concurrency cap; per-job timeout; oversized-diff fast-path emits summary-only and skips the provider call.
  - **Provider.** Per-installation cost ceiling proxy (max-tokens-per-PR, max-tokens-per-window) — class only; numeric values live in `operational-runbooks.md` § Numeric tunables, not here.

### 5. Acceptance criteria (GIVEN/WHEN/THEN)

See YAML block (IDs `SD-1` … `SD-7`).

### 6. Cross-file consistency requirements

- Component names listed in `## Component map` are referenced verbatim by `data-flow.md` (each step names the component touching it), `observability.md` (where component-scoped events are named), and `operational-runbooks.md` (every Mitigation step naming a component uses the same path string).
- Phase 2 schema identifiers (`ProviderReviewInput`, `ProviderReviewOutput`, `NormalizedFinding`, `RankedFindings`, `PublicationResult`, `RejectionLogEntry`, `JobPayload`, `JobResult`, `WebhookIngressRequest`, `WebhookIngressResponse`, `PublicationPolicy`, `PublishContext`) and Phase 1 identifiers (`ProviderError`, `ProviderCapabilities`) appear verbatim where referenced. No alias.
- Pipeline stages `prefilter`, `provider`, `validator`, `ranker`, `publication cap` appear in this order in the End-to-end sequence and match ADR-003.
- The Anthropic adapter location `packages/providers/anthropic` matches the OQ-1 resolution log entry.
- The phrase `namespaced by installation_id` appears verbatim in `## Multitenancy posture`.
- The interface name `SecretSource` is reused verbatim by `deployment.md`.
- The interface name `JobQueue` is reused verbatim by `deployment.md` (where the BullMQ binding is the only shipped implementation) and `operational-runbooks.md`.

### 7. Out of scope for this file

- No event taxonomy (lives in `observability.md`).
- No metric inventory (lives in `observability.md`).
- No environment variable list (lives in `deployment.md`).
- No `.env.example` block (lives in `deployment.md`).
- No runbook scenarios (live in `operational-runbooks.md`).
- No new schemas; all schemas come from Phase 2 or Phase 1.
- No retry numeric values, queue concurrency numeric values, or sample-rate numeric values; classes only.
- No ADR-level decisions; this file describes how the ADR decisions compose into a system.

---

## File 2 — `docs/data-flow.md`

### 1. Purpose

The five canonical end-to-end flows, described textually (ASCII diagrams permitted). Each flow lists ordered steps, names the component that emits each structured event, identifies where the trace span starts and ends, and names the terminal `JobResult.state`. Consumed by implementers (Phase 4) and by the runbooks.

### 2. Required sections (exact H2/H3 in order)

- `## Conventions`
- `## Flow 1 — Happy path`
- `## Flow 2 — Oversized-diff fast-path`
- `## Flow 3 — Provider failure`
- `## Flow 4 — Malformed provider output`
- `## Flow 5 — Re-run on synchronize (dedupe across runs)`
- `## Data-at-rest boundaries`

### 3. Research questions answered

- For each of the five canonical flows, what is the exact ordered sequence of component invocations from webhook receipt to terminal state?
- For each step, which component emits which structured-log event (named) and which span starts or ends?
- What is the terminal `JobResult.state` for each flow?
- What is persisted at rest, and what is explicitly never persisted?

### 4. Required content per section

- **Conventions:** must state (a) flows are described as ordered numbered steps; (b) ASCII diagrams are permitted as supplements but not required; (c) each step names the component (using the path strings from `system-design.md` § Component map) and the schema produced or consumed; (d) each step that emits a structured log identifies the event name from `observability.md` § Event taxonomy by exact string; (e) each flow ends with a single line stating the terminal `JobResult.state` and the highest-level span that closes; (f) trace spans are named per `observability.md` § Traces.
- **Flow 1 — Happy path:** must walk through, in order, every step from `## End-to-end sequence` in `system-design.md` for a PR whose prefilter accepts the diff, whose provider returns a valid `ProviderReviewOutput`, and whose publisher creates a Checks run and (when `mode = summary-plus-inline`) inline comments. Required event references in order: `webhook.received`, `job.enqueued`, `job.started`, `prefilter.accepted` (or equivalent named in observability.md), `provider.called`, `validator.completed`, `ranker.completed`, `publisher.published`, `job.terminal`. Trace span hierarchy: `http.webhook` opens at step 1, closes after enqueue; `worker.job` opens on pickup, closes on terminal state; `pipeline.snapshotter`, `pipeline.prefilter`, `pipeline.provider`, `pipeline.validator`, `pipeline.ranker`, `pipeline.publisher` are nested children of `worker.job`. Terminal state: `succeeded`.
- **Flow 2 — Oversized-diff fast-path:** must walk through the prefilter `oversized` short-circuit. Required event sequence: `webhook.received`, `job.enqueued`, `job.started`, `prefilter.skipped` with reason `oversized`, `publisher.published` (summary-only Checks run that names the limit hit and lists affected paths in aggregate, per `publication-policy.md` § Diff too large), `job.terminal`. The provider is **not** called; `pipeline.provider` span never opens. Terminal state: `succeeded`. Must explicitly reference `max_files` and `max_changed_lines` from `config-spec.md`.
- **Flow 3 — Provider failure:** must walk through a non-transient `ProviderError` (`auth`, `capability`) and the exhausted-retry case for transient errors. Required event sequence: `webhook.received`, `job.enqueued`, `job.started`, `prefilter.accepted`, `provider.called`, `provider.error` (with the variant), and on retry-class transient: zero or more additional `provider.called` / `provider.error` cycles before exhaustion; finally `publisher.dropped` (or equivalent — the publisher emits a `neutral` Checks run stating "review unavailable" per the brief's guidance), `job.terminal`. Inline comments are not created. Terminal state: `failed_terminal`. Must reference the retry policy classes from `system-design.md` § Error taxonomy mapping (Transient, Rate-limited, Non-transient) and the Checks-summary "review unavailable" body required by Phase 3 pre-resolved decisions.
- **Flow 4 — Malformed provider output:** must walk through a `ProviderError.schema_validation` (Zod fail at the adapter boundary). Required event sequence: `webhook.received`, `job.enqueued`, `job.started`, `prefilter.accepted`, `provider.called`, `validator.rejected` with `reason_code = provider_output_zod_failed` (and a `RejectionLogEntry` per finding excerpt where applicable, redacted of credential-bearing content), `publisher.published` (a `neutral` Checks run stating "no findings produced" per `publication-policy.md` § Malformed `ProviderReviewOutput`), `job.terminal`. The entire provider response is dropped; partially valid output is not silently kept. Terminal state: `failed_terminal`. Must reference the **drop-with-audit-log** policy and the `RejectionLogEntry` shape from `review-findings-schema.md`.
- **Flow 5 — Re-run on synchronize (dedupe across runs):** must walk through `pull_request.synchronize` for a PR the App previously reviewed. Required event sequence: (a) duplicate delivery case — `webhook.received`, then either `webhook.signature_failed` (out-of-scope here) or, when the same `idempotency_key` and same `head_sha` appear, the async resolution `job.terminal` with state `discarded_idempotent` and **no** `provider.called` event; (b) new-`head_sha` case — full pipeline re-runs, `publisher.published` consults the per-PR already-published dedupe set, findings whose `dedupe_key` is already present are not re-published, `job.terminal` with state `succeeded`. Must reference the dedupe scopes from `publication-policy.md` § Dedupe behavior (within-run and across-run) and the source of the already-published set (GitHub Checks/Review-Comments history of this App on this PR).
- **Data-at-rest boundaries:** must state, as a numbered list:
  1. **Persisted:** normalized findings (the `NormalizedFinding` records the publisher kept and published), the audit log (structured `RejectionLogEntry` records and terminal job records), the per-installation idempotency-key state record (per `api-contracts.md` § Async job contract), the per-installation `X-GitHub-Delivery` replay-window cache.
  2. **Never persisted:** raw `ProviderReviewOutput` (only validated, normalized findings persist; the raw response is discarded after Zod validation), repo file bodies, raw diff content beyond what the validator's `evidence` field references, installation tokens (minted at job execution time, not stored), the GitHub App private key (read from `SecretSource` per call, never written), webhook secrets, provider API keys.
  3. **Logs:** redacted log events only (per `observability.md` § Redaction allowlist); diff content, repo file bodies, and provider raw output are stripped at emission time by the redactor.

### 5. Acceptance criteria (GIVEN/WHEN/THEN)

See YAML block (IDs `DF-1` … `DF-6`).

### 6. Cross-file consistency requirements

- Every component name appearing in a flow step matches the path string declared in `system-design.md` § Component map.
- Every event name appearing in a flow step matches an entry in `observability.md` § Event taxonomy.
- Every span name appearing in a flow step matches an entry in `observability.md` § Traces.
- Schema identifiers (`ProviderReviewInput`, `ProviderReviewOutput`, `NormalizedFinding`, `RankedFindings`, `PublicationResult`, `RejectionLogEntry`) are reused verbatim from Phase 2.
- Terminal states `succeeded`, `failed_terminal`, `discarded_idempotent` match `api-contracts.md` § Async job contract.
- The "review unavailable" Checks-body wording for provider failure and the "no findings produced" wording for malformed output match the Phase 3 pre-resolved decisions (these exact phrases must appear in Flow 3 and Flow 4 respectively).
- Dedupe behavior in Flow 5 matches `publication-policy.md` § Dedupe behavior; the source of the already-published set is the same identifier.

### 7. Out of scope for this file

- No component definitions (live in `system-design.md`).
- No event field definitions (live in `observability.md`).
- No metric definitions (live in `observability.md`).
- No deployment topology (lives in `deployment.md`).
- No runbook scenarios (live in `operational-runbooks.md`).
- No new flows beyond the five named here; if a sixth flow is needed, IDG flags it for SPECTRA approval rather than introducing it.
- No retry numeric values; references to retry classes only.

---

## File 3 — `docs/deployment.md`

### 1. Purpose

The single canonical deployment document: topology, container shapes, environment variables, networking, sizing posture, secret management, health surfaces, and a verbatim `.env.example` block. Consumed by operators (who deploy the App), by Phase 4 implementers (who wire the env vars to the runtime), and by every runbook (which references env vars by name).

### 2. Required sections (exact H2/H3 in order)

- `## Topology`
- `## Bootstrapping`
- `## Networking`
- `## Sizing posture`
- `## Environment variables`
  - `### Secrets`
  - `### Config`
  - `### Tunables`
- `## Secret management abstraction`
- `## Health surfaces`
  - `### Liveness`
  - `### Readiness`
  - `### Dependency check`
- `## .env.example`

### 3. Research questions answered

- What processes does the App ship as, and how do they relate to one another (single Fastify app + worker(s) + Redis)?
- What containers are built, and what is the bootstrapping path (App creation, private-key import, secret rotation pointer)?
- Which network connections are required for the App to function, and which are optional?
- What is the sizing posture for the MVP, and what back-pressure controls let the App shed load before scaling?
- Which environment variables does the App read, what is each one's classification (`secret` / `config` / `tunable`), what does it control, and what is its default?
- How does the `SecretSource` abstraction relate to deployment, and what is the only implementation shipped in MVP?
- What liveness, readiness, and dependency-check surfaces does the App expose?
- What does a complete `.env.example` look like (placeholder values, every variable present)?

### 4. Required content per section

- **Topology:** must state: a single Fastify app process running the webhook ingress (`apps/github-app/webhook-ingress`) and one or more worker processes consuming the BullMQ `pr-review` queue from a Redis instance. Each runs as a container image. The MVP is single-tenant (one App registration). Workers may be horizontally scaled; the ingress is typically a single replica behind a load balancer for simplicity but is stateless and can be scaled. Must reference `system-design.md` § Queue and async model and § Multitenancy posture.
- **Bootstrapping:** must state: GitHub App creation is performed out-of-band (operator visits GitHub's App registration UI; this document does not reproduce GitHub's flow). Once registered, the private key (`.pem`) is imported into the secret store (env var or managed secret); the webhook secret is generated and stored alongside; the provider API key is stored alongside. Must include a one-line pointer to `operational-runbooks.md` § Rotating webhook secret and § Rotating provider API key for procedural detail; the procedures themselves are not duplicated here.
- **Networking:** must enumerate, with directionality:
  - **Inbound:** HTTPS to `apps/github-app/webhook-ingress` from GitHub (required for the App to receive webhooks); HTTP from the load balancer / platform health checker to `Liveness` and `Readiness` surfaces (required).
  - **Outbound from worker:** HTTPS to the GitHub API host (required); HTTPS to the provider API host (required when `mode != dry-run`-only deployments; in practice always required); HTTPS to the OTLP collector endpoint at `OTEL_EXPORTER_OTLP_ENDPOINT` (optional — when unset, traces and metrics are not exported, but the App still functions).
  - **Inbound to Redis:** TCP from both the ingress and the worker (required); typically on a private network.
  - Must explicitly state which connections are **required** for the App to function vs **optional** (OTLP collector).
- **Sizing posture:** must state: the MVP runs comfortably on small-instance class containers (one ingress replica, one to two worker replicas, one small Redis instance). Back-pressure controls (per `system-design.md` § Back-pressure controls) let the App shed before scaling out: the queue concurrency cap bounds in-flight provider calls, the per-job timeout bounds wall time per PR, the oversized-diff fast-path bypasses the provider on large PRs. Numeric values for concurrency, timeout, and cost ceilings live in `operational-runbooks.md` § Numeric tunables.
- **Environment variables:** an introductory paragraph stating: every variable is classified `secret` / `config` / `tunable`; `secret` values are read via `SecretSource` (per `system-design.md` § Secret storage abstraction) — the env-var implementation is the only one shipped in MVP. Then three subsections, one per classification:
  - `### Secrets` — must list at minimum: `GITHUB_APP_PRIVATE_KEY` (PEM contents or path; `SecretSource`-routed), `GITHUB_APP_WEBHOOK_SECRET` (HMAC secret for `X-Hub-Signature-256`), `ANTHROPIC_API_KEY` (provider API key per OQ-1; the variable name is provider-specific because the adapter is provider-specific, but downstream code only sees `SecretSource.getSecret('provider.api_key')`-equivalent). For each: a one-line description; classification `secret`; never echoed to logs.
  - `### Config` — must list at minimum: `PORT` (HTTP port for the ingress), `REDIS_URL` (BullMQ connection string), `GITHUB_APP_ID` (numeric App id, not a secret), `GITHUB_APP_SLUG` (App slug for identity/audit), `OTEL_SERVICE_NAME` (defaults to a fixed value, e.g., `prisma-review-bot`), `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP collector URL; when unset, telemetry export is disabled), `LOG_LEVEL` (one of `debug`, `info`, `warn`, `error`; default `info`), `INSTALLATION_REPLAY_WINDOW_SECONDS` (replay-protection window for `X-GitHub-Delivery` per installation). For each: a one-line description; classification `config`.
  - `### Tunables` — must list at minimum: `QUEUE_CONCURRENCY`, `JOB_TIMEOUT_SECONDS`, `RETRY_TRANSIENT_MAX_ATTEMPTS`, `RETRY_TRANSIENT_BACKOFF_BASE_MS`, `RETRY_TRANSIENT_BACKOFF_MAX_MS`, `RETRY_RATELIMIT_MAX_ATTEMPTS`, `MAX_TOKENS_PER_PR`, `MAX_TOKENS_PER_WINDOW_PER_INSTALLATION`, `MAX_TOKENS_WINDOW_SECONDS`, `OTEL_TRACES_SAMPLER_ARG` (head-sample arg; default `1.0`). For each: a one-line description; classification `tunable`. Each tunable must have a starting value listed in `operational-runbooks.md` § Numeric tunables — this section names them; that section sets the starting values.
- **Secret management abstraction:** must restate: secrets are read via `SecretSource.getSecret(name)`. The MVP implementation reads from process env. Operators may substitute a managed secret manager (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager, Azure Key Vault, etc.) without changing pipeline code; the substitution lives in the worker bootstrap. The interface name `SecretSource` must appear verbatim and match `system-design.md` § Secret storage abstraction.
- **Health surfaces:** three subsections.
  - `### Liveness` — an HTTP `GET` route that returns `200` if the process can answer; bounded in latency; performs no external IO. The exact path is named (recommend `/healthz/live`); IDG may finalize the string but it must be referenced by name.
  - `### Readiness` — an HTTP `GET` route that returns `200` only if the process has completed bootstrap (config loaded, `SecretSource` reachable for the keys it will need, queue client connected). The exact path is named (recommend `/healthz/ready`).
  - `### Dependency check` — an HTTP `GET` route that returns `200` only when (a) Redis is reachable; (b) the App can mint an installation token (sentinel call); (c) when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the OTLP collector is reachable (a non-blocking probe; failure here returns a degraded status, not `5xx`, because telemetry is non-critical). The exact path is named (recommend `/healthz/deps`).
- **`.env.example`:** a complete code-fenced block IDG must include verbatim. The block must contain every variable listed in §§ Secrets, Config, and Tunables, with placeholder values (no real secrets), and must be classified by inline comments. SPECTRA mandates that the block contains, at minimum, the literal lines:

  ```
  # secrets (read via SecretSource; env is the MVP implementation)
  GITHUB_APP_PRIVATE_KEY=
  GITHUB_APP_WEBHOOK_SECRET=
  ANTHROPIC_API_KEY=

  # config
  PORT=3000
  REDIS_URL=redis://localhost:6379
  GITHUB_APP_ID=
  GITHUB_APP_SLUG=
  OTEL_SERVICE_NAME=prisma-review-bot
  OTEL_EXPORTER_OTLP_ENDPOINT=
  LOG_LEVEL=info
  INSTALLATION_REPLAY_WINDOW_SECONDS=300

  # tunables (starting values; see operational-runbooks.md § Numeric tunables)
  QUEUE_CONCURRENCY=4
  JOB_TIMEOUT_SECONDS=120
  RETRY_TRANSIENT_MAX_ATTEMPTS=3
  RETRY_TRANSIENT_BACKOFF_BASE_MS=500
  RETRY_TRANSIENT_BACKOFF_MAX_MS=8000
  RETRY_RATELIMIT_MAX_ATTEMPTS=5
  MAX_TOKENS_PER_PR=60000
  MAX_TOKENS_PER_WINDOW_PER_INSTALLATION=2000000
  MAX_TOKENS_WINDOW_SECONDS=3600
  OTEL_TRACES_SAMPLER_ARG=1.0
  ```

  IDG includes the block byte-for-byte; the placeholder values for tunables are the same as those in `operational-runbooks.md` § Numeric tunables (single source of truth on values; the values are repeated here because `.env.example` is itself a deliverable).

### 5. Acceptance criteria (GIVEN/WHEN/THEN)

See YAML block (IDs `DEP-1` … `DEP-6`).

### 6. Cross-file consistency requirements

- Component names referenced (`apps/github-app/webhook-ingress`, the worker app, Redis) match `system-design.md` § Component map and § Queue and async model.
- The `SecretSource` interface name matches `system-design.md` § Secret storage abstraction verbatim.
- The `JobQueue` interface name (when referenced) matches `system-design.md` § Queue and async model.
- The OTLP env var `OTEL_EXPORTER_OTLP_ENDPOINT` matches `observability.md` § Metrics + traces.
- Every tunable listed in `### Tunables` appears as a row in `operational-runbooks.md` § Numeric tunables, with a starting value matching the `.env.example` value.
- The replay window env var `INSTALLATION_REPLAY_WINDOW_SECONDS` matches `system-design.md` § Queue and async model § Replay protection wording.
- The phrase `2xx-on-accept` is not redefined here; references back to `api-contracts.md` § Webhook ingress contract are sufficient.

### 7. Out of scope for this file

- No event taxonomy or metric inventory (lives in `observability.md`).
- No retry numeric values' rationale (lives in `operational-runbooks.md` § Numeric tunables).
- No vendor pinning for the OTLP collector — operators choose.
- No vendor pinning for the secret manager — operators choose.
- No flow descriptions (live in `data-flow.md`).
- No new components or schemas.

---

## File 4 — `docs/observability.md`

### 1. Purpose

The OQ-3-resolving observability contract: the structured-log field set, event taxonomy, metric inventory, trace span hierarchy, sampling configuration, redaction allowlist, and SLI/SLO posture. Consumed by `data-flow.md` (which references events by name), by `operational-runbooks.md` (which references metrics and events by name in Detection steps), and by Phase 4 implementers (who wire `@opentelemetry/*` and the redactor).

### 2. Required sections (exact H2/H3 in order)

- `## Resolution of OQ-3 (recap)`
- `## Logs`
  - `### Top-level fields`
  - `### Event taxonomy`
- `## Metrics`
  - `### Naming convention`
  - `### Metric inventory`
  - `### Cardinality discipline`
- `## Traces`
  - `### Span hierarchy`
  - `### Trace context propagation`
- `## Sampling`
- `## Redaction allowlist`
- `## SLI / SLO posture`

### 3. Research questions answered

- What is the OQ-3 resolution, and how does it bind logs, metrics, and traces?
- What is the fixed top-level field set on every structured log event, and in what order?
- What events does the App emit, what triggers each, what fields beyond the base set does each carry, and what redaction notes apply?
- What metrics does the App expose, what type is each (counter / gauge / histogram), and what labels does each carry?
- How is high-label-cardinality avoided?
- What is the trace span hierarchy, and how is trace context propagated across the BullMQ boundary?
- What is the sampling posture, and what knob tunes it?
- Which fields are on the redaction allowlist (i.e., explicitly permitted to leave the process)?
- What SLIs does the App track in MVP, and where do the SLO numerics live?

### 4. Required content per section

- **Resolution of OQ-3 (recap):** must restate, in two paragraphs, the OQ-3 decision: vendor-neutral, OpenTelemetry-first; logs to stdout JSON; metrics and traces via OTLP/HTTP to an operator-supplied collector at `OTEL_EXPORTER_OTLP_ENDPOINT`; head-sample default `1.0`; emission-time redactor against an explicit allowlist; PII/secret guard fail-closed. Must link to the Phase 2 contracts that reference observability (`api-contracts.md` validator/ranker/publisher contracts emit `RejectionLogEntry`; `publication-policy.md` references the structured log; `mvp-scope.md` § Observability and logging).
- **Logs:**
  - `### Top-level fields` — must declare a stable order. Required fields, in this order: `ts` (UTC ISO-8601), `level` (`debug` | `info` | `warn` | `error`), `service` (matches `OTEL_SERVICE_NAME`), `event` (the event name from § Event taxonomy), `trace_id`, `span_id`, `installation_id`, `repository_id`, `pull_request_number`, `idempotency_key`, plus the event-specific payload object under a key named `payload`. Must state that fields not in this list and not on the redaction allowlist are dropped at emission time.
  - `### Event taxonomy` — a table with columns `event name | trigger | fields beyond base | redaction notes | terminal? (yes/no — i.e., does this event carry the terminal job state)`. The required event names, in this order, are exactly:
    1. `webhook.received` — trigger: HTTP request arrives at `apps/github-app/webhook-ingress`. Fields: `event_type` (the GitHub event name), `delivery_id` (the `X-GitHub-Delivery` header value). Redaction: header signature value never logged. Terminal: no.
    2. `webhook.signature_failed` — trigger: HMAC-SHA-256 verification fails. Fields: `event_type`, `delivery_id`. Redaction: the signature itself never logged; raw body never logged. Terminal: no.
    3. `job.enqueued` — trigger: `deriveIdempotencyKey` produces a key and the queue accepts. Fields: `head_sha`. Redaction: none beyond base. Terminal: no.
    4. `job.started` — trigger: BullMQ worker picks up the job. Fields: `head_sha`. Redaction: none. Terminal: no.
    5. `prefilter.skipped` — trigger: prefilter short-circuits with reason `oversized` or `all-excluded`. Fields: `reason` (`oversized` | `all-excluded`), `file_count`, `changed_lines`. Redaction: file paths only when on allowlist (paths are allowed; file contents never). Terminal: no.
    6. `prefilter.accepted` — trigger: prefilter produced a `ProviderReviewInput`. Fields: `file_count`, `hunk_count`, `total_changed_lines`. Redaction: counts only; no diff content. Terminal: no.
    7. `provider.called` — trigger: `Provider.review` invoked. Fields: `provider_id` (e.g., `anthropic`), `model`, `input_token_estimate`. Redaction: `ProviderReviewInput` body never logged; only counts and shape. Terminal: no.
    8. `provider.error` — trigger: `Provider.review` throws `ProviderError`. Fields: `provider_id`, `variant` (`transport` | `auth` | `rate_limit` | `capability` | `schema_validation`), `attempt`, `retry_class` (`transient` | `rate_limited` | `non_transient`). Redaction: the API key never logged; provider raw body never logged. Terminal: no (unless retries exhausted, in which case `job.terminal` follows).
    9. `validator.rejected` — trigger: validator drops a finding or rejects the entire `ProviderReviewOutput`. Fields: `RejectionLogEntry` shape inline (`finding_id`, `stage = 'validator'`, `reason_code`, `reason_message`, `provider_output_excerpt`, `timestamp`). Redaction: `provider_output_excerpt` is redacted at the source per `review-findings-schema.md`. Terminal: no.
    10. `ranker.dropped` — trigger: ranker emits a `RejectionLogEntry` with `stage = 'ranker'` (rare; the ranker does not drop findings, but may emit informational entries; this event exists for symmetry). Fields: `RejectionLogEntry` shape inline. Redaction: same as validator. Terminal: no.
    11. `publisher.published` — trigger: publisher creates a Checks run and (when `mode = summary-plus-inline`) inline review comments. Fields: `mode`, `inline_count`, `summary_count`, `dropped_count`, `checks_run_id`. Redaction: finding bodies never logged at this event (counts only); `RejectionLogEntry` records are emitted via `publisher.dropped`. Terminal: no.
    12. `publisher.dropped` — trigger: publisher emits a `RejectionLogEntry` with `stage = 'publisher'`. Fields: `RejectionLogEntry` shape inline (`reason_code` ∈ {`per_file_cap_exhausted`, `per_pr_cap_exhausted`, `severity_below_floor`, `confidence_below_floor`, `dedupe_collapsed`}). Redaction: `provider_output_excerpt` redacted. Terminal: no.
    13. `job.terminal` — trigger: the job reaches a terminal state. Fields: `state` (`succeeded` | `failed_terminal` | `discarded_idempotent`), `failure_reason_code` (string or null), `duration_ms`. Redaction: none beyond base. Terminal: yes.
- **Metrics:**
  - `### Naming convention` — must state: metric names use the prefix `prisma_`, lowercase snake_case, suffixed by unit when applicable (`_seconds`, `_bytes`, `_total` for counters). All labels are low-cardinality.
  - `### Metric inventory` — a table with columns `name | type | labels | description`. Required entries, at minimum:
    - `prisma_webhooks_received_total` — counter — labels: `event_type`, `outcome` (`accepted` | `signature_failed` | `discarded_idempotent` | `discarded_other_event` | `enqueue_failed`).
    - `prisma_jobs_inflight` — gauge — labels: none (or only static labels like `service`).
    - `prisma_jobs_terminal_total` — counter — labels: `state` (`succeeded` | `failed_terminal` | `discarded_idempotent`), `failure_reason_code` (low-cardinality enum; bounded set).
    - `prisma_provider_call_seconds` — histogram — labels: `provider_id`, `outcome` (`success` | `error.transport` | `error.auth` | `error.rate_limit` | `error.capability` | `error.schema_validation`).
    - `prisma_provider_retry_total` — counter — labels: `provider_id`, `retry_class` (`transient` | `rate_limited`).
    - `prisma_findings_published_total` — counter — labels: `mode`, `surface` (`inline` | `summary`).
    - `prisma_findings_dropped_total` — counter — labels: `stage` (`validator` | `ranker` | `publisher`), `reason` (the `reason_code` enum from `RejectionLogEntry`).
    - `prisma_prefilter_skipped_total` — counter — labels: `reason` (`oversized` | `all-excluded`).
    - `prisma_redactor_dropped_total` — counter — labels: `event` (the event name that was dropped). Counts events the redactor refused to emit due to a fail-closed match.
    - `prisma_queue_lag_seconds` — gauge or histogram — labels: none. Time from `job.enqueued` to `job.started`.
  - `### Cardinality discipline` — must state: high-cardinality identifiers (`installation_id`, `repository_id`, `pull_request_number`, `idempotency_key`, `head_sha`, `delivery_id`, `checks_run_id`) **must not** appear as metric label values. They appear as structured-log fields and as trace attributes only. The reason is restated: unbounded label values blow up time-series storage.
- **Traces:**
  - `### Span hierarchy` — must declare the hierarchy:
    - `http.webhook` (root for ingress) — opens at HTTP request entry to `apps/github-app/webhook-ingress`, closes after the 2xx response is sent.
    - `queue.enqueue` (child of `http.webhook`) — wraps the BullMQ enqueue call.
    - `worker.job` (root for worker, linked-to `http.webhook` via the propagated trace context) — opens on BullMQ job pickup, closes on terminal state.
    - Children of `worker.job`, in order:
      - `pipeline.config_load`
      - `pipeline.snapshotter`
      - `pipeline.prefilter`
      - `pipeline.provider`
      - `pipeline.validator`
      - `pipeline.ranker`
      - `pipeline.publisher`
    - High-cardinality identifiers (`installation_id`, `repository_id`, `pull_request_number`, `head_sha`, `idempotency_key`) appear as **span attributes**, never as metric labels.
  - `### Trace context propagation` — must state: a `traceparent` string is included in `JobPayload` (the only addition Phase 3 makes to the Phase 2 `JobPayload` shape — explicitly call this out as a forward-compatible extension; the field is optional and carries trace context only, no semantic data, no secrets). The worker reads `traceparent` and uses it to start `worker.job` as a span with the ingress's `http.webhook` as its parent. OpenTelemetry's `propagator` API handles the mechanics; this document names the convention.
- **Sampling:** must state: parent-based sampler with head-sample default `1.0` for MVP single-tenant low-volume operation. Configurable via `OTEL_TRACES_SAMPLER_ARG` (a number in `[0,1]`). Reduction is left to operator discretion; this document states the default and the knob.
- **Redaction allowlist:** must state explicitly that **only fields on the allowlist may leave the process**. The allowlist is exactly:
  - The fixed top-level log fields listed in § Top-level fields.
  - Per-event fields named in § Event taxonomy (counts, enums, ids that are not secrets, ISO timestamps).
  - For `RejectionLogEntry`: `finding_id`, `stage`, `reason_code`, `reason_message`, `provider_output_excerpt` (already redacted at the source per `review-findings-schema.md`), `timestamp`.
  - Span attributes named in § Span hierarchy.
  - Metric labels named in § Metric inventory.
  Anything not on the allowlist is **dropped or hashed** at emission time. The PII/secret guard is fail-closed: if a value matching a secret-shape pattern (PEM block markers, GitHub installation token shape, provider API key shape, webhook signature header shape) is detected in a payload position, the **entire event is dropped** and the `prisma_redactor_dropped_total` counter is incremented with `event` label set to the dropped event name. No partial emission.
- **SLI / SLO posture:** must state: SLIs are defined here; SLO numerics live in `operational-runbooks.md` § Numeric tunables (or in a deliberate non-numeric "operator decides" note for MVP). Required SLIs:
  - **Webhook 2xx-on-accept rate** — the fraction of `webhook.received` events whose outcome is `accepted` or `discarded_idempotent` or `discarded_other_event` (i.e., the App responded `2xx` within budget). Sourced from `prisma_webhooks_received_total{outcome=...}`.
  - **Job-to-publish latency p95** — the p95 of (`job.terminal.duration_ms` for jobs whose `state = 'succeeded'`). Sourced from a histogram derived from the `job.terminal` event or an explicit `prisma_job_duration_seconds` histogram (IDG must add it to § Metric inventory if not already present).
  - **Provider error rate** — the fraction of `prisma_provider_call_seconds` observations with `outcome != 'success'`. Cap-checked separately for `error.rate_limit` (which is operationally distinct from outage signal).
  - **Findings-published-per-PR distribution** — derived from `prisma_findings_published_total`. The distribution shape is the SLI; a target floor (e.g., median > 0 in `summary-plus-inline` deployments) is operator-set in MVP.

### 5. Acceptance criteria (GIVEN/WHEN/THEN)

See YAML block (IDs `OBS-1` … `OBS-7`).

### 6. Cross-file consistency requirements

- Every event name in § Event taxonomy is referenced by name in `data-flow.md` (in at least one flow's step list) and is the Detection signal of at least one runbook in `operational-runbooks.md`.
- Every metric name in § Metric inventory is referenced by name in at least one runbook's Detection step.
- The `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_TRACES_SAMPLER_ARG` env vars match `deployment.md` § Environment variables.
- The redaction allowlist is the single source of truth on what may leave the process; `system-design.md` § Cross-cutting concerns § Structured logging fields refers to it without redefining.
- `RejectionLogEntry` field names match `review-findings-schema.md` § Rejection log entry shape.
- `ProviderError` variants (`transport`, `auth`, `rate_limit`, `capability`, `schema_validation`) match `api-contracts.md` § Provider adapter contract.
- Span names are exactly `http.webhook`, `queue.enqueue`, `worker.job`, `pipeline.config_load`, `pipeline.snapshotter`, `pipeline.prefilter`, `pipeline.provider`, `pipeline.validator`, `pipeline.ranker`, `pipeline.publisher`.
- Terminal state strings (`succeeded`, `failed_terminal`, `discarded_idempotent`) match `api-contracts.md` § Async job contract.

### 7. Out of scope for this file

- No vendor pinning for logs, metrics, or traces — operator chooses the OTLP collector destination.
- No specific log shipper or log sink choice — stdout JSON is the contract; the platform handles collection.
- No SLO numeric targets (MVP defers to operator).
- No retry numeric values, queue concurrency numeric values, or cost-ceiling numeric values.
- No event payload definitions outside the named events; if Phase 4 needs a new event, IDG adds it here in a future spec, not in implementation.

---

## File 5 — `docs/operational-runbooks.md`

### 1. Purpose

The operator's reference: one runbook per scenario the App is likely to encounter, each with `Symptom`, `Detection`, `Diagnosis`, `Mitigation`, `Recovery`, `Postmortem template pointer`. Closes with a single numeric-tunables table that is the MVP starting-values source of truth. Consumed by on-call operators and by `deployment.md` § Environment variables (which references the tunables here).

### 2. Required sections (exact H2/H3 in order)

- `## How to read these runbooks`
- `## Runbooks`
  - `### Webhook signatures are failing`
  - `### Queue is backing up`
  - `### Provider errors are climbing`
  - `### Findings rejected by validator at high rate`
  - `### Replay or duplicate deliveries`
  - `### Oversized PRs starving the queue`
  - `### Stuck failed_terminal rate spike`
  - `### Rotating webhook secret`
  - `### Rotating provider API key`
  - `### Revoking and reinstalling the App on a repo`
  - `### Disaster recovery — Redis loss`
- `## Numeric tunables`
- `## Postmortem template`

### 3. Research questions answered

- For each likely operational scenario, what is the externally visible symptom, what metric or event signals it, what diagnostic steps narrow the cause, what mitigates the immediate impact, what restores normal operation, and where is the postmortem template?
- What are the MVP starting values for every tunable named in `deployment.md` § Environment variables, and what is the one-line rationale for each?
- What is the disaster-recovery posture for Redis loss, and what is acceptable to lose?

### 4. Required content per section

- **How to read these runbooks:** must state: each runbook is structured `Symptom`, `Detection`, `Diagnosis`, `Mitigation`, `Recovery`, `Postmortem template pointer`. Detection signals are named events (from `observability.md` § Event taxonomy) or named metrics (from `observability.md` § Metric inventory). Mitigations name env vars (from `deployment.md`) and components (from `system-design.md`). The postmortem template is at `## Postmortem template` at the end of this file. MVP tunable starting values are in `## Numeric tunables`; runbooks reference tunables by name, not by numeric value.
- **Runbooks:** one subsection per scenario, in the order above. Each must contain, in this exact order: `Symptom`, `Detection`, `Diagnosis`, `Mitigation`, `Recovery`, `Postmortem template pointer`. Required content per scenario:
  - **Webhook signatures are failing.** Symptom: GitHub webhook deliveries return `4xx` from the App; PRs are not reviewed. Likely cause: the webhook secret was rotated in GitHub but not in the App (or vice versa). Detection: spike in `prisma_webhooks_received_total{outcome="signature_failed"}`; spike in `webhook.signature_failed` events. Diagnosis: confirm `GITHUB_APP_WEBHOOK_SECRET` matches the value in the GitHub App settings; check the deployment's most recent secret rotation. Mitigation: re-sync the secret using `## Rotating webhook secret`. Recovery: deliver a test event from GitHub's "Recent Deliveries" UI; verify a `webhook.received` event with `outcome=accepted`. Postmortem template pointer: `## Postmortem template`.
  - **Queue is backing up.** Symptom: PR reviews lag; users see no Checks output for newly opened PRs for many minutes. Likely cause: provider slowness, stuck job, or insufficient `QUEUE_CONCURRENCY`. Detection: rising `prisma_jobs_inflight`; rising `prisma_queue_lag_seconds`; absence of corresponding rise in `prisma_jobs_terminal_total`. Diagnosis: inspect span durations for `pipeline.provider`; check `prisma_provider_call_seconds` p95; check for stuck jobs in BullMQ. Mitigation: temporarily increase `QUEUE_CONCURRENCY`; reduce `JOB_TIMEOUT_SECONDS` to fail stuck jobs faster; if a single repo is producing oversized PRs, tighten `MAX_TOKENS_PER_PR` or rely on the prefilter oversized fast-path. Recovery: queue lag returns to baseline. Postmortem template pointer: `## Postmortem template`.
  - **Provider errors are climbing.** Symptom: many PRs end with `failed_terminal`; reviewers see "review unavailable" Checks summaries. Likely cause: provider outage, rate-limit hit, or revoked API key. Detection: rising `prisma_provider_call_seconds{outcome="error.transport"}` or `error.rate_limit`; spike in `provider.error` events with `variant=auth` (key revoked) or `variant=rate_limit` (rate-limited) or `variant=transport` (outage). Diagnosis: check the provider's status page; check `ANTHROPIC_API_KEY` validity; check whether `prisma_provider_retry_total{retry_class="rate_limited"}` is dominating. Mitigation: for `auth`, rotate the key via `## Rotating provider API key`; for `rate_limit`, raise `RETRY_RATELIMIT_MAX_ATTEMPTS` cautiously and consider tightening `MAX_TOKENS_PER_PR`; for `transport`, wait for the provider to recover; the App will retry per the Transient class. Recovery: error rate returns below baseline. Postmortem template pointer: `## Postmortem template`.
  - **Findings rejected by validator at high rate.** Symptom: most PRs produce a `neutral` Checks run with "no findings produced". Likely cause: provider schema drift; the provider is returning shape that fails the Zod schema at the adapter boundary. Detection: rising `prisma_findings_dropped_total{stage="validator", reason="provider_output_zod_failed"}`; spike in `validator.rejected` events. Diagnosis: inspect a few `validator.rejected` events for the `provider_output_excerpt` (already redacted) to see what shape the provider is now emitting; compare against the `ProviderReviewOutput` Zod schema. Mitigation: triage the schema delta; if the change is benign, update the adapter to map the new shape into `ProviderReviewOutput`; if the change is a bug on the provider side, contact the provider; in the meantime, the App's "drop with audit log" policy keeps existing PR comments unaffected. Recovery: validator rejection rate returns to baseline. Postmortem template pointer: `## Postmortem template`.
  - **Replay or duplicate deliveries.** Symptom: a single PR appears to be processed multiple times; users wonder if the bot is duplicating findings. Likely cause: GitHub redelivery (normal); idempotency window not honoring. Detection: spike in `prisma_jobs_terminal_total{state="discarded_idempotent"}` with no user-visible duplication (good — idempotency is working); or spike in user reports of duplicate inline comments (bad — across-run dedupe failed). Diagnosis: confirm `INSTALLATION_REPLAY_WINDOW_SECONDS` is set to a sane value; confirm the per-PR already-published dedupe set source (GitHub Checks/Review-Comments history of this App on this PR, per `publication-policy.md` § Dedupe behavior) is reachable. Mitigation: if duplicates are reaching PRs, verify the Checks history query is returning results; check the `dedupe_key` derivation. Recovery: duplicate publication ceases. Postmortem template pointer: `## Postmortem template`.
  - **Oversized PRs starving the queue.** Symptom: large PRs starve the worker; small PRs lag. Likely cause: prefilter caps too lax; oversized PRs are reaching the provider. Detection: many `prefilter.accepted` events with high `total_changed_lines`; rising `prisma_provider_call_seconds` p95; few `prefilter.skipped{reason="oversized"}` events. Diagnosis: inspect typical PR sizes for the affected repo; compare against `max_files` and `max_changed_lines` from `config-spec.md`. Mitigation: tighten `max_files` and `max_changed_lines` defaults at the App level (operator-side override) or instruct repo admins to tighten via `.github/review-bot.yml`. Recovery: oversized fast-path kicks in for large PRs; queue lag returns. Postmortem template pointer: `## Postmortem template`.
  - **Stuck failed_terminal rate spike.** Symptom: `prisma_jobs_terminal_total{state="failed_terminal"}` rises broadly across all installations. Likely cause: a dependency or upstream change affecting the entire fleet (provider auth issue, GitHub API change, snapshotter bug). Detection: broad-fleet rise in `failed_terminal`; correlated event taxonomy spikes (`provider.error`, `validator.rejected`, or other). Diagnosis: identify which `failure_reason_code` is dominant; cross-reference with provider status, GitHub status, and the most recent App deployment. Mitigation: roll back the most recent deployment if the spike correlates; if upstream, raise the relevant retry class's `MAX_ATTEMPTS` cautiously and wait. Recovery: `failed_terminal` rate returns to baseline. Postmortem template pointer: `## Postmortem template`.
  - **Rotating webhook secret.** A procedure with zero-downtime steps. Required steps:
    1. Generate a new webhook secret value.
    2. In GitHub App settings, add the new secret (GitHub supports a single secret; this step replaces the old value — see GitHub's docs for the exact UX).
    3. Update the App's deployment to read the new secret via `SecretSource` (env var `GITHUB_APP_WEBHOOK_SECRET` for the MVP implementation).
    4. Roll the App processes (rolling restart) so each replica picks up the new secret.
    5. Trigger a test webhook from the GitHub UI; confirm `webhook.received{outcome=accepted}`.
    Mitigation if step 2 and step 3 are not synchronized: deliveries fail with `signature_failed` until both sides match — this is acceptable for a brief window during planned rotation; expect a transient spike in `prisma_webhooks_received_total{outcome="signature_failed"}`. Recovery: signature failures return to zero. Postmortem template pointer: `## Postmortem template`.
  - **Rotating provider API key.** A procedure. Required steps:
    1. Mint a new provider API key in the provider's dashboard.
    2. Stage the new key in `SecretSource` under `ANTHROPIC_API_KEY` (or the equivalent `provider.api_key` slot for non-Anthropic adapters).
    3. Roll the App processes; each replica picks up the new key on startup.
    4. Verify with a sentinel call (the `provider.called` event followed by a successful provider response).
    5. Revoke the old key in the provider's dashboard.
    Postmortem template pointer: `## Postmortem template`.
  - **Revoking and reinstalling the App on a repo.** A procedure. Required steps:
    1. The repo admin uninstalls the App from the repository or organization in GitHub.
    2. The App stops receiving webhook deliveries for that installation; in-flight jobs run to completion (no graceful eviction in MVP — they may fail with `auth` errors when the installation token cannot be minted).
    3. Existing Checks runs and inline comments authored by the App are not retracted (cleanup is post-MVP per `product-spec.md` § Install the App).
    4. To reinstall, the admin re-installs the App; a new `installation_id` is minted.
    Postmortem template pointer: `## Postmortem template` (only when the revoke was unintentional).
  - **Disaster recovery — Redis loss.** Symptom: Redis becomes unreachable or its data is lost. Likely cause: Redis instance failure, accidental flush, infrastructure incident. Detection: dependency check (`/healthz/deps` or equivalent) fails; spike in `prisma_jobs_terminal_total{state="failed_terminal"}`; spike in webhook 5xx responses (because enqueue fails). Diagnosis: confirm Redis is reachable; confirm BullMQ connection; confirm replay-protection cache state. Mitigation: restore Redis (from snapshot if possible; from cold start otherwise). Recovery: state lost on cold-start: the in-flight idempotency window and the replay-protection cache. Acknowledged consequence: GitHub may redeliver webhooks during the outage, and the App may accept some replays after restart (the across-run dedupe set sourced from GitHub Checks/Review-Comments history on the PR remains the canonical de-duplication signal, so duplicate inline publication is still prevented; what is lost is short-window replay protection, not finding-level idempotency). Postmortem template pointer: `## Postmortem template`.
- **Numeric tunables:** an introductory paragraph that **must explicitly state**: "These are MVP starting values, not ADR commitments. Operators are expected to revise based on real traffic." Then a table with columns `name | starting value | classification | rationale (one line)`. Required rows, with the starting values matching `deployment.md` § `.env.example`:
  - `QUEUE_CONCURRENCY` | `4` | `tunable` | "Bounds in-flight provider calls per worker; 4 is conservative for small-instance class."
  - `JOB_TIMEOUT_SECONDS` | `120` | `tunable` | "Bounds wall time per PR; matches typical provider p95 plus headroom."
  - `RETRY_TRANSIENT_MAX_ATTEMPTS` | `3` | `tunable` | "Bounds retries on `transport` and similar transient errors; exponential backoff caps total wait."
  - `RETRY_TRANSIENT_BACKOFF_BASE_MS` | `500` | `tunable` | "Initial backoff for transient retries; jittered."
  - `RETRY_TRANSIENT_BACKOFF_MAX_MS` | `8000` | `tunable` | "Cap on backoff growth so a single PR never waits absurdly long."
  - `RETRY_RATELIMIT_MAX_ATTEMPTS` | `5` | `tunable` | "Bounds retries on `rate_limit`; honors `Retry-After` headers when provided."
  - `MAX_TOKENS_PER_PR` | `60000` | `tunable` | "Cost ceiling proxy per PR; the prefilter shed-load fast-path triggers before this is hit on oversized diffs."
  - `MAX_TOKENS_PER_WINDOW_PER_INSTALLATION` | `2000000` | `tunable` | "Cost ceiling proxy per installation per window; protects against PR-storm cost blowups."
  - `MAX_TOKENS_WINDOW_SECONDS` | `3600` | `tunable` | "Sliding window for the per-installation cost ceiling."
  - `OTEL_TRACES_SAMPLER_ARG` | `1.0` | `tunable` | "Head-sample rate for traces; 1.0 is fine for MVP single-tenant volume."
  - `INSTALLATION_REPLAY_WINDOW_SECONDS` | `300` | `config` | "How long `X-GitHub-Delivery` is cached per installation for replay protection."
  - `LOG_LEVEL` | `info` | `config` | "Default log verbosity; raise to `debug` only during incident triage."
- **Postmortem template:** a short template a runbook can point to. Must contain the headings: `Incident summary`, `Timeline (UTC)`, `Detection signal(s)`, `Mitigation taken`, `Recovery confirmation`, `Root cause`, `Action items`. One line per heading is sufficient — this is a template, not a specific incident.

### 5. Acceptance criteria (GIVEN/WHEN/THEN)

See YAML block (IDs `RB-1` … `RB-7`).

### 6. Cross-file consistency requirements

- Every Detection step references metric or event names that exist in `observability.md` § Metric inventory or § Event taxonomy.
- Every Mitigation step that names an env var matches a name declared in `deployment.md` § Environment variables.
- Every component name referenced (e.g., `apps/github-app/webhook-ingress`, `packages/providers/anthropic`) matches `system-design.md` § Component map.
- The `## Numeric tunables` table contains every variable classified as `tunable` in `deployment.md` § Tunables, plus selected `config` rows where a starting value rationale is useful (`INSTALLATION_REPLAY_WINDOW_SECONDS`, `LOG_LEVEL`).
- Starting values in `## Numeric tunables` match the values in `deployment.md` § `.env.example` byte-for-byte.
- The "MVP starting values, not ADR commitments" sentence appears verbatim in the introductory paragraph of `## Numeric tunables`.
- The accepted retry classes (Transient, Rate-limited, Non-transient) match `system-design.md` § Error taxonomy mapping.
- The "review unavailable" Checks-summary wording (referenced in `## Provider errors are climbing` recovery) matches `data-flow.md` § Flow 3 wording.
- The "no findings produced" Checks-summary wording (referenced in `## Findings rejected by validator at high rate`) matches `data-flow.md` § Flow 4 wording.

### 7. Out of scope for this file

- No new architectural decisions — runbooks describe operations of the system as designed.
- No event taxonomy or metric inventory definitions (live in `observability.md`).
- No environment variable definitions (live in `deployment.md`).
- No SLO numeric targets — the runbooks reference SLIs from `observability.md` but do not set SLOs.
- No vendor-specific operations beyond Anthropic's adapter as the OQ-1 reference; runbooks are framed in terms of the `Provider` interface where the same procedure applies to any adapter.

---

## Cross-cutting consistency-check pass (must pass before Phase 3 exit)

1. **Component-name uniformity.** Every component path string in `system-design.md` § Component map (`apps/github-app/webhook-ingress`, `packages/github/installation-auth`, `packages/core/snapshotter`, `packages/core/prefilter`, `packages/providers (provider abstraction surface)`, `packages/providers/anthropic`, `packages/core/validator-ranker`, `packages/github/check-runs`, `packages/github/review-comments`, `packages/config/config-loader`, `packages/shared/audit-log`) appears verbatim wherever referenced in `data-flow.md`, `observability.md`, `deployment.md`, and `operational-runbooks.md`. No alternate spellings.
2. **Pipeline-stage uniformity.** The five stages `prefilter`, `provider`, `validator`, `ranker`, `publication cap` appear in this order in `system-design.md` § End-to-end sequence, in `data-flow.md` § Flow 1, and in `observability.md` § Span hierarchy (as `pipeline.prefilter`, `pipeline.provider`, `pipeline.validator`, `pipeline.ranker`, `pipeline.publisher`).
3. **Schema-chain integrity.** `ProviderReviewInput → ProviderReviewOutput → NormalizedFinding → RankedFindings → PublicationResult` is named identically wherever referenced; `RejectionLogEntry`, `JobPayload`, `JobResult`, `WebhookIngressRequest`, `WebhookIngressResponse`, `PublicationPolicy`, `PublishContext` are reused verbatim from Phase 2.
4. **Phase 1 identifier reuse.** `ProviderError`, `ProviderCapabilities` appear verbatim wherever referenced.
5. **Mode-name uniformity.** `dry-run`, `summary-only`, `summary-plus-inline` appear with identical casing.
6. **Webhook contract reuse.** `POST /webhooks/github`, `X-Hub-Signature-256`, `X-GitHub-Event`, `X-GitHub-Delivery`, the accepted-events set `{pull_request.opened, pull_request.synchronize, pull_request.reopened}`, the phrase `2xx-on-accept`, and the function name `deriveIdempotencyKey` are reused verbatim from Phase 2.
7. **Repo-local config path uniformity.** `.github/review-bot.yml` appears verbatim wherever referenced in Phase 3 (`system-design.md`, `data-flow.md`, `operational-runbooks.md`).
8. **OQ-2 default reuse.** `5`, `1`, `medium`, `0.7`, `dry-run` are not redeclared in Phase 3 docs; references use Phase 2 docs as the source.
9. **Resolution log presence.** `docs/open-questions.md` § Resolution log contains the OQ-3 entry dated `2026-04-30`; OQ-4, OQ-5, OQ-6, OQ-7, OQ-8 remain in their respective sections unchanged.
10. **Event taxonomy / data-flow correspondence.** Every event name in `observability.md` § Event taxonomy is referenced in at least one step in `data-flow.md`; every event name appearing as a step in `data-flow.md` exists in `observability.md` § Event taxonomy.
11. **Metric / runbook correspondence.** Every metric name in `observability.md` § Metric inventory is referenced in at least one runbook's Detection step; every metric name appearing in a runbook exists in `observability.md` § Metric inventory.
12. **Env var / runbook correspondence.** Every variable name appearing in a runbook's Mitigation step matches a name in `deployment.md` § Environment variables; every `tunable`-classified variable in `deployment.md` has a row in `operational-runbooks.md` § Numeric tunables; values are byte-equivalent between `deployment.md` § `.env.example` and `operational-runbooks.md` § Numeric tunables.
13. **OTLP / sampling env vars.** `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_TRACES_SAMPLER_ARG` appear in both `deployment.md` § Environment variables and `observability.md` (Metrics + traces / Sampling).
14. **`SecretSource` interface uniformity.** The interface name `SecretSource` appears verbatim in `system-design.md` § Secret storage abstraction and `deployment.md` § Secret management abstraction.
15. **`JobQueue` interface uniformity.** The interface name `JobQueue` appears verbatim in `system-design.md` § Queue and async model and (when referenced) in `deployment.md` and `operational-runbooks.md`.
16. **MVP-tunables disclaimer.** The exact sentence "These are MVP starting values, not ADR commitments. Operators are expected to revise based on real traffic." appears verbatim in `operational-runbooks.md` § Numeric tunables.
17. **Anthropic adapter location.** `packages/providers/anthropic` matches the OQ-1 resolution log entry across `system-design.md` and `operational-runbooks.md`.
18. **Redaction allowlist as single source.** Only `observability.md` § Redaction allowlist enumerates the allowlist; `system-design.md` § Cross-cutting concerns § Structured logging fields and `data-flow.md` § Data-at-rest boundaries reference it without redefining.
19. **Fixed log-field order.** The top-level log field order in `observability.md` § Top-level fields (`ts`, `level`, `service`, `event`, `trace_id`, `span_id`, `installation_id`, `repository_id`, `pull_request_number`, `idempotency_key`, `payload`) is the only authoritative ordering.
20. **No vendor pinning beyond decided.** No Phase 3 doc names a specific OTLP collector vendor (Honeycomb, Datadog, etc.), a specific managed-secret vendor, or a non-Anthropic provider.

---

## Machine-readable acceptance criteria (YAML)

```yaml
files:
  docs/system-design.md:
    acceptance:
      - id: SD-1
        given: docs/system-design.md exists
        when: a reader inspects the component map section
        then: subsections exist for apps/github-app/webhook-ingress, packages/github/installation-auth, packages/core/snapshotter, packages/core/prefilter, packages/providers (provider abstraction surface), packages/providers/anthropic, packages/core/validator-ranker, packages/github/check-runs, packages/github/review-comments, packages/config/config-loader, and packages/shared/audit-log, each containing Responsibility, Owns-which-schemas, Depends-on, Public surface, and Invariants in that order
      - id: SD-2
        given: docs/system-design.md exists
        when: a reader inspects the end-to-end sequence section
        then: the sequence names webhook arrival, signature verify, deriveIdempotencyKey, enqueue, 2xx response, worker pickup, config-loader, installation-auth, snapshotter, prefilter, provider, validator, ranker, publisher, and audit-log in that order
      - id: SD-3
        given: docs/system-design.md exists
        when: a reader inspects the cross-cutting concerns section
        then: subsections exist for Structured logging fields, Trace propagation across the queue, and Error taxonomy mapping; the error taxonomy maps ProviderError variants transport, auth, rate_limit, capability, and schema_validation to retry classes Transient, Rate-limited, or Non-transient and to terminal states succeeded, failed_terminal, or discarded_idempotent
      - id: SD-4
        given: docs/system-design.md exists
        when: a reader inspects the multitenancy posture section
        then: the phrase "namespaced by installation_id" appears verbatim and the section states the App is single-tenant in MVP but every persistence and routing key is namespaced by installation_id from day one
      - id: SD-5
        given: docs/system-design.md exists
        when: a reader inspects the queue and async model section
        then: BullMQ on Redis is named, the queue name pr-review is named, ack-on-receive plus visibility timeout is named, the JobQueue interface is named, the idempotency key is the BullMQ job id, and replay protection caches X-GitHub-Delivery per installation for a bounded window
      - id: SD-6
        given: docs/system-design.md exists
        when: a reader inspects the secret storage abstraction section
        then: the SecretSource interface is named with method getSecret(name), the env-var implementation is identified as the only one shipped in MVP, and no specific managed secret manager vendor is pinned
      - id: SD-7
        given: docs/system-design.md exists
        when: a reader inspects the back-pressure controls section
        then: three classes are enumerated - webhook ingress (2xx-on-accept), worker (queue concurrency cap, per-job timeout, oversized-diff fast-path), and provider (per-installation cost ceiling proxy with max-tokens-per-PR and max-tokens-per-window) - and numeric values are deferred to operational-runbooks.md
  docs/data-flow.md:
    acceptance:
      - id: DF-1
        given: docs/data-flow.md exists
        when: a reader inspects the section headers
        then: sections exist for Conventions, Flow 1 - Happy path, Flow 2 - Oversized-diff fast-path, Flow 3 - Provider failure, Flow 4 - Malformed provider output, Flow 5 - Re-run on synchronize (dedupe across runs), and Data-at-rest boundaries in that order
      - id: DF-2
        given: docs/data-flow.md exists
        when: a reader inspects Flow 1 - Happy path
        then: the flow names webhook.received, job.enqueued, job.started, prefilter.accepted, provider.called, validator.completed (or equivalent), ranker.completed (or equivalent), publisher.published, and job.terminal in order, and the terminal state is succeeded
      - id: DF-3
        given: docs/data-flow.md exists
        when: a reader inspects Flow 2 - Oversized-diff fast-path
        then: the flow names prefilter.skipped with reason oversized, the provider span pipeline.provider does not open, publisher.published is summary-only, max_files and max_changed_lines from config-spec.md are referenced, and the terminal state is succeeded
      - id: DF-4
        given: docs/data-flow.md exists
        when: a reader inspects Flow 3 - Provider failure
        then: the flow names provider.error events with retry-class semantics, the publisher emits a Checks summary containing the phrase "review unavailable", no inline comments are created, and the terminal state is failed_terminal
      - id: DF-5
        given: docs/data-flow.md exists
        when: a reader inspects Flow 4 - Malformed provider output
        then: the flow names validator.rejected with reason_code provider_output_zod_failed, the publisher emits a Checks summary containing the phrase "no findings produced", a RejectionLogEntry is written with redacted provider_output_excerpt, and the terminal state is failed_terminal
      - id: DF-6
        given: docs/data-flow.md exists
        when: a reader inspects Flow 5 - Re-run on synchronize and the data-at-rest boundaries section
        then: the duplicate-delivery case resolves to discarded_idempotent without a provider.called event, the new-head_sha case consults the per-PR already-published dedupe set sourced from GitHub Checks/Review-Comments history of this App on this PR, and Data-at-rest boundaries explicitly states that raw ProviderReviewOutput, repo file bodies, installation tokens, and the App private key are never persisted while normalized findings and audit log are
  docs/deployment.md:
    acceptance:
      - id: DEP-1
        given: docs/deployment.md exists
        when: a reader inspects the topology section
        then: a single Fastify app, one or more workers, and a Redis instance are named, BullMQ queue pr-review is referenced, and the MVP is identified as single-tenant
      - id: DEP-2
        given: docs/deployment.md exists
        when: a reader inspects the environment variables section
        then: subsections exist for Secrets, Config, and Tunables; secrets include GITHUB_APP_PRIVATE_KEY, GITHUB_APP_WEBHOOK_SECRET, and ANTHROPIC_API_KEY; config includes PORT, REDIS_URL, GITHUB_APP_ID, GITHUB_APP_SLUG, OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, LOG_LEVEL, and INSTALLATION_REPLAY_WINDOW_SECONDS; tunables include QUEUE_CONCURRENCY, JOB_TIMEOUT_SECONDS, RETRY_TRANSIENT_MAX_ATTEMPTS, RETRY_TRANSIENT_BACKOFF_BASE_MS, RETRY_TRANSIENT_BACKOFF_MAX_MS, RETRY_RATELIMIT_MAX_ATTEMPTS, MAX_TOKENS_PER_PR, MAX_TOKENS_PER_WINDOW_PER_INSTALLATION, MAX_TOKENS_WINDOW_SECONDS, and OTEL_TRACES_SAMPLER_ARG
      - id: DEP-3
        given: docs/deployment.md exists
        when: a reader inspects the networking section
        then: inbound HTTPS to webhook-ingress, outbound HTTPS to GitHub API, outbound HTTPS to provider API, outbound HTTPS to OTLP collector, and inbound TCP to Redis are enumerated; OTLP is marked optional and the others are marked required
      - id: DEP-4
        given: docs/deployment.md exists
        when: a reader inspects the secret management abstraction section
        then: the SecretSource interface is named, the env-var implementation is identified as the only one shipped in MVP, and no specific managed secret manager vendor is pinned
      - id: DEP-5
        given: docs/deployment.md exists
        when: a reader inspects the health surfaces section
        then: subsections exist for Liveness, Readiness, and Dependency check; Dependency check verifies Redis reachability, the ability to mint an installation token, and (when OTEL_EXPORTER_OTLP_ENDPOINT is set) OTLP collector reachability with degraded-not-failure semantics
      - id: DEP-6
        given: docs/deployment.md exists
        when: a reader inspects the .env.example section
        then: a code-fenced block contains every variable from Secrets, Config, and Tunables, the literal lines for OTEL_SERVICE_NAME=prisma-review-bot, OTEL_TRACES_SAMPLER_ARG=1.0, QUEUE_CONCURRENCY=4, JOB_TIMEOUT_SECONDS=120, MAX_TOKENS_PER_PR=60000, MAX_TOKENS_PER_WINDOW_PER_INSTALLATION=2000000, and INSTALLATION_REPLAY_WINDOW_SECONDS=300 appear, and the values match those in operational-runbooks.md Numeric tunables byte-for-byte
  docs/observability.md:
    acceptance:
      - id: OBS-1
        given: docs/observability.md exists
        when: a reader inspects the resolution of OQ-3 (recap) section
        then: the section restates the vendor-neutral OpenTelemetry-first design, names stdout JSON for logs, names OTLP/HTTP for metrics and traces, names OTEL_EXPORTER_OTLP_ENDPOINT, names head-sample default 1.0, names the emission-time redactor, and identifies the redactor as fail-closed for installation tokens, webhook secrets, and provider API keys
      - id: OBS-2
        given: docs/observability.md exists
        when: a reader inspects the logs > top-level fields section
        then: the fields ts, level, service, event, trace_id, span_id, installation_id, repository_id, pull_request_number, idempotency_key, and payload are listed in this exact order
      - id: OBS-3
        given: docs/observability.md exists
        when: a reader inspects the logs > event taxonomy section
        then: the events webhook.received, webhook.signature_failed, job.enqueued, job.started, prefilter.skipped, prefilter.accepted, provider.called, provider.error, validator.rejected, ranker.dropped, publisher.published, publisher.dropped, and job.terminal are listed in a table with columns event name, trigger, fields beyond base, redaction notes, and terminal
      - id: OBS-4
        given: docs/observability.md exists
        when: a reader inspects the metrics > metric inventory section
        then: the metrics prisma_webhooks_received_total, prisma_jobs_inflight, prisma_jobs_terminal_total, prisma_provider_call_seconds, prisma_provider_retry_total, prisma_findings_published_total, prisma_findings_dropped_total, prisma_prefilter_skipped_total, prisma_redactor_dropped_total, and prisma_queue_lag_seconds are listed with type and labels, and high-cardinality identifiers (installation_id, repository_id, pull_request_number, head_sha, idempotency_key, delivery_id, checks_run_id) are explicitly forbidden as label values
      - id: OBS-5
        given: docs/observability.md exists
        when: a reader inspects the traces > span hierarchy section
        then: the spans http.webhook, queue.enqueue, worker.job, pipeline.config_load, pipeline.snapshotter, pipeline.prefilter, pipeline.provider, pipeline.validator, pipeline.ranker, and pipeline.publisher are named with the parent-child structure (worker.job linked-to http.webhook via propagated trace context; pipeline.* spans are children of worker.job)
      - id: OBS-6
        given: docs/observability.md exists
        when: a reader inspects the redaction allowlist section
        then: only fields explicitly on the allowlist may leave the process; the allowlist enumerates fixed top-level log fields, per-event fields from the event taxonomy, RejectionLogEntry fields, span attributes, and metric labels; the PII/secret guard is fail-closed and the redactor drops the entire event when secret-shaped values appear in payload positions
      - id: OBS-7
        given: docs/observability.md exists
        when: a reader inspects the SLI / SLO posture section
        then: SLIs include webhook 2xx-on-accept rate, job-to-publish latency p95, provider error rate, and findings-published-per-PR distribution; SLO numerics are deferred to operational-runbooks.md or marked operator-set
  docs/operational-runbooks.md:
    acceptance:
      - id: RB-1
        given: docs/operational-runbooks.md exists
        when: a reader inspects the runbook section headers
        then: subsections exist for Webhook signatures are failing, Queue is backing up, Provider errors are climbing, Findings rejected by validator at high rate, Replay or duplicate deliveries, Oversized PRs starving the queue, Stuck failed_terminal rate spike, Rotating webhook secret, Rotating provider API key, Revoking and reinstalling the App on a repo, and Disaster recovery - Redis loss, in that order
      - id: RB-2
        given: docs/operational-runbooks.md exists
        when: a reader inspects each runbook subsection
        then: each contains Symptom, Detection, Diagnosis, Mitigation, Recovery, and Postmortem template pointer, in that order
      - id: RB-3
        given: docs/operational-runbooks.md exists
        when: a reader inspects each runbook's Detection step
        then: Detection references at least one event name from observability.md Event taxonomy or one metric name from observability.md Metric inventory, byte-equivalent
      - id: RB-4
        given: docs/operational-runbooks.md exists
        when: a reader inspects each runbook's Mitigation step
        then: Mitigation references at least one env var name from deployment.md Environment variables (or a procedure from another runbook section in this file), byte-equivalent
      - id: RB-5
        given: docs/operational-runbooks.md exists
        when: a reader inspects the Numeric tunables section
        then: a table contains rows for QUEUE_CONCURRENCY, JOB_TIMEOUT_SECONDS, RETRY_TRANSIENT_MAX_ATTEMPTS, RETRY_TRANSIENT_BACKOFF_BASE_MS, RETRY_TRANSIENT_BACKOFF_MAX_MS, RETRY_RATELIMIT_MAX_ATTEMPTS, MAX_TOKENS_PER_PR, MAX_TOKENS_PER_WINDOW_PER_INSTALLATION, MAX_TOKENS_WINDOW_SECONDS, OTEL_TRACES_SAMPLER_ARG, INSTALLATION_REPLAY_WINDOW_SECONDS, and LOG_LEVEL with starting values 4, 120, 3, 500, 8000, 5, 60000, 2000000, 3600, 1.0, 300, info respectively, plus a one-line rationale per row
      - id: RB-6
        given: docs/operational-runbooks.md exists
        when: a reader inspects the introductory paragraph of the Numeric tunables section
        then: the exact sentence "These are MVP starting values, not ADR commitments. Operators are expected to revise based on real traffic." appears verbatim
      - id: RB-7
        given: docs/operational-runbooks.md exists
        when: a reader inspects the Postmortem template section
        then: the template contains the headings Incident summary, Timeline (UTC), Detection signal(s), Mitigation taken, Recovery confirmation, Root cause, and Action items
consistency_checks:
  - id: CC-1
    description: Every component path string from system-design.md Component map appears verbatim wherever referenced in data-flow.md, observability.md, deployment.md, and operational-runbooks.md
  - id: CC-2
    description: The five pipeline stages prefilter, provider, validator, ranker, publication cap appear in this order in system-design.md End-to-end sequence and in data-flow.md Flow 1 (and the corresponding pipeline.* span order in observability.md Span hierarchy)
  - id: CC-3
    description: Schema chain ProviderReviewInput -> ProviderReviewOutput -> NormalizedFinding -> RankedFindings -> PublicationResult is named identically wherever referenced; RejectionLogEntry, JobPayload, JobResult, WebhookIngressRequest, WebhookIngressResponse, PublicationPolicy, PublishContext are reused verbatim from Phase 2
  - id: CC-4
    description: Phase 1 identifiers ProviderError and ProviderCapabilities appear verbatim in Phase 3 docs
  - id: CC-5
    description: Mode names dry-run, summary-only, summary-plus-inline appear with identical casing across Phase 3 docs
  - id: CC-6
    description: Webhook contract elements POST /webhooks/github, X-Hub-Signature-256, X-GitHub-Event, X-GitHub-Delivery, accepted-events {pull_request.opened, pull_request.synchronize, pull_request.reopened}, the phrase 2xx-on-accept, and the function name deriveIdempotencyKey are reused verbatim from Phase 2
  - id: CC-7
    description: The path .github/review-bot.yml appears verbatim wherever referenced in Phase 3 docs
  - id: CC-8
    description: The OQ-2 defaults (5, 1, medium, 0.7, dry-run) are not redeclared in Phase 3; references defer to Phase 2 docs
  - id: CC-9
    description: docs/open-questions.md Resolution log contains the OQ-3 entry dated 2026-04-30 and OQ-3 has been removed from Open questions; OQ-4, OQ-5, OQ-6, OQ-7, OQ-8 remain in their respective sections unchanged
  - id: CC-10
    description: Every event name in observability.md Event taxonomy is referenced in at least one step in data-flow.md, and every event name appearing as a step in data-flow.md exists in observability.md Event taxonomy
  - id: CC-11
    description: Every metric name in observability.md Metric inventory is referenced in at least one runbook Detection step in operational-runbooks.md
  - id: CC-12
    description: Every variable name in operational-runbooks.md Mitigation steps matches a name in deployment.md Environment variables; every tunable-classified variable in deployment.md has a row in operational-runbooks.md Numeric tunables; values are byte-equivalent between deployment.md .env.example and operational-runbooks.md Numeric tunables
  - id: CC-13
    description: OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_TRACES_SAMPLER_ARG appear in both deployment.md Environment variables and observability.md (Metrics + traces / Sampling)
  - id: CC-14
    description: The interface name SecretSource appears verbatim in system-design.md Secret storage abstraction and deployment.md Secret management abstraction
  - id: CC-15
    description: The interface name JobQueue appears verbatim in system-design.md Queue and async model and (where referenced) in deployment.md and operational-runbooks.md
  - id: CC-16
    description: The exact sentence "These are MVP starting values, not ADR commitments. Operators are expected to revise based on real traffic." appears verbatim in operational-runbooks.md Numeric tunables
  - id: CC-17
    description: packages/providers/anthropic matches the OQ-1 resolution log entry across system-design.md and operational-runbooks.md
  - id: CC-18
    description: The redaction allowlist is enumerated only in observability.md Redaction allowlist; system-design.md and data-flow.md reference it without redefining
  - id: CC-19
    description: The fixed top-level log field order ts, level, service, event, trace_id, span_id, installation_id, repository_id, pull_request_number, idempotency_key, payload appears in observability.md Top-level fields and is the only authoritative ordering
  - id: CC-20
    description: No Phase 3 doc names a specific OTLP collector vendor, a specific managed-secret vendor, or a non-Anthropic provider; only Anthropic Claude (per OQ-1) and BullMQ on Redis (per Phase 3 pre-resolved decisions) are pinned
exit_gate:
  description: All 5 Phase 3 files exist at their specified paths, all acceptance criteria above evaluate true, all consistency_checks pass with zero violations, and docs/open-questions.md Resolution log records OQ-3 with resolution date 2026-04-30 while OQ-4, OQ-5, OQ-6, OQ-7, and OQ-8 remain unchanged.
```
