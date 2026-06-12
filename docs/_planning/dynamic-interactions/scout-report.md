# Scout Report — Dynamic User Interactions (prisma review bot)

MISSION: Map today's webhook → review → publish pipeline and identify everything needed to add
(1) comment-mention commands, (2) GitHub review-control triggers, (3) retries / review rounds /
user feedback, (4) configurable bot nickname.
Date: 2026-06-12 · Agent: ATLAS · Confidence legend: H/M/L · All paths repo-relative.

A planning input already exists: `docs/_planning/dynamic-interactions/research-digest.md`
(command vocabulary, ack protocol, round model, nickname decisions — feeds SPECTRA directly). [H]

## Topology summary

- pnpm monorepo: `apps/github-app` (Fastify ingress `src/main.ts` + BullMQ worker `src/worker.ts`),
  `packages/{shared,config,core,github,providers/*}`. [H]
- Two processes share Redis: ingress enqueues, worker consumes. No DB; GitHub itself is the only
  durable review state (comment markers). [H]

## 1. Webhook receive / verify / dispatch (FINDING-001..006)

- **Single route** `POST /webhooks/github`: `apps/github-app/src/server.ts:259` (route),
  raw-body-preserving JSON parser `server.ts:184-197`. [H]
- **Verification**: HMAC SHA-256 over raw body, timing-safe compare —
  `apps/github-app/src/webhook/signature.ts:1-70` (timingSafeEqual at 64/68), invoked at
  `server.ts:302-316`; 401 on failure. Ingress shape validated by `WebhookIngressRequestSchema`
  (`packages/shared/src/schemas/webhook.ts:13-30`) at `server.ts:319-342`. [H]
- **Event dispatch is a closed allowlist**: `isAcceptedEvent` accepts ONLY
  `pull_request` with action ∈ {opened, synchronize, reopened}
  (`apps/github-app/src/webhook/event-filter.ts:12-26`); everything else → 202 + audit
  `webhook.event_ignored` (`server.ts:353-361`). [H]
- **Envelope guard** `isPullRequestEnvelope` requires `installation.id, repository.{id,name,owner.login},
  pull_request.{number,head.sha}` (`server.ts:90-110`); event_type mapping `eventTypeFor`
  (`server.ts:112-126`). [H]
- **Replay + idempotency**: `deriveIdempotencyKey` = `prisma_` + sha256(delivery_id, installation_id,
  repository_id, pr_number, head_sha) (`apps/github-app/src/webhook/idempotency.ts:24-34`); replay cache
  keyed `installation:delivery` with TTL window (default 300s, `main.ts:36-39`), Redis + in-memory impls
  (`apps/github-app/src/webhook/replay-cache.ts:13-60`); checked `server.ts:399`, remembered `server.ts:493`. [H]
- **Enqueue**: validated `JobPayload` → `opts.enqueueJob` (`server.ts:469-483`), 202 with key (`server.ts:495`).
  Production wiring (queue, secret resolver w/ dev fallback) in `apps/github-app/src/main.ts:33-74`. [H]
- **App registration events** (docs): `pull_request`, `installation`, `installation_repositories` —
  `docs/install-github-app.md:45-53`; permissions table at `docs/install-github-app.md:36-41`
  (pull_requests RW, checks RW, contents R, metadata R). `installation*` events are subscribed but
  dropped by the event filter. [H]

## 2. Review pipeline: webhook → posted review (FINDING-007..011)

Flow: ingress 202 → BullMQ `pr-review` queue → worker handler → orchestrator → publisher.

- **Worker wiring** `apps/github-app/src/worker.ts:270-349`: provider selection precedence
  anthropic → copilot → openai → FakeProvider (`worker.ts:30-44, 91-130`); per-job handler
  (`worker.ts:282-349`) does `installationAuth.getOctokit` → `repoLookup`
  (env override → payload owner/repo, `worker.ts:188-219`) → `fetchRepoConfig` at `head_sha`
  (`worker.ts:300-307`) → `runPipeline`. [H]
- **Orchestrator** `runPipeline` (`apps/github-app/src/pipeline/orchestrator.ts:284+`):
  snapshot (`:302-304`), prefilter (oversized → summary-only short-circuit `:253-263`),
  guidance augmentation (`:386,399`), `deps.provider.review(providerInput)` (`:427`),
  validator (`:518`), ranker (`:533`), publish (`:536-539`). Non-transient provider errors are
  converted to a "review unavailable" check-run; transient/rate-limit re-thrown for BullMQ
  backoff (`orchestrator.ts:53-59`). [H]
