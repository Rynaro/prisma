# Spec — Dynamic Bot Interactions (prisma review bot)

- Status: decision-ready, single-pass SPECTRA cycle (CLARIFY → S → P → E → C → T → R → A)
- Date: 2026-06-12 · Author: SPECTRA · Intent: `REQUEST` (clear goal, missing specs)
- Complexity: 8/12 (extended-thinking tier; single-pass — TRANCE not authorized)
- Confidence: **88%** (gate ≥85% → AUTO_PROCEED). Factor breakdown in §11.
- Ships as **ONE pull request**. Non-essential items marked OUT / FOLLOW-UP.
- Inputs: `docs/_planning/dynamic-interactions/research-digest.md` (§5 decisions),
  `.atlas/scout-report-dynamic-interactions.md` (gaps G1–G8, file:line anchors).

The bot today runs only on `pull_request` ∈ {opened, synchronize, reopened}
(`apps/github-app/src/webhook/event-filter.ts:12-13`). This spec makes it dynamic:
comment-mention commands, a GitHub-native re-review control, round-aware incremental
reviews with honest round summaries, and an optional repo-configurable nickname.

---

## 1. Scope table

| # | In scope (this PR) | Out of scope / Follow-up |
|---|---|---|
| 1 | New event path: `issue_comment` (action `created`) for PR-comment commands | `pull_request_review_comment` (review-thread replies) → **FOLLOW-UP** (same parser reused; extra envelope shape) |
| 2 | New event path: `check_run` (action `rerequested`) → new review round (zero-vocabulary GitHub control) | `pull_request.review_requested` → **OUT** (App bots are not requestable reviewers; digest §5.3 correction) |
| 3 | Command parser module (ingress-cheap candidate match + worker-authoritative resolution) | Threaded conversational follow-ups / multi-turn dialogue → **OUT** |
| 4 | v1 command vocabulary: `review` (incremental), `full review`, `help`, `configuration` | `pause`/`resume`, `resolve`, `summary` → **OUT** (need persistent toggle state / comment mutation) |
| 5 | `JobPayload` v2 as a **discriminated union** by `event_type` (carries comment_id, commenter, command, round intent) | — |
| 6 | OctokitLike seam extension: `issues.createComment`, `reactions.createForIssueComment`, `issues.getComment` | `pulls.createReview` (grouped submission), comment edit/delete → **OUT** |
| 7 | Ack protocol: 👀 reaction on receipt, ✅ reaction + reply comment on completion, friendly error reply on failure | — |
| 8 | Round model = **GitHub-marker-only** (round counter + round summary marker on the check-run summary); incremental review skips findings whose dedupe key already posted | Redis-backed round counters → **OUT** (breaks survives-flush invariant; see §3.1) |
| 9 | Round summary feedback: "N addressed / M still open / K new" rendered into check-run summary | Per-finding resolution tracking via GitHub resolve-thread API → **OUT** |
| 10 | Loop prevention (ignore bot-authored comments) + permission gating (state-changing commands require write access) | — (gating is specified; v1 commands are all read-only so the gate is a guard, not a blocker — see §3.4) |
| 11 | Optional `nickname:` top-level config key (mention alias + voice flavor in summary) | Voice flavor beyond a single summary preamble line → **FOLLOW-UP** |
| 12 | GitHub App manifest/docs deliverable: subscribe `issue_comment` + `check_run`; confirm `issues:write` permission | Reactions need no extra permission (covered by `pull_requests:write` / `issues:write`) — verify at install |
| 13 | Validation gates: `pnpm lint`, `pnpm typecheck`, `pnpm test` all green | — |

**Assumptions (risk-if-wrong):**
- A1: `issues:write` permission is sufficient for `issues.createComment` + `reactions` on a PR conversation (PRs are issues). Risk-if-wrong: ack/reply fails at runtime → **mitigate**: verify at install before merge (§Track 7); reactions/replies fail-open (degraded, never crash the job).
- A2: `check_run.rerequested` is delivered to the creating App when a user clicks "Re-run" on the "AI Code Review" check run. Risk-if-wrong: the GitHub control is silent → **mitigate**: comment commands remain the primary channel; check_run is additive.
- A3: `issue_comment` volume in installed repos is tolerable under the 1s ingress budget (`server.ts:253-257`) because the candidate-match prefilter is a cheap local regex with no I/O. Risk-if-wrong: ingress latency → **mitigate**: prefilter rejects non-mentions before any allocation; no config fetch at ingress.

---

## 2. Resolved decisions (the "refine and gaps" step)

### D1 — Round-state strategy: **GitHub-marker-only** (reject Redis round model)

**Decision.** Do NOT add a Redis-backed round counter. Extend the *existing*
comment-marker mechanism the publisher already uses
(`packages/github/src/publisher/effects.ts:84-117`, marker regex `:106`).

