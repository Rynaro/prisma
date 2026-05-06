# Deployment

## Topology

The App ships as two process roles backed by a single Redis instance:

- A **single Fastify app process** running the webhook ingress (`apps/github-app/webhook-ingress`). It receives `POST /webhooks/github`, verifies `X-Hub-Signature-256`, derives the idempotency key via `deriveIdempotencyKey`, enqueues a `JobPayload` onto the BullMQ `pr-review` queue, and returns `2xx` (per `api-contracts.md` § Webhook ingress contract — `2xx-on-accept`).
- **One or more worker processes** consuming the BullMQ `pr-review` queue. Each worker runs the pipeline `prefilter → provider → validator → ranker → publication cap` against each accepted PR event (per `system-design.md` § Queue and async model).
- A **Redis instance** that backs BullMQ.

Each role is delivered as a container image. The MVP is single-tenant — one GitHub App registration; `system-design.md` § Multitenancy posture states that every persistence and routing key is namespaced by `installation_id` from day one. Workers may be horizontally scaled; the ingress is typically a single replica behind a load balancer for simplicity but is stateless and can also be scaled.

## Bootstrapping

GitHub App creation is performed out-of-band: the operator visits GitHub's App registration UI and creates the App (this document does not reproduce GitHub's flow — verify against current GitHub docs in Phase 4). Once registered, the operator imports the artifacts into the secret store reachable by the App's `SecretSource`:

- The App private key (`.pem`) — stored under `GITHUB_APP_PRIVATE_KEY`.
- The webhook secret — generated and stored under `GITHUB_APP_WEBHOOK_SECRET`.
- The provider API key — minted in the provider's dashboard and stored under `ANTHROPIC_API_KEY` (Anthropic Claude is the OQ-1 reference adapter, located at `packages/providers/anthropic`).

For the procedural detail of rotating the webhook secret or the provider API key, see `operational-runbooks.md` § Rotating webhook secret and § Rotating provider API key. The procedures are not duplicated here.

## Networking

Connections required for the App to function are marked **required**; connections used only for telemetry are marked **optional**. Direction is from the App perspective.

- **Inbound to `apps/github-app/webhook-ingress`** — HTTPS from GitHub (required for the App to receive webhooks); HTTP from the load balancer / platform health checker to the `Liveness` and `Readiness` surfaces (required).
- **Outbound from the worker** — HTTPS to the GitHub API host (required, for snapshotter, Checks API, Review Comments API, Installations API); HTTPS to the provider API host (required when `mode != dry-run`-only deployments; in practice always required, since `dry-run` is per-repo not per-deployment); HTTPS to the OTLP collector at `OTEL_EXPORTER_OTLP_ENDPOINT` (**optional** — when unset, traces and metrics are not exported, but the App still functions).
- **Inbound to Redis** — TCP from both the ingress and the worker (required); typically on a private network within the deployment.

The OTLP collector is the only optional connection. All others are required.

## Sizing posture

The MVP runs comfortably on small-instance class containers: one ingress replica, one to two worker replicas, and one small Redis instance. Back-pressure controls (per `system-design.md` § Back-pressure controls) shed load before scale-out is necessary:

- The queue concurrency cap (`QUEUE_CONCURRENCY`) bounds in-flight provider calls per worker.
- The per-job timeout (`JOB_TIMEOUT_SECONDS`) bounds wall time per PR.
- The oversized-diff fast-path bypasses the provider on large PRs (per `data-flow.md` § Flow 2 — Oversized-diff fast-path).
- The per-installation cost ceiling proxy (`MAX_TOKENS_PER_PR`, `MAX_TOKENS_PER_WINDOW_PER_INSTALLATION`, `MAX_TOKENS_WINDOW_SECONDS`) protects against cost blowups.

Numeric starting values for concurrency, timeout, and the cost ceilings live in `operational-runbooks.md` § Numeric tunables.

## Environment variables

