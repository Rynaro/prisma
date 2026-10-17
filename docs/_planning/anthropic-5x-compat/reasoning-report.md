# Reasoning report — Anthropic 5.x (Haiku 5.5 / Sonnet 5.5 / Opus 5.5 / Fable 5.1) compatibility trade-offs

> FORGE, standard tier, single trace (no self-consistency). 2026-10-16. Base `b441099` (v0.15.0).
> Evidence: `research-digest.md` (H for vendor facts; items it marks "likely" are M), `scout-report.md` (H), source read directly (H). OpenAI precedents are cited as **O-Dn** (`docs/_planning/gpt6-compat/reasoning-report.md`).
> `requires_checker: false`: no verdict deploys, deletes data, changes a security boundary, commits spend, or publishes. The spend-relevant verdicts (D3, D5, D11) take effect only on release and are `[USER-RATIFY]`.
> Paths are relative to the repo root.

## Gaps closed

**GAP-2: what a user sees today when the Anthropic model 404s.** `mapAnthropicError` sends a 404 to `transport, retryable: false` (`packages/providers/anthropic/src/error-mapping.ts:221`). `classifyRetry` ignores `retryable` for `transport` and returns `transient` (`apps/github-app/src/queue/job-queue.ts:94-95`). The SDK does not retry a 404 itself: it retries only 408/409/429/5xx (`node_modules/@anthropic-ai/sdk/core.js:379-397`). So each job attempt makes exactly one failing call.
- **PR events (opened/synchronize): nothing appears on GitHub.**
  - The orchestrator logs `provider.error` (`orchestrator.ts:1509`) and re-throws, both on the single-call path and on the batch path (`:1284-1288`).
  - `handleAuthCapabilityError` (`:819-864`) is never reached, so no summary is published.
  - The check run is created only at publish time (`packages/github/src/publisher/effects.ts:276`), so there is no check run and no comment.
  - BullMQ retries `RETRY_TRANSIENT_MAX_ATTEMPTS` (default 3, exponential from 500 ms; `bullmq-job-queue.ts:51,151-154`), then marks the job failed in Redis. Only the logs show it.
- **Comment commands (`@bot review`, `@bot ask`): the same misleading reply, once per attempt.**
  - The worker posts "Sorry, I encountered an error while processing your request. Please try again later." and re-throws (`worker.ts:881-893`).
  - The job is retried and the command path has no reply dedupe (`worker.ts:563-600`), so that reply is posted up to 3 times for a configuration error that never clears.
- **Who is affected:** every Anthropic deployment today. The model can only be the default `claude-3-5-sonnet-latest` (`index.ts:30`): there is no `ANTHROPIC_MODEL`, and `request_shaping.model` is ignored (FINDING-004/006). This makes D10 the most valuable mapping fix, and D11 mandatory.

**GAP-4: `provider.usage` field list** (`docs/observability.md:43`). Fields:
- `provider`
- `endpoint` (`chat` | `responses`)
- `model`
- `input_tokens`, `output_tokens`, `cached_input_tokens`, `reasoning_tokens`, `cache_write_tokens`, each omitted when the endpoint did not report it.

The event carries counts only and is emitted before truncation detection.

**Also found while verifying** (feeds D3, D4, D9 and D14):
- **Base URL.** `client.ts:23-25` passes `baseURL` only when it is given, and the adapter never gives it. SDK 0.32.1 therefore falls back to `process.env.ANTHROPIC_BASE_URL` (`node_modules/@anthropic-ai/sdk/index.js:55`). Gateway use is possible today, but undocumented and untested.
- **Passthrough promise.** `docs/config-spec.md:87` promises verbatim passthrough of the active provider's `provider_options` bag for every provider. The Anthropic adapter silently does not do it (FINDING-004).
- **Broken docs example.** The documented `anthropic` example (`config-spec.md:97-100`, `thinking: {type: enabled, budget_tokens: 1024}`) is a 400 on every 5.x model (digest §2).

## D1 — Tool choice for `review()`

**Options:**
- (a) `auto` for every Claude model.
- (b) `auto` only for the four models that reject forced choice (Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1).
- (c) `auto` for every model that thinks by default (generation ≥ 5); forced for the rest.

For (c), the predicate can be either a version rule or an explicit ID table.

**Verdict:** (c), decided by a generation rule, not a table.
- **The rule.** Parse the bare ID as `claude-<family>-<major>[-<minor>][-<yyyymmdd>]`. Then `isClaudeAdaptiveThinkingModel(id)` is `major ≥ 5`.
- **The auto bundle** (sent to matching models):
  - `tool_choice: {type: 'auto', disable_parallel_tool_use: true}`;
  - `strict: true` with the D2 schema copy;
  - an adapter-local nudge appended to `system`;
  - one retry when no `submit_review_findings` `tool_use` block comes back.
- **Forced, byte for byte as today:** Opus 4.6/4.7/4.8, Sonnet 4.x, Haiku 4.5, version-first `claude-3-…` IDs, and unparseable names.
- **Unknown future `claude-*-6`** gets `auto`.
- **Escape hatch for aliases:** a new env var `ANTHROPIC_TOOL_CHOICE` (`auto` | `forced`). Unset or invalid means "use the rule".

**Why:**
- (b) leaves Haiku 5.5 on forced choice. Forced calls skip thinking there (digest §6), which reproduces Prisma's silent empty-review incident (O-D2, O-D10).
- Opus 5, Sonnet 5 and Fable 5 think by default and accept forced choice. A forced response must open with the tool call, so the model cannot think first [ASSUMPTION, M: the digest states the skip only for Haiku 5.5]. One predicate covers both the 400 set and the skip set.
- (a) changes the wire bytes of every 4.x deployment and drops a call guarantee that works on non-thinking models. That violates the classic-bytes rule (O-D7, O-D8).
- A major-version rule is exactly the vendor's thinking boundary: every 5.x thinks by default, while Opus 4.7/4.8 do not (digest §2). It survives new minors and codenames. A table goes stale with every release, which is why O-D8 rejected tables.
- **Safe-direction asymmetry.** `auto` on a model that would accept forced choice costs at most one retry. Forced choice on a model that rejects it is a guaranteed 400. So a new generation defaults to `auto`.
- Unparseable names default to forced because that keeps today's bytes and matches O-D2's classic fallback. The env var covers an alias in front of a 5.x model. Without it, that alias is a guaranteed 400 with no repo-level fix.
- **Missing-call policy: one identical retry, then `schema_validation`.**
  - Treating a missing call as `findings: []` would bring back the silent "clean" review.
  - Failing immediately turns a random miss into a lost batch.
  - Check-then-retry is the vendor's pattern (digest §6, step 4).
  - The retry costs a call only when the call is missing. The forced path never retries, so its call count is unchanged.

