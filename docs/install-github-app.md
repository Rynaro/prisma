# Install prisma as a GitHub App on your org

This document is the operator path: from "I have admin rights on a GitHub org" to "the App receives webhook deliveries and posts a Check run on a real PR." Target window: ~60 minutes.

This guide names the **prisma-specific** parameters (permissions, events, webhook URL, env vars). It does not mirror GitHub's App-registration UI — for the click-by-click flow, follow GitHub's authoritative docs at <https://docs.github.com/en/apps/creating-github-apps>. When the two disagree, GitHub's docs are canonical for the registration UI and this document is canonical for the prisma-specific values you enter into it.

## Prerequisites

- Admin rights on the GitHub organization (or a personal account) where the App will be installed.
- A host that can run `docker compose up` and is reachable from the public internet on a TLS-terminated URL (so GitHub can deliver webhooks). For local development, see [`quickstart.md`](quickstart.md) and the `make replay-webhook` flow described under [Verifying first delivery](#verifying-first-delivery) below.
- An API key for one provider — either an Anthropic Claude API key or a GitHub PAT with `models:read` scope (or a runtime-resolved GitHub App installation token) for the GitHub Copilot adapter. See [Choosing a provider](#choosing-a-provider) below.
- Docker (≥ 20) and GNU Make on the host (same prereqs as the Quickstart).

## Step 1 — Register the GitHub App

Follow GitHub's UI flow at <https://docs.github.com/en/apps/creating-github-apps>. The values **you** enter, however, are prisma-specific:

### Webhook URL

Point the App's webhook URL at:

```
https://<your-host>/webhooks/github
```

This is the path served by `apps/github-app/webhook-ingress`. The ingress verifies `X-Hub-Signature-256`, derives an idempotency key, enqueues a `JobPayload` onto the BullMQ `pr-review` queue, and returns `2xx` within a one-second budget. (See [`system-design.md` § End-to-end sequence](system-design.md).) On the local dev stack, the same path is served at `http://localhost:3030/webhooks/github` (or whatever port `APP_HOST_PORT` overrides — see [`docs/quickstart.md` § Troubleshooting](quickstart.md#port-3030-already-in-use-when-you-later-run-make-up-or-make-smoke)).

### Webhook secret

Generate a strong random value (e.g., `openssl rand -hex 32`) and paste it into the App's webhook secret field. **Save this value** — you will set it as `GITHUB_APP_WEBHOOK_SECRET` in [Step 3](#step-3--provision-secrets).

### Permissions

The App requires exactly the following repository permissions. Granting more is unnecessary; granting less will break the App.

| Permission | Access | Why |
| --- | --- | --- |
| `pull_requests` | Read & write | Create/update Check runs and inline review comments on PRs (per `packages/github/check-runs` and `packages/github/review-comments`). |
| `checks` | Read & write | Create/update Check runs on the PR `head_sha` (per ADR-001 § Rationale: Checks API richness). |
| `contents` | Read | Fetch the PR diff and `.github/review-bot.yml` from the head ref (per `packages/core/snapshotter` and `packages/config/config-loader`). |
| `issues` | Read & write | Post PR conversation reply comments and 👀/✅ reactions for the comment-command ack protocol (`packages/github/issue-comments`). PRs are issues in the GitHub data model; no separate `pull_requests` scope is required for conversation comments. Reactions require no additional scope beyond `issues:write`. |
| `metadata` | Read | Required by every GitHub App; auto-granted. |

No organization-level permissions are required for MVP. (Multi-installation routing is namespaced by `installation_id` per [`system-design.md` § Multitenancy posture](system-design.md).)

### Subscribed events

Subscribe to the following webhook events:

| Event | Why |
| --- | --- |
| `pull_request` | The trigger that makes the bot review a PR (`opened`, `synchronize`, `reopened` actions). |
| `issue_comment` | Enables PR comment-command mentions: `@bot review`, `@bot full review`, `@bot help`, `@bot configuration`. Only the `created` action is accepted; `edited` and `deleted` are ignored. Bot-authored comments are dropped at ingress (loop prevention). |
| `check_run` | Enables the native GitHub "Re-run" button on the "AI Code Review" check run. Only the `rerequested` action is accepted; `completed`, `created`, and all others are ignored. |
| `installation` | The bot must observe install/uninstall to track installation lifecycle. |
| `installation_repositories` | Repository add/remove against an existing installation. |

### Where it can be installed

For MVP, prisma is single-tenant; choose "Only on this account" if you are evaluating, or "Any account" if you intend to publish the App. (Single-tenant posture is documented in [`system-design.md` § Multitenancy posture](system-design.md); routing is namespaced by `installation_id` from day one regardless.)

### Approving permission upgrades

When you change the App's permissions after it has already been installed (for example, adding `issue_comment` subscription or requesting `issues: write`), **each existing installation must explicitly approve the upgrade** before GitHub resumes delivering the newly gated events.

To approve:

1. Go to **Settings → GitHub Apps** on the account or organization where the App is installed.
2. Find the App under "Review request" and click **Approve**.
3. Until approved, gated events (including `issue_comment`) are **not delivered to the App** — the bot will not respond to PR comments even if the stack is running correctly.

This is a GitHub-enforced safety gate; it cannot be bypassed from the App side. Operators who see missing `issue_comment` deliveries after a permission change should check this approval flow first.

## Step 2 — Mint and download the App private key

After the App is registered, GitHub presents the option to generate a private key (a `.pem` file). Generate one and download it. **The PEM file is a secret** — store it the same way you store database credentials. You will load its contents (or its path) into `GITHUB_APP_PRIVATE_KEY` in the next step.

Also note your App's **App ID** (a numeric identifier on the App's settings page) and the App **slug** (the URL-safe name; e.g. `prisma-bot`). These are not secrets but are required configuration.

## Step 3 — Provision secrets

Set the following values in the deployment's secret store. Per [`deployment.md` § Secret management abstraction](deployment.md#secret-management-abstraction), these are read by the App through the `SecretSource` interface; the MVP implementation reads from process env. Operators may substitute a managed secret manager (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager, Azure Key Vault, etc.) without changing pipeline code.

The minimum set of secrets:

- `GITHUB_APP_PRIVATE_KEY` — the PEM contents (or a path to the PEM file) from Step 2. Used by `packages/github/installation-auth` to mint installation tokens.
- `GITHUB_APP_WEBHOOK_SECRET` — the webhook secret you generated in Step 1. Used by `apps/github-app/webhook-ingress` to verify `X-Hub-Signature-256` on inbound deliveries.
- Exactly one of `ANTHROPIC_API_KEY`, `COPILOT_API_KEY`, **or** `OPENAI_API_KEY` — see [Choosing a provider](#choosing-a-provider).

The minimum set of (non-secret) config:

- `GITHUB_APP_ID` — the numeric App ID from Step 2.
- `GITHUB_APP_SLUG` — the App slug from Step 2.

For the **complete** environment-variable reference (every variable, classification, and description), see [`deployment.md` § Environment variables](deployment.md#environment-variables). This document does not duplicate the table; if you do not see a knob named here, look there.

## Choosing a provider

prisma ships with three production-ready provider adapters and one boot-only stub. Worker selection is by deterministic env-var precedence (see `apps/github-app/src/worker.ts` `buildProvider()` and ADR-004 / ADR-005 § Decision):

1. If `ANTHROPIC_API_KEY` is set → `AnthropicProvider` (the OQ-1 reference adapter at `packages/providers/anthropic`).
2. Else if `COPILOT_API_KEY` is set → `CopilotProvider` (per ADR-004; targets the GitHub Models inference endpoint at `https://models.github.ai/inference/chat/completions` over an OpenAI-compatible chat-completions surface).
3. Else if `OPENAI_API_KEY` is set → `OpenAIProvider` (per ADR-005; targets the OpenAI `/chat/completions` endpoint at `https://api.openai.com/v1/chat/completions`. The only adapter that honors a deterministic `seed` and a per-request model override via `request_shaping`).
4. Else → `FakeProvider({ script: [] })` (the worker boots and logs `worker.started` but every real job fails terminal — this is the dev-stub posture, not a production posture).

**Set exactly one** of the keys for production-equivalent behavior. If more than one is set, the highest-precedence wins (Anthropic, then Copilot, then OpenAI); the operator must explicitly unset it to switch vendors. The chosen vendor is observable via the `worker.provider.selected` log event.

Optional OpenAI overrides (consumed only when `OPENAI_API_KEY` is set):

- `OPENAI_MODEL` — defaults to `gpt-4o`.
- `OPENAI_BASE_URL` — defaults to `https://api.openai.com/v1`. Useful for re-targeting at Azure OpenAI or a proxy gateway without code changes (per ADR-005 § Decision).

(Listed by precedence above, Copilot is tried before OpenAI.) Optional Copilot overrides (consumed only when `COPILOT_API_KEY` is set):

- `COPILOT_MODEL` — defaults to `gpt-4o`.
- `COPILOT_BASE_URL` — defaults to `https://models.github.ai/inference`. Useful for re-targeting at Azure OpenAI or an alternate inference endpoint without code changes (per ADR-004 § Trade-offs).

## Step 4 — Bring the stack up

The deployment topology is documented in [`deployment.md` § Topology](deployment.md#topology): one Fastify ingress process, one or more BullMQ worker processes, and a Redis instance. Each role ships as a container image. For local-host evaluation you can use the bundled `docker-compose.yml`:

```bash
make up
```

This runs `docker compose up -d redis app worker`. The `app` container listens on container-internal port `3000`, mapped to host port `3030` by default (override with `APP_HOST_PORT=<port> make up`).

Once up, GitHub deliveries hitting `https://<your-host>/webhooks/github` (or the local equivalent) flow through the ingress → BullMQ → worker → pipeline → publisher path described in [`system-design.md` § End-to-end sequence](system-design.md).

For production deployment topology, sizing, networking (inbound/outbound connections, OTLP collector), and health surfaces (`/healthz/live`, `/healthz/ready`, `/healthz/deps`), see [`deployment.md`](deployment.md). [ACTION] If you are deploying to a real host (not localhost), terminate TLS in front of the ingress; GitHub will not deliver webhooks over plain HTTP.

## Step 5 — Install the App on a test repo

In GitHub's App settings, install the App on a single test repository first. (This minimizes blast radius if anything is misconfigured.) Then open a pull request on that repository. Within seconds GitHub should deliver a `pull_request` event to your webhook URL.

## Verifying first delivery

Three signals confirm the App received and processed the delivery:

1. **GitHub side.** In the App's settings → "Advanced" → "Recent Deliveries", the most recent delivery shows a `2xx` response code from the App. The webhook-ingress contract requires a `2xx` within a one-second budget on accept (per [`api-contracts.md`](api-contracts.md) and [`system-design.md` § End-to-end sequence](system-design.md)).
2. **Ingress logs.** The ingress emits a `webhook.received` event with `outcome=accepted`. (The full event taxonomy is in [`observability.md`](observability.md).) A signature mismatch produces `outcome=signature_failed` and is the most common first-delivery failure — see [Troubleshooting](#troubleshooting) below.
3. **Worker logs.** The worker emits `job.started`, then either `provider.called` followed by a publisher event, or a typed error. On success the publisher creates a Check run on the PR's `head_sha`; on terminal failure it emits a `failed_terminal` job result.

### Replaying a delivery without a real PR

If you want to verify the ingress + worker path before installing on a real repo, the `make replay-webhook` target signs and posts an evaluation fixture as if it were a real GitHub `pull_request` delivery:

```bash
make replay-webhook FIXTURE=security-bug
```

The replay script reads `evals/fixtures/security-bug.yaml`, signs the JSON body with `GITHUB_APP_WEBHOOK_SECRET` (or, in development only, the dev fallback `dev-only-not-secure`), POSTs to `http://app:3000/webhooks/github` over the compose network, sets `X-GitHub-Event: pull_request`, generates an `X-GitHub-Delivery` UUID, and computes `X-Hub-Signature-256: sha256=<HMAC>`. Override the URL to target a different host:

```bash
make replay-webhook FIXTURE=security-bug URL=http://localhost:3030/webhooks/github
```

For a real deployment, **`GITHUB_APP_WEBHOOK_SECRET` must be set to the App registration's actual webhook secret.** The dev fallback exists so contributors can exercise the full ingress path without provisioning a real App; it must never be used in production.

The end-to-end smoke test (`make smoke`) wraps this flow: brings the stack up, posts an unsigned delivery (expects `401`), posts a signed delivery (expects `202`), greps the worker logs for `worker.started`, and tears down. ~45 seconds total.

## Troubleshooting

For incident-shaped runbooks (queue backing up, provider errors climbing, validator rejecting at high rate, replay-storms, etc.), see [`operational-runbooks.md`](operational-runbooks.md). For first-delivery failures specifically:

### GitHub's "Recent Deliveries" UI shows `4xx`

Almost always a webhook-secret mismatch. Confirm `GITHUB_APP_WEBHOOK_SECRET` (read via `SecretSource`) matches the value configured in the GitHub App settings. If you rotated either side, follow [`operational-runbooks.md` § Rotating webhook secret](operational-runbooks.md) for the zero-downtime procedure.

### GitHub's "Recent Deliveries" UI shows `5xx`

Usually means Redis is unreachable from the ingress (the enqueue step fails, so the ingress returns `5xx` and GitHub retries the delivery). Check `/healthz/deps` on the ingress; see [`operational-runbooks.md` § Disaster recovery — Redis loss](operational-runbooks.md).

### Delivery returns `2xx` but no Check run appears

The ingress accepted the delivery but the worker did not produce a publication. Check worker logs for `provider.error` events:

- `variant=auth` — the provider API key is invalid or revoked. Rotate via [`operational-runbooks.md` § Rotating provider API key](operational-runbooks.md).
- `variant=rate_limit` — provider rate limits are tripping. Tighten `MAX_TOKENS_PER_PR` and `MAX_TOKENS_PER_WINDOW_PER_INSTALLATION`, or raise `RETRY_RATELIMIT_MAX_ATTEMPTS` cautiously.
- `variant=schema_validation` — the provider returned a shape that fails the `ProviderReviewOutput` Zod schema. See [`operational-runbooks.md` § Findings rejected by validator at high rate](operational-runbooks.md).

If the configured repo is in `dry-run` mode (the default for newly installed repos, per [`publication-policy.md` § Defaults (per OQ-2)](publication-policy.md)), the App will emit a `neutral` Check with the body "dry-run; no findings published" rather than inline comments. This is by design — flip the repo's `mode` to `summary-only` or `summary-plus-inline` in `.github/review-bot.yml` to publish.

## What you have now

If the steps above succeeded, you have:

- A registered GitHub App with the prisma-specific permissions and event subscriptions.
- The App installed on a test repository.
- The prisma stack receiving and processing webhook deliveries (`webhook.received` → `job.started` → `provider.called` → published Check).
- Conservative defaults active: `comment_cap.per_pr = 5`, `comment_cap.per_file = 1`, `severity_floor.inline = medium`, `confidence_floor.inline = 0.7`, `mode = dry-run` for newly installed repos. (Per [`publication-policy.md`](publication-policy.md) and [README § What is prisma?](../README.md#what-is-prisma).)

For day-2 operations (rotating secrets, scaling workers, reading the structured logs and metrics), the canonical references are [`deployment.md`](deployment.md), [`observability.md`](observability.md), and [`operational-runbooks.md`](operational-runbooks.md).