Every variable is classified `secret`, `config`, or `tunable`. `secret` values are read via `SecretSource` (per `system-design.md` § Secret storage abstraction); the env-var implementation is the only one shipped in MVP — operators may substitute a managed secret manager without changing pipeline code.

### Secrets

| name | description | classification |
| --- | --- | --- |
| `GITHUB_APP_PRIVATE_KEY` | The GitHub App private key (PEM contents or path), used by `packages/github/installation-auth` to mint installation tokens. Read via `SecretSource`. Never echoed to logs. | `secret` |
| `GITHUB_APP_WEBHOOK_SECRET` | The HMAC secret used by `apps/github-app/webhook-ingress` to verify `X-Hub-Signature-256` on inbound webhooks. Read via `SecretSource`. Never echoed to logs. | `secret` |
| `ANTHROPIC_API_KEY` | The Anthropic Claude provider API key consumed by the adapter at `packages/providers/anthropic` (per OQ-1). The variable name is provider-specific because the adapter is provider-specific; downstream code only sees a `SecretSource.getSecret(...)` call. Read via `SecretSource`. Never echoed to logs. | `secret` |
| `COPILOT_API_KEY` | The GitHub Copilot provider API key (a GitHub PAT with `models:read` scope, or a runtime-resolved App installation token) consumed by the adapter at `packages/providers/copilot` (per ADR-004). Selected only when `ANTHROPIC_API_KEY` is unset; see `apps/github-app/src/worker.ts` for precedence. Read via `SecretSource`. Never echoed to logs. | `secret` |

### Config

| name | description | classification |
| --- | --- | --- |
| `PORT` | TCP port the Fastify ingress listens on. | `config` |
| `REDIS_URL` | BullMQ connection string for the `pr-review` queue (per `system-design.md` § Queue and async model). | `config` |
| `GITHUB_APP_ID` | Numeric GitHub App id. Not a secret; identifies the App registration. | `config` |
| `GITHUB_APP_SLUG` | GitHub App slug, used for App identity attribution and audit-log correlation. | `config` |
| `OTEL_SERVICE_NAME` | OpenTelemetry service name; matches the `service` field on every structured log event (per `observability.md` § Top-level fields). Default: `prisma-review-bot`. | `config` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP collector URL (per `observability.md` § Resolution of OQ-3 (recap) and § Sampling). When unset, telemetry export is disabled but the App still functions. | `config` |
| `LOG_LEVEL` | Default log verbosity for `packages/shared/audit-log`; one of `debug`, `info`, `warn`, `error`. | `config` |
| `INSTALLATION_REPLAY_WINDOW_SECONDS` | The replay-protection window for `X-GitHub-Delivery` per installation (per `system-design.md` § Queue and async model § Replay protection). Duplicate deliveries within the window short-circuit to `discarded_idempotent`. | `config` |
| `COPILOT_MODEL` | Optional override for the Copilot adapter's default model (defaults to `gpt-4o`). Consumed only when `COPILOT_API_KEY` is set. | `config` |
| `COPILOT_BASE_URL` | Optional override for the Copilot adapter's inference endpoint (defaults to `https://models.github.ai/inference`). Consumed only when `COPILOT_API_KEY` is set. | `config` |

### Tunables