**Rationale.** The publisher already reconstructs across-run dedupe state by harvesting
`<!-- prisma-bot:dedupe=KEY -->` markers from prior bot comments at publish time
(`effects.ts:83-114`). This is stateless and survives a Redis flush — that is the load-bearing
invariant (scout FINDING-018..020, `effects.ts:84-114`). Redis is ephemeral
(replay-cache TTL entries + BullMQ jobs only; no DB). A Redis round counter would make
round numbering wrong after any flush, and would diverge from the comment markers that
are the *actual* source of truth. Adding a second source of truth for the same fact is the
anti-pattern. Marker-only keeps one source of truth and zero new infrastructure.

**Exact mechanism — incremental review that does not repeat prior findings:**
1. The publisher already collects `acrossRunKeys: Set<string>` from prior inline comment
   markers (`effects.ts:144-145`) and the planner partitions on
   `prior.published_inline_dedupe_keys` (`planner.ts`, `effects.ts:145-147`). **Incremental
   review reuses this unchanged** — a finding whose dedupe key is already present is dropped
   as a duplicate. No new state needed for "don't repeat."
2. Add a **round-counter marker** emitted on the check-run summary (NOT on inline comments —
   the check-run summary is a single, predictable, edit-on-finalize surface):
   `<!-- prisma-bot:round=N head=<sha8> -->`. On each run the publisher harvests the
   max prior `round` via a new `CheckRunsClient.listOurs` summary scan (the client already
   exposes `output_summary`, `packages/github/src/check-runs/index.ts:49-54`) and emits
   `N = maxPriorRound + 1`. Absent prior marker → round 1. This is reconstructable from
   GitHub state alone (survives flush) — identical discipline to the dedupe marker.

**Exact mechanism — round-summary feedback ("N addressed / M still open / K new"):**
Computed purely from set arithmetic over dedupe keys at publish time, no persisted history:
- `prior = acrossRunKeys` (keys from prior inline comments still present on the PR).
- `current = { dedupe_key of every finding the ranker produced this round }`.
- `new = current \ prior` → **K new** (findings posted this round that are genuinely new).
- `still_open = prior ∩ current` → **M still open** (previously-flagged AND re-detected →
  not yet fixed).
- `addressed = prior \ current` → **N addressed** (previously-flagged, NOT re-detected this
  round → presumed fixed by the new diff).
- Render one line into the check-run summary: `Round N · N addressed · M still open · K new`.
- `full review` sets `acrossRunKeys = ∅` for the partition step (fresh review) but STILL
  reads the prior round marker for the round number, and labels the summary `Round N (full)`.

This is honest, diff-derived, and requires only the data already on the PR. Edge case: a
user manually deletes a prior bot comment → that key drops from `prior` and is counted `new`
again if re-detected; acceptable and self-healing (documented in §Track 5 acceptance).

### D2 — Nickname resolution point: **permissive ingress candidate + authoritative worker resolution + drop**

**Decision.** Ingress matches a permissive candidate pattern and the bot login; the worker
resolves the nickname authoritatively against repo config and **drops** non-matching jobs
before any review work.

**Rationale.** Mention parsing happens at ingress under a 1s budget with NO config available
(config is fetched per-job in the worker at `head_sha`, `worker.ts:227-307`; scout FINDING-012..014).
Moving a config fetch into the ingress path would (a) blow the 1s budget with a GitHub round-trip,
and (b) duplicate the worker's config-loading logic. So:

- **Ingress** (cheap, no I/O): accept an `issue_comment.created` job IFF the comment body
  matches `^\s*@(?<candidate>[A-Za-z0-9][A-Za-z0-9-]{0,38})\b` AND the candidate is EITHER
  the configured bot login (from `GITHUB_APP_SLUG`, already resolved in the worker but also
  available to ingress via env) OR a syntactically-valid alias candidate (any login-shaped
  token). Ingress carries the raw `candidate` + parsed `command` string into the JobPayload.
  Ingress does NOT decide whether the candidate is a *valid* nickname — it only gates obvious
  non-mentions cheaply.
- **Worker** (authoritative): after `fetchRepoConfig` (`worker.ts:301-307`), resolve the
  mention target = `{ bot_login } ∪ ({ config.nickname } if set)`. If the job's `candidate`
  is not in that set → emit `command.dropped_nickname_mismatch` audit and return
  `discarded_idempotent` WITHOUT posting anything (silent — never reply to a non-mention).
  If it matches → proceed to command dispatch.

