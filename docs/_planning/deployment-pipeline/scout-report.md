# scout-report.md — Deployment-pipeline scout (prisma-bot)

**Mission:** 019eae72-01ad-7ad1-a02a-0bc727483e4b · tier=trance · read-only · repo root `/Users/henrique/workspace/oss/prisma`

## DECISION_TARGET answer

Nearly the entire production pipeline must be **created**: the repo today ships only a dev-mode container surface (no production image stage, no production compose, no Traefik/ACME/TLS anywhere, no installer, no image-publish CI). What is reusable: the Dockerfile `base` stage and pnpm conventions, the dev compose topology (redis + app + worker, Redis healthcheck, `REDIS_URL=redis://redis:6379` wiring), the `start:app`/`start:worker` entrypoints, `scripts/smoke.sh` as an installer-preflight pattern, and a complete, code-verified env-var inventory (`.env.example` + `docs/deployment.md`). One hard constraint discovered: `/healthz/ready` and `/healthz/deps` are **stubs** that diverge from the docs — Traefik health checks and installer preflight must use `/healthz/live` only, and the installer must validate secrets itself because the app silently degrades (dev fallback webhook secret, FakeProvider) when secrets are missing.

## Findings

**FINDING-001 (SQ-1, H)** — The Dockerfile defines only `base` and `dev` stages; production stages are explicitly deferred ("Production stages arrive in Phase 5"), and `dev` ends in `CMD ["sleep","infinity"]` expecting bind-mounted source. `Dockerfile:1-39` (deferral comment at :36, dev stage :37-39).

**FINDING-002 (SQ-1, H)** — `docker-compose.yml` is a dev stack: `redis:7-alpine` with `redis-cli ping` healthcheck (:2-12), `app` runs `pnpm --filter @prisma-bot/github-app run dev:app` (tsx watch) with source bind-mounted, port `${APP_HOST_PORT:-3030}:3000`, optional `.env` env_file, `REDIS_URL=redis://redis:6379`, `depends_on: redis: service_healthy`; `worker` mirrors it with `dev:worker`. No healthchecks on app/worker, no `restart:` policies, no proxy. `docker-compose.yml:1-82`.

**FINDING-003 (SQ-2, H)** — Process entrypoints are package scripts: `dev:app`/`dev:worker` (`tsx watch`) and `start:app`/`start:worker` (`tsx src/main.ts` / `tsx src/worker.ts`). There is **no build/compile script** — even `start:*` runs TypeScript via tsx, so a production image must either ship tsx+source or add a build step. `apps/github-app/package.json:10-16`.

**FINDING-004 (SQ-2, H)** — No install/bootstrap script exists, interactive or otherwise. `scripts/` contains only `check-vendor-isolation.sh`, `replay-webhook.ts`, `smoke.sh`; the Makefile is a container-first dev workflow (`install/test/up/down/smoke`), nothing operator-facing. `scripts/` (3 entries); `Makefile:1-111`.

**FINDING-005 (SQ-2, H)** — `scripts/smoke.sh` is a reusable preflight pattern: brings the stack up, polls `/healthz/live` with timeout, exercises unsigned (expect 401) and signed webhook deliveries, tears down; composes only `make` targets. `scripts/smoke.sh:1-60`. (Note: uses `set -euo pipefail` — works on Bash 3.2, but installer helpers must stay 3.2-clean per I-C9.)

**FINDING-006 (SQ-3, H)** — `infra/README.md` is a 9-line "Phase 4 scaffold placeholder": promises operator-facing infra config (OTel collector, Redis tuning) "lives here" but contains nothing; confirms OTLP is optional via `OTEL_EXPORTER_OTLP_ENDPOINT`. `infra/README.md:1-9`.

**FINDING-007 (SQ-4, H)** — All three health routes exist on the Fastify ingress, but `ready` and `deps` are stubs: `/healthz/live` returns `{status:'ok'}`; `/healthz/ready` **always** returns 200 with no bootstrap check; `/healthz/deps` returns 200 with `redis/github/provider: 'unchecked'`. `apps/github-app/src/server.ts:136-147`.

**FINDING-008 (SQ-4, H)** — This diverges from `docs/deployment.md` § Health surfaces, which promises `ready` → 503 until secrets+Redis verified, and `deps` → 503 on Redis/GitHub failure. `docs/deployment.md:98-114`. Consequence: Traefik must health-check `/healthz/live` (or treat ready as equivalent-to-live); installer preflight cannot use `ready`/`deps` to verify Redis or secrets.

**FINDING-009 (SQ-5, H)** — `packages/config` is **not** the env-var loader: it parses repo-local `.github/review-bot.yml` (YAML → Zod `RepoConfigSchema`). The mission premise is wrong on this point. `packages/config/src/config-loader/load.ts:19-30`, `parse.ts:43-77`.

