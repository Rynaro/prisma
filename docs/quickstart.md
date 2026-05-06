# Quickstart — 5-minute evaluator tutorial

This document is the depth complement to the README's Quickstart block. The goal is the same: get from `git clone` to seeing the bot produce realistic review output, in five minutes, **without provisioning any API key**. This page goes deeper on what each command produces, how to recover from common failures, and what to do next.

If anything below disagrees with the [README Quickstart](../README.md#quickstart--5-minutes-no-api-key-required), the README's literal command sequence wins; this page is the longer-form explanation around it.

## Prereqs

- **Docker** ≥ 20.
- **GNU Make**.

That is the entire host-side toolchain. No Node, no `pnpm`, no other host runtime is required. Every command runs inside a container managed by the `Makefile`.

## The five steps

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

## What each step produces

### Step 1 — `git clone <url> prisma && cd prisma`

A working tree at `./prisma`. Nothing prisma-specific happens yet. [DECISION] We do not pin a specific clone URL here so the doc applies equally to forks and to the canonical upstream.

### Step 2 — `cp .env.example .env`

A `.env` file in the repo root. The shipped `.env.example` contains placeholder values only — no real secrets — and the eval path needs none of them filled in. The same file becomes the canonical operator config when wiring a real GitHub App; see [`install-github-app.md`](install-github-app.md).

### Step 3 — `make install`

Runs `pnpm install` inside the `tools` container. Materializes `pnpm-lock.yaml`-resolved dependencies into the `node_modules` Docker volume. Nothing is installed on the host.

- **Warm-cache duration.** Seconds. Docker reuses the cached `prisma-bot/dev` image and the `node_modules` and `pnpm_store` named volumes.
- **Cold-cache duration.** 5–10 minutes. The first run builds the dev image (Node 20-alpine base + `pnpm install` inside the image). This is one-time. See [Troubleshooting](#troubleshooting) below.

Success signal: the final `pnpm` summary lists every workspace and exits `0`.

### Step 4 — `make eval`

Runs the Phase 6 deterministic evaluation harness via the `@prisma-bot/eval-runner` package. The harness loads the 9 scenarios indexed in `evals/scenarios.yaml`, resolves each fixture under `evals/fixtures/`, runs the full pipeline (`prefilter → provider → validator → ranker → publication cap`) against the in-process `FakeProvider`, and compares the resulting `PublicationResult` against the per-scenario expectation. The PASS gate is **9/9**; any regression fails the command. The harness writes a Markdown report to `evals/last-report.md`.

- **Wall-clock duration.** ~15 seconds on a typical laptop.
- **Why no API key is needed.** The provider stage runs against `FakeProvider`, a deterministic in-process adapter that returns scripted `ProviderReviewOutput` shapes. No live network calls, no Anthropic key, no Copilot key. The schema chain handed downstream is identical to a real provider's output, so the validator/ranker/publisher behavior is the same.

Success signal: the final lines include `9 passed, 0 failed` and a path to `evals/last-report.md`.

### Step 5 — `cat evals/last-report.md`

A Markdown file with one section per scenario. Each section shows the published Check title, the Check summary body, and any inline-comment shapes the publisher would create — exactly as the bot would render them on a real PR. The 9 scenarios cover the full taxonomy: a security finding that publishes inline; tests/migration findings; a harmless-refactor false-positive guard; generated-files exclusion; lockfile/source coexistence; malformed provider output degraded to summary-only; within-run dedupe; and oversized-PR fast-path. The IDs and order match [`docs/evaluation-plan.md` § Scenario taxonomy](evaluation-plan.md) byte-equivalent; see [`evals/README.md`](../evals/README.md) for the per-scenario index.

This is the evaluator's first contact with the bot. **It is the closest honest stand-in for "see what a review looks like" without an API key.**

## Troubleshooting

### "Cannot connect to the Docker daemon"

Docker is not running on the host. Start Docker Desktop (macOS / Windows) or `sudo systemctl start docker` (Linux), then re-run `make install`.

### Port `3030` already in use (when you later run `make up` or `make smoke`)

By default `docker-compose.yml` binds the App container's internal port `3000` to host port `3030`. Override with the `APP_HOST_PORT` env var:

```bash
APP_HOST_PORT=4040 make up
```

Application code continues to listen on `PORT=3000` inside the container regardless. (The Quickstart's `make eval` does not bind any host port; this only matters for `make up` / `make smoke`.)

### `make install` is taking a long time on the first run

Expected. First-time builds take 5–10 minutes while Docker materializes the dev image (Node 20-alpine base + workspace `pnpm install` inside the image). Subsequent runs use the cached image and named volumes; expect seconds. If you want to confirm progress, run `docker compose --profile tools logs --tail=100 -f tools` in a second terminal.

### `make eval` reports failures (other than `9 passed, 0 failed`)

The PASS gate is 9/9; any regression is a real failure. Capture the harness output and the offending scenario id (the report writes per-scenario sections) and file an issue. Per-scenario re-runs use:

```bash
make eval-scenario SCENARIO=<id>
```

Valid `<id>` values are listed in [`evals/README.md` § Scenario index](../evals/README.md#scenario-index).

### `cat: evals/last-report.md: No such file or directory`

`make eval` did not complete successfully — usually because step 3 (`make install`) failed silently and dependencies are not resolvable. Re-run `make install` with full output, then re-run `make eval`.

### Workspace lock not materialized / `pnpm-lock.yaml` mismatches

A clean reset from inside the repo:

```bash
make clean      # removes containers, volumes, and build cache
make install    # re-resolves dependencies and rebuilds the image
```

`make clean` deletes the `node_modules` and `pnpm_store` volumes; the next `make install` is effectively a cold-cache run.

## What to do next

### Run the end-to-end smoke test (`make smoke`, ~45 s)

```bash
make smoke
```

`scripts/smoke.sh` brings the full stack up (`make up`), polls `/healthz/live`, posts an unsigned webhook (expects `401`), posts a signed webhook via `make replay-webhook FIXTURE=security-bug` (expects `202`), greps the worker logs for the boot-time `worker.started` log line, and tears the stack down. This is the strongest "the stack actually runs" demonstration short of installing on a real GitHub App. Smoke is idempotent — running it twice in a row works.

### Wire a real provider and a real GitHub App

Once you want a live PR review, follow [`install-github-app.md`](install-github-app.md). That guide is the operator path: register a GitHub App, mint and store the secrets, choose a provider (Anthropic Claude or GitHub Copilot, per ADR-002 + ADR-004), bring the stack up via `make up`, and verify first webhook delivery.

### Contribute

If you want to extend the pipeline, add a provider, or add an eval scenario, see [`contributing.md`](contributing.md). It covers the workspace map, the inner-loop Make targets, where ADRs live, and a worked example for adding a provider (using `packages/providers/copilot` under ADR-004 as the precedent).

## A note on this Quickstart's success criterion

The default Quickstart path produces a deterministic eval report rather than a live PR review against `github.com`. This is deliberate: a live PR review requires a registered GitHub App, secrets, and an API key for the chosen provider — the operator path, not the evaluator path. The eval harness uses the same schemas, the same publisher, and renders the same Markdown a published Check would render in production, so the report is a faithful preview of what the bot produces. [DECISION] If you want the live-PR experience instead, jump to [`install-github-app.md`](install-github-app.md); the time-to-first-review goes from ~5 minutes to ~60 minutes.