**Loop prevention (G7).** Ingress drops `issue_comment` jobs where the comment author is a bot:
the payload carries `comment.user.type === 'Bot'` and/or `sender.type === 'Bot'`. The new
envelope guard requires `comment.user.login`/`type`; if `type === 'Bot'` OR
`login === '<bot_login>[bot]'` → `webhook.event_ignored` at ingress (no enqueue). This is
checked at ingress (cheapest) AND defensively re-checked in the worker (the bot's own ack
replies must never re-trigger). The nickname NEVER overrides loop prevention (digest §5.6).

**Permission gating (G7).** State-changing commands require the commenter to have write access.
The commenter's `author_association` is present on `issue_comment` payloads
(`OWNER|MEMBER|COLLABORATOR` ⇒ write; `CONTRIBUTOR|NONE|FIRST_TIMER` ⇒ read). The worker maps
`author_association ∈ {OWNER, MEMBER, COLLABORATOR}` → write. v1 vocabulary (`review`,
`full review`, `help`, `configuration`) is **all read-only**, so the gate is implemented as a
reusable guard (`requiresWrite(command): boolean`) that currently returns `false` for every
v1 command — wired and tested, ready for `pause`/`resume`/`resolve` follow-ups, but never
blocks a v1 command. Documented so the follow-up is a one-line change, not a new design.

### D3 — Command vocabulary for v1 (scoped ruthlessly)

| Command | Trigger phrase (after `@<mention>`) | Behavior | Write-gated? |
|---|---|---|---|
| `review` | `review` | **Incremental** review round (default; skips prior dedupe keys) | No |
| `full review` | `full review` | Fresh review round (ignores prior dedupe keys) | No |
| `help` | `help` (or unknown command → friendly help) | Post a quick-reference reply comment | No |
| `configuration` | `configuration` (alias `config`) | Post the effective repo config as a reply comment | No |

`check_run.rerequested` maps to `review` (incremental) — same code path, no comment author.
Unknown/empty command after a valid mention → `help` reply (graceful degradation, digest §4).
**Out:** `pause`/`resume` (need persistent per-PR toggle state — no DB), `resolve` (needs
comment mutation — explicitly never edits prior comments, `review-comments/index.ts:9-11`),
`summary` (regenerate-only; low value for one PR). All deferred with rationale recorded.

### D4 — Idempotency-key shape per trigger

Current: `prisma_` + sha256(delivery_id, installation_id, repository_id, pr_number, head_sha)
(`apps/github-app/src/webhook/idempotency.ts:24-34`). delivery_id already makes every delivery
unique, so re-deliveries differ — but comment/check_run triggers add a discriminating field so
two distinct commands in the same delivery window never collide and the key is self-describing.

Extend `DeriveIdempotencyKeyOptions` (`idempotency.ts:14-20`) with optional discriminators and
include them in the canonical JSON only when present (preserves existing PR-event keys byte-for-byte):

| Trigger | Added field(s) | Canonical key inputs |
|---|---|---|
| `pull_request.*` (today) | — | delivery_id, installation_id, repo_id, pr_number, head_sha (unchanged) |
| `issue_comment.created` | `comment_id` | + comment_id; head_sha = PR head at fetch time (resolved in worker; ingress sets head_sha from `issue.pull_request` is absent — see G2 note below) |
| `check_run.rerequested` | `check_run_id` | + check_run_id; head_sha = `check_run.head_sha` (present on payload) |

**G2 note (no head_sha at ingress for comments).** `issue_comment` payloads carry `issue`,
not `pull_request.head.sha` (scout G2). At ingress the idempotency key for comment jobs uses
`comment_id` as the primary discriminator and sets `head_sha = ''` (sentinel) in the key inputs;
the worker fetches the live PR head via `pulls.get` (already in OctokitLike,
`installation-auth/client.ts:122-127`) before reviewing. `check_run.rerequested` DOES carry
`head_sha` on the payload, so its key includes the real sha.

---

## 3. Architecture deltas (ports-and-adapters, follow existing patterns)

```
INGRESS (Fastify, ≤1s, no config I/O)
  server.ts route :259
   ├─ verify HMAC (signature.ts) — UNCHANGED
   ├─ isAcceptedEvent(...)  ── GENERALIZE to a per-event allowlist (Track 1)
   ├─ envelope guard ──────── ADD isIssueCommentEnvelope / isCheckRunEnvelope (Track 1)
   ├─ loop prevention ─────── ADD bot-author drop for issue_comment (Track 6)
   ├─ command candidate ───── ADD parseMentionCandidate() cheap regex (Track 4)
   ├─ deriveIdempotencyKey ── EXTEND with comment_id / check_run_id (Track 2)
   └─ enqueue JobPayload v2 ─ EXTEND schema → discriminated union (Track 2)

WORKER (BullMQ, owns config + GitHub writes)
  worker.ts handler :282
   ├─ getOctokit / repoLookup ── UNCHANGED
   ├─ fetchRepoConfig ────────── EXTEND: resolve nickname (Track 3)
   ├─ command dispatch ───────── ADD: ack 👀 → resolve nickname → gate → run (Track 5/6)
   │     ├─ help / configuration → IssueCommentsClient.create reply (Track 6)
   │     └─ review / full review → runPipeline(roundIntent) (Track 5)
   └─ ack ✅ + reply on done ──── IssueCommentsClient + ReactionsClient (Track 6)

PUBLISH (pure plan + effects)
  effects.ts publish :135
   ├─ collectAcrossRunDedupeKeys ── UNCHANGED (incremental reuse)
   ├─ harvest prior round marker ── ADD CheckRunsClient summary scan (Track 5)
   └─ render round summary ──────── ADD "Round N · N addr · M open · K new" (Track 5)
```

