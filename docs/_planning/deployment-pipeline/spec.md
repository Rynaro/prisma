# SPECTRA Spec — prisma-bot Production Deployment Pipeline

> Junction thread `019eae72-01ad-7ad1-a02a-0bc727483e4b` · TRANCE G3 (evaluator-optimizer) · iteration 3/3 · final confidence **0.88**
> Upstream: `scout-report.md` (atlas→spectra envelope `019eae72-01b0-7eca-9484-0ae39e8a03cd`, verify_pass)

## Executive Summary

prisma-bot is a GitHub App that reviews PRs. Its runtime is two roles off **one image**: a Fastify **ingress** (`start:app`, listens :3000, receives GitHub webhooks at `/webhooks/github`) and one or more **workers** (`start:worker`) that consume a **BullMQ** queue backed by **Redis**. There is **no SQL database** and there are **no migrations** — Redis is the sole datastore. This spec delivers the missing production surface: a production image stage, a hardened compose stack fronted by **Traefik** (TLS via ACME), an **interactive installer**, and a CI release workflow that publishes to GHCR.

The scout (verified upstream, envelope `019eae72-01b0-7eca-9484-0ae39e8a03cd`) established the ground truth this spec is pinned to:

- The root `Dockerfile` has only `base` + `dev` stages ("Production stages arrive in Phase 5", `Dockerfile:31-39`). Entrypoints are interpreter-direct: `start:app=tsx src/main.ts`, `start:worker=tsx src/worker.ts`. **No compiled build exists** (FINDING-003) — production must run the tsx runtime (DECISION-1).
- `docker-compose.yml` is dev-only (bind mounts, `tsx watch`, `redis:7` healthcheck, host port `3030:3000`, no TLS/restart/Traefik). A separate prod compose is required (GAP-002).
- `/healthz/live` **already exists** and is the only honest probe (`apps/github-app/src/server.ts:136-147`). `/healthz/ready` and `/healthz/deps` are always-200 / "unchecked" stubs that contradict `docs/deployment.md:104-114`. Traefik and the installer must probe `/healthz/live` only (DECISION-4); hardening ready/deps is out-of-band stretch (S7).
- Missing secrets **silently degrade** (dev fallback webhook secret `main.ts:48-58`; `FakeProvider` `worker.ts:132`), so the installer must enforce secret presence at intake.
- CI (`.github/workflows/ci.yml`) builds/publishes nothing; the repo has zero traefik/acme/registry references (GAP-006).

Scope is three parallel tracks — **T-image**, **T-compose**, **T-installer** — joined by two hard sync contracts: the **image tag** and the **healthcheck path** (`/healthz/live`). Seven stories (S1–S6 ship; S7 stretch). Final confidence **0.88**.

---

## [DECISION] Log

**[DECISION-1] Production runs the tsx runtime, not a compiled bundle.**
Rationale: No `build` script and no compiled entrypoint exist (FINDING-003); `start:app`/`start:worker` invoke `tsx src/*.ts` directly. Adding a bundler/`tsc` emit step is net-new surface, out of scope, and a fresh failure axis. The production Dockerfile stage installs prod deps + `tsx` and runs the same entrypoints with `NODE_ENV=production`. Tradeoff accepted: a slightly larger runtime image and per-start transpile cost, in exchange for zero build-toolchain risk and exact parity with how the app already runs.

**[DECISION-2] One image, two roles, selected by compose `command:`.**
Rationale: app and worker share the same dependency closure and codebase; the only difference is the entrypoint. Building two images doubles CI/publish/pull surface for no isolation benefit. A single image `ghcr.io/<owner>/prisma-bot` is published once; compose sets `command: ["pnpm","start:app"]` vs `["pnpm","start:worker"]`. The prod Dockerfile stage does **not** hardcode a role.

**[DECISION-3] Traefik is the edge (user-mandated), terminating TLS via ACME.**
Rationale: Traefik's docker provider auto-discovers routers from container labels, so the only routed service is the app (Host + Path rule for `/webhooks/github` plus `/healthz`); worker and redis carry **no** router and are never exposed. ACME resolver `letsencrypt` uses **HTTP-01** by default (works for any host that can answer :80), with **DNS-01** documented as the variant for wildcard/closed-:80 environments. `acme.json` is a bind-mounted store at perms **600** (Traefik refuses to start otherwise). `exposedByDefault=false` means a service is dark unless it opts in via `traefik.enable=true`.

**[DECISION-4] Pin the Traefik healthcheck and installer readiness-poll to `/healthz/live` only.**
Rationale: It is the only probe that reflects real process liveness (`server.ts:136-147`); `/healthz/ready` and `/deps` are stubs that lie green (FINDING-007/008). Health-checking a stub would mask real outages. No story *builds* a liveness endpoint — it exists. The contract story (S6) only *pins* the existing path into the Traefik label and the installer poll loop.