**Rejected:**
- (a), because classic bytes change for no benefit.
- (b), because it keeps the Haiku 5.5 thinking skip.
- An explicit ID table, because it goes stale with every release.
- Structured outputs (`output_config.format`) instead of the tool, because the shared `IMMUTABLE_SYSTEM_PROMPT` names the tool contract (`packages/shared/src/prompt/review-prompt.ts:49,56,61-62`). That would need an Anthropic-only system prompt.
- A multi-turn repair retry (replaying the text answer plus "call the tool now"), because it is more code, replays thinking blocks, and has no measured gain.

**Implementer constraints:**
- **Where it lives.** Put the parser and `isClaudeAdaptiveThinkingModel` in `packages/shared/src/model-slug.ts`, next to `isReasoningModel`; the orchestrator needs them for D12. **Do not touch `REASONING_MODEL_RE`** (`:75`). The D5, D6 and D7 resolvers derive from the same parser, so there is no second regex.
- **How it matches.**
  - Match `claude-([a-z]+)-(\d+)`, case-insensitive and unanchored, so a gateway or Bedrock-style prefix such as `us.anthropic.claude-opus-5-5` still parses.
  - The family token must be letters, so version-first `claude-3-5-sonnet-*` never matches.
  - **An 8-digit group is a date, never a minor version:** `claude-opus-4-20250514` is 4.x with no minor.
- **Thinking set through the bag (D4).** The auto bundle also applies when `provider_options.anthropic.thinking.type` is `adaptive` or `enabled` on a pre-5 model. Forced choice with thinking enabled is rejected on those models [M, Anthropic extended-thinking contract]. The bag can turn the bundle on, never off.
- **The nudge.**
  - It is an adapter-local constant appended to `system` only on the auto path.
  - The shared `IMMUTABLE_SYSTEM_PROMPT`, OpenAI's `REASONING_NUDGE` (`packages/providers/openai/src/index.ts:1388`) and Copilot's bytes stay unchanged.
  - Suggested text: O-D2b's sentence plus "Your answer is read only from that tool call; plain text is discarded."
  - Its roughly 40 tokens fit inside `prompt_overhead_tokens`, so no estimator change is needed.
  - The shared prompt already names the tool three times (`review-prompt.ts:49,56,227`) and the tool description says "exactly once" (`:72`).
- **Check order after the response:**
  1. usage (D13);
  2. `refusal` (D8);
  3. `max_tokens` (`index.ts:264-274`);
  4. tool extraction;
  5. on the auto path only, after the first attempt: the retry.

  A second miss throws `schema_validation` with a message distinct from the forced path's (`index.ts:168-171`). Example: "…did not call 'submit_review_findings' (tool_choice auto) after 1 retry".
- **Naming.** `ANTHROPIC_TOOL_CHOICE` uses wire names, so its `auto` means "always auto". That differs from `OPENAI_TOOL_CHOICE=auto`, which means "use the heuristic". Either document the difference or let RAMZA choose distinct value names.
- **Tests.**
  - The forced request object deep-equals today's for `claude-haiku-4-5`, `claude-opus-4-8`, `claude-sonnet-4-6` and an unparseable name.
  - The auto bundle is sent for `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`, `claude-mythos-5-1`, `claude-opus-5` and `claude-foo-6`.
  - Parser cases cover prefixes and date suffixes.

**Reverses if:** Anthropic documents that forced choice keeps thinking on Haiku 5.5, Opus 5, Sonnet 5 or Fable 5 (then narrow the rule to the 400 set), or production shows auto-path misses surviving the retry at a material rate (then use a repair turn or structured outputs).

## D2 — `strict: true` on the review tool

**Options:**
- (a) No `strict`; send the shared schema unchanged.
- (b) `strict: true` on the auto path only, with an Anthropic-only wire copy of the schema built from an allowlist. The copy keeps `type`, `properties`, `required`, `additionalProperties`, `items`, `enum` and `description`.
- (c) `strict: true` on every Claude request.
- (d) Strip the constraints from the shared schema itself.

**Verdict:** (b).

**Why:**
- **What strict buys.** It guarantees types, enums, required fields and no extra properties. Those are the violations most likely to fail `ProviderReviewOutputSchema`, and one bad finding fails the whole parse and drops the batch (`index.ts:277-284`).
- **What stripping costs.** Strict cannot express `minLength`/`maxLength`/`minimum`/`maximum`/`maxItems` (digest §6), so removing them loses only hints to the model:
  - Zod stays authoritative and still enforces them.
  - The prompt states the same bounds in prose (`review-prompt.ts:55-59`).
  - The `description` fields are kept.
- **Why auto path only.** It keeps the forced-path bytes identical and avoids depending on strict support on 4.x models.
- **Why an allowlist.** A keyword added later to the shared schema is then simply dropped from the Anthropic copy. A denylist would let it through and turn every 5.x review into a 400.
- **Cache benefit.** Dropping `maxItems` (`:158`) leaves two schema variants, so the 24-hour compilation cache stays warm (digest §6).

**Rejected:**
- (a), because the vendor's migration pattern pairs `auto` with strict: `auto` already loosens the call guarantee.
- (c), because it changes 4.x bytes.
- (d), because it changes OpenAI and Copilot wire bytes (FINDING-002).

