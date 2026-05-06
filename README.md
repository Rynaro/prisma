# prisma — vendor-independent AI code review bot for GitHub pull requests

## Status

Phase 7 — MVP-complete; not yet GA. The codebase has shipped Phase 1 (research and decisions) through Phase 6 (deterministic offline evaluation) and is now packaged for first-time contributor and operator onboarding via Phase 7. Architectural anchors: ADR-001 (GitHub App delivery shape), ADR-002 (provider abstraction), and ADR-003 (deterministic validate-rank-publish pipeline).

Verified-state baselines:

- 227 tests across 33 test files (Vitest, run via `make test`).
- 9/9 evaluation scenarios PASS (Phase 6 harness; index at `evals/scenarios.yaml`, run via `make eval`).

## Architecture overview

`prisma` is delivered as a GitHub App (per ADR-001). A single Fastify ingress accepts `POST /webhooks/github`, verifies `X-Hub-Signature-256`, derives an idempotency key, and enqueues a `JobPayload` onto a BullMQ `pr-review` queue backed by Redis. Worker processes consume the queue and run a deterministic pipeline whose stages are pinned by ADR-003. The provider stage is the only non-deterministic component; everything before and after is mechanical (per ADR-002, the `Provider` abstraction is the single boundary that vendor-specific code crosses). The schema chain handed between stages is `ProviderReviewInput → ProviderReviewOutput → NormalizedFinding → RankedFindings → PublicationResult`.

```
GitHub webhook
     |
     v
+-----------------+      +---------+      +----------+      +--------+      +-----------------+      +-----------+
| webhook ingress | ---> | enqueue | ---> | worker   | ---> | runner | ---> | provider stage  | ---> | publisher |
| (HMAC verify)   |      | BullMQ  |      | pickup   |      |        |      | (anthropic)     |      | Checks API|
+-----------------+      +---------+      +----------+      +--------+      +-----------------+      +-----------+
                                                                |
                                                                v
                                          prefilter → provider → validator → ranker → publication cap
```

ADR anchors:

- **ADR-001 — Deliver as a GitHub App.** Locks the deployment shape (App, not Action; webhook-driven, not poll-driven).
- **ADR-002 — Provider Abstraction.** Locks the `Provider` interface so the Anthropic Claude reference adapter can be swapped without touching pipeline code.
- **ADR-003 — Validation, Ranking, and Publication Cap.** Locks the pipeline string `prefilter → provider → validator → ranker → publication cap` and the trust-preserving cap stage.

## Module map

