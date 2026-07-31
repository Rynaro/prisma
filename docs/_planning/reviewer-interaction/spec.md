# Spec — Reviewer Interaction (`ask` command)

Date: 2026-07-30 · ESL change: `.spectra/changes/reviewer-interaction-ask` · Tier: full
Predecessor: `docs/_planning/dynamic-interactions/spec.md` § 9 explicitly parked
"threaded conversational follow-ups / multi-turn dialogue" as follow-up backlog — this spec is
that follow-up.

## 1. Problem & goals

Developers want to **talk to the reviewer about its feedback**: ask why a finding matters, tell
it a finding is a false positive, ask for a suggested fix, etc. Today the command vocabulary
(`review`, `full review`, `help`, `configuration`) only triggers pipelines; there is no
conversational channel.

Requirements (verbatim from the ask):

1. Send a message to the reviewer agent asking or telling something about the feedback.
2. The interaction must carry **review context** (the feedback being discussed).
3. A **config setting hard-caps how many interactions a given review can have** (anti-chat abuse).
4. When more than 1 message is allowed, later messages must also carry **thread context**
   (the prior exchanges).

## 2. In / out of scope

| # | In scope (this PR) | Out of scope / follow-up |
|---|---|---|
| 1 | `ask <message>` command on PR conversation comments (`issue_comment`, existing ingress) | Replies inside finding threads (`pull_request_review_comment`) — new envelope, separate PR |
| 2 | Vendor-neutral `respond()` provider entry + all 4 adapters (anthropic, openai, copilot, fake) | Streaming replies |
| 3 | `interactions` config block (`enabled`, `max_per_review`) | Per-user caps, permission gating (`requiresWrite` seam stays false) |
| 4 | Marker-based interaction ledger (stateless, GitHub-is-the-DB) | Redis/DB persistence of conversations |
| 5 | Evals scenarios + docs (config-spec, api-contracts, help text) | Voice/nickname flavoring of replies |

## 3. UX contract

```
@bot ask why is finding 2 a security risk? we sanitize upstream
```

- 👀 reaction on receipt (existing ack protocol), reply comment on completion, ✅ reaction.
- The reply comment format (blockquote of the question makes each exchange self-contained —
  thread reconstruction never needs to fetch/pair user comments):

```markdown
> **@alice asked:** why is finding 2 a security risk? we sanitize upstream

<reviewer reply markdown>

<!-- prisma-bot:interaction round=3 seq=2 -->
```

- `ask` with an empty message → the existing unknown-command path (help reply, `unknown: true`).
- Disabled (`interactions.enabled: false`, the default) → friendly reply: interactions are
  opt-in, point at `.github/review-bot.yml`. No provider call.
- No published review round on the PR yet → friendly reply: "run a review first"
  (`@bot review`). No provider call. (Guarantees review context always exists.)
- Budget exhausted → friendly reply stating the cap and the configured value, suggesting a new
  review round (which resets the budget). No provider call. Template replies never consume budget.
- Provider failure → existing error-reply semantics of the command path (auth/capability get the
  operator-actionable replies; generic otherwise). Failed calls do NOT consume budget (no
  interaction marker is posted).

`help` reply gains one row: `| \`@bot ask <message>\` | Discuss the review feedback (opt-in) |`.
`configuration` reply echoes the block (always, like `command_marker`):

```yaml
interactions:
  enabled: false
  max_per_review: 3
```

## 4. Config (`packages/shared/src/schemas/config.ts`)

New top-level `interactions` block, sibling of `positive_feedback` / `approval`, same opt-in,
default-off convention:

```ts
InteractionsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Hard cap on provider-backed interaction replies per review round. */
  max_per_review: z.number().int().min(1).max(25).default(3),
}).strict().default({})
```

## 5. Interaction ledger — markers, budget, round scoping

GitHub is the only durable state (system invariant — no new infra):

- Every successful interaction reply embeds `<!-- prisma-bot:interaction round=<N> seq=<M> -->`.
- **Current round** = the highest `round=` harvested from existing bot comments (the publisher
  already harvests its own markers; reuse/extend that helper — `packages/github/src/publisher/effects.ts`).
- **Budget used** = count of bot interaction markers whose `round` equals the current round.
- A new published review round therefore resets the budget to 0 ("per review" semantics), with
  no mutation or cleanup required.
- Enforcement is worker-side, before the provider call. Bot-authored comments are already
  dropped by loop prevention; the cap bounds provider spend per round at `max_per_review`.

## 6. Provider contract extension (the tradeoff)

`Provider` (ADR-002; `packages/shared/src/schemas/provider-interface.ts`) gains a second
mandatory method — chosen over a capability-gated optional method because all four adapters can
produce plain markdown and a mandatory method keeps the pipeline free of runtime capability
branching (append an amendment note to ADR-002):

```ts
export interface Provider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  review(input: ProviderReviewInput): Promise<ProviderReviewOutput>;
  respond(input: ProviderRespondInput): Promise<ProviderRespondOutput>;
}
```