**Implementer constraints:**
- A pure helper in `packages/providers/anthropic/src/prompt.ts` deep-copies `buildToolInputSchema(pf)`.
- A test asserts that the shared object is not mutated and that the OpenAI and Copilot schema bytes are unchanged.
- `additionalProperties: false` is already on every object (`review-prompt.ts:77,103,135,148`), and the copy keeps it.
- Optional properties (`suggested_fix`, highlight `path`, `highlights`) stay optional [ASSUMPTION, M: the digest's limit list does not exclude them].

**Reverses if:** a live call shows strict rejecting the stripped schema. Then remove `strict`, a one-line change, and keep the rest of the auto bundle. A pre-release smoke test is recommended (see Open for the user).

## D3 — Thinking and effort

**Options:**
- (a) Send nothing and use model defaults (`medium` on Opus 5.5 and Haiku 5.5, `high` elsewhere).
- (b) An explicit per-family default table.
- (c) Knobs: `provider_options.anthropic.effort` → `output_config.effort`, plus an `ANTHROPIC_EFFORT` env var.
- (d) (a) plus the repo knob from (c), forwarded verbatim, with no env var.

**Verdict:** (d).
- Prisma never sends `thinking`.
- It sends `output_config.effort` only when a repo configures it, in one of two forms:
  - the flat `effort` key, which is mapped to `output_config.effort`;
  - native `output_config.effort`, which wins over the flat key (the O-D3 / ADR-007 D3 "native wins" rule).
- Values are forwarded verbatim and not validated. An unsupported value reaches the D10 remedy.

**Why:**
- The vendor's "set effort explicitly, levels are recalibrated between generations" advice (digest §3) protects tuned settings, and Prisma has never set one.
- The model defaults are the vendor's per-model calibration. For Opus 5.5 and Haiku 5.5 they equal the vendor's own starting points.
- A Prisma table would encode cost and quality judgments without eval data, and go stale with every release (O-D3's rejection reason).
- Effort controls thinking cost, and thinking is billed as output. That makes it a choice for whoever pays, which today means per-repo config, as with OpenAI's `reasoning_effort` (no OpenAI effort env var exists).
- Never sending `thinking` is forced by the contract: `disabled` or `budget_tokens` is a 400 on most 5.x models (digest §2).

**Rejected:**
- (b): a stale table, with no data behind it.
- The env-var half of (c): it breaks OpenAI parity, and the bag already covers it. Revisit if operators ask.

**Implementer constraints:**
- `thinking` is not on the denylist (D4). An operator may set it, and a resulting 400 gets the D10 thinking remedy.
- Replace the `config-spec.md:97-100` example with `effort: medium`.
- Add an effort × model matrix to `model-compatibility.md`: `xhigh` is absent on the 4.6 models, and effort errors on Haiku 4.5 and Sonnet 4.5 (digest §3).

**Reverses if:** evals show Sonnet 5.5's `high` default routinely truncating at the D5 cap, or costing materially more than `medium` for no quality gain. Then default Sonnet 5.5 to `medium`, the vendor's tool-use starting point.

## D4 — Honoring `request_shaping`

**Options:**
- **Model:** honor `request_shaping.model`, or keep ignoring it.
- **Generation:**
  - (i) ignore all of it, as today;
  - (ii) forward everything with a sampling strip (the O-D4 analog);
  - (iii) honor `max_output_tokens` only.
- **Passthrough bag:**
  - (α) none;
  - (β) a raw bag with a denylist, mirroring OpenAI;
  - (γ) a typed allowlist containing only `effort`.

**Verdict:**
- Honor `model` in `review()`: `input.request_shaping?.model ?? this.model`.
- Honor `generation.max_output_tokens` as `max_tokens`.
- Keep ignoring `temperature`, `top_p` and `seed`.
- Implement (β), with this denylist:

  | Denied keys | Why |
  |---|---|
  | `model`, `messages`, `system`, `tools`, `tool_choice`, `stream` | Prisma-managed, as in OpenAI's list |
  | `betas`, `mcp_servers`, `container` | Data boundary; `betas` would smuggle headers once the D9 beta endpoint exists |
  | `fallbacks` | Spend routing; a deployment-level decision (D9) |
  | `output_config.format` (nested) | Conflicts with the tool contract; the analog of OpenAI's `response_format` |

**Why:**
- **Model.** A repo-level `model: anthropic/claude-sonnet-5-5` is silently dropped today (FINDING-004). That is the only per-repo way off the retired default.
- **`max_output_tokens`.** The orchestrator already reserves it for every provider (`orchestrator.ts:898-908`). Honoring it closes the gap between what is planned and what is sent.
- **Sampling stays ignored.**
  - Anthropic never forwarded sampling, so not starting is zero-regression.
  - Forwarding would need a second predicate: Opus 4.7/4.8 removed sampling too, and Sonnet 5.5 and Haiku 5.5 reject non-default values (digest §4).
  - It would also change behavior for repos that set `temperature` for OpenAI parity.
  - O-D4 protected an existing forwarding path; here there is none.
- **Bag.**
  - `config-spec.md:87` already promises verbatim passthrough, so (β) fulfils a documented contract that is silently broken today. It also carries D3's `effort`.
  - The bag is controlled by the repo owner (`.github/review-bot.yml`), so keys that send diff content to third-party servers (`mcp_servers`) or let `betas` set headers are a security boundary.
  - `fallbacks` changes which model is billed.

**Rejected:**
- (ii): a second family predicate, and a behavior change for parity-tuned repos.
- (α): the documented contract stays broken.
- (γ): `service_tier`, `inference_geo`, `metadata`, legacy `thinking` and `top_k` are all legitimate, and each would need its own code.

**Implementer constraints:**
- **Precedence on the wire:** bag > `generation.max_output_tokens` > `ANTHROPIC_MAX_OUTPUT_TOKENS` > family default (D5). This matches `config-spec.md:64`, where the repo setting overrides the deployment env.
- **Notes for dropped keys** are key-only and stay local, as in OpenAI's `applyProviderOptions` (`openai/src/index.ts:538-553`).
- **`respond()`** keeps `this.model` and gets no bag, because `ProviderRespondInput` has no `request_shaping`. Same as O-D2.
- **Docs:** fix `config-spec.md:70` to say Anthropic honors `max_output_tokens` and ignores sampling and `seed`.
- **`seed`** is never sent (`deterministic_seed: false`).

**Reverses if:** operators on legacy Claude models need sampling through `generation`. Then add a strip keyed on a "sampling-removed" rule derived from the D1 parser.

## D5 — Output cap

**Options:**
- (a) Keep 4096.
- (b) Family-aware: 4096 on the forced path, 16,384 when thinking is expected (generation ≥ 5, or thinking set in the bag).
- (c) Family-aware with 32,768, O-D7's number.
- (d) One new default for every model.

**Verdict:** (b).
- `ANTHROPIC_MAX_OUTPUT_TOKENS` still overrides the cap for every model.
- The default is resolved per request, from the request's model (`resolveAnthropicDefaultMaxOutputTokens`).
- The worker mirrors the OpenAI arm exactly (`worker.ts:270-275`):
  - it passes `maxOutputTokens` to the adapter only when the env var is set;
  - it gives the orchestrator `envMax ?? resolveAnthropicDefaultMaxOutputTokens(model ?? ANTHROPIC_DEFAULT_MODEL)` through `limitsFor`.
- No streaming.

**Why:**
- Thinking counts toward `max_tokens` (digest §2), so a 4096 cap truncates systematically. Each `output_truncated` split costs a real call (the split path in `orchestrator.ts`, from about `:1087`).
- 16,384 sits inside the vendor's ~16K non-streaming guidance. It is also below the ~21.3K threshold at which newer SDKs refuse non-streaming requests (digest §5), so a future SDK bump cannot break it. 32,768 would.
- Worst-case latency stays under the SDK's 10-minute default timeout (`node_modules/@anthropic-ai/sdk/index.js:136`).
- The cap is a ceiling, not spend.
- The forced path keeps 4096, so its bytes are unchanged.
- Streaming would rewrite response assembly for no benefit at or below 21K.

**Rejected:**
- (a): broken by default.
- (c): outside the non-streaming envelope, and broken by a future SDK guard.
- (d): changes 4.x bytes.

**Implementer constraints:**
- **Coupling (O-D7):** by default, the deployment model's effective cap and `providerLimits.maxOutputTokens` must stay equal. The constant 4096 at `worker.ts:189` goes away.
- `output_truncated.requested_max_tokens` carries the cap actually sent.
- `respond()` uses the same resolver on `this.model`.
- `DEFAULT_MAX_OUTPUT_TOKENS` (`index.ts:67`) becomes the forced-path value. The test at `provider.test.ts:246-252` still holds for a 4.x model; add a 5.x sibling.
- The default keys on the model and the bag, not on `ANTHROPIC_TOOL_CHOICE`.
- Document two points:
  - caps above about 21K need streaming on newer SDKs;
  - lower `effort` rather than starving the cap.

**Reverses if:** telemetry shows `output_truncated` on 5.x batches with `output_tokens` near the cap at a material rate. Then raise the cap, or adopt streaming if it must exceed 21K. Also revisit if the SDK is bumped, to re-check its guard.

## D6 — Context window and per-request guard

**Options:**
- (a) A static 1M for every Claude ID.
- (b) A per-model resolver: 1,000,000 for generation ≥ 5 and for 4.x with minor ≥ 6 (Opus 4.6/4.7/4.8, Sonnet 4.6); 200,000 for everything else, including unknown IDs.
- (c) New input/output capability fields.

**Verdict:** (b), via `resolveAnthropicContextWindow(model)` on the D1 parser.
- **Wiring:** set in the constructor with the `options.capabilities?.max_context_tokens ??` precedent (O-D1).
- **Defaults:** `DEFAULT_CAPABILITIES` (`index.ts:32-43`) is derived from the resolvers for `ANTHROPIC_DEFAULT_MODEL`, so the literal cannot drift.
- **Per-request guard (O-D2):**
  - `inputCap = min(maxTokensPerCall, windowFor(model) − requestOutputCap)`.
  - `windowFor(model)` is `this.capabilities.max_context_tokens` for the deployment model, and the resolver's value for an override.
  - The estimate uses the request model's D7 tokenizer family.

**Why:**
- **No 922K-style adjustment is needed (unlike O-D1).** `hard_cap_in` already subtracts the reserved output and a 7% safety margin from the window (`orchestrator.ts:898-908`). So 1,000,000 is safe whether the vendor's figure is total context or input only.
- **A wrong 1M on Haiku 4.5 is harmless at the default `MAX_TOKENS_PER_PR` of 120,000** (`worker.ts:93`): the budget is capped at 120K either way (`orchestrator.ts:935`). It overflows only once an operator raises that cap, which is exactly when windows start to matter.
- **Unknown IDs get 200K** because it is the safe direction: it means more chunking, never a 400.
- **The guard must change.** Today it checks `maxTokensPerCall` only (`index.ts:215-233`), which is wrong once the model varies per request (D4).

**Rejected:**
- (a): overflows a 200K model whenever `MAX_TOKENS_PER_PR` is raised.
- (c): a cross-provider `.strict()` schema change (O-D1).

**Implementer constraints:**
- **Flagged orchestrator tests are unaffected.** The tests the scout flagged (`apps/github-app/tests/pipeline/orchestrator.test.ts:1010-1180`) use `FakeProvider` with explicit `capabilities`, so the adapter window does not touch them. They depend only on the `anthropic-approx` margin, which D7 leaves unchanged.
- **Accepted blast radius:** an override to a larger-window model plans with the deployment window (O-D2).
- **Docs:** Haiku 5.5 bills 5× above 100K prompt tokens (digest §1). Setting `MAX_TOKENS_PER_PR` to about 95,000 or less keeps it in the cheap tier, which is reliable only with D7's non-under-counting estimate. This mirrors O-D1's 272K price note.

**Reverses if:** a 4.5-or-older ID is documented at 1M without a beta header, or a second consumer needs separate input and output ceilings.

## D7 — Tokenizer estimate

**Options:**
- (a) Raise the global `SAFETY_MARGIN` from 1.15 to about 1.55.
- (b) Add a new family (for example `anthropic-approx-v2`, margin 1.55) and resolve it per model.
- (c) Keep 1.15 and rely on the 1M windows plus D10's mapping of the prompt-too-long 400.

**Verdict:** (b), via `resolveAnthropicTokenizerFamily(model)` on the D1 parser.
- **New family:** generation ≥ 5, Opus 4.7/4.8, and unknown or unparseable IDs.
- **`anthropic-approx` (1.15):** provably legacy IDs, meaning 4.x other than Opus 4.7+, and version-first `claude-<digit>` IDs.
- **Margin 1.55:** the legacy 1.15 times the vendor's upper inflation bound of 1.35 (digest §10).

**Why:**
- **The estimator's contract is "never under-counts"** (`packages/shared/src/tokens/estimator.ts:92,119`; tests `estimator.test.ts:93-112`). O-D8 kept that contract at some cost in accuracy: it rejected a default that could under-count.
- **Under-counting by up to 35% has two costs:**
  - `MAX_TOKENS_PER_PR` is off by that much per call;
  - the overflow guarantee breaks precisely when operators raise that cap to use the 1M window. About 900K estimated becomes about 1.2M real, and the API returns a 400.
- **A new family keeps legacy behavior and tests untouched.** Legacy planning and the many tests calibrated to 1.15 stay as they are: `orchestrator.test.ts:1011`, `packages/core/tests/batcher/batcher.test.ts:263,306,320`, `split-file.test.ts:66`. A global raise would re-baseline all of them and over-chunk Haiku 4.5.
- **Unknown IDs get the higher margin** because over-counting is the safe direction (O-D8).
- **Cost of the higher margin:** about 26% less diff per call at the 120K default. That matters only when `max_provider_calls_per_pr` (default 6, `config.ts:182`) is the binding limit, which needs a PR above roughly 600K estimated tokens. `max_changed_lines` usually stops those first.

**Rejected:**
- (a): a global re-baseline, and over-chunking on legacy models.
- (c): the "never under-counts" claim stays false, and the raised-cap overflow stays possible.

**Implementer constraints:**
- Add the enum member in `estimator.ts:43` and `packages/shared/src/schemas/provider.ts:381`. The change is additive.
- Add estimator tests that mirror the 1.15 set.
- Tokenizer family by consumer:
  - the orchestrator plans with the deployment model's family (`orchestrator.ts:939`);
  - the adapter guard uses the request model's family (D6).
- That 1.15 is an adequate bound for the legacy tokenizer is an [ASSUMPTION, unverified; FINDING-008]. 1.55 inherits that assumption.

**Reverses if:** a `messages.count_tokens` calibration over representative diffs (a live-call follow-up) shows a different ratio. Then set the margin from the data.

## D8 — Refusal handling (`stop_reason: 'refusal'`)

**Options:**
- (a) `capability` with `code: 'refusal'`.
- (b) A new `ProviderError` kind, `refusal`.
- (c) `schema_validation` with a clearer message.
- (d) `schema_validation` plus a new optional, additive `code: 'refusal'` field, with the category in the message.

**Verdict:** (d).
- **Order.** Check `stop_reason === 'refusal'` **before** reading any content, and discard partial content.
- **Error.** Throw `schema_validation` with `code: 'refusal'` and the message "anthropic declined the request: stop_reason refusal (category: <category | none>)".
- **No retry.** It is non-transient, and D1's retry must not fire on a refusal.
- **Notice, selected by `code`.**
  - **Single-call path:** "⚠️ Review unavailable — the provider's safety classifier declined to review this diff (category: `cyber`). This is not a configuration error; it can happen on security-related code. Re-run with `@<bot> review`, or pin a different model for this repository with `model:` in `.github/review-bot.yml`."
  - **Chunked path:** the declined batch's files are listed as not reviewed, with this reason.
  - **Ask path:** the same sentence replaces the generic "Sorry…" reply.

**Why:**
- **A refusal is about the batch's content, not configuration.** The existing `schema_validation` handling already does the right thing:
  - in a chunked review, it drops the batch and continues (`orchestrator.ts:1272-1276`);
  - on a single call, it publishes a summary and does not retry (`:1510-1531`).
- **(a) is too blunt.** It would abort the **whole** chunked review on one declined batch, because capability errors always abort (AC4.4). Benign security code is plausible `cyber` territory (digest §8), so one refusal would throw away every other batch's findings.
- **(b) is the cleanest semantically, but its failure modes are dangerous.**
  - It touches the schema union, `classifyRetry`, both orchestrator paths, the fake provider and observability.
  - A kind missing from `classifyRetry` falls through to `transient` (`job-queue.ts:114`).
  - An unhandled kind in the batch loop is re-thrown for retry (`orchestrator.ts:1284-1288`).
- **(d) fails safe.** A missed branch shows today's "malformed output" text, never a retry or an abort. It also mirrors the additive `code` that O-D11 added to `capability`.
- **(c) alone** gives users the wrong diagnosis.

**Rejected:**
- (a), (b) and (c), for the reasons above.
- An in-adapter retry on refusal. The classifier is likely deterministic for the same input [ASSUMPTION], and server-side fallbacks (D9) are the vendor's mechanism for this.

**Implementer constraints:**
- Make `code` optional on the `schema_validation` variant (`provider.ts:318`), and log it in `providerErrorDetailFields` (`orchestrator.ts:411-424`).
- Surface only `category`, which is a vendor enum. `stop_details.explanation` is free text that may echo content: never log or show it (G-1).
- Branch on `stop_reason`, never on `stop_details`, which may be null.
- `respond()` gets the same check.
- Document the code in `observability.md:45`.
- A refusal eval fixture scripted through FakeProvider is optional.

**Reverses if:** refusals need different queue semantics, such as their own retry policy. Then promote them to a kind (b).

## D9 — Server-side fallbacks

**Options:**
- (a) On by default for supported models (the vendor default, digest §9).
- (b) An opt-in, deployment-level knob (`ANTHROPIC_FALLBACKS=default`).
- (c) Defer.

**Verdict:** (c), defer. `[USER-RATIFY]`, because this departs from the vendor default.

When it lands, it should take the (b) shape, already decided here:
- set by deployment env only, never repo config, because it changes the billed model;
- beta header `server-side-fallback-2026-07-01` with `fallbacks: "default"`;
- supported models only: Opus 5/5.5, Fable 5.1, Sonnet 5.5 (not Haiku 5.5, not unknown IDs);
- `AnthropicClientLike` widened with an optional `beta.messages.create` (FINDING-010; still free of SDK types);
- a summary note naming the model that actually served (from the response `model` or the `fallback` block).

**Why:**
- **(a) is unsafe without knowing the endpoint.**
  - The SDK silently honors `ANTHROPIC_BASE_URL` (`client.ts:23-25` → SDK `index.js:55`).
  - Fallbacks do not exist on Bedrock, Vertex, Foundry or arbitrary gateways (digest §9).
  - So turning them on by default would make every review behind such a gateway fail with a 400 on upgrade. (a) would need the (b) knob anyway, just to turn it off.
- **Fallbacks substitute the model.** A different model reviews the code, billed at that model's rate.
- **(b) is sound, but there is no refusal data yet.**
  - D8 creates that telemetry (`code: refusal`, `category`).
  - D8's notice already gives a manual remedy: re-run, or pin a model per repo through D4.
- **Deferring is fully reversible** and keeps a beta-header dependency out of an already wide change.

**Rejected:**
- (a): the gateway outage risk, plus silent model and spend substitution.
- (b) now: no evidence of need yet, and exposure to beta-API churn.

**Reverses if:** production shows `code: refusal` on supported models at a non-trivial rate (security-tooling repos are the likely first case), or the user chooses to ship (b) now.

## D10 — Error mapping and remedies

**Options:**
- **Mapping:**
  - (a) keep the keyword heuristic and add 404;
  - (b) classify by stable fields:
    - 404 → `capability`;
    - every 400 with type `invalid_request_error` → `capability`;
    - in both cases, `code` = the vendor's `error.type`.
- **Remedies:**
  - (i) add regexes to the OpenAI remedy table;
  - (ii) separate Anthropic remedies, keyed on `code` plus the message.

**Verdict:** (b) + (ii).

**Mapping:**
- **404**, any type but typically `not_found_error` → `capability`, `code: 'not_found_error'`.
- **400 `invalid_request_error`** → `capability` regardless of wording, `code: 'invalid_request_error'`.
- **A 400 without a recognizable type** keeps today's keyword heuristic.
- **5xx and 529** read `Retry-After` into `transport.retry_after_ms`, for O-D11 parity; it is log-only.

**Remedies:** in `provider-notices.ts`, applied only when the new `meta.provider === 'anthropic'`.

| Trigger | Remedy text |
|---|---|
| `code === 'not_found_error'` | "The configured Claude model ID was not found: it is retired or misspelled (`claude-3-5-sonnet-latest` and every Claude 3.x ID are retired). Set `ANTHROPIC_MODEL`, or `model: anthropic/<id>` in `.github/review-bot.yml`, for example `claude-sonnet-5-5`." |
| `/tool_choice/i` and `/not supported/i` | "This model rejects forced tool choice. Prisma sends `auto` to Claude 5.x IDs automatically; behind an alias, set `ANTHROPIC_TOOL_CHOICE=auto`." |
| `/thinking\.type/i` | "Remove `provider_options.anthropic.thinking`. Claude 5.x thinks adaptively; use `effort` to control depth." |
| `/output_config\.effort\|\beffort\b/i` | "This model does not support the configured `effort`. Claude 5.x accepts low, medium, high, xhigh or max; Haiku 4.5 and Sonnet 4.5 accept none." |
| `/\b(temperature\|top_p\|top_k)\b/i` | "Remove that sampling key from `provider_options.anthropic`; Claude 5.x rejects it." |
| `/prompt is too long/i` | "Lower `MAX_TOKENS_PER_PR` or `chunking.call_token_budget`." |

Both call sites pass `provider`: the check-run summary (`orchestrator.ts:819-830`) and the comment reply (`worker.ts:855-866`).

**Why:**
- **GAP-2:** today the 404 is invisible on PR events and produces three misleading replies on commands.
- **Every Anthropic 400 is non-transient.** Today, a 400 that misses the keywords becomes `transport` and is silently retried. Two examples:
  - prompt-too-long;
  - "credit balance is too low", which is also an `invalid_request_error`.
- **Type is the stable field.** Anthropic errors carry no `param` or `code`, only the error type. (b) applies O-D11's principle (stable fields over wording) to this vendor.
- **Scoping by provider prevents cross-talk.** `/tool_choice/` could match an OpenAI gateway message and hand an OpenAI operator an Anthropic env var. The OpenAI remedies stay byte-identical.

**Rejected:**
- (a): silent retries continue for every 400 that misses the keywords.
- Fixing `classifyRetry` to honor `transport.retryable === false`: it is a cross-provider change, and it still publishes nothing, because only auth and capability errors publish (`orchestrator.ts:819-864`). Deferred (D14).
- (i): regexes collide across providers.
- Mapping prompt-too-long to `over_budget`, which would degrade the review instead of aborting it: it departs from O-GAP-001 (`context_length_exceeded` → `capability`), and the case becomes rare after D7. Revisit if it shows up.

**Implementer constraints:**
- Billing 400s and the Fable ZDR 400 now also become `capability`. Their safe message appears verbatim in the generic notice, which is acceptable and visible.
- **Error-mapping tests:** 404, the verbatim digest §13 strings, prompt-too-long, credit balance, and a gateway 400 with no type.
- **`provider-notices` tests:** one per remedy, plus negatives:
  - an OpenAI message containing "tool_choice" must not get the Anthropic remedy;
  - an Anthropic 404 must not get the OpenAI remedy.

**Reverses if:** Anthropic adds a structured `param` or `code` to its errors (then key on it), or operators report capability notices for 400s that turned out to be transient.

## D11 — Default model and `ANTHROPIC_MODEL`

**Options:**

| Model | Rationale | Price ($/MTok in / out) | Default effort |
|---|---|---|---|
| `claude-opus-5-5` | Vendor default for new code | $4 / $20 | `medium` |
| `claude-sonnet-5-5` | Vendor's named replacement for Sonnet 3.x | $2 / $10 | `high` |
| `claude-haiku-5-5` | Cheapest | $0.10 / $0.50 | `medium` |

**Verdict:** `claude-sonnet-5-5` `[USER-RATIFY]`. Add `ANTHROPIC_MODEL`: yes, read through `tryGetSecret` like `OPENAI_MODEL` and `COPILOT_MODEL` (`worker.ts:217,239`).

**Why:**
- **The flip itself is mandatory.** The current default returns 404 (GAP-2). Only the target is a choice.
- **Precedent favors Sonnet.**
  - O-D9, as ratified, followed the vendor's *named replacement* for the retiring default (`gpt-4o` → `gpt-6-luna`).
  - The exact analog here is "Sonnet 3.x → `claude-sonnet-5-5`" (digest §1).
  - The vendor's "new code → Opus 5.5" is general guidance for greenfield code, not a migration of an existing default.
- **Price continuity favors Sonnet.**
  - The retired default was a Sonnet at $3/$15, and Sonnet 5.5 is cheaper per token.
  - Opus 5.5 would raise unconfigured deployments' per-token cost by a third, on top of the new thinking tokens, with no Prisma eval showing a quality gain.
- **The quality gap is partly closed by default.** Sonnet 5.5 runs at `high` effort out of the box, and Opus 5.5 stays one env var away.
- **`ANTHROPIC_MODEL` is needed regardless.** Without it, a deployment's model can be changed only per repo, and the current incident shows a deployment-wide lever is required.

**Rejected:**
- Opus 5.5: twice the per-token cost by default, with no proven gain for this workload.
- Haiku 5.5: the quality floor is too low for an unconfigured default.
- Keeping the current default with a warning (O-D9's original proposal): impossible, because the current default is already broken.

**Implementer constraints:**
- `worker.provider.selected` may log the resolved model name (it is not a secret).
- **Config and docs to update:**
  - `.env.example`, `deploy/.env.prod.example`, `config/deploy.yml` (as a commented knob, in the style of `:87-90`);
  - `docs/deployment.md`, `docs/install-github-app.md:105`, `README.md:108`.
- Replace the stale `claude-sonnet-4.5` and `claude-4-class-model-id` examples (FINDING-011, FINDING-012).

**Reverses if:** the user prefers review quality over cost for the default. Then use Opus 5.5; every other verdict is unchanged, since both are generation 5.

## D12 — Empty-review notice and eval fixture

**Options:**
- (a) No notice for Claude. This is the status quo: the gate is `isReasoningModel` only (`orchestrator.ts:398,1586`).
- (b) Extend the gate to `isClaudeAdaptiveThinkingModel`, with Anthropic wording that does not rely on `reasoning_tokens`.
- (c) Reuse the OpenAI text.

**Verdict:** (b).
- `reasoningModelNoFindingsNotice(model)` (`provider-notices.ts:165`) dispatches internally. The OpenAI text stays byte-identical, since eval fixtures assert its substrings.
- Claude adaptive-thinking models get:

  "`<model>` thinks before answering (adaptive thinking) and reported no findings. If you expected some, check the `provider.usage` log event: `output_tokens` in the low tens means the model answered without thinking — unset `ANTHROPIC_TOOL_CHOICE=forced` if set; otherwise raise `provider_options.anthropic.effort` (Opus 5.5 and Haiku 5.5 default to `medium`). See docs/model-compatibility.md § Anthropic."
- Add one eval fixture, `thinking-model-empty-review-claude`:
  - config `model: anthropic/claude-sonnet-5-5`, with FakeProvider returning `findings: []`;
  - it asserts the Claude text is present and `reasoning_tokens` is absent.

**Why:**
- **The silent-empty failure class still exists for Claude:** forced choice through the escape hatch, or low effort.
- **The diagnostic must use `output_tokens`.** Anthropic folds thinking into `output_tokens` (FINDING-009), so the useful signal is "`output_tokens` barely above an empty call".
- **O-D10's "large count means a tight cap" branch does not transfer.** A capped Claude call stops on `max_tokens` and becomes `output_truncated`, never an empty review.
- **Internal dispatch leaves all three call sites unchanged.** That includes `worker.ts:789`, which keys on the outcome flag.
- **The fixture follows O-D10's precedent** and costs one YAML file. It tests orchestrator gating only, not the adapter (FINDING-012).

**Rejected:**
- (a): the silent class goes undetected.
- (c): it names `reasoning_tokens` and `OPENAI_*` settings, which are wrong for Claude.

**Implementer constraints:**
- Reuse the `reasoning_model_empty` outcome detail; no schema change.
- **Known gap carried over from OpenAI:** the gate reads the repo's `config.model`, so a repo without `model:` that runs on the deployment default never gets the notice (listed in D14).

**Reverses if:** telemetry shows empty Claude reviews correlate with something other than effort or forced choice. Then reword the notice.

## D13 — Usage telemetry

**Options:**
- (a) None, the status quo.
- (b) Raw vendor fields.
- (c) Vendor fields normalized onto the existing `provider.usage` names.

**Verdict:** (c).
- Add `AnthropicUsageTelemetry` and an `onUsage` option, mirroring `openai/src/index.ts:896-940`.
- The worker emits `log('provider.usage', { provider: 'anthropic', ...usage })`.
- Field mapping:

  | `provider.usage` field | Anthropic source |
  |---|---|
  | `endpoint` | always `'messages'` |
  | `model` | the model sent |
  | `input_tokens` | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` (OpenAI semantics: total prompt) |
  | `output_tokens` | `output_tokens` (includes thinking) |
  | `cached_input_tokens` | `cache_read_input_tokens` |
  | `cache_write_tokens` | `cache_creation_input_tokens` |
  | `reasoning_tokens` | omitted (Anthropic does not report it) |

- Fields the response did not report are omitted, never zero-filled.
- The event fires once per API call, before the refusal and truncation checks, so the D1 retry reports twice.
- `review()` only, as with OpenAI.

**Why:**
- **One event name lets dashboards sum across providers.**
- **Normalization keeps `input_tokens` meaning "total prompt" everywhere.** Anthropic's own `input_tokens` excludes cache reads and writes. Prisma sends no `cache_control` today, so the sum equals the raw value for now.
- **D12's diagnostic needs `output_tokens`.**
- **Counts only**, per the `observability.md:43` invariant.

**Rejected:**
- (a): D12 cannot be diagnosed, and OpenAI parity is broken.
- (b): two vocabularies under one event name.

**Implementer constraints:**
- Exceptions thrown by `onUsage` are swallowed and never fail a review.
- Update `observability.md:43` to name both adapters and the `messages` endpoint value.
- Tests mirror `packages/providers/openai/tests/provider.test.ts:2583-2640`.

**Reverses if:** prompt caching lands and someone needs the raw uncached input count. Then add a field and keep the totals.

## D14 — Scope cuts (explicitly out of this change)

- **SDK bump past 0.32.1.** Every 5.x field travels untyped (FINDING-010). A bump would re-open D5's non-streaming threshold.
- **Streaming** (D5).
- **Bedrock, Vertex and Foundry clients**, and any Prisma base-URL setting or docs. The SDK's implicit `ANTHROPIC_BASE_URL` stays undocumented and unsupported.
- **Server-side fallbacks** (D9).
- **Prompt caching** (`cache_control`). The D13 fields are already in place for it.
- **Structured outputs** replacing the tool (D1).
- **`respond()` beyond two changes.** It gets only the D5 cap and the D8 refusal handling. It does not get the model override, the bag, effort, usage telemetry or the retry.
- **Forwarding `generation` sampling** (D4).
- **An `ANTHROPIC_EFFORT` env var** (D3).
- **A per-request `capabilities` interface** (O-D2, ADR-002).
- **Live calibration** of the D7 margin with `count_tokens`.
- **The cross-provider `classifyRetry` fix** for `transport.retryable === false` (D10).
- **The empty-review notice for repos without `model:`** that run on the deployment default (D12).
- **Copilot**, which is untouched (scout GAP-1).

## Confidence

| Decision | Confidence | Main uncertainty |
|---|---|---|
| D1 | 0.75 | Thinking skip under forced choice on Opus 5 / Sonnet 5 / Fable 5 is assumed (M); the design is otherwise conservative. |
| D2 | 0.65 | Strict accepting optional properties is assumed (M). If wrong, every 5.x review fails until the one-line revert. |
| D3 | 0.70 | Sending no effort leaves Sonnet 5.5 at `high` by default; its cost and truncation behavior is unmeasured. |
| D4 | 0.80 | Denylist completeness for future body fields. |
| D5 | 0.70 | Whether 16,384 suffices at `high` effort on 120K-token batches is unmeasured. |
| D6 | 0.85 | — |
| D7 | 0.65 | The margin derivation rests on the unverified 1.15 legacy bound. |
| D8 | 0.75 | `schema_validation` is a misnomer for a refusal; accepted for fail-safe behavior. |
| D9 | 0.60 | A scope judgment that departs from the vendor default. |
| D10 | 0.80 | — |
| D11 | 0.75 | A product cost/quality call with no eval data. |
| D12 | 0.75 | — |
| D13 | 0.85 | — |
| D14 | 0.85 | — |

**Composite: 0.77.**

| Factor | Score | Basis |
|---|---|---|
| Evidence | 0.78 | Code and digest are H; five assumptions are M. |
| Logic | 0.82 | — |
| Constraints | 0.85 | Every caller-listed decision and both gaps are covered. |
| Sensitivity | 0.62 | D2, D7 and D9 depend on unverified wire behavior or data. |

The low sensitivity factor is a flag, not a blocker. Every sensitive verdict has a one-line reversal.

## Open for the user

- **D11:** default `claude-sonnet-5-5` (the vendor-named replacement; half Opus's price) or `claude-opus-5-5` (the vendor's default for new code). `[USER-RATIFY]`
- **D9:** defer server-side fallbacks, departing from the vendor's default of turning them on for supported models; the opt-in shape is already designed. `[USER-RATIFY]`
- **D5:** accept 16,384 as the default output cap for Claude 5.x. When `ANTHROPIC_MAX_OUTPUT_TOKENS` is unset, this raises the worst-case output spend per call 4×. `[USER-RATIFY]`
- **D3:** send no `effort` by default, so the model defaults apply (Sonnet 5.5 and Fable 5.1 run at `high`); the alternative is a Prisma-chosen default. `[USER-RATIFY]`
- **Recommended, not a ratification:** a pre-release live smoke test. Run one `review()` per family (Opus 5.5, Sonnet 5.5, Haiku 5.5) on a small diff to confirm the D1 auto bundle, D2 strict acceptance, the D5 cap and the D8 refusal path. This workflow made no live calls (digest header; scout GAP-3), and it needs an API key and a few cents.

**Ratified by the user (2026-10-16, orchestrator-recorded):**
- **D11:** `claude-sonnet-5-5` as the default. **Ratified.**
- **D9:** defer server-side fallbacks. **Ratified.**
- **D5 + D3:** 16,384 default cap for Claude 5.x, with no default `effort` (model defaults apply). **Ratified.**
- **Live smoke test:** the user will run it themselves with their own key. The change ships a runnable smoke script and the exact command; this workflow makes no live calls.

**Hand-off:**
- **→ RAMZA** for the spec. The implementer constraints above are the spec's acceptance anchors. No decision blocks the spec: the `[USER-RATIFY]` items are each a constant or a scope flag, and RAMZA can spec the proposed values.
- **→ IDG** for ADR-009 and the docs once implementation lands.

## Provenance

- **Decision type:** trade-off (multi-decision, 14 sections).
- **Hypotheses:** ≥ 3 per decision.
- **Passes used:** 2.
- **Confidence:** 77% (Evidence 78%, Logic 82%, Constraints 85%, Sensitivity 62%).
- **Gate result:** PASS.
  - **Fallacy scan:** D5 and D11 rest on functional reasons (the SDK threshold and latency; precedent and price), not on vendor authority alone.
  - **Evidence:** unverified claims carry `[ASSUMPTION]`.
  - **Completeness:** every decision the caller listed is answered, and GAP-2 and GAP-4 are closed.
- **`requires_checker`:** false.