**[DECISION-5] CI publishes to `ghcr.io/<owner>/prisma-bot` with a deterministic tag scheme.**
Rationale: GHCR needs no extra secret (uses `GITHUB_TOKEN`), and the org already lives on GitHub. Tags: `sha-<short>` is **always** pushed (every workflow run → an immutable, reproducible pull ref); on a published GitHub Release, `vX.Y.Z` + `latest` are added. The installer and compose default to `latest`, overridable by pinning a digest/sha tag in `deploy/.env`.

**[DECISION-6] The installer is interactive and repo-cloned, not curl|sh (user-mandated).**
Rationale: Secrets (provider API key, GitHub App private key) must never transit a pipe-to-shell or appear in shell history; the installer reads them with `read -s` (no echo) from a cloned checkout. It is the single chokepoint that converts silent-degradation defaults into enforced inputs, generates the webhook secret, and surfaces the exact webhook URL + secret to paste into the GitHub App registration screen.

**[DECISION-7] The installer generates `GITHUB_APP_WEBHOOK_SECRET` rather than prompting for it.**
Rationale: It is a shared secret created at install time, not a pre-existing credential. `openssl rand -hex 32` yields a 256-bit value; the installer writes it to `deploy/.env` and echoes it once at the end so the operator can paste it into GitHub. This closes the `main.ts:48-58` dev-fallback gap by guaranteeing a strong secret is always present in prod.

---

## ASCII Topology

```
                            Internet
                               │
                  GitHub  ─────┤  (inbound webhook POST /webhooks/github,
              (webhook +       │   signed w/ GITHUB_APP_WEBHOOK_SECRET)
               REST/GraphQL)   │
                               ▼
                    ┌──────────────────────┐
       :80 web ────►│       TRAEFIK         │  static cfg: deploy/traefik/traefik.yml
       :443 ws ────►│  entrypoints web/    │   • web :80  → redirect → websecure :443
   (ONLY published  │  websecure           │   • ACME resolver "letsencrypt" (HTTP-01
    host ports)     │  ACME letsencrypt    │     default; DNS-01 variant)
                    │  docker provider     │   • acme.json store (chmod 600)
                    │  exposedByDefault=    │   • provider: docker, exposedByDefault=false
                    │     false            │
                    └──────────┬───────────┘
                               │ router rule (label on app only):
                               │ Host(`${PRISMA_DOMAIN}`) && Path(`/webhooks/github`)
                               │   (+ /healthz), TLS certresolver=letsencrypt
                               ▼
                    ┌──────────────────────┐         outbound
                    │   app  (Fastify)     │────────► GitHub REST/GraphQL
                    │   command: start:app │         (installation auth)
                    │   :3000 (NOT host-   │────────► Provider API
                    │    published)        │         (Anthropic|Copilot|OpenAI)
                    │   GET /healthz/live ◄─┼── Traefik healthcheck + installer poll
                    └──────────┬───────────┘
                               │ enqueue review jobs (BullMQ)
                               ▼
                    ┌──────────────────────┐
                    │  redis:7-alpine      │  healthcheck: redis-cli ping
                    │  (BullMQ backing,    │  named volume (persistence)
                    │   SOLE datastore —   │  NO router (not exposed)
                    │   no SQL, no migr.)  │
                    └──────────┬───────────┘
                               │ consume jobs (BullMQ)
                               ▼
                    ┌──────────────────────┐         outbound
                    │ worker(s)            │────────► GitHub REST/GraphQL (post review)
                    │ command: start:worker│────────► Provider API (generate findings)
                    │ NO router (not       │
                    │  exposed), scalable  │
                    └──────────────────────┘

  internal network: app ↔ redis ↔ worker (compose default bridge); only Traefik
  binds host :80/:443. No SQL database exists anywhere in the topology.
```

---

## Stories

### S1 — Add a production stage to the existing root `Dockerfile` (tsx runtime)
**Track:** T-image · **kupo_delegable:** yes
**Traceability:** GAP-001, FINDING-001, FINDING-003 · **Files:** `Dockerfile` (modify)

> **GIVEN** the root `Dockerfile` ends at the `dev` stage with a comment "Production stages arrive in Phase 5" (`Dockerfile:31-39`) and no `build` script exists (FINDING-003),
> **WHEN** I add a `prod` stage that `FROM base`, installs production dependencies + `tsx`, sets `NODE_ENV=production`, runs as a non-root user, and defines a default `CMD` runnable as either `start:app` or `start:worker` via compose `command:` override (no role hardcoded),
> **THEN** the single image runs both roles unchanged from how they run today, with no bundler/tsc step introduced.