**FINDING-010 (SQ-5, H)** — Real env intake is decentralized: direct `process.env` reads with defaults — `PORT` (3000), `HOST` (0.0.0.0), `REDIS_URL` (redis://redis:6379), `INSTALLATION_REPLAY_WINDOW_SECONDS` (300), `OTEL_SERVICE_NAME` at `apps/github-app/src/main.ts:23-30`; `MAX_TOKENS_PER_PR` (60000) at `src/worker.ts:53-55`; `LOG_LEVEL` at `src/server.ts:111`; BullMQ tunables (`QUEUE_CONCURRENCY` 4, `JOB_TIMEOUT_SECONDS` 120, `RETRY_TRANSIENT_*`) at `src/queue/bullmq-job-queue.ts:65-70,206-208`. Secrets resolve via `envSecretSource()` reading `process.env[name]` at `packages/github/src/installation-auth/secret-source.ts:19-22`.

**FINDING-011 (SQ-5, H)** — The documented env table (`docs/deployment.md:44-89`: 5 secrets, 11 config, 10 tunables) matches `.env.example` names byte-for-byte (`.env.example:1-57`), including provider precedence `ANTHROPIC_API_KEY → COPILOT_API_KEY → OPENAI_API_KEY → FakeProvider` (confirmed in `src/worker.ts:86-132`). Installer intake set: collect `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, exactly one provider key; **generate** `GITHUB_APP_WEBHOOK_SECRET`; everything else has safe code defaults.

**FINDING-012 (SQ-5, H)** — Nothing fails fast on missing secrets: unset `GITHUB_APP_WEBHOOK_SECRET` triggers a **dev-only fallback secret** (`apps/github-app/src/main.ts:48-58`) and no provider key silently selects FakeProvider (`src/worker.ts:132`). The installer is the only enforcement point for required secrets.

**FINDING-013 (SQ-6, H)** — CI is a single workflow that builds the **dev** compose image and runs typecheck/lint/test/eval; no image publish, no registry login, no tags. `.github/workflows/ci.yml:1-44`. Repo-wide search for `traefik|acme|letsencrypt|ghcr|registry|docker push` across `**/*.yml` returned zero matches (H).

## Gaps

- **GAP-001** — No production Dockerfile stage (deps-prune + runtime image per role, or single image with role-switched command). Must be created; only `base` is reusable.
- **GAP-002** — No production compose stack: needs restart policies, app/worker healthchecks, named (non-bind) source delivery, Traefik service, ACME resolver/volume, removal of host port publishing in favor of Traefik routing.
- **GAP-003** — No Traefik/ACME/TLS artifact of any kind exists (FINDING-013 search). Entire proxy+certificate layer is greenfield.
- **GAP-004** — No installer. Interactive `.env`-writing flow (Bash 3.2, stdout=values/stderr=logs) must be created; only smoke.sh's poll/replay patterns are wrappable.
- **GAP-005** — Docs-vs-code conflict on `ready`/`deps` (FINDING-007/008). Fixing the stubs is application code — **out of mission scope**; the spec must either pin health checks to `/healthz/live` or escalate a code-change decision.
- **GAP-006** — Could not verify any documented production image registry/naming convention; none exists.

## REUSE-vs-CREATE

| Concern | Verdict | Justification |
|---|---|---|
| Image build (prod) | **CREATE** (EXTEND `base` stage) | FINDING-001, FINDING-003, GAP-001 |
| Compose stack (prod) | **CREATE** (reuse dev topology/Redis wiring as template) | FINDING-002, GAP-002 |
| Reverse proxy (Traefik) | **CREATE** | FINDING-013, GAP-003 |
| Certificates (ACME/LE) | **CREATE** | FINDING-013, GAP-003 |
| Installer (interactive) | **CREATE** (WRAP smoke.sh preflight patterns) | FINDING-004, FINDING-005, GAP-004 |
| Health checks | **USE** `/healthz/live` only | FINDING-007, FINDING-008, GAP-005 |
| Env/secret intake | **USE** `.env.example` + docs table as installer manifest; installer enforces required secrets | FINDING-011, FINDING-012 |
| CI (image publish) | **CREATE** (EXTEND ci.yml or new workflow) | FINDING-013, GAP-006 |

## HANDOFF

→ **SPECTRA:** Spec must decide the production image strategy (tsx-runtime vs compiled; one image/two roles vs two images), the Traefik health-check surface given stubbed readiness (pin `/healthz/live` or escalate the app-code fix), and the installer's required-vs-generated env partition per FINDING-011/012.
→ **human:** Decide whether fixing `/healthz/ready`/`/healthz/deps` stubs (app code, currently out of scope) is pulled into the pipeline milestone (GAP-005).
