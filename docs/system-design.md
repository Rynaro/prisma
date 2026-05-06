# System Design

## Overview

The App is a single Fastify webhook ingress plus one or more BullMQ workers backed by Redis. The ingress receives `POST /webhooks/github`, verifies the `X-Hub-Signature-256` header, derives a deterministic idempotency key via `deriveIdempotencyKey`, enqueues a `JobPayload` onto a single `pr-review` queue, and returns `2xx` within a budget of one second. Workers consume the queue and run the pipeline `prefilter → provider → validator → ranker → publication cap` against each accepted PR event. The schema chain `ProviderReviewInput → ProviderReviewOutput → NormalizedFinding → RankedFindings → PublicationResult` is preserved end-to-end. The App is single-tenant in MVP (one App registration), but every persistence and routing key is namespaced by `installation_id` from day one so a second tenant is additive, not a refactor.

## Component map

### apps/github-app/webhook-ingress

- **Responsibility.** Receive `POST /webhooks/github`, verify `X-Hub-Signature-256`, derive the idempotency key, enqueue, and respond `2xx`.
- **Owns-which-schemas.** `WebhookIngressRequest`, `WebhookIngressResponse`.
- **Depends-on.** `packages/config/config-loader` (for app-level configuration only, not repo configuration), `packages/shared/audit-log`, the queue client.
- **Public surface.** The HTTP route handler for `POST /webhooks/github` and the `deriveIdempotencyKey` function (per `api-contracts.md` § Webhook ingress contract).
- **Invariants.** Signature verification precedes idempotency-key derivation, which precedes enqueue, which precedes the `2xx` response (per `api-contracts.md` § Webhook ingress contract). The 2xx budget is ≤ 1 s. No PR-visible artifact is created at this component.

### packages/github/installation-auth

- **Responsibility.** Mint and cache GitHub App installation tokens, scoped by the App manifest's declared permissions.
- **Owns-which-schemas.** An internal `InstallationToken` record (not a Phase 2 schema).
- **Depends-on.** `SecretSource` for the GitHub App private key.
- **Public surface.** `getInstallationToken(installation_id): Promise<InstallationToken>`.
- **Invariants.** Tokens are minted at job execution time and never embedded in `JobPayload`. Expired tokens are not returned. The App private key never appears in any log, trace attribute, or queued payload.

### packages/core/snapshotter

- **Responsibility.** Fetch the PR diff and metadata for a `(installation_id, repository_id, pull_request_number, head_sha)` tuple from GitHub.
- **Owns-which-schemas.** An internal `DiffSnapshot` record.
- **Depends-on.** `packages/github/installation-auth`, the GitHub Pull Requests API.
- **Public surface.** `snapshot(ctx): Promise<DiffSnapshot>`.
- **Invariants.** The snapshot is bounded by `max_files` and `max_changed_lines` (per `config-spec.md`). Raw file contents do not leave the worker process beyond what the prefilter forwards.

### packages/core/prefilter

- **Responsibility.** Scope the diff context per ADR-003 (paths, globs, generated-file detection, vendored detection, size rules) and construct a `ProviderReviewInput`.
- **Owns-which-schemas.** `ProviderReviewInput` (constructed here).
- **Depends-on.** `packages/core/snapshotter`, `packages/config/config-loader`.
- **Public surface.** `prefilter(snapshot, config): { input: ProviderReviewInput | null; reason: 'ok' | 'oversized' | 'all-excluded' }`.
- **Invariants.** Prefilter runs before any provider call. On `oversized` the worker takes the oversized-diff fast-path defined in `data-flow.md`; on `all-excluded` the pipeline ends without invoking the provider.

### packages/providers (provider abstraction surface)

- **Responsibility.** Expose the typed `Provider` interface from ADR-002 and `api-contracts.md` § Provider adapter contract.
- **Owns-which-schemas.** Re-exports `ProviderReviewInput`, `ProviderReviewOutput`, `ProviderError`, `ProviderCapabilities` (Phase 1 identifiers).
- **Depends-on.** Nothing vendor-specific.
- **Public surface.** The `Provider` interface (`review`, `capabilities`).
- **Invariants.** No vendor SDK type appears in this package's signatures. Downstream code imports the provider types only from this package.

