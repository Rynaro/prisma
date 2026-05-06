# Contributing to prisma

This document is the contributor path: from `git clone` to a green local make-loop and a feel for where things live. Target window: ~90 minutes.

If you only want to run the bot locally, see [`quickstart.md`](quickstart.md). If you want to install it on a real GitHub org, see [`install-github-app.md`](install-github-app.md). This page is for PR authors.

## Workspace layout

prisma is a `pnpm` workspace. `apps/` contains runtime entry points; `packages/` contains pure-logic and IO-shaped libraries that the apps compose. `packages/github/*` is separate from `packages/core/*` because GitHub-API code is IO-shaped and credential-bearing — it must be testable with fakes, isolated from pure pipeline logic, and substitutable behind `Provider`-style seams. (Per [`system-design.md` § Apps vs packages boundaries](system-design.md).)

| Package | Purpose | Anchor |
| --- | --- | --- |
| `apps/github-app` | Fastify ingress + BullMQ worker entry points; owns process bootstrap, provider selection, health surfaces, and queue wiring. | [`docs/system-design.md#appsgithub-appwebhook-ingress`](system-design.md#appsgithub-appwebhook-ingress) |
| `packages/shared` | Canonical schemas (`ProviderReviewInput`, `ProviderReviewOutput`, `NormalizedFinding`, `RankedFindings`, `PublicationResult`, `RepoConfig`, `JobPayload`), audit-log surface, emission-time redactor. | [`docs/system-design.md#packagessharedaudit-log`](system-design.md#packagessharedaudit-log) |
| `packages/config` | Repo-local `.github/review-bot.yml` resolver; owns `loadRepoConfig` and the `RepoConfigSchema` resolution rules. | [`docs/system-design.md#packagesconfigconfig-loader`](system-design.md#packagesconfigconfig-loader) |
| `packages/core` | Deterministic pipeline modules: snapshotter, prefilter, validator, ranker. | [`docs/system-design.md#packagescoresnapshotter`](system-design.md#packagescoresnapshotter) |
| `packages/github` | GitHub-side adapters: installation-auth, Checks API, review comments, Installations API. | [`docs/system-design.md#packagesgithubinstallation-auth`](system-design.md#packagesgithubinstallation-auth) |
| `packages/providers/anthropic` | Anthropic Claude reference adapter (per OQ-1). | [`docs/system-design.md#packagesprovidersanthropic`](system-design.md#packagesprovidersanthropic) |
| `packages/providers/copilot` | GitHub Copilot adapter (per ADR-004) targeting the GitHub Models inference endpoint. | [ADR-004](architecture-decision-records/adr-004-copilot-provider.md) |
| `packages/providers/fake` | Deterministic in-process `FakeProvider` used by the eval harness and unit tests. | [`docs/system-design.md#packagesproviders-provider-abstraction-surface`](system-design.md#packagesproviders-provider-abstraction-surface) |
| `evals/runner` | Phase 6 deterministic evaluation harness (`@prisma-bot/eval-runner`); owns the scenario loader and the PASS/FAIL gate. | [`evals/README.md`](../evals/README.md) |

### The 60-second locate list

For a quick orientation:

- **Pipeline stages** live in `packages/core/` (`snapshotter`, `prefilter`, `validator-ranker`) and the worker app at `apps/github-app/src/pipeline/` composes them.
- **Zod schemas** live in `packages/shared/` (canonical `ProviderReviewInput`, `ProviderReviewOutput`, `NormalizedFinding`, `RankedFindings`, `PublicationResult`).
- **Providers** live in `packages/providers/{anthropic,copilot,fake}/`.
- **Configuration** loader and schema live in `packages/config/`.
- **GitHub adapters** live in `packages/github/` (installation-auth, Checks API, review-comments).
- **ADRs** live in `docs/architecture-decision-records/`.
- **Runbooks** live in `docs/operational-runbooks.md`; numeric tunables live there too.
- **Evaluation scenarios** live in `evals/scenarios.yaml` and `evals/fixtures/`; the harness package is at `evals/runner/`.

## Prereqs

Same as the Quickstart: **Docker** (≥ 20) and **GNU Make**. Nothing else is installed on the host. Every command in the inner loop runs inside a container managed by the `Makefile`.

## The make loop

The contributor inner loop is four commands. Run them in order; each runs inside the `tools` container.

```bash
make install     # install workspace deps (creates pnpm-lock.yaml)
make typecheck   # tsc across every workspace
make lint        # Biome + check-vendor-isolation (ADR-002 enforcement)
make test        # Vitest suite — 227 tests across 33 test files
make eval        # Phase 6 harness — 9 scenarios; PASS gate is 9/9
```

| Command | What it does |
| --- | --- |
| `make install` | Materializes `pnpm-managed` workspace dependencies. No host-side runtime is touched. |
| `make typecheck` | Runs the TypeScript typechecker across every workspace (`apps/github-app`, `packages/shared`, `packages/config`, `packages/core`, `packages/github`, `packages/providers/anthropic`, `packages/providers/copilot`, `packages/providers/fake`, `evals/runner`). |
| `make lint` | Runs Biome lint plus `check-vendor-isolation` (ADR-002 mechanical enforcement; see [Vendor isolation](#vendor-isolation-adr-002) below). Lint failures exit non-zero so the command is CI-safe. |
| `make lint-fix` | Auto-fix lint issues. |
| `make format` | Run Biome formatter. |
| `make test` | Runs the full Vitest suite — **227 tests across 33 test files** at the Phase 6 baseline. The suite is hermetic: GitHub interactions go through `OctokitLike` and provider interactions through `FakeProvider`. |
| `make test-watch` | Vitest watch mode. |
| `make eval` | Runs the Phase 6 deterministic evaluation harness against the 9 scenarios indexed in `evals/scenarios.yaml`. PASS gate is 9/9. |
| `make eval-scenario SCENARIO=<id>` | Run a single Phase 6 scenario. |

For deeper iteration, the stack-up commands:

| Command | What it does |
| --- | --- |
| `make up` | `docker compose up -d redis app worker`. The `app` container listens on container-internal `3000`; mapped to host `3030` by default (override with `APP_HOST_PORT`). |
| `make down` | Stop and remove containers. |
| `make logs` | Tail logs from running services. |
| `make ps` | List running services. |
| `make shell` | Open a shell in the `tools` container. |
| `make clean` | Remove containers, volumes, and build cache. |
| `make smoke` | End-to-end stack check: `make up`, post unsigned (expect 401) + signed (expect 202) deliveries, grep worker logs for `worker.started`, `make down`. ~45 s. |

### Replaying a webhook locally

To exercise the full ingress → worker → publisher path without a real GitHub PR:

```bash
make replay-webhook FIXTURE=security-bug
```

The replay script reads `evals/fixtures/security-bug.yaml`, signs the JSON body with `GITHUB_APP_WEBHOOK_SECRET` (or, in development only, the dev fallback `dev-only-not-secure`), and POSTs to `http://app:3000/webhooks/github` over the compose network. Override the URL with `URL=<override>` (e.g., `http://localhost:3030/webhooks/github` from the host shell). For real deliveries against a real App, set the real webhook secret; the dev fallback must never be used in production.

## ADRs — when to write one

Architecture Decision Records live at `docs/architecture-decision-records/`. They are immutable once accepted; a superseding decision requires a new ADR that explicitly references the prior one (per the convention in [ADR-001 § Status](architecture-decision-records/adr-001-github-app.md), [ADR-002 § Status](architecture-decision-records/adr-002-provider-abstraction.md), [ADR-003 § Status](architecture-decision-records/adr-003-validation-ranking.md), [ADR-004 § Status](architecture-decision-records/adr-004-copilot-provider.md)).

Write an ADR when:

- A change locks a deployment shape, an interface contract, or a pipeline stage's identity (the four existing ADRs are the precedent set).
- A change introduces a new vendor adapter (ADR-004 is the precedent — see [Adding a provider](#adding-a-provider) below).
- A change deletes or replaces a contract that other components or tests depend on.

Do **not** write an ADR for:

- Bug fixes, refactors, or test additions inside an existing contract.
- Numeric tunable changes (those live in [`operational-runbooks.md` § Numeric tunables](operational-runbooks.md)).
- Documentation reorganization (this document is a precedent).

ADRs follow the structure used by ADR-001 through ADR-004: Status, Context, Decision, Rationale, Trade-offs, Rejected alternatives, Consequences (now), Consequences (later). New ADRs are numbered sequentially (`adr-005-...`).

## Adding a provider

ADR-002 § Consequences (later): *"Adding or swapping a provider must be additive: a new adapter that satisfies the interface and its schemas. No core pipeline change is permitted to add provider B."* ADR-004 is the worked example: it added the GitHub Copilot adapter at `packages/providers/copilot/` without touching `packages/core`, `packages/shared/src/schemas`, or `evals/`. Use it as the precedent.

### Skeleton

The Copilot adapter ships with the four-file source layout that mirrors `packages/providers/anthropic/`:

- `src/client.ts` — the only network-call site. The vendor primitive (`fetch`, vendor SDK) is confined here per ADR-002 and `scripts/check-vendor-isolation.sh`.
- `src/prompt.ts` — user-message rendering for the provider's prompt envelope.
- `src/error-mapping.ts` — maps vendor errors to the five `ProviderError` variants (`transport | auth | rate_limit | capability | schema_validation`).
- `src/index.ts` — the `Provider` factory; exposes the three-member public surface (`name`, `capabilities`, `review`).

Plus three test files under `tests/`.

### Steps

1. **Create the package.** Mirror `packages/providers/copilot/` (or `packages/providers/anthropic/`). The package name follows the `@prisma-bot/provider-<vendor>` convention.
2. **Implement `Provider`.** Validate the vendor's wire response against `ProviderReviewOutputSchema` from `@prisma-bot/shared` at the adapter boundary. On Zod failure, throw `ProviderError` with variant `schema_validation`. (Per ADR-002 § Decision and § Interface contract; see also `packages/providers/copilot/src/index.ts` for the worked example.)
3. **Declare capabilities honestly.** `ProviderCapabilities` is a typed bag (`structured_output`, `function_calling`, `deterministic_seed`, `max_context_tokens`, etc.). Set each flag to what the vendor actually supports. (ADR-004's example: `structured_output: true, function_calling: true, deterministic_seed: false, max_context_tokens: 128000`.)
4. **Map errors.** Every vendor error maps to one of the five `ProviderError` variants; the adapter must scrub secrets from error messages (the `mapCopilotError` precedent reproduces the secret-scrubbing rule from `packages/providers/anthropic/src/error-mapping.ts:23` verbatim).
5. **Wire the worker selector.** Add a precedence arm to `apps/github-app/src/worker.ts` `buildProvider()`. The current order is `ANTHROPIC_API_KEY` → `COPILOT_API_KEY` → `FakeProvider({ script: [] })`. The chosen vendor must be observable via the `worker.provider.selected` log event.
6. **Wire vendor isolation.** Add the new vendor SDK / network primitive to `scripts/check-vendor-isolation.sh` (one rule = one `check_rule` invocation). The current rules are: `@anthropic-ai/sdk` confined to `packages/providers/anthropic/src/client.ts`; `@octokit/*` confined to `packages/github/src/installation-auth/`; `fetch(` calls under `packages/providers/` confined to `*/src/client.ts`. (Per ADR-004 § Consequences (later).)
7. **Document.** Add an ADR (`adr-005-<vendor>-provider.md`); update `.env.example`, `docs/deployment.md` (env-var table + readiness probe + `.env.example` snippet), and `docs/operational-runbooks.md` (rotation + incident-response copy).
8. **Test.** Unit tests for client, prompt, error-mapping, and provider behavior. The eval harness uses `FakeProvider`, so you do not need to add eval scenarios to land the adapter; the 9/9 PASS gate is preserved. (Per ADR-004 § Rationale § Additive change.)

### Vendor isolation (ADR-002)

The "no vendor SDK / network primitive outside the adapter" rule is enforced mechanically by `scripts/check-vendor-isolation.sh`, which runs as part of `make lint`. A violation prints a `path:line` citation and exits non-zero, so `make lint` fails the CI build. Run it standalone with `make check-vendor-isolation`. (Per the Makefile and ADR-004 § Consequences (later).)

## Adding an eval scenario

The Phase 6 evaluation harness lives at `evals/runner/` and is invoked via `make eval`. The PASS gate is 9/9. The full per-scenario index, the scenario YAML schema, and the step-by-step "add a scenario" instructions live in [`evals/README.md`](../evals/README.md). In short:

1. Pick an ID (kebab-case) not present in `evals/scenarios.yaml`.
2. Add the scenario entry to `evals/scenarios.yaml`.
3. Create `evals/fixtures/<id>.yaml` against the schema in [`evaluation-plan.md` § Scenario YAML schema](evaluation-plan.md).
4. Create `evals/fixtures/<id>/` for any auxiliary payload files referenced via `@file:<relative-path>`.
5. Run `make eval-scenario SCENARIO=<id>` and iterate until PASS.
6. Add the scenario to [`evaluation-plan.md` § Scenario taxonomy](evaluation-plan.md).
7. Open a PR; CI runs `make eval` and blocks on FAIL.

## Schemas first

prisma's pipeline contracts are Zod schemas in `packages/shared/`. Operating principle 8 from ADR-002 — "every public interface typed and schema-validated" — applies at every cross-package boundary, especially the provider boundary. When you add or change a schema:

- **Co-locate the schema with its identifier.** `ProviderReviewOutput` is the canonical name in ADR-002, ADR-003, the validator, and the publisher; it is one Zod schema and one TypeScript type.
- **Validate at the boundary.** Provider adapters validate the wire response against `ProviderReviewOutputSchema` before returning; on failure, throw `ProviderError` with variant `schema_validation`.
- **Update tests.** The Vitest suite includes contract tests at every cross-package seam.

## Licensing of contributions

License: TBD — pre-GA decision; see [`open-questions.md`](open-questions.md). Until a license lands, contributions are made on the same TBD basis as the project itself. [GAP] [ACTION] If a license lands during your work, this section will name it explicitly; check back here before opening a PR if you have specific licensing concerns.

## Where to ask

- For pipeline behavior: [`system-design.md`](system-design.md), [`data-flow.md`](data-flow.md), [`api-contracts.md`](api-contracts.md).
- For configuration: [`config-spec.md`](config-spec.md).
- For the publisher's ruleset and OQ-2 defaults: [`publication-policy.md`](publication-policy.md).
- For operational concerns: [`operational-runbooks.md`](operational-runbooks.md), [`observability.md`](observability.md), [`deployment.md`](deployment.md).
- For why decisions were made: the four ADRs at [`architecture-decision-records/`](architecture-decision-records/).
- For tracked unknowns: [`open-questions.md`](open-questions.md).