**Validation gate:**
- `docker build --target prod -t prisma-bot:local .` exits 0.
- `docker run --rm prisma-bot:local node -e "require('tsx')"` exits 0 (runtime present).
- `docker run --rm prisma-bot:local sh -c 'echo $NODE_ENV'` prints `production`.
- `docker run --rm prisma-bot:local id -u` prints non-zero (non-root).
- `docker inspect prisma-bot:local --format '{{.Config.Cmd}}'` shows no hardcoded `worker`/`app` role.

### S2 — Author the production compose stack (app + worker + redis, internal-only)
**Track:** T-compose · **kupo_delegable:** yes
**Traceability:** GAP-002, FINDING-002 · **Files:** `deploy/docker-compose.prod.yml` (create)

> **GIVEN** only a dev compose exists (bind mounts, `tsx watch`, host port `3030:3000`, no restart policy),
> **WHEN** I author `deploy/docker-compose.prod.yml` with three services — `app` (image `ghcr.io/<owner>/prisma-bot:${IMAGE_TAG:-latest}`, `command: ["pnpm","start:app"]`, `restart: unless-stopped`, `env_file: .env`, **no host-published ports**), `worker` (same image, `command: ["pnpm","start:worker"]`, `restart: unless-stopped`, `depends_on: redis` healthy, scalable), and `redis` (`redis:7-alpine`, `healthcheck: redis-cli ping`, named volume, no published ports) — all on the default internal network,
> **THEN** `docker compose -f deploy/docker-compose.prod.yml config` validates and the app's `:3000` is reachable only inside the network.

**Validation gate:**
- `docker compose -f deploy/docker-compose.prod.yml config --quiet` exits 0.
- `docker compose -f deploy/docker-compose.prod.yml config | grep -A3 'app:'` shows no `ports:` host publish.
- `docker compose -f deploy/docker-compose.prod.yml config | grep 'redis-cli'` confirms the redis healthcheck.
- Config shows `command` differs between app (`start:app`) and worker (`start:worker`) off one image.

### S3 — Front the stack with Traefik (static config + per-service app labels, ACME)
**Track:** T-compose · **kupo_delegable:** no (TLS/ACME judgement)
**Traceability:** GAP-003, FINDING-013 · **Files:** `deploy/traefik/traefik.yml` (create), `deploy/docker-compose.prod.yml` (extend)

> **GIVEN** there is no edge proxy and no TLS anywhere in the repo,
> **WHEN** I add `deploy/traefik/traefik.yml` (entrypoints `web :80` / `websecure :443`; global HTTP→HTTPS redirect; certificatesResolvers.`letsencrypt` ACME with **HTTP-01** challenge default — email `${PRISMA_ACME_EMAIL}`, storage `/acme.json` — and DNS-01 documented as a commented variant; providers.docker with `exposedByDefault: false`), add a `traefik` service to compose (image `traefik:v3`, publishes **only** host `80:80`/`443:443`, mounts the docker socket read-only and the static config, bind-mounts `acme.json` at perms 600), and put router labels **only on the app service** (`traefik.enable=true`; router rule `Host(\`${PRISMA_DOMAIN}\`) && (PathPrefix(\`/webhooks/github\`) || PathPrefix(\`/healthz\`))`; `tls.certresolver=letsencrypt`; loadbalancer server port `3000`),
> **THEN** worker and redis carry no Traefik labels (dark), and a valid certificate is issued for `${PRISMA_DOMAIN}` on first request.