New vendor-neutral types in `packages/shared/src/schemas/provider.ts` (Zod, `.strict()`):

```ts
ProviderRespondInput = {
  pr: { title, description, base_ref, head_ref, head_sha },   // reuse existing PR meta shape
  review_context: {
    round: number,
    summary_markdown: string,          // latest round's check-run summary (byte-capped)
    findings: RespondFinding[],        // file, line, severity, category, title, body (capped)
  },
  thread: RespondExchange[],           // prior exchanges THIS round, oldest→newest; [] on first
  message: { author_login: string, text: string },
  guidance?: string,                   // repo review_guidance.instructions if configured
  generation?: GenerationSettings,     // same normalized bag review() gets
}
ProviderRespondOutput = { reply_markdown: string }   // non-empty; worker truncates to comment cap
```

- Errors: identical semantics to `review()` — adapters map vendor failures to the five
  `ProviderError` variants and throw `ProviderErrorThrowable`. No vendor type leaks
  (`scripts/check-vendor-isolation.sh` must stay green).
- Prompt building lives in `packages/shared/src/prompt` next to the review prompt: system frame
  = "you are the reviewer that produced these findings; answer/acknowledge the developer's
  message; be concise; if the developer shows a finding is wrong, say so plainly; never invent
  findings". Deterministic assembly, byte/token caps like the guidance caps in
  `packages/shared/src/schemas/guidance.ts`.
- `FakeProvider.respond()` is deterministic (echo the round, finding count, thread length, and a
  canned reply) so evals stay key-less and stable.

## 7. Worker flow (`apps/github-app/src/worker.ts` — extend `handleCommentJob` dispatch)

`parseCommand` (`packages/shared/src/commands/parse.ts`) gains
`{ kind: 'ask'; message: string }`: first token `ask` (case-insensitive), remainder (original
casing, trimmed) = message; empty remainder → `{ kind: 'help', unknown: true }`. `requiresWrite`
still returns false for all commands.

Dispatch order for `ask` (all template replies are fail-open, consistent with the ack protocol):

1. `config.interactions.enabled`? else disabled-reply, done.
2. Harvest bot comments once → current round + used budget + prior exchanges (parse blockquote
   question + reply body out of each marked comment; malformed marked comments count toward
   budget but are skipped as thread context — budget integrity beats context completeness).
3. No round found → run-a-review-first reply, done.
4. `used >= max_per_review` → cap reply, done.
5. Fetch latest check-run summary for review context (`packages/github/src/check-runs`), build
   findings list from harvested finding comments (dedupe-marked) — both byte-capped.
6. Thread context: include prior exchanges only when `max_per_review > 1` (requirement 4);
   cap at the 10 most recent exchanges AND a total byte budget.
7. `provider.respond(input)` → truncate reply to the 64 KiB issue-comment ceiling (reuse
   `ISSUE_COMMENT_BODY_MAX_BYTES` guard) → post reply with blockquoted question + marker → ✅.
8. Log taxonomy (no bodies, per observability invariant): `command.interaction.started`,
   `.denied_disabled`, `.denied_no_round`, `.denied_cap`, `.replied`, `.failed`.

No ingress/server changes: `issue_comment.command` jobs already carry `command_raw` free text.
No job-schema change.

## 8. Deliverables checklist

- [ ] `packages/shared`: parse.ts (`ask`), config.ts (`interactions`), provider.ts (respond
      types), provider-interface.ts, prompt builder + barrels
- [ ] `packages/providers/{anthropic,openai,copilot,fake}`: `respond()` implementations + tests
- [ ] `packages/github`: comment-harvest helper exposure for interaction markers; issue-comments
      list method if harvest needs it
- [ ] `apps/github-app`: worker dispatch + interaction module + tests (disabled / no-round /
      cap / happy / provider-error / truncation / thread-context-only-when-cap>1)
- [ ] evals: scenarios — ask happy path, cap exceeded, disabled (FakeProvider deterministic)
- [ ] docs: config-spec.md (`interactions`), api-contracts.md (provider contract §), ADR-002
      amendment note, product-spec command table, README command mention if present
- [ ] `scripts/check-vendor-isolation.sh` green; typecheck, lint, full vitest, `make eval` parity
      via host runner

## 9. Acceptance

- AS a developer, WHEN I comment `@bot ask <question>` on a reviewed PR (feature enabled), THEN
  the bot replies with an answer grounded in the latest round's findings, quoting my question,
  and the reply carries the interaction marker.
- AS a developer, WHEN the round's budget (`max_per_review`) is spent, THEN further `ask`s get a
  polite cap notice and no provider call happens.
- AS a developer, WHEN `max_per_review > 1` and I ask a second question, THEN the provider input
  contains the first exchange as thread context.
- AS a repo owner, WHEN I don't opt in, `ask` never calls the provider.
- AS the system, a new review round resets the budget; bot-authored comments never trigger
  interactions; no vendor type crosses the shared boundary.
