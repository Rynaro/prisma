# Mission — Deployment-pipeline scout (deployment surface of prisma-bot)

**Thread:** 019eae72-01ad-7ad1-a02a-0bc727483e4b
**Tier:** trance (explicit TRANCE token from operator; G1 not required — surface is bounded)
**Requested by:** human operator (adoption initiative)

## DECISION_TARGET

What must be built — and what existing surface can be reused — so that an operator
can lift prisma-bot onto a single Docker host with one **interactive** installation
flow, fronted by **Traefik** with **automatic TLS certificates** (ACME/Let's Encrypt)
terminating HTTPS for the GitHub webhook ingress?

## Why (stakes)

Adoption is gated on deployment effort. Today the operator must hand-assemble
images, env vars, reverse proxy, and certificates. The intended outcome is a
deployment pipeline where `git clone && <one interactive command>` yields a
production-equivalent stack.

## Sub-questions for ATLAS (read-only)

1. **SQ-1 — Container surface.** What do the existing `Dockerfile` and
   `docker-compose.yml` provide today: build stages, process roles (ingress vs
   worker), exposed ports, healthchecks, Redis wiring?
2. **SQ-2 — Process entrypoints.** How are the ingress and worker started
   (`apps/github-app` package scripts, `Makefile` targets, `scripts/` helpers)?
   Is there any existing install/bootstrap script, interactive or otherwise?
3. **SQ-3 — Infra promises.** What does `infra/README.md` contain or promise?
4. **SQ-4 — Health surfaces.** Are `/healthz/live`, `/healthz/ready`,
   `/healthz/deps` implemented in `apps/github-app/webhook-ingress` as
   `docs/deployment.md` § Health surfaces declares (needed for Traefik health
   checks and installer preflight)?
5. **SQ-5 — Config/secret intake.** Which env vars must an interactive installer
   collect or generate? Verify `docs/deployment.md` § Environment variables
   against the real config loader in `packages/config` (names, defaults,
   required/optional).
6. **SQ-6 — CI surface.** Is there any existing image build/publish automation
   (GitHub Actions, registry references) the pipeline can extend?

## Constraints (carry into spec)

- Brownfield reuse-first (USE → EXTEND → WRAP → CREATE).
- Installer CLI helpers must be Bash 3.2-compatible (cortex invariant I-C9);
  stdout reserved for captured values, logs to stderr (I-C10).
- Single-tenant MVP; secrets remain env-delivered via `SecretSource` —
  the installer writes `.env`, it does not introduce a secret manager.
- Traefik must health-check the ingress via the documented `/healthz` surfaces.
- The OTLP collector remains optional; the installer must not require it.

## Out of scope

- Kubernetes/Helm; multi-host orchestration.
- Changing application code paths (pipeline, providers, queue semantics).
- Managed-secret-vendor integrations.