### 3.1 Why not Redis (expanded)
Redis here holds only replay-cache TTL entries and BullMQ jobs (scout FINDING-018). It is flushed
freely. The dedupe markers on GitHub comments are the durable truth. Putting round counters in
Redis creates a split brain: after a flush, Redis says "round 1" while the PR shows 3 prior
rounds. Marker-only avoids this entirely and reuses code already proven in production
(`effects.ts:84-114`).

---

## 4. Work breakdown — ordered implementation tracks

Ordering is dependency-driven: schema/seam first (no behavior), then ingress, then worker
dispatch, then round model, then docs. Each track is independently testable with fakes.

### Track 1 — Generalize the event filter + envelope guards (P0, ≤1d)
**Files:**
- MODIFY `apps/github-app/src/webhook/event-filter.ts:12-26` — replace the single
  `ACCEPTED_EVENT_NAME` constant with a per-event allowlist map:
  `pull_request → {opened, synchronize, reopened}`, `issue_comment → {created}`,
  `check_run → {rerequested}`. Keep the closed-allowlist shape (no wildcards).
- MODIFY `apps/github-app/src/server.ts:82-126` — add `isIssueCommentEnvelope` and
  `isCheckRunEnvelope` guards alongside `isPullRequestEnvelope:89-110`; extend `eventTypeFor`
  `:112-126` to map `issue_comment.created` and `check_run.rerequested` to the new event_type
  values (Track 2). Dispatch picks the guard by `x-github-event` header.
- MODIFY `apps/github-app/src/server.ts:344-371` — branch envelope validation per event name.

**GIVEN/WHEN/THEN:**
- GIVEN an `issue_comment` delivery with action `created` and a valid envelope
  WHEN posted to `/webhooks/github` with a valid HMAC
  THEN `isAcceptedEvent('issue_comment','created')` is true and the issue-comment envelope guard passes.
- GIVEN a `check_run` delivery with action `completed` (not `rerequested`)
  WHEN dispatched THEN it is ignored with `webhook.event_ignored` (202, `accepted:false`).
