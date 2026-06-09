# prisma — vendor-independent AI code review for GitHub PRs

An AI code-review GitHub App with a deterministic validate-rank-publish pipeline and a swappable provider interface.

## Status

Phase 7 (MVP-complete, pre-GA). 227 tests across 33 test files · 9/9 evals PASS · ADR-001/002/003/004.

## Pick your path

- **Evaluating?** See [Quickstart](#quickstart--5-minutes-no-api-key-required) below — 5 minutes, no API key needed.
- **Installing on your org?** See [`docs/install-github-app.md`](docs/install-github-app.md) — operator how-to (~60 minutes).
- **Contributing?** See [`docs/contributing.md`](docs/contributing.md) — workspace, tests, ADRs (~90 minutes).

## Quickstart — 5 minutes, no API key required

Prereqs: Docker (≥ 20) and GNU Make. Nothing else is installed on the host. The headline 5 minutes assumes a warm Docker cache; first-time builds add 5–10 minutes while `docker build` materializes the dev image (one-time, dominated by `pnpm install` inside the image).

```bash
# 1. Clone and enter
git clone <url> prisma && cd prisma

# 2. Configure (placeholders are fine for the eval path)
cp .env.example .env

# 3. Build the workspace (first run pulls + builds the dev image; subsequent runs are seconds)
make install

# 4. Run the deterministic evaluation — produces a Markdown report of 9 review scenarios
make eval

# 5. Read the report
cat evals/last-report.md
```

You should see `9 passed, 0 failed` at the end of step 4. The report at `evals/last-report.md` shows the per-scenario published-Check shape (title, summary body, and inline-comment shapes) the bot would produce in production — rendered against the deterministic `FakeProvider`, no live API key required.

Going further: run `make smoke` (~45 s) for an end-to-end stack check that brings the App, worker, and Redis up, posts a signed webhook, and tears the stack down. To wire prisma onto a real GitHub org, see [`docs/install-github-app.md`](docs/install-github-app.md). The 5-minute tutorial with troubleshooting is at [`docs/quickstart.md`](docs/quickstart.md).

## What is prisma?

prisma is delivered as a GitHub App (per ADR-001). A single Fastify ingress accepts `POST /webhooks/github`, verifies `X-Hub-Signature-256`, derives an idempotency key, and enqueues a `JobPayload` onto a BullMQ `pr-review` queue backed by Redis. Worker processes consume the queue and run a deterministic pipeline whose stages are pinned by ADR-003. The provider stage is the only non-deterministic component; everything before and after is mechanical (per ADR-002, the `Provider` abstraction is the single boundary that vendor-specific code crosses). The schema chain handed between stages is `ProviderReviewInput → ProviderReviewOutput → NormalizedFinding → RankedFindings → PublicationResult`.

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
- **ADR-002 — Provider Abstraction.** Locks the `Provider` interface so vendor adapters can be swapped without touching pipeline code.
- **ADR-003 — Validation, Ranking, and Publication Cap.** Locks the pipeline string `prefilter → provider → validator → ranker → publication cap` and the trust-preserving cap stage.
- **ADR-004 — GitHub Copilot Provider Adapter.** First additive vendor under ADR-002; ships alongside the Anthropic Claude reference adapter.
- **ADR-005 — OpenAI Provider Adapter.** Third production vendor; the first to honor a deterministic `seed` (declares `deterministic_seed: true`) and to thread `request_shaping`.

Operating principle 5 — "Trust preservation beats maximum coverage" — drives every default in the publication-cap stage. New installs ship with `comment_cap.per_pr = 5`, `comment_cap.per_file = 1`, `severity_floor.inline = medium`, `confidence_floor.inline = 0.7`, and the default `mode` for newly installed repos is `dry-run`. These caps are deliberately conservative so that a fresh installation never floods a pull request with low-confidence advisory noise: the maintainer sees the App's first findings in the Checks summary while keeping inline comments off until they opt into `summary-only` or `summary-plus-inline`. Caps and floors are tunable per-repo via `.github/review-bot.yml`; the OQ-2 defaults are the floor of conservatism, not a ceiling. The full mode behavior matrix and dedupe rules live in [`docs/publication-policy.md`](docs/publication-policy.md).

## Documentation

Organized by what you want to do (Diátaxis).

**Get started**

- [`docs/quickstart.md`](docs/quickstart.md) — 5-minute evaluator tutorial with troubleshooting.
- [`docs/install-github-app.md`](docs/install-github-app.md) — install on your GitHub org.
- [`docs/contributing.md`](docs/contributing.md) — workspace, tests, ADRs, adding a provider.

**Reference (lookup)**

- [`docs/deployment.md`](docs/deployment.md) — env vars, topology, secrets, networking, health surfaces.
- [`docs/config-spec.md`](docs/config-spec.md) — `.github/review-bot.yml` schema and resolution order.
- [`docs/api-contracts.md`](docs/api-contracts.md) — internal pipeline contracts.
- [`docs/review-findings-schema.md`](docs/review-findings-schema.md) — `NormalizedFinding`, `dedupe_key`, `RejectionLogEntry`.
- [`docs/observability.md`](docs/observability.md) — logs, metrics, traces, redaction allowlist.
- [`docs/publication-policy.md`](docs/publication-policy.md) — modes, caps, dedupe behavior.
- [`docs/operational-runbooks.md`](docs/operational-runbooks.md) — runbooks and numeric tunables.

All environment variables are enumerated in [`docs/deployment.md` § Environment variables](docs/deployment.md#environment-variables). The README does not duplicate the table.

**Understand (explanation)**

- [`docs/system-design.md`](docs/system-design.md) — components, schemas, end-to-end sequence.
- [`docs/data-flow.md`](docs/data-flow.md) — happy / oversized / fail / malformed / replay flows.
- [`docs/threat-model.md`](docs/threat-model.md) — risks and mitigations.
- [`docs/research-summary.md`](docs/research-summary.md) — OSS landscape and decisions.
- [`docs/mvp-scope.md`](docs/mvp-scope.md) — what is and is not MVP.
- [`docs/open-questions.md`](docs/open-questions.md) — OQ register.
- [`docs/product-spec.md`](docs/product-spec.md) — personas, modes, flows.
- [`docs/evaluation-plan.md`](docs/evaluation-plan.md) — Phase 6 evaluation methodology.

**Decisions (ADRs)**

- [ADR-001 — Deliver as a GitHub App](docs/architecture-decision-records/adr-001-github-app.md).
- [ADR-002 — Provider Abstraction](docs/architecture-decision-records/adr-002-provider-abstraction.md).
- [ADR-003 — Validation, Ranking, and Publication Cap](docs/architecture-decision-records/adr-003-validation-ranking.md).
- [ADR-004 — GitHub Copilot Provider Adapter](docs/architecture-decision-records/adr-004-copilot-provider.md).
- [ADR-005 — OpenAI Provider Adapter](docs/architecture-decision-records/adr-005-openai-provider.md).

## License

License: TBD — pre-GA decision; see [`docs/open-questions.md`](docs/open-questions.md). [GAP]