### packages/providers/anthropic

- **Responsibility.** Implement `Provider` against the Anthropic Claude wire (per OQ-1).
- **Owns-which-schemas.** An internal Anthropic-specific request/response shape, private to this package.
- **Depends-on.** `SecretSource` for the provider API key, the Anthropic SDK. ADR-002's "no vendor SDK outside the adapter" rule is enforced by `scripts/check-vendor-isolation.sh`.
- **Public surface.** A factory function returning a `Provider`.
- **Invariants.** No Anthropic SDK type, response shape, or error class crosses the package boundary. `ProviderReviewOutput` is Zod-validated at the adapter boundary; on Zod failure the adapter throws `ProviderError` with variant `schema_validation`.

### packages/core/validator-ranker

- **Responsibility.** Implement the validator and ranker contracts defined in `api-contracts.md`.
- **Owns-which-schemas.** `NormalizedFinding`, `RankedFindings`, `RejectionLogEntry` (constructed here for `stage = 'validator'` and `stage = 'ranker'`).
- **Depends-on.** `packages/core/prefilter` (for diff context shape), `packages/config/config-loader` (for `repo_heuristics` and `severity` overrides).
- **Public surface.** `validate(output, ctx)`, `rank(findings, policy)`.
- **Invariants.** Per `api-contracts.md` § Validator contract and § Ranker contract: every emitted `NormalizedFinding` has `path` present in the diff and `[line_start, line_end]` within a touched hunk. The ranker never sets `render_target = 'dropped'` and never drops findings.

### packages/github/check-runs

- **Responsibility.** Create and update GitHub Checks runs on the PR `head_sha`; render the Markdown summary body.
- **Owns-which-schemas.** An internal `CheckRunRequest` record.
- **Depends-on.** `packages/github/installation-auth`, the GitHub Checks API.
- **Public surface.** `createCheckRun(ctx, body): Promise<{ checks_run_id: string }>`, `updateCheckRun(...)`.
- **Invariants.** The Checks run is owned by the App identity. Conclusion is one of `success`, `neutral`, or `failure`, per `publication-policy.md`.

### packages/github/review-comments

- **Responsibility.** Create line-anchored review comments when `mode = summary-plus-inline`.
- **Owns-which-schemas.** An internal `ReviewCommentRequest` record.
- **Depends-on.** `packages/github/installation-auth`, the GitHub Pull Request Review Comments API.
- **Public surface.** `createReviewComment(ctx, finding): Promise<void>`.
- **Invariants.** Only invoked for findings whose `render_target = 'inline'` after caps and thresholds. The publisher does not edit or delete prior inline comments in MVP (per `publication-policy.md` § Re-run behavior on synchronize).

### packages/config/config-loader

- **Responsibility.** Resolve effective configuration per `config-spec.md` § Resolution order: built-in defaults, repo-local `.github/review-bot.yml`, per-PR overrides slot.
- **Owns-which-schemas.** The resolved configuration object.
- **Depends-on.** `packages/github/installation-auth` (to fetch the file from the head ref).
- **Public surface.** `loadConfig(ctx): Promise<ResolvedConfig>`.
- **Invariants.** Malformed files reject and fall back to defaults (per `config-spec.md` § Failure modes); unknown keys warn and are ignored.

### packages/shared/audit-log

- **Responsibility.** Structured-log emission with the redaction allowlist defined in `observability.md`.
- **Owns-which-schemas.** The emitter and the redactor.
- **Depends-on.** Nothing component-specific.
- **Public surface.** `emit(event, payload)`, `emitRejection(entry: RejectionLogEntry)`.
- **Invariants.** The redactor is fail-closed for secret-shaped values. Only fields on the allowlist (defined in `observability.md` § Redaction allowlist) leave the process. Diff content, repo file bodies, and provider raw output are never emitted.

## End-to-end sequence

The ordered path from webhook arrival to terminal job state, naming the component and schema each step touches:

1. Webhook arrival at `apps/github-app/webhook-ingress` — produces a `WebhookIngressRequest`.
2. Signature verify — `apps/github-app/webhook-ingress` validates `X-Hub-Signature-256` against the webhook secret read via `SecretSource`.
3. `deriveIdempotencyKey` — `apps/github-app/webhook-ingress` computes the idempotency key from `X-GitHub-Delivery` and `(installation_id, repository_id, pull_request_number, head_sha)`.
4. Enqueue to BullMQ — `apps/github-app/webhook-ingress` enqueues a `JobPayload` onto the `pr-review` queue using the idempotency key as the BullMQ job id.
5. `2xx` response — `apps/github-app/webhook-ingress` returns a `WebhookIngressResponse` with the appropriate code (per `api-contracts.md` § Webhook ingress contract).
6. Worker pickup — the BullMQ worker process picks up the job and starts the pipeline against the `JobPayload`.
7. `packages/config/config-loader` resolves effective configuration from `.github/review-bot.yml` on the PR head ref.
8. `packages/github/installation-auth` mints an installation token for the worker's downstream calls.
9. `packages/core/snapshotter` fetches the diff and produces a `DiffSnapshot`.
10. `packages/core/prefilter` runs. On `all-excluded` the pipeline ends with terminal `succeeded` and no findings; on `oversized` the worker takes the oversized-diff fast-path (skip the provider, emit a summary-only Checks run, terminal `succeeded`); otherwise the prefilter produces a `ProviderReviewInput`.
11. Provider call via `packages/providers/anthropic` — the adapter invokes `Provider.review` and returns `ProviderReviewOutput`.
12. Zod validation at the adapter boundary — `packages/providers/anthropic` validates the wire response against the `ProviderReviewOutput` schema; failure throws `ProviderError` with variant `schema_validation`.
13. `packages/core/validator-ranker` validate — produces `NormalizedFinding[]` and any `RejectionLogEntry` records with `stage = 'validator'`.
14. `packages/core/validator-ranker` rank — produces `RankedFindings`.
15. Publisher applies `PublicationPolicy` (per `publication-policy.md` § Threshold and cap application order — the publication cap stage).
16. `packages/github/check-runs` creates the Checks run, and (when `mode = summary-plus-inline`) `packages/github/review-comments` creates inline review comments. The publisher returns a `PublicationResult`.
17. `packages/shared/audit-log` writes the terminal job state (`succeeded`, `failed_terminal`, or `discarded_idempotent`) and any `RejectionLogEntry` records.

## Apps vs packages boundaries

`apps/` contains the runtime entry points: the Fastify HTTP server (`apps/github-app/webhook-ingress`) and the BullMQ worker process. `packages/` contains pure-logic and IO-shaped libraries that the apps compose. `packages/github/*` exists separately from `packages/core/*` because GitHub-API code is IO-shaped and credential-bearing — it must be testable with fakes, isolated from pure pipeline logic, and substitutable behind `Provider`-style seams. No `apps/` directory contains pipeline logic; pipeline logic lives in `packages/core/*` and is invoked by the worker app.

## Cross-cutting concerns

### Structured logging fields

The structured-log top-level field set is fixed: `ts`, `level`, `service`, `event`, `trace_id`, `span_id`, `installation_id`, `repository_id`, `pull_request_number`, `idempotency_key`. The canonical list, ordering, and redaction allowlist are defined in `observability.md` § Logs and § Redaction allowlist; this section forward-references that document and does not redefine the allowlist.

### Trace propagation across the queue

Trace context is carried across the BullMQ boundary by including a `traceparent` header value in the `JobPayload`. This is a Phase 3 additive extension to the Phase 2 `JobPayload` shape: an optional `traceparent: string` field is added for trace context only — no semantic data, no secrets. The extension is forward-compatible (optional, trace-only) and does not modify Phase 2 contracts. The exact wording, repeated for clarity: **Phase 3 additive extension — does not modify Phase 2 contracts**. The worker reads `traceparent` and uses it to start the `worker.job` span with the ingress's `http.webhook` as the parent. Span names and propagation mechanics are defined in `observability.md` § Traces.

### Error taxonomy mapping

The error taxonomy maps `ProviderError` variants and pipeline-stage rejections to retry classes and terminal `JobResult.state` values, anchored to `api-contracts.md` § Invariants and error semantics:

