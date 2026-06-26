# Deploying prisma with Kamal

> **ALTERNATIVE to the Compose + Traefik path** (`docs/deployment.md` + `deploy/`). The two
> are mutually exclusive on one host — both bind ports 80/443. Pick ONE per server.

## When to use this path

Use the Kamal path when you want a single-command deployment to a single Linux host with
automatic TLS managed by `kamal-proxy` (native Let's Encrypt), and you prefer a Ruby-based
deploy toolchain rather than the Bash + Docker Compose installer (`deploy/install.sh`).

Key characteristics versus the Compose + Traefik path:

- **kamal-proxy** replaces Traefik as the TLS-terminating reverse proxy. It obtains a
  Let's Encrypt certificate automatically from a DNS A-record; no ACME email key is required.
- **Redis** runs as a Kamal *accessory* — managed separately from app deploys, with a persistent
  named volume (`redis-data`) that survives rolling upgrades.
- **Roles**: one `web` role (Fastify webhook ingress) and one `worker` role (BullMQ consumer),
  both running the same prebuilt image with different `cmd` overrides.
- **Primary flow**: pull the published image from `ghcr.io/rynaro/prisma-bot` using
  `--skip-push --version=vX.Y.Z`. No local Docker build required.

If you already have a server running the Compose + Traefik stack (`deploy/install.sh`), do
**not** run the Kamal stack on the same host — the two proxies compete for ports 80 and 443.

## Prerequisites (the footgun guard — verify ALL before `kamal setup`) [E2]

Work through each item before you run `kamal setup`. Skipping any one of them is the most
common cause of a failed first deploy.

- **A server reachable by root SSH.** Kamal uses SSH to reach the host and installs Docker on
  first setup. The user running `kamal setup` must be able to `ssh root@<SERVER_IP>` without a
  password (use an SSH key). Supported distros: Ubuntu 22/24, Debian 12, or any Linux with
  Docker-compatible kernel.
- **`<SERVER_IP>` filled into `config/deploy.yml`.** Replace every `<SERVER_IP>` occurrence: in
  `servers.web.hosts`, `servers.worker.hosts`, and `accessories.redis.host`. All three point to
  the same single host.
- **Ports 80 AND 443 open to the host.** kamal-proxy binds both. Verify with your firewall or
  cloud security group.
- **A DNS A-record: `<your-domain>` → `<SERVER_IP>`.** Let's Encrypt resolves your domain during
  `kamal setup`. Propagation must be complete before you run setup; otherwise certificate
  issuance fails. Replace `<your-domain>` in `config/deploy.yml proxy.host`.
- **A GitHub PAT with `read:packages` scope → `KAMAL_REGISTRY_PASSWORD`.** This is the *deploying
  user's* PAT (your own GitHub account), not a prisma-team credential. It authorizes pulling
  `ghcr.io/rynaro/prisma-bot` from the GitHub Container Registry.
- **A populated `.kamal/secrets`.** Copy `.kamal/secrets.example` to `.kamal/secrets`, fill every
  value, and lock down permissions: `chmod 600 .kamal/secrets`. Never commit the filled-in file
  — it is gitignored.
- **Kamal installed locally.** The `kamal` CLI must be on your local machine (not the server):
  `gem install kamal` requires Ruby ≥ 3.1. Alternatively, use the official Kamal Docker image
  (`docker run -it --rm -v "$(pwd):/workdir" ghcr.io/basecamp/kamal:latest ...`) if you prefer
  not to install Ruby.

## Configure

1. **Secrets file.** Copy the template and fill every placeholder:

   ```bash
   cp .kamal/secrets.example .kamal/secrets
   chmod 600 .kamal/secrets
   ```

   Fill in:
   - `KAMAL_REGISTRY_PASSWORD` — your GitHub PAT with `read:packages`.
   - `GITHUB_APP_ID`, `GITHUB_APP_SLUG` — from your GitHub App registration.
   - `GITHUB_APP_PRIVATE_KEY` — the PEM key as a **single line** with literal `\n` escapes,
     single-quoted. Convert a `.pem` file with:
     `awk 'NF {printf "%s\\n", $0}' app.private-key.pem`
     Do NOT paste a raw multiline PEM — dotenv truncates at the first newline.
   - `GITHUB_APP_WEBHOOK_SECRET` — generate with `openssl rand -hex 32`.
   - `ANTHROPIC_API_KEY` (or your chosen provider key — see Provider key swap rule below).

2. **`config/deploy.yml` placeholders.** Edit the three placeholder strings:
   - `<SERVER_IP>` — appears three times (web hosts, worker hosts, redis host).
   - `<your-domain>` — the domain whose DNS A-record points at your server.
   - `<github-username>` — your GitHub username (the owner of the PAT above).

3. **Port and Redis URL consistency.** Do not change `proxy.app_port` (3000), `env.clear.PORT`
   ("3000"), or `env.clear.REDIS_URL` ("redis://prisma-redis:6379"). The port values must remain
   equal; the Redis URL uses the Kamal-network service name `prisma-redis`, not the Compose-path
   name `redis:6379`. Changing these without understanding the knock-on effects will break
   health-gating or queue connectivity.

## First deploy — PREBUILT image (PRIMARY flow) [T1]

Once prerequisites are satisfied and placeholders filled:

```bash
kamal setup --skip-push --version=vX.Y.Z
```

Replace `vX.Y.Z` with the image tag you want to run (e.g. `v0.12.0`). Always pin an explicit
version — never deploy `latest`.

What `kamal setup` does in order:

1. SSHs into `<SERVER_IP>` and installs Docker (if not already present).
2. Logs into `ghcr.io` using `KAMAL_REGISTRY_PASSWORD`.
3. Starts `kamal-proxy` (binds ports 80 and 443, obtains a Let's Encrypt certificate for
   `<your-domain>`).
4. Boots the `redis` accessory (pulls `redis:7-alpine`, mounts the `redis-data` volume).
5. Pulls `ghcr.io/rynaro/prisma-bot:<version>` — no local build.
6. Starts the `web` and `worker` containers with their respective `cmd` overrides.
7. Health-gates the `web` role against `GET /healthz/live` (interval 3s, timeout 5s) before
   routing traffic.
8. Routes inbound HTTPS to the `web` container on port 3000.

After setup completes, set your **GitHub App webhook URL** to
`https://<your-domain>/webhooks/github` in your GitHub App registration [E4]. Without this step
the App receives no webhook deliveries.

## Redeploy / update (PRIMARY flow)

To update to a new image version:

```bash
kamal deploy --skip-push --version=vX.Y.Z
```

Kamal performs a zero-downtime swap: it pulls the new image, starts new containers, health-gates
them against `/healthz/live`, switches traffic, and stops the old containers. The `redis`
accessory is **not touched** by `kamal deploy` (see Operations below).

Notes:
- `-P` is the short alias of `--skip-push`. Use one, not both.
- Always pin `--version`. Deploy `latest` at your own risk — it is a moving tag.
- `retain_containers: 5` keeps the five most recent container generations on the host for fast
  rollback.

## Provider key swap rule [T2]

prisma selects a provider by environment variable precedence:
`ANTHROPIC_API_KEY` → `COPILOT_API_KEY` → `OPENAI_API_KEY`.

The Kamal config enforces a fail-fast invariant: every name listed in `config/deploy.yml`
`env.secret` must be present as a key in `.kamal/secrets`, or Kamal errors at deploy time and
refuses to proceed. This is intentional — it prevents a silent fallback to a different provider
than you intended.

To switch providers:

1. In `config/deploy.yml` `env.secret`: comment out the current provider key and uncomment the
   new one. Only ONE provider key may be active (uncommented) at a time.
2. In `.kamal/secrets`: comment out the current key value and uncomment the new one. The active
   names in both files must match exactly.
3. Redeploy: `kamal deploy --skip-push --version=vX.Y.Z`.

Never leave a provider key set to an empty value — the app will start but authentication will
fail on the first review request.

## Operations

**Rollback.** To revert to a previous container generation:

```bash
kamal rollback <version>
```

`retain_containers: 5` keeps the five most recent generations on the host, so rollbacks are
instantaneous (no pull required).

**Logs and exec.** To stream logs from a role:

```bash
kamal app logs -r web
kamal app logs -r worker
```

To run a one-off command inside a running container:

```bash
kamal app exec -r worker '<cmd>'
```

**Redis accessory [E8].** The `redis` accessory lifecycle is managed independently of app
deploys. `kamal deploy` does NOT restart or touch Redis. To manage the accessory explicitly:

```bash
kamal accessory boot redis      # first-time start
kamal accessory reboot redis    # restart (e.g. after config change)
kamal accessory logs redis      # tail accessory logs
kamal accessory exec redis '<cmd>'
```

The `redis-data` named volume persists across both app deploys and accessory reboots, mirroring
the behaviour of the `redis_data` volume in the Compose path.

**Worker health [E1].** The `worker` role has no HTTP listener — its `proxy: false` setting
means Kamal does not route HTTP to it and does not run an HTTP health probe. Worker health is
assessed by process liveness only: if the container exits, Kamal's supervisor restarts it.
Do not add an HTTP healthcheck to the worker role.

## Build-from-source (SECONDARY / fork path) [T1]

The primary flow pulls a prebuilt image. If you need to build from source (e.g. you have forked
the repo and changed application code), follow these steps:

1. Uncomment the `builder` stanza at the bottom of `config/deploy.yml`:

   ```yaml
   builder:
     arch:
       - amd64
       - arm64
     target: prod          # build the Dockerfile `prod` stage
     context: .
   ```

2. Change `registry.username` to your own GitHub username (or your registry host) and ensure
   `KAMAL_REGISTRY_PASSWORD` has **write** access to the target registry.

3. Run a plain `kamal deploy` (no `--skip-push`). Kamal builds the `prod` stage of the
   `Dockerfile`, pushes the image to your registry, and deploys it.

4. Confirm `.dockerignore` excludes secrets before building. The sanctioned edit to `.dockerignore`
   already excludes `.kamal/secrets*`, `**/.env`, and `deploy/.env` — so a `COPY . .` in the
   `prod` stage cannot bake secrets into the image [E10].

Multiarch builds (`amd64` + `arm64`) require `buildx` and QEMU installed on your local machine.
For a single-arch build, remove the `arch` block and Kamal will default to the host
architecture.

## CI (optional)

`.github/workflows/deploy.yml.example` is an inert GitHub Actions workflow template. It is
a `.example` file — GitHub Actions only runs `*.yml`/`*.yaml` files, so it will never trigger
in this repo or in a fork.

To activate it in your own fork:

1. `git mv .github/workflows/deploy.yml.example .github/workflows/deploy.yml`
2. Set the required repo secrets in **Settings → Secrets and variables → Actions**:
   - `KAMAL_REGISTRY_PASSWORD`, `SSH_PRIVATE_KEY`
   - `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`
   - `ANTHROPIC_API_KEY` (or your chosen provider key)
3. Trigger the workflow manually via **Actions → Deploy (Kamal) → Run workflow**, supplying the
   image tag.

The workflow runs the prebuilt `--skip-push --version` flow against **your** server using
**your** secrets — it does not touch prisma-team infrastructure.

## Scaling caveat (residual gap) [E6]

The shipped topology mirrors the Compose prod stack: one `web` container and one `worker`
container on a single host. This is non-regressive — it is not worse than the existing path.

Before scaling beyond one replica per role, be aware:

- **Webhook replay protection** is Redis-backed (the `prisma-redis` accessory), keyed by
  `X-GitHub-Delivery` per installation. This is safe across multiple replicas because all
  replicas share the same Redis instance.
- **The `MAX_TOKENS_*` cost-window ledger** has no confirmed cross-replica Redis enforcement.
  If you run more than one `web` or more than one `worker`, validate your own rate and cost
  assumptions. Do not assume full multi-replica cost safety until that guarantee is established.

When in doubt, stay at one replica per role.

## Coexistence note

This path does NOT modify `deploy/`, `bin/prisma`, `deploy/install.sh`, or `deploy/traefik/`.
The existing Compose + Traefik stack is fully intact. Do not run both stacks on the same host
— `kamal-proxy` and Traefik both bind ports 80 and 443, and one will prevent the other from
starting.

If you are migrating from the Compose path to the Kamal path on the same host, stop and remove
the Compose stack first (`bin/prisma down` or `docker compose -f deploy/docker-compose.prod.yml down`),
then run `kamal setup`.

## See also

- [docs/deployment.md](deployment.md) — Compose + Traefik path, full environment variable reference
- [docs/operations.md](operations.md) — `bin/prisma` operations CLI (Compose path)
- [docs/install-github-app.md](install-github-app.md) — GitHub App registration steps