- **Publisher** (`packages/github/src/publisher/effects.ts:136-190`): harvest across-run dedupe keys
  from prior bot comments (`:84-114`, marker regex `:106`) → pure plan
  (`packages/github/src/publisher/planner.ts:1-67`: floors, caps, dedupe partition) → start check run
  "AI Code Review" (`effects.ts:49,150-167`) → post inline comments only in `summary-plus-inline`
  mode (`:172-190`) → finalize check run with summary markdown. [H]

## 3. Repo config / where "nickname" lives (FINDING-012..014)

- Config is fetched **per job** from `.github/review-bot.yml` at the PR head ref via ContentFetcher
  (`worker.ts:229-268`, `REPO_LOCAL_CONFIG_PATH` from `@prisma-bot/config`); missing file → schema
  defaults; parse error → defaults + user-visible `config_notes` threaded into the summary
  (`worker.ts:252-268`, `orchestrator.ts:155-158`). [H]
- Schema: `RepoConfigSchema` (`packages/shared/src/schemas/config.ts:105-133`) — PR #9 added the
  `review_guidance` key (`config.ts:122-128`) backed by `ReviewGuidanceSchema`
  (`packages/shared/src/schemas/guidance.ts:50-62`: `instructions`, `path_instructions` ≤20,
  `context_files` ≤5, hard byte/token caps `guidance.ts:9-26`). Parser: warn-and-ignore unknown
  top-level keys (`packages/config/src/config-loader/parse.ts:59-70`). [H]
- **Nickname placement**: a new optional top-level key (e.g. `nickname:` sibling of `review_guidance`)
  in `RepoConfigSchema` is the natural home — it is mention-routing + voice, not review guidance,
  and warn-and-ignore semantics make it forward/backward compatible. Caveat: config is loaded in the
  **worker**, but mention parsing happens at **ingress** before any config fetch — nickname resolution
  must either move a lightweight config fetch into the comment-handling path or be resolved in the
  worker with the ingress accepting any `@…` mention candidate. [M — design judgment on H facts]

## 4. GitHub posting abstractions (FINDING-015..017)

- **OctokitLike seam** (`packages/github/src/installation-auth/client.ts:1-33`): the ONLY Octokit
  surface exposed is `pulls.get/listFiles`, `checks.create/update/listForRef`,
  `pulls_reviews.createReviewComment/listReviewComments`, plus `repos.getContent` (content-fetcher).
  Vendor SDK imports confined to `installation-auth/{client,auth}.ts`. [H]
- **Clients**: `ReviewCommentsClient.postInline/listOurs` (64KiB body cap, `[bot]` login filter) —
  `packages/github/src/review-comments/index.ts:33-49`; `CheckRunsClient.startInProgress/finalize/listOurs`
  (60-char title cap) — `packages/github/src/check-runs/index.ts:33-55`. [H]
- **Comment formatting**: `renderInlineCommentBody` (`effects.ts:119-134`) — severity tag, explanation,
  suggested fix, confidence footer, and hidden dedupe marker `<!-- prisma-bot:dedupe=KEY -->`
  (`effects.ts:116-117`). **Missing for this feature**: no `issues.createComment` (PR conversation
  replies), no reactions API (👀/✅ acks), no `pulls.createReview` (grouped review submission),
  no comment edit/delete (publisher explicitly never edits prior comments,
  `review-comments/index.ts:9-11`). [H]

## 5. State / persistence (FINDING-018..020)

- **Stateless per webhook except Redis**: (a) replay cache TTL entries; (b) BullMQ jobs where
  `idempotency_key` = jobId gives enqueue-level dedupe → `discarded_idempotent`
  (`apps/github-app/src/queue/job-queue.ts:25-51`). [H]
- **Retry logic exists and is reusable**: `classifyRetry` → transient | rate_limited | non_transient
  (`job-queue.ts:75-106`); BullMQ attempts/backoff tunables (defaults 3 attempts / 500ms base,
  `apps/github-app/src/queue/bullmq-job-queue.ts:44-77`); non-transient wrapped in
  `UnrecoverableError` (`bullmq-job-queue.ts:267-276`). [H]
- **No review-round model**: across-run dedupe state is reconstructed from GitHub comment markers at
  publish time (`effects.ts:84-114`); nothing records "round N", what was previously reported, or
  resolved-vs-open status. Every accepted delivery (incl. each `synchronize`) is an independent
  full-PR job — idempotency key includes `delivery_id`, so re-deliveries differ. [H]

## 6. Test setup (FINDING-021)