- `ProviderError.transport` → **Transient** retry class → potentially `failed_terminal` after retries are exhausted.
- `ProviderError.rate_limit` → **Rate-limited** retry class (honors `Retry-After`) → potentially `failed_terminal` after retries are exhausted.
- `ProviderError.auth` → **Non-transient** → `failed_terminal` immediately.
- `ProviderError.capability` → **Non-transient** → `failed_terminal` immediately.
- `ProviderError.schema_validation` → **Non-transient** → `failed_terminal` immediately.
- Validator `RejectionLogEntry.reason_code` values (`path_not_in_diff`, `line_outside_hunk`, `evidence_unverifiable`, `provider_output_zod_failed`) → per-finding drops; do not fail the job.
- Publisher `RejectionLogEntry.reason_code` values (`per_file_cap_exhausted`, `per_pr_cap_exhausted`, `severity_below_floor`, `confidence_below_floor`, `dedupe_collapsed`) → per-finding drops; do not fail the job.
- Redactor fail-closed match → drop the event, do not retry, audit (the dropped event is counted but its payload does not leave the process).
- Webhook signature failure → `4xx`, no enqueue (no terminal job state is recorded because no job was created).
- Idempotency replay (same `idempotency_key` and `head_sha`) → `2xx` with the async resolution `discarded_idempotent`.

## Multitenancy posture

The App is single-tenant in MVP: one GitHub App registration. Every persistence key — including idempotency-key storage, dedupe lookup keys, replay-protection keys, and queue job ids — and every routing key is namespaced by `installation_id` from day one. The phrase "namespaced by installation_id" is the contract: it appears here verbatim and is referenced by every flow in `data-flow.md` and every runbook in `operational-runbooks.md`. Adding a second tenant later is additive — a new App registration produces new `installation_id` values that flow through the same code path — not a refactor.

## Queue and async model

The queue is BullMQ on Redis. There is a single queue named `pr-review`. The model is ack-on-receive plus visibility timeout: the worker acquires a job on pickup and the queue retains the job for the visibility window so that a crashed worker's job becomes redeliverable. There is a single concurrency knob (`QUEUE_CONCURRENCY`) and a single per-job timeout (`JOB_TIMEOUT_SECONDS`); numeric starting values are in `operational-runbooks.md` § Numeric tunables.

The worker code depends on a `JobQueue` interface, declared by name here; the field-by-field shape is Phase 4. No file in `packages/core/*` imports BullMQ directly; only the worker app and a thin adapter (in `packages/shared` or equivalent) does. Operators who later swap to a different queue substitute a different implementation of `JobQueue`.

The idempotency key from `api-contracts.md` § Webhook ingress contract is the BullMQ job id; re-enqueue of the same key is a no-op when an active or completed job exists for that id.

**Replay protection.** `X-GitHub-Delivery` is cached per installation for a bounded window (env var `INSTALLATION_REPLAY_WINDOW_SECONDS`). A duplicate delivery within the window short-circuits to the async resolution `discarded_idempotent` without a provider call.

## Secret storage abstraction

All secrets (GitHub App private key, webhook secret, provider API key) are read via a `SecretSource` interface with a single method:

```
SecretSource.getSecret(name): Promise<string>
```

The MVP implementation reads from process env. Operators are expected to wrap `SecretSource` with a managed secret manager (the choice is theirs); no specific vendor is pinned. The interface name `SecretSource` is the contract; it is reused verbatim in `deployment.md` § Secret management abstraction.

## Back-pressure controls

Back-pressure is enforced in three classes; numeric values for each live in `operational-runbooks.md` § Numeric tunables, not here.

- **Webhook ingress.** `2xx-on-accept` always (≤ 1 s budget). The ingress enqueues then returns; it rejects only on bad signature or unsupported event (the latter discards with a `2xx`).
- **Worker.** Queue concurrency cap (`QUEUE_CONCURRENCY`); per-job timeout (`JOB_TIMEOUT_SECONDS`); the oversized-diff fast-path emits a summary-only Checks run and skips the provider call entirely.
- **Provider.** Per-installation cost ceiling proxy: `MAX_TOKENS_PER_PR` and `MAX_TOKENS_PER_WINDOW_PER_INSTALLATION` (over a `MAX_TOKENS_WINDOW_SECONDS` window). This is the class — a token-cost ceiling — that protects against PR-storm cost blowups; numeric starting values live in `operational-runbooks.md`.