| name | description | classification |
| --- | --- | --- |
| `QUEUE_CONCURRENCY` | BullMQ worker concurrency cap; bounds in-flight provider calls per worker process. | `tunable` |
| `JOB_TIMEOUT_SECONDS` | Per-job wall-time timeout; the worker fails the job if the pipeline exceeds it. | `tunable` |
| `RETRY_TRANSIENT_MAX_ATTEMPTS` | Maximum attempts for the **Transient** retry class (`ProviderError.transport`). | `tunable` |
| `RETRY_TRANSIENT_BACKOFF_BASE_MS` | Initial backoff for transient retries (jittered). | `tunable` |
| `RETRY_TRANSIENT_BACKOFF_MAX_MS` | Cap on backoff growth for transient retries. | `tunable` |
| `RETRY_RATELIMIT_MAX_ATTEMPTS` | Maximum attempts for the **Rate-limited** retry class (`ProviderError.rate_limit`); honors `Retry-After` when provided. | `tunable` |
| `MAX_TOKENS_PER_PR` | Per-PR token-cost ceiling proxy enforced by the active provider adapter (`packages/providers/anthropic` or `packages/providers/copilot`). | `tunable` |
| `MAX_TOKENS_PER_WINDOW_PER_INSTALLATION` | Per-installation token-cost ceiling proxy over a sliding window. | `tunable` |
| `MAX_TOKENS_WINDOW_SECONDS` | Length of the sliding window for `MAX_TOKENS_PER_WINDOW_PER_INSTALLATION`. | `tunable` |
| `OTEL_TRACES_SAMPLER_ARG` | Head-sample argument for the parent-based sampler (per `observability.md` § Sampling); a number in `[0,1]`. | `tunable` |

Each tunable has a starting value listed in `operational-runbooks.md` § Numeric tunables. This section names the tunables; that section sets the starting values.

## Secret management abstraction

Secrets are read via `SecretSource.getSecret(name): Promise<string>` (per `system-design.md` § Secret storage abstraction). The MVP implementation reads from process env. Operators may substitute a managed secret manager (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager, Azure Key Vault, and the like) without changing pipeline code; the substitution lives in the worker and ingress bootstrap. No specific managed-secret vendor is pinned by the App.

The interface name `SecretSource` matches `system-design.md` § Secret storage abstraction verbatim.

## Health surfaces

The App exposes three HTTP `GET` health surfaces. All return `200` on success; failure semantics are per surface.

### Liveness

- **Path.** `/healthz/live`.
- **Behavior.** Returns `200` if the process can answer. Bounded in latency. Performs no external IO. The platform health checker uses this to decide whether to restart the container.

### Readiness

- **Path.** `/healthz/ready`.
- **Behavior.** Returns `200` only if the process has completed bootstrap: configuration loaded, `SecretSource` reachable for the keys this process will need (`GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, and exactly one of `ANTHROPIC_API_KEY` / `COPILOT_API_KEY`), and the `JobQueue` client is connected to Redis (`REDIS_URL`). Returns `503` until bootstrap completes.

### Dependency check

- **Path.** `/healthz/deps`.
- **Behavior.** Returns `200` only when (a) Redis is reachable; (b) the App can mint an installation token via `packages/github/installation-auth` (a sentinel call against the GitHub Installations API); (c) when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the OTLP collector is reachable. The OTLP probe is non-blocking: failure of (c) returns a `200` with a degraded status payload, not a `5xx`, because telemetry is non-critical to the App's PR-review function. Failure of (a) or (b) returns `503`.

## .env.example

The block below is the `.env.example` shipped with the App. Placeholder values only — no real secrets. Variable names match § Secrets, § Config, and § Tunables byte-for-byte. Tunable values match the starting values declared in `operational-runbooks.md` § Numeric tunables.

```
# secrets (read via SecretSource; env is the MVP implementation)
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_WEBHOOK_SECRET=
# Provider selection by precedence: ANTHROPIC_API_KEY first, then COPILOT_API_KEY.
# Set exactly one for production-equivalent behavior.
ANTHROPIC_API_KEY=
COPILOT_API_KEY=

# config
PORT=3000
REDIS_URL=redis://localhost:6379
GITHUB_APP_ID=
GITHUB_APP_SLUG=
OTEL_SERVICE_NAME=prisma-review-bot
OTEL_EXPORTER_OTLP_ENDPOINT=
LOG_LEVEL=info
INSTALLATION_REPLAY_WINDOW_SECONDS=300
# Optional Copilot overrides; consumed only when COPILOT_API_KEY is set.
COPILOT_MODEL=
COPILOT_BASE_URL=

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