| package | purpose | system-design.md anchor |
| --- | --- | --- |
| `apps/github-app` | Fastify ingress and BullMQ worker entry points; owns process bootstrap, provider selection, health surfaces, and queue wiring. | [`docs/system-design.md#appsgithub-appwebhook-ingress`](docs/system-design.md#appsgithub-appwebhook-ingress) |
| `packages/shared` | Canonical schemas (`ProviderReviewInput`, `ProviderReviewOutput`, `NormalizedFinding`, `RankedFindings`, `PublicationResult`, `RepoConfig`, `JobPayload`), audit-log surface, and the emission-time redactor. | [`docs/system-design.md#packagessharedaudit-log`](docs/system-design.md#packagessharedaudit-log) |
| `packages/config` | Repo-local `.github/review-bot.yml` resolver and parser; owns `loadRepoConfig` and the `RepoConfigSchema` resolution rules. | [`docs/system-design.md#packagesconfigconfig-loader`](docs/system-design.md#packagesconfigconfig-loader) |
| `packages/core` | Deterministic pipeline modules: snapshotter, prefilter, validator, and ranker. | [`docs/system-design.md#packagescoresnapshotter`](docs/system-design.md#packagescoresnapshotter) |
| `packages/github` | GitHub-side adapters: installation-auth, Checks API, review comments, Installations API. | [`docs/system-design.md#packagesgithubinstallation-auth`](docs/system-design.md#packagesgithubinstallation-auth) |
| `packages/providers/anthropic` | Anthropic Claude reference adapter (per OQ-1); production-ready. | [`docs/system-design.md#packagesprovidersanthropic`](docs/system-design.md#packagesprovidersanthropic) |
| `packages/providers/copilot` | GitHub Copilot adapter (per ADR-004) targeting the GitHub Models inference endpoint over an OpenAI-compatible chat-completions surface. | [`docs/architecture-decision-records/adr-004-copilot-provider.md`](docs/architecture-decision-records/adr-004-copilot-provider.md) |
| `packages/providers/fake` | Deterministic in-process `FakeProvider` used by Phase 6 evaluation and unit tests. | [`docs/system-design.md#packagesproviders-provider-abstraction-surface`](docs/system-design.md#packagesproviders-provider-abstraction-surface) |
| `evals/runner` | Phase 6 deterministic evaluation harness (`@prisma-bot/eval-runner`); owns the scenario loader and the PASS/FAIL gate. | [`evals/README.md`](evals/README.md) |

## Setup

Prerequisites — and only these:

- **Docker (≥ 20)**
- **GNU Make**

No Node, no pnpm, no other host runtime is required. Every command in this README runs inside containers managed by the `Makefile`.

First-time setup:

```
git clone <url>
cd prisma
cp .env.example .env
make install
```

`make install` materializes `pnpm-managed` workspace dependencies inside the `tools` container; it does not install anything on the host.

## Local development

Run the following commands in order. Each command runs inside a container managed by the `Makefile`.

```
make install
```

Installs all workspace dependencies inside the `tools` container and produces / refreshes `pnpm-lock.yaml`. No host-side runtime is touched.

```
make typecheck
```

Runs the TypeScript typechecker across every workspace (`apps/github-app`, `packages/shared`, `packages/config`, `packages/core`, `packages/github`, `packages/providers/anthropic`, `packages/providers/fake`, `evals/runner`).

```
make lint
```

Runs Biome lint across every workspace. Lint failures exit non-zero so the command is CI-safe.

```
make test
```

Runs the full Vitest suite — 227 tests across 33 test files at the Phase 6 baseline. The suite is hermetic: GitHub and Anthropic interactions are exercised through `OctokitLike` and `FakeProvider`.

```
make eval
```

Runs the Phase 6 evaluation harness against the 9 scenarios indexed in `evals/scenarios.yaml`. The PASS gate is 9/9; any regression fails the command.

```
make up
```

Starts the local stack via `docker compose up -d`: `redis`, `app` (the Fastify ingress), and `worker` containers. The `app` container always listens on container-internal port `3000`; that port is mapped to host port `3030` by default. To bind a different host port, set `APP_HOST_PORT`:

```
APP_HOST_PORT=4040 make up
```

`docker-compose.yml` consumes `APP_HOST_PORT` purely for the host-side bind; application code continues to listen on `PORT=3000` inside the container regardless.

## Local webhook development

To replay a Phase 6 evaluation fixture as if it were a real GitHub `pull_request` delivery, use `make replay-webhook`:

```
make replay-webhook FIXTURE=security-bug
```

The replay script reads `evals/fixtures/security-bug.yaml`, extracts the `pr_payload` field, signs the JSON body with the `GITHUB_APP_WEBHOOK_SECRET` env var when set, and otherwise falls back to the dev-only secret `dev-only-not-secure` (the same fallback `apps/github-app` accepts in development). It then POSTs to `http://localhost:3030/webhooks/github`, sets `X-GitHub-Event: pull_request`, generates an `X-GitHub-Delivery` UUID, and computes `X-Hub-Signature-256: sha256=<HMAC>`.

To target a different host or port:

```
make replay-webhook FIXTURE=security-bug URL=http://localhost:4000/webhooks/github
```

For a real deployment receiving real GitHub deliveries, `GITHUB_APP_WEBHOOK_SECRET` must be set to the App registration's actual webhook secret (per `docs/deployment.md` § Secrets). The dev fallback `dev-only-not-secure` exists so contributors can exercise the full ingress path without provisioning a real App; it must never be used in production.

An end-to-end smoke test is available via `make smoke`; see § Test commands.

## Environment variables

The full set of variables consumed by the App. Names, classifications, and descriptions are sourced from `docs/deployment.md` § Environment variables. Refer to that document for the canonical reference.

**Secrets** — required for production.

| name | classification | description |
| --- | --- | --- |
| `GITHUB_APP_PRIVATE_KEY` | secret | The GitHub App private key (PEM contents or path), used by `packages/github/installation-auth` to mint installation tokens. Read via `SecretSource`. Never echoed to logs. |
| `GITHUB_APP_WEBHOOK_SECRET` | secret | The HMAC secret used by `apps/github-app/webhook-ingress` to verify `X-Hub-Signature-256` on inbound webhooks. Read via `SecretSource`. Never echoed to logs. |
| `ANTHROPIC_API_KEY` | secret | The Anthropic Claude provider API key consumed by `packages/providers/anthropic` (per OQ-1). Read via `SecretSource`. Never echoed to logs. |
| `COPILOT_API_KEY` | secret | The GitHub Copilot provider API key (PAT with `models:read` scope, or App installation token) consumed by `packages/providers/copilot` (per ADR-004). Selected only when `ANTHROPIC_API_KEY` is unset. Read via `SecretSource`. Never echoed to logs. |

**Config**

| name | classification | description |
| --- | --- | --- |
| `PORT` | config | TCP port the Fastify ingress listens on inside the container. Default `3000`. |
| `REDIS_URL` | config | BullMQ connection string for the `pr-review` queue. |
| `GITHUB_APP_ID` | config | Numeric GitHub App id. Identifies the App registration; not a secret. |
| `GITHUB_APP_SLUG` | config | GitHub App slug, used for App identity attribution and audit-log correlation. |
| `OTEL_SERVICE_NAME` | config | OpenTelemetry service name; matches the `service` field on every structured log event. Default `prisma-review-bot`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | config | OTLP/HTTP collector URL. When unset, telemetry export is disabled but the App still functions. |
| `LOG_LEVEL` | config | Default log verbosity for `packages/shared/audit-log`; one of `debug`, `info`, `warn`, `error`. |
| `INSTALLATION_REPLAY_WINDOW_SECONDS` | config | Replay-protection window for `X-GitHub-Delivery` per installation. Duplicate deliveries within the window short-circuit to `discarded_idempotent`. |
| `NODE_ENV` | config | Standard Node.js environment marker (`development`, `production`, `test`). |
| `APP_HOST_PORT` | config | Docker-compose host-port override consumed by `docker-compose.yml`; not read by application code. Default `3030`. |
| `COPILOT_MODEL` | config | Optional Copilot adapter model override. Default `gpt-4o`. Consumed only when `COPILOT_API_KEY` is set. |
| `COPILOT_BASE_URL` | config | Optional Copilot adapter inference-endpoint override. Default `https://models.github.ai/inference`. Consumed only when `COPILOT_API_KEY` is set. |

**Tunables**

| name | classification | description |
| --- | --- | --- |
| `QUEUE_CONCURRENCY` | tunable | BullMQ worker concurrency cap; bounds in-flight provider calls per worker process. |
| `JOB_TIMEOUT_SECONDS` | tunable | Per-job wall-time timeout; the worker fails the job if the pipeline exceeds it. |
| `RETRY_TRANSIENT_MAX_ATTEMPTS` | tunable | Maximum attempts for the **Transient** retry class (`ProviderError.transport`). |
| `RETRY_TRANSIENT_BACKOFF_BASE_MS` | tunable | Initial backoff for transient retries (jittered). |
| `RETRY_TRANSIENT_BACKOFF_MAX_MS` | tunable | Cap on backoff growth for transient retries. |
| `RETRY_RATELIMIT_MAX_ATTEMPTS` | tunable | Maximum attempts for the **Rate-limited** retry class (`ProviderError.rate_limit`); honors `Retry-After` when provided. |
| `MAX_TOKENS_PER_PR` | tunable | Per-PR token-cost ceiling proxy enforced by `packages/providers/anthropic`. |
| `MAX_TOKENS_PER_WINDOW_PER_INSTALLATION` | tunable | Per-installation token-cost ceiling proxy over a sliding window. |
| `MAX_TOKENS_WINDOW_SECONDS` | tunable | Length of the sliding window for `MAX_TOKENS_PER_WINDOW_PER_INSTALLATION`. |
| `OTEL_TRACES_SAMPLER_ARG` | tunable | Head-sample argument for the parent-based sampler; a number in `[0,1]`. |

## Test commands

```
make test
```

Runs the Vitest suite — 227 tests across 33 test files (Phase 6 baseline). All GitHub interactions are routed through `OctokitLike` fakes and all provider interactions through `FakeProvider`, so the suite is fully offline and deterministic. A failure exits non-zero.

```
make eval
```

Runs the Phase 6 deterministic evaluation harness across 9 scenarios. The harness loads each scenario from `evals/scenarios.yaml`, resolves the matching fixture under `evals/fixtures/`, runs the pipeline against `FakeProvider`, and compares the `PublicationResult` against the per-scenario expectation. The PASS gate is 9/9. To add a new scenario, see `evals/README.md`.

## Known limitations

- Single-tenant MVP; multitenant boundaries are namespaced by `installation_id` (per `docs/system-design.md` § Multitenancy posture) but are not validated under load. Concurrency, fairness, and isolation across many installations are out of scope until the App moves to hosted multi-tenant operation.
- Two production adapters ship: Anthropic Claude (per OQ-1) and GitHub Copilot via the GitHub Models inference endpoint (per ADR-004). Worker selection is by env-var precedence (`ANTHROPIC_API_KEY` → `COPILOT_API_KEY` → `FakeProvider` boot stub); both adapters satisfy the same `Provider` interface, so downstream pipeline stages do not branch.
- No live-API integration tests; all GitHub and Anthropic calls in tests use hand-rolled fakes (`OctokitLike`, `FakeProvider`). Phase 6 evaluation is deterministic and offline.
- Cost-ceiling enforcement uses a `character/4` token proxy (per OQ-4); precise tokenization is post-MVP.
- Inline-comment dedupe across runs is correct in unit tests but unproven against real GitHub API quirks (per `docs/publication-policy.md` § Dedupe behavior).
- The Checks summary may be truncated to 60 KB on very large finding sets.
- Tracked unknowns are listed in `docs/open-questions.md` (open: OQ-4, OQ-5, OQ-6, OQ-8, OQ-9).

## Trust model — why comments are capped

Operating principle 5 — "Trust preservation beats maximum coverage" — drives every default in the publication-cap stage. New installs ship with `comment_cap.per_pr = 5`, `comment_cap.per_file = 1`, `severity_floor.inline = medium`, `confidence_floor.inline = 0.7`, and the default `mode` for newly installed repos is `dry-run`. These caps are deliberately conservative so that a fresh installation never floods a pull request with low-confidence advisory noise: the maintainer sees the App's first findings in the Checks summary while keeping inline comments off until they opt into `summary-only` or `summary-plus-inline`. Caps and floors are tunable per-repo via `.github/review-bot.yml`; the OQ-2 defaults are the floor of conservatism, not a ceiling. The full mode behavior matrix and dedupe rules live in [`docs/publication-policy.md`](docs/publication-policy.md).

## Documentation map

Every Phase 1–6 artifact, grouped by phase. Links resolve relative to the repository root.

| document | purpose |
| --- | --- |
| **Phase 1 — Research and decisions** | |
| [`docs/research-summary.md`](docs/research-summary.md) | OSS landscape and integration-surface findings. |
| [`docs/architecture-decision-records/adr-001-github-app.md`](docs/architecture-decision-records/adr-001-github-app.md) | App-first decision (vs. Action). |
| [`docs/architecture-decision-records/adr-002-provider-abstraction.md`](docs/architecture-decision-records/adr-002-provider-abstraction.md) | Provider abstraction decision (Zod-bounded boundary). |
| [`docs/architecture-decision-records/adr-003-validation-ranking.md`](docs/architecture-decision-records/adr-003-validation-ranking.md) | Pipeline shape decision (`prefilter → provider → validator → ranker → publication cap`). |
| [`docs/threat-model.md`](docs/threat-model.md) | Security and abuse risk register; mitigations and residual risk. |
| [`docs/mvp-scope.md`](docs/mvp-scope.md) | What is in and out of MVP scope. |
| [`docs/open-questions.md`](docs/open-questions.md) | Open and resolved decisions registry (OQ-1 through OQ-9). |
| **Phase 2 — Product and contracts** | |
| [`docs/product-spec.md`](docs/product-spec.md) | Personas, operating modes, and core flows. |
| [`docs/config-spec.md`](docs/config-spec.md) | `.github/review-bot.yml` schema, key reference, and resolution order. |
| [`docs/review-findings-schema.md`](docs/review-findings-schema.md) | `NormalizedFinding`, `dedupe_key`, and `RejectionLogEntry`. |
| [`docs/api-contracts.md`](docs/api-contracts.md) | Internal pipeline contracts (ingress, provider, validator, ranker, publisher). |
| [`docs/publication-policy.md`](docs/publication-policy.md) | Publisher ruleset, mode-behavior matrix, and OQ-2 defaults. |
| **Phase 3 — System design and observability** | |
| [`docs/system-design.md`](docs/system-design.md) | Components, schemas, end-to-end sequence. |
| [`docs/data-flow.md`](docs/data-flow.md) | The five flows: happy, oversized, provider-fail, malformed, replay. |
| [`docs/deployment.md`](docs/deployment.md) | Topology, environment variables, health surfaces. |
| [`docs/observability.md`](docs/observability.md) | Logs, metrics, traces, and the redaction allowlist. |
| [`docs/operational-runbooks.md`](docs/operational-runbooks.md) | Runbooks and numeric tunables. |
| **Phase 6 — Evaluation** | |
| [`docs/evaluation-plan.md`](docs/evaluation-plan.md) | Phase 6 methodology and scenario taxonomy. |
| [`evals/README.md`](evals/README.md) | Operator-facing eval harness guide. |

## License

License: TBD — pre-GA decision; see [`docs/open-questions.md`](docs/open-questions.md).