- Vitest 2.1.8, node env; include globs `apps/**/tests`, `packages/**/tests`, `evals/runner`
  (`vitest.config.ts:4-14`). Run from host with pnpm (NOT make):
  `pnpm test` (= `vitest run`, `package.json:16`), watch `pnpm test:watch`,
  single file `pnpm vitest run apps/github-app/tests/server.test.ts`,
  `pnpm typecheck`, `pnpm lint`. [H]
- Webhook handlers are tested via `app.inject()` on `buildServer` with hand-signed HMAC bodies and
  fake `EnqueueJob`/`InMemoryReplayCache` (`apps/github-app/tests/server.test.ts:12-66`) — the exact
  pattern to copy for new events. End-to-end: `apps/github-app/tests/e2e/full-loop.test.ts` with the
  in-memory queue (`apps/github-app/src/queue/in-memory-job-queue.ts`). Orchestrator tests inject
  hooks/fakes (`apps/github-app/tests/pipeline/orchestrator.test.ts`). [H]

## 7. Gaps blocking the feature (FINDING-022..028)

| # | Gap | Anchor | Conf |
|---|-----|--------|------|
| G1 | Event filter hard-rejects `issue_comment`, `pull_request_review`, `pull_request_review_comment`, and `pull_request.review_requested` | `webhook/event-filter.ts:12-13` | H |
| G2 | Ingress envelope assumes `pull_request.head.sha` present; `issue_comment` payloads carry only `issue` — new envelope guard + idempotency derivation needed (no head_sha at ingress) | `server.ts:83-110`, `webhook/idempotency.ts:14-20` | H |
| G3 | `JobPayloadSchema.event_type` is a closed 3-value enum; no fields for comment id / commenter / command / round intent | `packages/shared/src/schemas/job.ts:12-37` | H |
| G4 | No mention/command parser exists anywhere (only the planning digest references one) | repo-wide search; `docs/_planning/dynamic-interactions/research-digest.md:50` | H |
| G5 | OctokitLike lacks issues.createComment, reactions, createReview, comment update — needed for acks, replies, and round summaries | `installation-auth/client.ts:23-32` | H |
| G6 | No round model / no memory of prior findings beyond dedupe markers; incremental ("since last round") review requires new state (extend comment/check-run markers or add Redis keys) | `effects.ts:84-114`, `planner.ts:69-77` | H |
| G7 | No loop prevention (ignore bot-authored comments) and no commenter permission gating (write-access check for state-changing commands) | absence; ingress trusts payload after HMAC `server.ts:319-361` | H |
| G8 | App manifest/docs must add subscribed events (`issue_comment`, `pull_request_review(_comment)`) and re-verify permission set for issue-comment writes + reactions | `docs/install-github-app.md:36-53` | H |

## Recommended next actions

1. → SPECTRA: Spec the feature using `docs/_planning/dynamic-interactions/research-digest.md` §5
   decisions + this report's G1–G8 as the constraint set (event filter generalization, JobPayload v2
   discriminated union, command parser module, ack/reply client additions, round model, nickname key).
2. → SPECTRA: Decide round-state strategy explicitly (GitHub-marker-only vs Redis-backed) — it drives
   G3/G5/G6 and the idempotency-key shape for comment-triggered jobs.
3. → APIVR-Δ (after spec): low-risk preparatory slice — extend OctokitLike + add `IssueCommentsClient`
   / reactions (G5) behind the existing seam pattern; fully testable with hand-rolled fakes.
4. → human: confirm GitHub App permission changes (issues write? reactions) and event subscriptions
   before implementation; installations must re-approve permission upgrades.

## Risks & gaps

- `issue_comment` fires on every PR/issue comment in installed repos — volume + loop risk; the
  ingress 1s budget (`server.ts:253-257`) means mention pre-filtering must stay cheap and local. [H]
- Nickname-at-ingress vs config-in-worker ordering (see §3) is the main architectural wrinkle. [M]
- Re-requesting review via GitHub UI requires the bot login to be a requestable reviewer; GitHub
  Apps appear as `[bot]` users — verify `review_requested` targeting works for App slugs. [L — not
  verifiable from repo; flag for spec research]
- Not inspected in depth: `packages/core` prefilter/snapshotter internals (unchanged by this
  feature), provider adapters (round-aware prompting would touch `packages/shared/src/prompt/review-prompt.ts`). [M]

## Telemetry

phase: S | tool_calls: 24 | probes: deterministic-first (list/grep/windowed reads ≤100 lines) |
sub-questions: 7/7 answered ≥M | gaps recorded: 8 | recursion used: 0