**Validation gate:**
- `yamllint deploy/traefik/traefik.yml` exits 0.
- `grep -E 'exposedByDefault: *false' deploy/traefik/traefik.yml` matches.
- `grep -E 'httpChallenge|dnsChallenge' deploy/traefik/traefik.yml` shows HTTP-01 active, DNS-01 noted.
- `docker compose -f deploy/docker-compose.prod.yml config | grep -c 'traefik.http.routers'` returns labels under `app` only (worker/redis: 0).
- After `up`: `curl -I http://${PRISMA_DOMAIN}/healthz/live` returns `301/308` to https; `curl -I https://${PRISMA_DOMAIN}/healthz/live` returns `200` with a valid (Let's Encrypt) chain.
- `stat` on `deploy/acme.json` (post-install) is `600`.

### S4 — Interactive installer `deploy/install.sh` + `.env` template
**Track:** T-installer · **kupo_delegable:** no (secret intake, UX)
**Traceability:** GAP-004, FINDING-004, FINDING-005, FINDING-011, FINDING-012 · **Files:** `deploy/install.sh` (create), `deploy/.env.prod.example` (create)

> **GIVEN** no installer exists and missing secrets silently degrade (dev fallback webhook secret `main.ts:48-58`; `FakeProvider` `worker.ts:132`),
> **WHEN** I author `deploy/install.sh` (Bash 3.2-compatible; **all prompts/logs → stderr**, **captured values → stdout**) that, run from a cloned repo, prompts in order — (1) domain → `PRISMA_DOMAIN`, (2) ACME email → `PRISMA_ACME_EMAIL`, (3) GitHub App ID, (4) GitHub App slug, (5) private-key intake (path to `.pem`, read and folded into an env-safe single-line/escaped form), (6) provider menu `1=Anthropic 2=Copilot 3=OpenAI` + the matching key read silently (`read -s`, no echo), (7) optional OTLP endpoint (Enter to skip) — then **generates** `GITHUB_APP_WEBHOOK_SECRET=$(openssl rand -hex 32)`, writes `deploy/.env` from `deploy/.env.prod.example` (and **never clobbers an operator-edited `.env` without an explicit confirm**); a `--yes` non-interactive mode sources all answers from environment variables instead of prompting,
> **THEN** a complete, secret-enforced `deploy/.env` is produced with no secret echoed to the terminal or shell history.

**Validation gate:**
- `bash -n deploy/install.sh` exits 0; `shellcheck deploy/install.sh` reports no errors (warnings acceptable).
- Bash 3.2 check: script uses no `${var^^}` / associative arrays / `mapfile`.
- `--yes` run with env-provided answers produces a `deploy/.env` containing every required key and a 64-hex `GITHUB_APP_WEBHOOK_SECRET`.
- Re-running `--yes` against an existing edited `.env` does NOT overwrite without the confirm path.
- Prompts/logs reach stderr only; captured machine-readable values reach stdout; provider key never appears in trace or history.

### S5 — CI release workflow → publish `ghcr.io/<owner>/prisma-bot`
**Track:** T-image · **kupo_delegable:** yes
**Traceability:** GAP-006, FINDING-013 · **Files:** `.github/workflows/release.yml` (create)

> **GIVEN** `ci.yml` builds/publishes no image and there are zero registry references repo-wide,
> **WHEN** I add a **new** `.github/workflows/release.yml` (it may `needs:` the existing ci.yml jobs but does **not** otherwise modify ci.yml) that logs into GHCR with `GITHUB_TOKEN`, builds `--target prod`, and pushes `ghcr.io/${{ github.repository_owner }}/prisma-bot` tagged `sha-<short>` **always**, plus `vX.Y.Z` + `latest` **only on a published GitHub Release**,
> **THEN** every push yields an immutable `sha-` pull ref and releases additionally produce semver + `latest`.

**Validation gate:**
- `actionlint .github/workflows/release.yml` exits 0.
- Build step targets `prod`.
- `sha-` tag is unconditional; `latest`/`vX.Y.Z` steps guarded by `if: github.event_name == 'release'`.
- `ci.yml` unchanged.

### S6 — Pin Traefik healthcheck + installer readiness-poll to `/healthz/live` (contract story)
**Track:** sync (joins T-compose ↔ T-installer) · **kupo_delegable:** yes
**Traceability:** GAP-005, FINDING-007, FINDING-008 · **Files:** `deploy/docker-compose.prod.yml` (extend), `deploy/install.sh` (extend)

> **GIVEN** `/healthz/live` already exists and is honest (`server.ts:136-147`) while `/healthz/ready` and `/deps` are always-200 stubs (FINDING-007/008) — so **no story builds a liveness endpoint**,
> **WHEN** I (a) add a container healthcheck on the app service that GETs `http://localhost:3000/healthz/live`, and (b) make the installer's post-`up` readiness loop **bounded-poll** `https://${PRISMA_DOMAIN}/healthz/live` — falling back to `curl --resolve` / `-H "Host: ${PRISMA_DOMAIN}"` against the host before DNS has propagated — until 200 or timeout,
> **THEN** both the orchestrator and the installer gate on the only truthful probe; the stub `ready`/`deps` paths are never used for health.

**Validation gate:**
- Compose healthcheck contains `/healthz/live` and `/healthz/ready` appears 0 times.
- `grep -c '/healthz/live' deploy/install.sh` ≥ 1; `grep -c '/healthz/ready' deploy/install.sh` == 0.
- Installer poll is time-bounded (no unbounded `while true`).
- End-to-end: after install, the printed webhook URL is exactly `https://${PRISMA_DOMAIN}/webhooks/github` and the generated webhook secret is echoed once.

### S7 — STRETCH: harden `/healthz/ready` + `/healthz/deps` in app code
**Track:** stretch · **kupo_delegable:** no
**Traceability:** FINDING-007, FINDING-008 (resolves the doc↔code divergence) · **Files:** `apps/github-app/src/server.ts` (modify), `docs/deployment.md` (modify)

> **GIVEN** `docs/deployment.md:104-114` promises 503-until-bootstrap and real Redis/GitHub probes, but `server.ts:136-147` returns always-200 "unchecked",
> **WHEN** I implement `/healthz/ready` to return 503 until BullMQ/Redis connectivity and GitHub App auth bootstrap succeed, implement `/healthz/deps` to report each dependency's real state, and update `docs/deployment.md` to match,
> **THEN** code and docs agree, and an optional richer readiness gate becomes available **without** changing the S6 liveness pin.

**Validation gate:**
- Unit test: pre-bootstrap `/healthz/ready` → 503; post-bootstrap → 200.
- `/healthz/deps` enumerates redis + github with live status.
- `docs/deployment.md` no longer contradicts `server.ts`.
- S6 liveness behavior unchanged (regression check on `/healthz/live`).

---

## Effort Table

| Story | Description | Complexity (N/12) | Size + Hours | Files | Track | kupo_delegable |
|------|-------------|:--:|:--:|------|------|:--:|
| S1 | Prod stage in root Dockerfile (tsx runtime) | 4/12 | S · 2–3h | `Dockerfile` | T-image | yes |
| S2 | Prod compose: app+worker+redis, internal-only | 5/12 | M · 3–4h | `deploy/docker-compose.prod.yml` | T-compose | yes |
| S3 | Traefik static cfg + ACME + app labels | 8/12 | L · 6–8h | `deploy/traefik/traefik.yml`, `deploy/docker-compose.prod.yml` | T-compose | no |
| S4 | Interactive installer + `.env` template | 9/12 | L · 7–9h | `deploy/install.sh`, `deploy/.env.prod.example` | T-installer | no |
| S5 | CI release workflow → GHCR | 5/12 | M · 3–4h | `.github/workflows/release.yml` | T-image | yes |
| S6 | Pin healthcheck `/healthz/live` (contract) | 3/12 | S · 2h | `deploy/docker-compose.prod.yml`, `deploy/install.sh` | sync | yes |
| S7 | STRETCH: harden ready/deps probes | 6/12 | M · 4–5h | `apps/github-app/src/server.ts`, `docs/deployment.md` | stretch | no |

**Ship total (S1–S6):** ~23–30h. **With stretch (S7):** ~27–35h.

---

## Risks + Mitigations

| # | Risk | Severity | Mitigation |
|---|------|:--:|-----------|
| R1 | ACME HTTP-01 fails (port 80 blocked / DNS not yet pointing at host) → no cert, edge down | High | Installer preflight **warns** (not blocks) if domain A-record doesn't resolve to host; document DNS-01 variant in `traefik.yml`; bounded poll uses `Host:`-header fallback so verification works pre-DNS. |
| R2 | `tsx` runtime in prod transpiles on each start / larger image (DECISION-1 tradeoff) | Med | Accepted per FINDING-003 (no build exists); prod stage installs only production deps; revisit a compiled stage as a separate future spec. |
| R4 | Installer leaks a secret to terminal/history (provider key, App private key) | High | `read -s` (no echo) for keys; prompts/logs→stderr only, captured values→stdout; no `set -x` around secret reads; `.env` written with restrictive perms. |
| R5 | Operator re-runs installer and clobbers a hand-edited `deploy/.env` | Med | Never overwrite an existing edited `.env` without explicit confirm; `--yes` re-run also respects the no-clobber confirm path. |
| R6 | `latest` tag drift → unpredictable deploy | Med | `sha-<short>` always published as an immutable pin; compose `IMAGE_TAG` overridable to a sha/digest in `deploy/.env`. |
| R7 | Health gate masks a real outage if pinned to a stub | High | S6 pins **only** `/healthz/live` (honest); `ready`/`deps` stubs are excluded from all health gating until S7 hardens them. |
| R8 | `acme.json` perms wrong → Traefik refuses to start | Low | Installer/compose ensure `acme.json` is created at `600`; S3 gate asserts perms. |
| R9 | Worker/redis accidentally exposed | Med | `exposedByDefault=false` + router labels on app **only**; no host-published ports on app/worker/redis; S2/S3 gates assert. |

(R3 deleted: there is no SQL database and no migrations — Redis/BullMQ is the sole datastore.)

---

## Stretch Section

- **S7** (above): harden `/healthz/ready` (503-until-bootstrap) and `/healthz/deps` (real Redis + GitHub probes), reconciling `docs/deployment.md:104-114`.
- **Worker autoscaling**: parameterize `docker compose up --scale worker=N`; document BullMQ concurrency env.
- **DNS-01 turnkey**: promote the documented DNS-01 variant to an installer-selectable ACME mode (prompt for provider token).
- **Image hardening**: distroless/compiled-bundle stage as a follow-up once a `build` script exists (revisits DECISION-1, R2).

---

```yaml
# spec.yaml — prisma-bot production deployment pipeline (SPECTRA Refine iter3, corrected)
meta:
  project: prisma
  artifact: prisma-bot-production-deployment-pipeline
  spectra_pass: refine
  iteration: 3
  trance: G3
  junction_thread: 019eae72-01ad-7ad1-a02a-0bc727483e4b
  upstream_scout_envelope: 019eae72-01b0-7eca-9484-0ae39e8a03cd
  verify_pass: true
  confidence: 0.88
  datastore: redis            # BullMQ backing; SOLE datastore. No SQL DB, no migrations.
  edge_proxy: traefik         # user-mandated
  installer_mode: interactive # user-mandated; repo-cloned, not curl|sh
  runtime: tsx                # DECISION-1; no compiled build exists (FINDING-003)
  image: ghcr.io/<owner>/prisma-bot
  default_tag: latest

decisions:
  - id: DECISION-1
    statement: Production runs the tsx runtime, not a compiled bundle.
    rationale: No build script / compiled entrypoint (FINDING-003); start:app/start:worker invoke tsx directly.
  - id: DECISION-2
    statement: One image, two roles selected by compose command.
    rationale: Shared dep closure; role differs only by entrypoint; prod stage hardcodes no role.
  - id: DECISION-3
    statement: Traefik is the edge, terminating TLS via ACME (letsencrypt, HTTP-01 default, DNS-01 variant).
    rationale: docker provider, exposedByDefault=false, acme.json chmod 600, app labels only.
  - id: DECISION-4
    statement: Pin Traefik healthcheck and installer poll to /healthz/live only.
    rationale: Only honest probe (server.ts:136-147); ready/deps are always-200 stubs (FINDING-007/008).
  - id: DECISION-5
    statement: CI publishes ghcr.io/<owner>/prisma-bot; sha-<short> always, vX.Y.Z+latest on release.
    rationale: GHCR uses GITHUB_TOKEN; immutable sha pin + semver/latest on release.
  - id: DECISION-6
    statement: Installer is interactive and repo-cloned, not curl|sh.
    rationale: Secrets read with no echo; single chokepoint enforcing secret presence.
  - id: DECISION-7
    statement: Installer GENERATES GITHUB_APP_WEBHOOK_SECRET via openssl rand -hex 32.
    rationale: Shared secret created at install; closes dev-fallback gap (main.ts:48-58); echoed once for GitHub.

stories:
  - id: S1
    title: Add production stage to existing root Dockerfile (tsx runtime)
    files: [Dockerfile]
    action: modify
    depends_on: []
    parallel_track: T-image
    kupo_delegable: true
    traceability: [GAP-001, FINDING-001, FINDING-003]
    acceptance:
      - Adds prod stage FROM base; installs prod deps + tsx; NODE_ENV=production; non-root.
      - No role hardcoded; runnable as start:app or start:worker via compose command.
      - No bundler/tsc step introduced.
    verify:
      - "docker build --target prod -t prisma-bot:local . # exit 0"
      - "docker run --rm prisma-bot:local node -e \"require('tsx')\" # exit 0"
      - "docker run --rm prisma-bot:local sh -c 'echo $NODE_ENV' # production"
      - "docker run --rm prisma-bot:local id -u # non-zero (non-root)"
      - "docker inspect prisma-bot:local --format '{{.Config.Cmd}}' # no hardcoded role"
  - id: S2
    title: Author production compose stack (app + worker + redis, internal-only)
    files: [deploy/docker-compose.prod.yml]
    action: create
    depends_on: [S1]
    parallel_track: T-compose
    kupo_delegable: true
    traceability: [GAP-002, FINDING-002]
    acceptance:
      - app (start:app, no host ports), worker (start:worker, depends_on redis healthy, scalable), redis:7-alpine.
      - redis healthcheck redis-cli ping; named volume; no published ports on redis.
      - restart unless-stopped; env_file .env; one image, command differs per role.
    verify:
      - "docker compose -f deploy/docker-compose.prod.yml config --quiet # exit 0"
      - "docker compose -f deploy/docker-compose.prod.yml config | grep -A3 'app:' # no host ports"
      - "docker compose -f deploy/docker-compose.prod.yml config | grep 'redis-cli' # healthcheck present"
  - id: S3
    title: Front stack with Traefik (static config + ACME + per-service app labels)
    files: [deploy/traefik/traefik.yml, deploy/docker-compose.prod.yml]
    action: create+extend
    depends_on: [S2]
    parallel_track: T-compose
    kupo_delegable: false
    traceability: [GAP-003, FINDING-013]
    acceptance:
      - traefik.yml entrypoints web:80/websecure:443; HTTP->HTTPS redirect.
      - certificatesResolvers.letsencrypt ACME HTTP-01 default (email PRISMA_ACME_EMAIL, storage /acme.json); DNS-01 noted as variant.
      - providers.docker exposedByDefault=false; acme.json bind-mounted at chmod 600.
      - traefik service publishes ONLY host 80/443; docker socket read-only.
      - Router labels on app ONLY; worker and redis carry NO traefik labels.
    verify:
      - "yamllint deploy/traefik/traefik.yml # exit 0"
      - "grep -E 'exposedByDefault: *false' deploy/traefik/traefik.yml"
      - "grep -E 'httpChallenge|dnsChallenge' deploy/traefik/traefik.yml # HTTP-01 active, DNS-01 noted"
      - "docker compose -f deploy/docker-compose.prod.yml config | grep -c 'traefik.http.routers' # app only"
      - "curl -I https://${PRISMA_DOMAIN}/healthz/live # 200, valid LE chain"
      - "stat on deploy/acme.json # 600"
  - id: S4
    title: Interactive installer deploy/install.sh + .env template
    files: [deploy/install.sh, deploy/.env.prod.example]
    action: create
    depends_on: [S2]
    parallel_track: T-installer
    kupo_delegable: false
    traceability: [GAP-004, FINDING-004, FINDING-005, FINDING-011, FINDING-012]
    acceptance:
      - Bash 3.2-compatible; prompts/logs to stderr; captured values to stdout.
      - Prompt order: domain, ACME email, GitHub App ID, App slug, private-key path (.pem -> env-safe form), provider menu (1=Anthropic 2=Copilot 3=OpenAI)+key read silently, optional OTLP (Enter to skip).
      - Generates GITHUB_APP_WEBHOOK_SECRET via openssl rand -hex 32.
      - Writes deploy/.env from .env.prod.example; never clobbers an edited .env without asking.
      - --yes non-interactive mode sources answers from env.
      - No secret echoed to terminal or shell history.
    verify:
      - "bash -n deploy/install.sh # exit 0"
      - "shellcheck deploy/install.sh # no errors"
      - "no bash-4+ constructs (declare -A, mapfile, case-conversion expansions)"
      - "--yes run produces deploy/.env with every required key and 64-hex webhook secret"
      - "re-run --yes against edited .env does not overwrite without confirm"
      - "prompts to stderr; values to stdout; key absent from trace/history"
  - id: S5
    title: CI release workflow publishing ghcr.io/<owner>/prisma-bot
    files: [.github/workflows/release.yml]
    action: create
    depends_on: [S1]
    parallel_track: T-image
    kupo_delegable: true
    traceability: [GAP-006, FINDING-013]
    acceptance:
      - New release.yml (may `needs:` ci.yml jobs; does not otherwise modify ci.yml).
      - Login GHCR via GITHUB_TOKEN; build --target prod.
      - Tags sha-<short> ALWAYS; vX.Y.Z + latest only on published GitHub Release.
    verify:
      - "actionlint .github/workflows/release.yml # exit 0"
      - "build-push step has target: prod"
      - "sha- tag unconditional; latest/vX.Y.Z guarded by if github.event_name == 'release'"
      - "ci.yml unchanged"
  - id: S6
    title: Pin Traefik healthcheck + installer poll to /healthz/live (contract story)
    files: [deploy/docker-compose.prod.yml, deploy/install.sh]
    action: extend
    depends_on: [S3, S4]
    parallel_track: sync
    kupo_delegable: true
    traceability: [GAP-005, FINDING-007, FINDING-008]
    acceptance:
      - app container healthcheck GETs http://localhost:3000/healthz/live (no /ready, no /deps).
      - Installer bounded-poll https://${PRISMA_DOMAIN}/healthz/live with Host-header/--resolve fallback pre-DNS.
      - No story builds a liveness endpoint (exists at server.ts:136-147).
      - Installer prints webhook URL https://${PRISMA_DOMAIN}/webhooks/github + generated webhook secret once.
    verify:
      - "compose healthcheck contains /healthz/live; /healthz/ready count 0"
      - "grep -c '/healthz/live' deploy/install.sh # >=1; '/healthz/ready' # 0"
      - "poll is time-bounded (no unbounded while true)"

parallel_tracks:
  - id: T-image
    stories: [S1, S5]
    description: Build the single multi-role image and publish it to GHCR.
  - id: T-compose
    stories: [S2, S3]
    description: Production compose + Traefik edge (TLS/ACME), internal-only app/worker/redis.
  - id: T-installer
    stories: [S4]
    description: Interactive secret-enforcing installer + .env template.
  sync_points:
    - id: SYNC-image-tag
      contract: image_tag
      detail: Compose references ghcr.io/<owner>/prisma-bot:${IMAGE_TAG:-latest}; CI (S5) publishes that ref; tag scheme frozen before T-compose/T-installer start.
      joins: [T-image, T-compose]
      stories: [S1, S2, S5]
    - id: SYNC-healthcheck-path
      contract: healthcheck_path
      detail: /healthz/live is the single liveness contract for Traefik/compose healthcheck AND installer poll; ready/deps stubs excluded.
      joins: [T-compose, T-installer]
      stories: [S3, S4, S6]

gates:
  - id: G-build
    story: S1
    cmd: "docker build --target prod -t prisma-bot:local . && docker run --rm prisma-bot:local sh -c 'echo $NODE_ENV'"
    expect: "exit 0; prints production"
  - id: G-compose-valid
    story: S2
    cmd: "docker compose -f deploy/docker-compose.prod.yml config --quiet"
    expect: "exit 0; no host-published app ports; redis-cli healthcheck present"
  - id: G-traefik
    story: S3
    cmd: "grep -E 'exposedByDefault: *false' deploy/traefik/traefik.yml && curl -I https://${PRISMA_DOMAIN}/healthz/live"
    expect: "exposedByDefault false; 200 with valid LE cert; http redirects to https; acme.json 600"
  - id: G-installer
    story: S4
    cmd: "bash -n deploy/install.sh && shellcheck deploy/install.sh"
    expect: "exit 0; bash 3.2 constructs only; 64-hex webhook secret generated; secrets not echoed"
  - id: G-release
    story: S5
    cmd: "actionlint .github/workflows/release.yml"
    expect: "exit 0; build target prod; sha- always; latest/semver gated on release; ci.yml unchanged"
  - id: G-healthcheck-pin
    story: S6
    cmd: "docker compose -f deploy/docker-compose.prod.yml config | grep '/healthz/live' && grep -c '/healthz/ready' deploy/install.sh"
    expect: "live present; ready count 0; installer poll bounded; webhook URL + secret printed"

risks:
  - id: R1
    risk: ACME HTTP-01 fails (port 80 blocked / DNS not yet pointing at host).
    severity: high
    mitigation: Installer preflight warns (not blocks) on DNS mismatch; DNS-01 variant documented; poll uses Host-header fallback pre-DNS.
  - id: R2
    risk: tsx runtime transpiles per start / larger image (DECISION-1 tradeoff).
    severity: medium
    mitigation: Accepted per FINDING-003; prod-only deps; compiled stage deferred to future spec.
  - id: R4
    risk: Installer leaks provider key / GitHub App private key to terminal or history.
    severity: high
    mitigation: read -s for keys; logs->stderr, values->stdout; no set -x around secrets; restrictive .env perms.
  - id: R5
    risk: Re-run installer clobbers a hand-edited deploy/.env.
    severity: medium
    mitigation: Never overwrite edited .env without confirm; --yes respects the no-clobber confirm path.
  - id: R6
    risk: latest tag drift -> unpredictable deploy.
    severity: medium
    mitigation: sha-<short> immutable pin always published; IMAGE_TAG overridable to sha/digest in .env.
  - id: R7
    risk: Health gate masks a real outage if pinned to a stub.
    severity: high
    mitigation: S6 pins ONLY /healthz/live; ready/deps stubs excluded from health gating until S7.
  - id: R8
    risk: acme.json perms wrong -> Traefik refuses to start.
    severity: low
    mitigation: Installer/compose create acme.json at 600; S3 gate asserts perms.
  - id: R9
    risk: worker/redis accidentally exposed.
    severity: medium
    mitigation: exposedByDefault=false; router labels on app only; no host ports on app/worker/redis; gates assert.

stretch:
  - id: S7
    title: Harden /healthz/ready (503-until-bootstrap) + /healthz/deps (real probes) in app code
    files: [apps/github-app/src/server.ts, docs/deployment.md]
    action: modify
    depends_on: [S6]
    kupo_delegable: false
    traceability: [FINDING-007, FINDING-008]
  - id: stretch-worker-scale
    title: Worker autoscaling (docker compose up --scale worker=N) + BullMQ concurrency env
  - id: stretch-dns01
    title: Promote DNS-01 to installer-selectable ACME mode (prompt for provider token)
  - id: stretch-image-harden
    title: distroless/compiled-bundle image stage once a build script exists (revisits DECISION-1)
```