- GIVEN a `pull_request` `opened` delivery (today's path)
  WHEN dispatched THEN behavior is **byte-for-byte unchanged** (regression guard).

**Test plan:** copy `apps/github-app/tests/server.test.ts:12-66` (`buildTestServer`, `sign`,
`app.inject`). Add `makeIssueCommentBody()` / `makeCheckRunBody()` factories beside
`makePullRequestBody:28-40`. Add a dedicated `event-filter.test.ts` table-test (one row per
event/action pair, accepted + rejected). Existing `pull_request` rows MUST still pass.

### Track 2 — JobPayload v2 discriminated union + idempotency extension (P0, ≤2d)
**Files:**
- MODIFY `packages/shared/src/schemas/job.ts:12-39` — turn `JobPayloadSchema` into a Zod
  **discriminated union** on `event_type`. Keep the existing PR variant (`pull_request.opened|
  synchronize|reopened`) exactly as-is (all current fields). Add two variants:
  - `comment` variant (`event_type: 'issue_comment.command'`): adds `comment_id: number`,
    `commenter_login: string`, `commenter_association: enum(...)`, `mention_candidate: string`,
    `command_raw: string`, `pull_request_number`, `installation_id`, `repository_id`, owner/repo,
    `received_at`, optional `traceparent`. `head_sha` optional (resolved in worker — D4 G2 note).
  - `check_run` variant (`event_type: 'check_run.rerequested'`): adds `check_run_id: number`,
    carries `head_sha` (present on payload), `pull_request_number` (from `check_run.pull_requests[0]`).
  Keep `.strict()` per variant. Export `JobEventTypeSchema` superset.
- MODIFY `apps/github-app/src/webhook/idempotency.ts:14-34` — add optional
  `comment_id?: number`, `check_run_id?: number` to `DeriveIdempotencyKeyOptions`; include each
  in the canonical JSON only when defined (existing keys unchanged). Allow `head_sha` empty
  sentinel for comment jobs.
- MODIFY `apps/github-app/src/server.ts:390-433` — build the correct discriminated variant per
  event; pass new discriminators to `deriveIdempotencyKey`.

**GIVEN/WHEN/THEN:**
- GIVEN two `issue_comment` deliveries that differ only by `comment_id`
  WHEN keys are derived THEN the keys differ (no collision).
- GIVEN an existing `pull_request.opened` job input
  WHEN parsed by `JobPayloadSchema` THEN it still validates and produces the identical key
  it produces today (golden-value regression).
- GIVEN a `comment` variant missing `command_raw`
  WHEN parsed THEN Zod rejects with a path-specific issue.

**Test plan:** copy `packages/shared/tests/schemas.test.ts` table pattern (parse valid + invalid,
assert issue paths). Copy the idempotency golden-value assertion style from
`apps/github-app/tests` (deterministic key for a fixed input). Add a regression case pinning the
current PR-event key value so the union refactor can't silently change it.

### Track 3 — Nickname config key (mirror PR #9 review_guidance) (P1, ≤1d)
**Files:**
- MODIFY `packages/shared/src/schemas/config.ts:105-130` — add optional top-level
  `nickname: z.string().min(1).max(39).regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/).optional()` sibling
  of `review_guidance:128`. Login-shaped (so it can be an `@mention` alias). No default
  (absent → today's behavior unchanged). Warn-and-ignore semantics already covered by the loader
  (`packages/config/src/config-loader/parse.ts:59-70`), so an unknown `nickname` on an old
  parser is forward/backward compatible.
- MODIFY `apps/github-app/src/worker.ts:308-318` — log `has_nickname` in `worker.config.loaded`.
- (Voice flavor) MODIFY the check-run summary render to prepend one preamble line using the
  nickname if set (e.g. `<nickname> reviewed this round.`). Keep minimal — full voice is FOLLOW-UP.

**GIVEN/WHEN/THEN:**
- GIVEN `.github/review-bot.yml` with `nickname: reviewbot`
  WHEN config is loaded THEN `config.nickname === 'reviewbot'` and defaults are otherwise unchanged.
- GIVEN a config WITHOUT `nickname`
  WHEN loaded THEN `config.nickname` is undefined and `DEFAULT_REPO_CONFIG` is byte-for-byte today's.
- GIVEN `nickname: "has spaces"` (invalid)
  WHEN loaded THEN Zod rejects / loader warns-and-ignores per existing policy (assert the existing
  policy outcome, do not invent a new one).

**Test plan:** copy the `review_guidance` test cases in `packages/shared/tests/schemas.test.ts`
and the loader warn-and-ignore test in `packages/config/tests` (PR #9 added these — use them as
the exact template). Assert `DEFAULT_REPO_CONFIG` snapshot is unchanged (defaults regression).

### Track 4 — Command parser module (P0, ≤1d)
**Files:**
- CREATE `packages/shared/src/commands/parse.ts` (new module, no Octokit dependency — pure
  function, lives in `shared` next to schemas so both ingress and worker import it).
  - `parseMentionCandidate(body: string): { candidate: string; rest: string } | null` — the
    cheap ingress regex (`^\s*@(?<candidate>[A-Za-z0-9][A-Za-z0-9-]{0,38})\b\s*(?<rest>.*)`),
    case-insensitive, first-line only. Returns null fast for non-mentions.
  - `parseCommand(rest: string): Command` — maps the remainder to the v1 vocabulary
    (`review`, `full review`, `help`, `configuration|config`); empty/unknown → `{ kind: 'help',
    unknown: true }`. Returns a closed `Command` discriminated union.
  - `requiresWrite(cmd: Command): boolean` — returns `false` for all v1 commands; the gate seam
    for follow-ups (D2 permission gating).
- EXPORT from `packages/shared/src/index.ts`.

**GIVEN/WHEN/THEN:**
- GIVEN `@reviewbot full review please` WHEN parsed THEN candidate `reviewbot`, command
  `{kind:'full_review'}`.
- GIVEN `@reviewbot   REVIEW` (whitespace + case) WHEN parsed THEN `{kind:'review'}`.
- GIVEN `LGTM, ship it` (no mention) WHEN `parseMentionCandidate` runs THEN returns null.
- GIVEN `@reviewbot frobnicate` (unknown) WHEN parsed THEN `{kind:'help', unknown:true}`.

**Test plan:** new `packages/shared/tests/commands.test.ts`, table-driven (Vitest `it.each`),
one row per vocabulary phrase + adversarial inputs (mid-body mention, emoji, multiline, code
fence containing `@bot`). Pure functions → no fakes needed.

### Track 5 — Round-aware review + round summary (marker-only) (P0, ≤2d)
**Files:**
- MODIFY `packages/github/src/publisher/effects.ts:83-117` — add
  `harvestPriorRound(deps, ctx): Promise<number>` scanning `CheckRunsClient.listOurs` summaries
  (`check-runs/index.ts:49-54`) for `<!-- prisma-bot:round=N head=.. -->`; return max N (0 if none).
- MODIFY `effects.ts:135-220` (`publish`) — accept a `RoundIntent = 'incremental' | 'full'`
  (threaded from the job). For `'full'`, pass `prior.published_inline_dedupe_keys = ∅` to the
  planner (fresh review) while still computing the round number from the marker. Compute the
  round-summary set arithmetic (D1) and render `Round N · X addressed · Y still open · Z new`
  (+ `(full)` label) into the finalize summary; emit the round marker.
- MODIFY `apps/github-app/src/pipeline/orchestrator.ts:284+` and `:536-539` (publish call) —
  thread `round_intent` from the JobPayload variant (`check_run.rerequested` + `review` →
  incremental; `full review` → full; `pull_request.*` → incremental as today's default).
- MODIFY `packages/github/src/publisher/planner.ts` — only if the round-summary math needs the
  full `current` finding-key set surfaced; otherwise compute in `effects.ts` from `ranked`.

**GIVEN/WHEN/THEN:**
- GIVEN a PR with prior bot inline comments carrying dedupe keys {a,b,c} and a check-run summary
  marker `round=1` WHEN an incremental round runs and the ranker produces {b,c,d}
  THEN inline posts only {d} (a/b/c deduped), and the summary reads `Round 2 · 1 addressed
  (a) · 2 still open (b,c) · 1 new (d)`.
- GIVEN the same PR WHEN `full review` runs THEN all of {b,c,d} are eligible to post (fresh) and
  the summary reads `Round 2 (full) · …`.
- GIVEN a PR with NO prior round marker WHEN a round runs THEN it is `Round 1` and behaves like
  today (regression: PR-open path unchanged).
- GIVEN the prior across-run dedupe lookup throws WHEN publishing THEN it fails open
  (`effects.ts:101-104` behavior preserved) — round summary degrades to `Round N` with no diff line.

**Test plan:** extend `apps/github-app/tests/pipeline/orchestrator.test.ts` (injects hooks/fakes)
and the publisher unit tests in `packages/github/tests` — supply a fake `CheckRunsClient.listOurs`
returning summaries with/without the round marker, and a fake `ReviewCommentsClient.listOurs`
returning prior dedupe markers. Assert the partition (which findings post) and the rendered
summary string. Reuse the marker regex style from `effects.ts:106`.

### Track 6 — OctokitLike seam extension + ack/reply + dispatch (P0, ≤3d)
**Files:**
- MODIFY `packages/github/src/installation-auth/client.ts:120-229` — extend `OctokitLike.rest`
  with an `issues` sub-namespace: `createComment`, `getComment`, and a `reactions` namespace
  `createForIssueComment` (👀/✅). Map 1:1 to `octokit.rest.issues.*` / `octokit.rest.reactions.*`
  in `createDefaultOctokit:186-229` with the same confined-cast pattern used for `pulls_reviews`.
- CREATE `packages/github/src/issue-comments/index.ts` — `IssueCommentsClient` mirroring
  `ReviewCommentsClient` (`review-comments/index.ts:33-49`): `createReply({owner,repo,issue_number,
  body})` with the 64 KiB body cap (`REVIEW_COMMENT_BODY_MAX_BYTES:22`), `getAuthor(comment_id)`,
  `addReaction({comment_id, content: '👀'|'✅'})`. Keep a module marker const for the smoke test
  (mirror `REVIEW_COMMENTS_MODULE:14`).
- MODIFY `apps/github-app/src/worker.ts:282-349` — command dispatch in the handler:
  1. re-check loop prevention (bot author) → discard;
  2. post 👀 reaction (fail-open);
  3. `fetchRepoConfig` → resolve nickname (D2) → if candidate ∉ {bot_login, nickname} →
     `discarded_idempotent`, no reply;
  4. `requiresWrite(cmd)` gate (D2) — v1: always passes;
  5. dispatch: `help`/`configuration` → `IssueCommentsClient.createReply`; `review`/`full review`
     → resolve PR head via `pulls.get`, then `runPipeline(round_intent)`;
  6. on success post ✅ reaction + a short reply linking the check run; on failure post a friendly
     error reply (digest §4 graceful degradation). All ack effects fail-open.
- MODIFY `apps/github-app/src/main.ts` — wire the new clients into worker deps (mirror existing
  client wiring).

**GIVEN/WHEN/THEN:**
- GIVEN a comment job `@bot review` from a human WHEN dispatched THEN a 👀 reaction is added,
  an incremental round runs, a ✅ reaction + reply is posted.
- GIVEN a comment authored by `<bot>[bot]` WHEN it reaches the worker THEN it is discarded
  (defensive loop prevention) and NO reaction/reply is posted.
- GIVEN `@wrongname review` (candidate not bot login nor nickname) WHEN dispatched THEN
  `discarded_idempotent`, no reply (silent — never answer a non-mention).
- GIVEN `@bot help` WHEN dispatched THEN a reply comment containing the v1 command reference is posted.
- GIVEN `IssueCommentsClient.addReaction` throws WHEN dispatching THEN the review still runs
  (ack is fail-open; assert review effects still occur).

**Test plan:** create a hand-rolled `FakeIssueCommentsClient` (mirror the fakes used for
`ReviewCommentsClient` in `packages/github/tests` and `apps/github-app/tests/e2e`). Drive the
worker handler with the in-memory queue (`apps/github-app/src/queue/in-memory-job-queue.ts`) and
assert the recorded reaction/reply calls + that `runPipeline` was invoked with the right
`round_intent`. Add an `issue-comments` unit test mirroring `review-comments` tests (body cap,
login filter).

### Track 7 — GitHub App manifest + docs deliverable (P1, ≤1d)
**Files:**
- MODIFY `docs/install-github-app.md:36-41` (Permissions table) — add/confirm `issues` **Read &
  write** (PR conversation comments + reactions). Note in the "Why" column: comment-command
  replies and 👀/✅ acks. Confirm reactions need no separate permission.
- MODIFY `docs/install-github-app.md:45-53` (Subscribed events) — add `issue_comment` (PR-comment
  commands) and `check_run` (native Re-run control → new review round). State the existing
  `pull_request` row is unchanged.
- MODIFY `docs/api-contracts.md` § Webhook ingress contract — document the new accepted events,
  the discriminated `JobPayload` variants, and the extended idempotency-key inputs (keep the
  existing contract text for `pull_request` intact).
- ADD a short "Commands" section to `README` / docs: the v1 vocabulary, the nickname config key,
  the ack protocol, and graceful-degradation behavior (discoverability is DX, digest §4).

**GIVEN/WHEN/THEN:**
- GIVEN a reviewer reads `install-github-app.md` WHEN following it THEN they subscribe
  `issue_comment` + `check_run` and grant `issues:write`, and the listed permission set still
  matches what the code actually calls (no over-grant).
- GIVEN the docs WHEN cross-checked against the code THEN every newly-documented event has a
  corresponding accepted-event row in `event-filter.ts` (consistency check at review time).

**Test plan:** docs are prose; the consistency guard is the `event-filter.test.ts` table from
Track 1 (it is the executable spec of "what events we accept"). No new automated test for prose,
but a reviewer checklist item: permission/event docs ⇄ code parity.

---

## 5. Test plan summary (which existing pattern to copy)

| Track | Copy this pattern | Location |
|---|---|---|
| 1 | `buildTestServer` + `sign` + `app.inject` + body factories | `apps/github-app/tests/server.test.ts:12-66` |
| 2 | Zod parse table tests + idempotency golden value | `packages/shared/tests/schemas.test.ts`; `apps/github-app/tests` idempotency cases |
| 3 | `review_guidance` schema tests + loader warn-and-ignore (PR #9) | `packages/shared/tests/schemas.test.ts`; `packages/config/tests` |
| 4 | Pure-function `it.each` table tests | new `packages/shared/tests/commands.test.ts` |
| 5 | Orchestrator hook/fake injection + publisher marker assertions | `apps/github-app/tests/pipeline/orchestrator.test.ts`; `packages/github/tests` |
| 6 | Hand-rolled client fakes + in-memory queue e2e | `apps/github-app/tests/e2e/full-loop.test.ts`; `packages/github/tests` (review-comments fakes) |
| 7 | (prose) reviewer parity checklist anchored by Track 1 table test | `docs/install-github-app.md`, `docs/api-contracts.md` |

**Regression guardrails (must stay green):** the existing `pull_request.opened|synchronize|
reopened` path is unchanged at every layer — event filter, envelope guard, idempotency key,
JobPayload parse, publisher round=1 default. Pin a golden idempotency-key value (Track 2) and a
`DEFAULT_REPO_CONFIG` snapshot (Track 3) to catch silent drift.

---

## 6. Validation gates (run from host with pnpm — NOT make; scout FINDING-021)

```
pnpm lint        # biome — vendor-isolation rules must still pass (no @octokit import outside installation-auth)
pnpm typecheck   # tsc — discriminated-union JobPayload must typecheck at every consumer
pnpm test        # vitest run — full suite green; new tracks add tests, no existing test regresses
```

Single-file iteration during build: `pnpm vitest run apps/github-app/tests/server.test.ts`
(scout FINDING-021). The `@octokit/*` import stays confined to `installation-auth/{client,auth}.ts`
(vendor-isolation lint rule, confirmed by memory: ADR-002 fetch-glob rule is generic) — Track 6's
seam extension MUST add new methods inside `client.ts`, never import Octokit elsewhere.

---

## 7. Implementation order & dependency graph

```
Track 1 (event filter + guards) ─┐
Track 2 (JobPayload v2 + idemp.) ─┼─→ Track 4 (parser) ─→ Track 6 (seam + dispatch) ─→ Track 5 (round model)
Track 3 (nickname config) ───────┘                                                        │
Track 7 (docs/manifest) ── after 1,2,6 land (documents the real surface) ─────────────────┘
```
- Tracks 1+2+3 are no-behavior-change foundations (parallelizable).
- Track 4 (pure parser) has no deps; can land early.
- Track 6 depends on 1,2,4 (it dispatches parsed commands through the extended seam).
- Track 5 depends on 6 (round_intent is threaded from the dispatched job).
- Track 7 documents what 1/2/6 actually expose.

Recommended single-PR commit sequence: 1 → 2 → 3 → 4 → 6 → 5 → 7 (foundations, then behavior,
then round model, then docs), each commit green under all three gates.

---

## 8. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| `issues:write` insufficient for reactions/replies on PRs | P0 (acks fail) | A1: verify at install before merge; all ack effects fail-open so the review still completes |
| `check_run.rerequested` not delivered as expected | P1 (silent control) | A2: comment commands are primary; check_run is additive — feature still works without it |
| `issue_comment` webhook volume / 1s budget | P1 (latency) | A3: candidate prefilter is a cheap local regex, no I/O; bot-author + non-mention dropped before enqueue |
| Discriminated-union refactor changes existing PR-event key | P0 (dedupe/idempotency drift) | Golden-value regression test pins the current key (Track 2) |
| Nickname enables impersonation/loop | P1 | Nickname NEVER overrides loop prevention; bot-author drop runs first; alias is login-shaped only |
| Round summary wrong after user deletes a bot comment | P2 (cosmetic) | Self-healing set arithmetic; documented as expected; not persisted state to corrupt |

---

## 9. Out-of-scope / follow-up backlog (recorded so it isn't re-explored)

- `pull_request_review_comment` review-thread replies (reuse parser; new envelope).
- `pause`/`resume` (needs persistent per-PR toggle — no DB today).
- `resolve` (needs comment mutation — publisher never edits prior comments by design).
- `summary` regenerate command.
- Grouped review submission via `pulls.createReview`.
- Full nickname "voice flavor" beyond a single summary preamble line.
- `pull_request.review_requested` (rejected: App bots are not requestable reviewers — digest §5.3).

---

## 10. Acceptance (feature-level, ties tracks together)

- AS a maintainer, WHEN I comment `@bot review` on a PR, THEN the bot reacts 👀, posts an
  incremental review that does not repeat already-posted findings, and reacts ✅ with a reply.
- AS a maintainer, WHEN I comment `@bot full review`, THEN the bot reviews the whole PR fresh
  and labels the round summary `(full)`.
- AS a maintainer, WHEN I click "Re-run" on the "AI Code Review" check, THEN a new incremental
  round runs (zero new vocabulary).
- AS a maintainer, WHEN I comment `@bot help` or an unknown command, THEN I get a friendly
  command reference reply.
- AS a repo owner, WHEN I set `nickname: ourbot` in `.github/review-bot.yml`, THEN `@ourbot review`
  works and the bot ignores `@bot review` only if it isn't the real login (real login always works).
- AS the system, the bot NEVER acts on bot-authored comments, and existing PR-open reviews behave
  exactly as before.

---

## 11. Confidence report

| Factor (25% each) | Score | Notes |
|---|---|---|
| Pattern match | 90% | ADAPT — OctokitLike seam, ports-and-adapters fakes, Zod-in-shared, closed allowlist, PR #9 nickname twin all directly reused; verified anchors. |
| Requirement clarity | 88% | 4 open decisions resolved with rationale; vocabulary scoped; only A1/A2 (GitHub-side permission/event delivery) carry external uncertainty. |
| Decomposition stability | 88% | 7 disjoint, dependency-ordered tracks; alternative decompositions (by layer vs by command) converge on the same seams. |
| Constraint compliance | 86% | Single PR; closed allowlist preserved; vendor isolation respected; marker-only avoids new infra; docs deliverable included. |

**Overall: 88% → AUTO_PROCEED.** Flags for the executor: confirm A1 (`issues:write` covers
reactions) and A2 (`check_run.rerequested` delivery) against a live App before relying on acks /
the check-run control; both are designed to fail-open / be additive so neither blocks the core
comment-command + incremental-round value.
```
