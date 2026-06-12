# prisma

**Vendor-independent AI code review for GitHub PRs.**

[![CI](https://github.com/Rynaro/prisma/actions/workflows/ci.yml/badge.svg)](https://github.com/Rynaro/prisma/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Rynaro/prisma)](https://github.com/Rynaro/prisma/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

A production-ready GitHub App that reviews pull requests with swappable AI providers (Anthropic, Copilot, OpenAI). Deterministic validation, ranking, and publication pipeline. Zero vendor lock-in.

## Pick Your Path

- **Try locally in 5 minutes** → [Local evaluation quickstart](#quickstart)
- **Deploy to production** → [Interactive installer](#deploy-to-production)
- **Integrate via GitHub App** → [App installation guide](./docs/install-github-app.md)
- **Customize the review** → [Custom review prompts guide](./docs/custom-review-prompts.md)
- **Understand the architecture** → [System design](./docs/system-design.md)

## Quickstart

No API key required. Evaluate against deterministic scenarios in under 5 minutes.

```bash
git clone https://github.com/Rynaro/prisma.git
cd prisma

cp .env.example .env   # placeholders are fine for the eval path
make install
make eval

cat evals/last-report.md
```

**Expected result:** `12 passed, 0 failed`. The report shows the per-scenario published-Check shape the bot would produce in production — rendered against the deterministic `FakeProvider`, no live API key required.

Smoke test (end-to-end stack — app, worker, Redis, signed webhook, teardown; ~45 seconds):

```bash
make smoke
```

**Prerequisites:** Docker ≥ 20, GNU Make. First-time builds add 5–10 minutes while the dev image materializes (one-time, dominated by `pnpm install` inside the image).

## Deploy to Production

One interactive command from a clean clone, fronted by Traefik with automatic TLS:

```bash
bash deploy/install.sh
```

The installer:

- Prompts for domain, ACME email, GitHub App credentials, and provider API key (silent reads — secrets never echo)
- Generates the webhook secret for you
- Runs preflight checks (Docker, Compose v2, ports 80/443, DNS)
- Brings up the production stack: app, worker, Redis (internal-only), Traefik v3 — the only published ports are 80/443
- Configures automatic TLS via Let's Encrypt (ACME HTTP-01; DNS-01 variant documented)
- Waits on `https://<domain>/healthz/live`, then prints the webhook URL and secret to paste into your GitHub App registration

For non-interactive deployment (answers from environment variables):

```bash
bash deploy/install.sh --yes
```

Images are published to `ghcr.io/rynaro/prisma-bot` (`v0.1.0`, `latest`, immutable `sha-<short>` per commit). Full reference: [docs/deployment.md](./docs/deployment.md).

## What is prisma?

A GitHub App with a deterministic review pipeline. A single Fastify ingress accepts `POST /webhooks/github`, verifies `X-Hub-Signature-256`, derives an idempotency key, and enqueues onto a BullMQ queue backed by Redis. Workers consume the queue and run the pipeline:

```
  GitHub PR webhook
        ↓
  HMAC verify → idempotency key → enqueue (BullMQ / Redis)
        ↓
  prefilter → provider → validator → ranker → publication cap
        ↓
  GitHub Checks API (bounded by publication policy)
```

**One vendor boundary, zero lock-in.** The provider stage is the only non-deterministic component; the `Provider` interface ([ADR-002](./docs/architecture-decision-records/adr-002-provider-abstraction.md)) is the single line vendor-specific code crosses. Selection at runtime by environment precedence:

1. `ANTHROPIC_API_KEY` → Anthropic Claude (reference adapter)
2. `COPILOT_API_KEY` → GitHub Copilot ([ADR-004](./docs/architecture-decision-records/adr-004-copilot-provider.md))
3. `OPENAI_API_KEY` → OpenAI ([ADR-005](./docs/architecture-decision-records/adr-005-openai-provider.md), deterministic seed support)
4. Fallback → `FakeProvider` (deterministic; powers the no-key eval path)

**Trust preservation beats maximum coverage.** Findings are validated, ranked, and capped before anything is published:

- Per-PR inline comment cap: 5 · per-file cap: 1
- Inline findings require severity ≥ medium and confidence ≥ 0.7
- New installations default to `dry-run` mode — you see findings in the Checks summary before any inline comment is written
- All tunable per repository via `.github/review-bot.yml`

Full mode matrix and dedupe rules: [docs/publication-policy.md](./docs/publication-policy.md).

## Customize the review

Shape how the bot reviews your code by adding custom guidance to `.github/review-bot.yml`:

```yaml
review_guidance:
  instructions: |
    Check for proper error handling. Each async operation must have a
    clear failure mode. Prefer specific error types over generic Error.

  path_instructions:
    - path: "src/payments/**"
      instructions: |
        Payment processing requires audit logging and idempotency keys.
        Flag any currency conversions without rounding checks.

  context_files:
    - path: "docs/architecture.md"
    - path: "docs/SECURITY_RULES.md"
```

Guidance is injected as **untrusted data** beneath an immutable system prompt — your rules can focus the review but never override the output schema or finding categories. Missing context files degrade gracefully. Token budget enforced; the diff is never evicted.

Full guide: [docs/custom-review-prompts.md](./docs/custom-review-prompts.md).

## Status

**v0.1.0** — first production release.

- 364 tests across 45 files, all passing · 12/12 deterministic eval scenarios PASS
- Containerized CI (typecheck, lint, test) on every push and PR
- TypeScript · Node >=22 <23 · pnpm 9.15.0 workspace monorepo
- Container images: `ghcr.io/rynaro/prisma-bot`
- Built on [Fastify](https://fastify.dev), [BullMQ](https://docs.bullmq.io), and Redis

## Providers

| Provider | Package | Seed-deterministic | Notes |
|----------|---------|:--:|-------|
| Anthropic Claude | `@prisma-bot/provider-anthropic` | — | Reference adapter ([ADR-002](./docs/architecture-decision-records/adr-002-provider-abstraction.md)) |
| GitHub Copilot | `@prisma-bot/provider-copilot` | — | [ADR-004](./docs/architecture-decision-records/adr-004-copilot-provider.md) |
| OpenAI | `@prisma-bot/provider-openai` | yes | First adapter honoring a deterministic `seed` ([ADR-005](./docs/architecture-decision-records/adr-005-openai-provider.md)) |
| Fake | `@prisma-bot/provider-fake` | yes | Deterministic; evals and keyless development |

Adding a provider touches exactly one package — see [docs/contributing.md](./docs/contributing.md).

## Documentation

Organized by what you want to do (Diátaxis).

### Get started

- [Quickstart](./docs/quickstart.md) — 5-minute evaluator tutorial with troubleshooting
- [GitHub App installation](./docs/install-github-app.md) — install on your org
- [Customize the review](./docs/custom-review-prompts.md) — add custom guidance and context files
- [Deployment](./docs/deployment.md) — env vars, topology, secrets, networking, health surfaces
- [Contributing](./docs/contributing.md) — workspace, tests, ADRs, adding a provider

### Reference

- [Configuration spec](./docs/config-spec.md) — `.github/review-bot.yml` schema and resolution order
- [API contracts](./docs/api-contracts.md) — internal pipeline contracts
- [Review findings schema](./docs/review-findings-schema.md) — `NormalizedFinding`, `dedupe_key`, `RejectionLogEntry`
- [Observability](./docs/observability.md) — logs, metrics, traces, redaction allowlist
- [Publication policy](./docs/publication-policy.md) — modes, caps, dedupe behavior
- [Operational runbooks](./docs/operational-runbooks.md) — runbooks and numeric tunables

All environment variables are enumerated in [docs/deployment.md § Environment variables](./docs/deployment.md#environment-variables); this README does not duplicate the table.

### Understand

- [System design](./docs/system-design.md) — components, schemas, end-to-end sequence
- [Data flow](./docs/data-flow.md) — happy / oversized / fail / malformed / replay flows
- [Threat model](./docs/threat-model.md) — risks and mitigations
- [Research summary](./docs/research-summary.md) — OSS landscape and decisions
- [MVP scope](./docs/mvp-scope.md) · [Open questions](./docs/open-questions.md) · [Product spec](./docs/product-spec.md) · [Evaluation plan](./docs/evaluation-plan.md)

### Decisions (ADRs)

- [ADR-001 — Deliver as a GitHub App](./docs/architecture-decision-records/adr-001-github-app.md)
- [ADR-002 — Provider Abstraction](./docs/architecture-decision-records/adr-002-provider-abstraction.md)
- [ADR-003 — Validation, Ranking, and Publication Cap](./docs/architecture-decision-records/adr-003-validation-ranking.md)
- [ADR-004 — GitHub Copilot Provider Adapter](./docs/architecture-decision-records/adr-004-copilot-provider.md)
- [ADR-005 — OpenAI Provider Adapter](./docs/architecture-decision-records/adr-005-openai-provider.md)

## License

[MIT](./LICENSE)
