# Operations CLI — `bin/prisma`

Day-2 operations for a deployed prisma-review-bot stack. One command, two faces:

```bash
bin/prisma                              # interactive TUI console
bin/prisma --update --tag v0.4.0 --yes  # headless workflow (CI / cron / LLM operator)
```

The CLI operates on the production stack installed by `deploy/install.sh`
(`deploy/docker-compose.prod.yml` + `deploy/.env`). It is a single
dependency-free Bash script — nothing to install on the server beyond what the
installer already requires (Docker, Compose v2, curl).

Every command works in both subcommand form (`bin/prisma update`) and flag form
(`bin/prisma --update`); they are equivalent. Logs and prompts go to **stderr**,
machine-readable results to **stdout**, so headless output is pipeable.

## The core workflow: updating the running image

```bash
bin/prisma --update --tag v0.4.0 --yes       # release tag
bin/prisma --update --tag sha-1a2b3c4 --yes  # immutable per-commit pin
bin/prisma --update --yes                    # re-pull the current tag (e.g. latest moved)
```

What `update` does, in order:

1. Records the currently running release as a precise `tag@sha256:…` pin
   (digest taken from the live `app` container).
2. Writes `IMAGE_TAG=<new tag>` into `deploy/.env`.
3. `docker compose pull` + `up -d` for `app` and `worker` (redis and Traefik
   are untouched — no TLS or queue interruption).
4. Gates on `https://$PRISMA_DOMAIN/healthz/live` returning 200 (bounded poll,
   default 120 s, `--timeout N` to change; `--resolve` fallback covers
   pre-DNS / split-horizon hosts).
5. **On success:** appends the new pin to `deploy/.releases`.
   **On failure:** automatically rolls back to the pin from step 1 and
   health-gates again. `--no-rollback` disables this; `--no-health` skips the
   gate entirely (not recommended).

`--sync` runs `git pull --ff-only` on the checkout first, so compose/Traefik
changes ship together with the image.

Rolling back later:

```bash
bin/prisma --rollback --yes                       # previous recorded release
bin/prisma --rollback --tag v0.3.0 --yes          # explicit tag
bin/prisma --rollback --tag 'latest@sha256:…' --yes  # explicit digest pin
bin/prisma releases                               # inspect the recorded history
```

## Command reference

| Command | What it does |
|---|---|
| `update` | Pull + redeploy the image, health-gated, auto-rollback (`--tag`, `--sync`, `--no-rollback`, `--no-health`) |
| `rollback` | Redeploy the previous recorded release, or `--tag TAG` |
| `releases` | Print the release history (`deploy/.releases`) |
| `status` | Services table, image tag + digest, liveness summary |
| `health` | Probe `/healthz/live`; prints `live`/`down`, exit 0/1 (`--timeout N`) |
| `logs [SERVICE]` | Tail logs (`--tail N`, `--follow`) |
| `restart [SERVICE]` | Restart one service or all |
| `up` / `down` | Bring the full stack up (health-gated) / take it down (asks first; Redis data preserved) |
| `scale --workers N` | Scale worker replicas (not persisted across `down`) |
| `config show` | Print `deploy/.env` with secret values redacted |
| `config get KEY` / `config set KEY=VALUE` | Read / write a single key (apply with `restart`) |
| `backup` | Redis `BGSAVE` snapshot → `deploy/backups/redis-<ts>.rdb` (path printed to stdout) |
| `restore --file PATH` | Replace Redis state from a backup (stops app/worker first; asks first) |
| `doctor` | Full diagnostic: docker, env completeness, perms, DNS, disk, services, liveness; exit 0/1 |
| `version` | CLI version, image tag, running digest, checkout SHA |

Global options: `--yes` (never prompt — required for non-TTY runs that hit a
confirmation), `--timeout N`, `--help`.

## The TUI console

Run `bin/prisma` with no arguments on the server. The console shows a live
dashboard (domain, image pin, per-service up/down) and a menu covering every
command above. All destructive actions still confirm before acting.

## Headless recipes

```bash
# CI deploy step (after release.yml publishes the image)
bin/prisma --update --tag "sha-${SHORT_SHA}" --yes

# Nightly backup (cron)
0 4 * * * cd /opt/prisma && bin/prisma backup --yes >> /var/log/prisma-backup.log 2>&1

# Monitoring probe (exit code is the signal)
bin/prisma health --timeout 15 --yes

# Turn up verbosity, apply, watch
bin/prisma config set LOG_LEVEL=debug --yes && bin/prisma restart --yes && bin/prisma logs app --follow
```

## State files

| Path | Purpose |
|---|---|
| `deploy/.env` | Stack configuration incl. `IMAGE_TAG` (written by installer, edited by `update`/`config set`; perms 600) |
| `deploy/.releases` | Append-only release history (`<UTC timestamp>\t<tag@digest>`); source for `rollback` |
| `deploy/backups/` | Redis snapshots from `backup` (perms 600) |

All three are gitignored — they are per-deployment state, never committed.

## Relationship to other tooling

- **`deploy/install.sh`** — day-0: first install, secret intake, ACME setup.
  `bin/prisma` assumes it has run (it refuses to operate without `deploy/.env`).
- **`Makefile`** — development workflow against the dev compose stack;
  `bin/prisma` only ever touches the production stack.
- **`docs/operational-runbooks.md`** — incident procedures; `bin/prisma doctor`,
  `logs`, and `rollback` are the entry points those runbooks reference.
