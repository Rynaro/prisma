.PHONY: help install typecheck lint lint-fix format test test-watch eval eval-scenario up down logs ps shell clean replay-webhook smoke check-vendor-isolation

# Use ?= so the calling environment (e.g. a CI workflow `env:` block, or a
# contributor with an unusual UID) can override these without forking the
# Makefile. The Dockerfile makes /app/node_modules and /pnpm/store mode 0777
# so any UID the container runs as can write into them — `id -u` is the
# right default and matches the bind-mounted workspace owner on both local
# (developer's UID) and CI (runner UID).
HOST_UID ?= $(shell id -u)
HOST_GID ?= $(shell id -g)
export HOST_UID
export HOST_GID

DC := docker compose
TOOLS := $(DC) --profile tools run --rm tools

help:
	@echo "Container-first developer workflow. All commands run in Docker."
	@echo "Nothing is installed on the host."
	@echo ""
	@echo "  make install      Install workspace dependencies (creates pnpm-lock.yaml)"
	@echo "  make typecheck    Run TypeScript typecheck across all workspaces"
	@echo "  make lint         Lint with Biome (also runs check-vendor-isolation)"
	@echo "  make lint-fix     Auto-fix lint issues"
	@echo "  make check-vendor-isolation  Enforce ADR-002 vendor-SDK isolation"
	@echo "  make format       Format code with Biome"
	@echo "  make test         Run Vitest test suite"
	@echo "  make test-watch   Run Vitest in watch mode (Ctrl-C to exit)"
	@echo ""
	@echo "  make eval                       Run all 9 Phase 6 evaluation scenarios"
	@echo "  make eval-scenario SCENARIO=id  Run a single Phase 6 scenario by id"
	@echo "  make replay-webhook FIXTURE=id  Replay an eval fixture as a signed webhook delivery"
	@echo "  make smoke                      Bring stack up, run e2e webhook check, tear down"
	@echo ""
	@echo "  make up           Start app, worker, and redis"
	@echo "  make down         Stop and remove containers"
	@echo "  make logs         Tail logs from running services"
	@echo "  make ps           List running services"
	@echo "  make shell        Open a shell in the tools container"
	@echo ""
	@echo "  make clean        Remove containers, volumes, and build cache"

install:
	$(TOOLS) pnpm install

typecheck:
	$(TOOLS) pnpm typecheck

lint: check-vendor-isolation
	$(TOOLS) pnpm lint

lint-fix:
	$(TOOLS) pnpm lint:fix

# ADR-002 mechanical enforcement — vendor SDKs and the network primitive
# (fetch) are confined to each adapter's client.ts. Runs on the host shell
# (plain bash + grep) so it doesn't pay container startup cost; the
# rule set lives in scripts/check-vendor-isolation.sh.
check-vendor-isolation:
	@bash scripts/check-vendor-isolation.sh

format:
	$(TOOLS) pnpm format

test:
	$(TOOLS) pnpm test

test-watch:
	$(TOOLS) pnpm test:watch

eval:
	$(TOOLS) pnpm --filter @prisma-bot/eval-runner run eval -- --all --report-md /app/evals/last-report.md --index /app/evals/scenarios.yaml --fixtures-dir /app/evals/fixtures

eval-scenario:
	$(TOOLS) pnpm --filter @prisma-bot/eval-runner run eval -- --scenario $(SCENARIO) --index /app/evals/scenarios.yaml --fixtures-dir /app/evals/fixtures

up:
	$(DC) up -d redis app worker

down:
	$(DC) down

logs:
	$(DC) logs -f --tail=100

ps:
	$(DC) ps

shell:
	$(TOOLS) sh

clean:
	$(DC) --profile tools down -v --remove-orphans

# Replay an eval fixture as a signed pull_request webhook delivery. Runs
# scripts/replay-webhook.ts inside the `tools` container. The default URL
# routes through the compose network to the `app` service (container-internal
# port 3000); pass URL=<override> to target a different endpoint (e.g.
# http://localhost:3030/webhooks/github when invoking from the host shell).
replay-webhook:
	@if [ -z "$(FIXTURE)" ]; then \
		echo "usage: make replay-webhook FIXTURE=<id> [URL=<override>]"; \
		exit 2; \
	fi
	$(TOOLS) pnpm exec tsx scripts/replay-webhook.ts --fixture $(FIXTURE) --url $(if $(URL),$(URL),http://app:3000/webhooks/github)

# End-to-end smoke check. Runs on the host shell (NOT in a container) so it
# can compose `make up` / `make down` and inspect `docker compose logs`.
# The replay-webhook step it invokes does run through the tools container.
smoke:
	bash scripts/smoke.sh
