# ADR-008 — GPT-6 / GPT-6.1 Model-Family Compatibility: Window, Tokenizer, Sampling, Output Budget, and Error Remedies

## Status

Proposed — 2026-10-16. Amends [ADR-005](adr-005-openai-provider.md) (capability constants: `max_context_tokens` becomes a per-model resolution and `tokenizer_family` becomes a rule) and [ADR-006](adr-006-diff-chunking-stability.md) (the 128K window assumption and the `reserved_output` coupling). Supersedes nothing. ADRs are immutable once accepted; superseding decisions require a new ADR that explicitly references this one.

Two decisions are pending user ratification: D3 (forward reasoning effort verbatim) and D7 (32,768 default output cap for reasoning-family models). D9 (flip the default model to `gpt-6-luna`) was ratified by the maintainer on 2026-10-16.

## Context

OpenAI released `gpt-6-astra` (2026-09-03), `gpt-6-sol` and `gpt-6-luna` (2026-09-22), and `gpt-6.1-sol` (2026-09-29), and replaced the ChatGPT-tracking aliases with a bare `chat-latest`. [ADR-007](adr-007-openai-responses-endpoint.md) already routes these models to `/responses`, because the shared reasoning-family predicate matches `gpt-6-*`. The rest of the adapter and the worker still assume a GPT-5.x-era contract. What changed:

- **Window.** All four GPT-6 IDs have a 1,050,000-token window, a **922,000-token maximum input** and a 128,000-token maximum output. `OPENAI_CAPABILITIES.max_context_tokens` is 128,000, which is the output ceiling; the orchestrator plans input batches from it, so GPT-6 reviews are split roughly eight times more finely than needed. `chat-latest` has 400,000 / 272,000 / 128,000. Prompts above 272,000 input tokens are billed at 2× the input rate.
- **Tokenizer.** OpenAI publishes no encoding for GPT-6. The adapter's tokenizer map is an exact-name match with a `cl100k` fallback, so every `gpt-6*` slug, `chat-latest` and even `gpt-5.6-sol` are counted with the wrong vocabulary. Public measurements show GPT-6 token counts identical to GPT-5 (`o200k_base`); that evidence is empirical, not an OpenAI statement.
- **Reasoning effort.** `none` is rejected by `gpt-6-astra` and `gpt-6.1-sol`; `minimal` is rejected by every GPT-6 model; `max` is a new value valid on GPT-5.6 and GPT-6 via Responses.
- **Sampling.** `temperature`, `top_p`, `top_logprobs` (and `logprobs` on chat) are rejected at any effort other than `none`, so always on `gpt-6-astra` and `gpt-6.1-sol`. The adapter forwards `generation.temperature` / `top_p` unconditionally.
- **Output cap.** `max_output_tokens` includes reasoning tokens. The worker default of 4,096 truncates a medium-effort review systematically; OpenAI's guidance is to reserve at least 25,000 tokens.
- **`chat-latest` misroute.** The alias does not match the routing predicate, so it would be sent to `/chat/completions` with `max_tokens` and a forced function tool.
- **Errors.** The API now returns `code: unsupported_value` / `unsupported_parameter` with a `param`; the adapter ignores both. A 429 `insufficient_quota` is retried as a rate limit, and a 503 `server_is_overloaded` drops `Retry-After`.
- **Shutdowns.** The dated `gpt-4o` and `gpt-4.1` snapshots shut down on 2027-01-14 (announced 2026-10-14), with `gpt-6-luna` as OpenAI's named replacement. The adapter's default model is `gpt-4o`.
- **Docs.** The empty-review advice ("try `openai/gpt-4.1`, set `OPENAI_TOOL_CHOICE=required`") exists in three copies and is stale: `required` is already the default on `/responses`.

Chat Completions is not deprecated; OpenAI keeps supporting it while recommending Responses for new projects. `gpt-6-astra` and `gpt-6.1-sol` accept chat only without tools; `gpt-6-sol` and `gpt-6-luna` accept chat with tools only at effort `none`.

## Decision

### D1 — the input window is resolved per model

`resolveOpenAIContextWindow(model)` returns 922,000 for `gpt-6` and `gpt-6.<n>` slugs (`gpt-6-astra`, `gpt-6.1-sol`), 272,000 for `chat-latest`, and 128,000 for everything else, including gpt-5.x, o-series, classic and unknown slugs. The 922,000 figure is the maximum input, not the 1,050,000 window. The constructor derives `capabilities.max_context_tokens` from it; an explicit `capabilities` option still wins. The `ProviderCapabilitiesSchema` field is unchanged; its description now reads "maximum input tokens per call".

### D2 — a per-request input guard, and the worker limit reaches the orchestrator

The adapter's per-call guard becomes `min(MAX_TOKENS_PER_PR, window of the request's model − output cap of that request)`: the deployment model uses `capabilities.max_context_tokens`, a `request_shaping.model` override uses the resolver. The guard reserves the output cap because a 128K-class window is the total context; for GPT-6, whose 922,000 is already the maximum input, the reservation is merely conservative. An estimate above it throws `over_budget`, which the orchestrator already answers with a split. A non-finite `MAX_TOKENS_PER_PR` is not passed to the adapters, and the adapter treats a non-finite `maxTokensPerCall` as unbounded, so a malformed env value cannot disable the window bound. A new optional `OrchestratorDeps.providerLimits` (`maxTokensPerCall`, `maxOutputTokens`) lets the orchestrator plan `effectiveBudget` no higher than the adapter's own guard. The absolute cap, above which a single file is skipped at planning, is bounded by `MAX_TOKENS_PER_PR` as well, so a file the guard would reject is never sent alone and retried. Per-request `capabilities` are not introduced.

### D3 — reasoning effort is forwarded verbatim (pending ratification)

`toResponsesArgs` is unchanged. `none`, `minimal` and `max` reach the API as configured. The 400 that results becomes actionable through D11, and `docs/model-compatibility.md` carries the effort × model matrix.

### D4 — sampling parameters are dropped for reasoning models

`generation.temperature` and `generation.top_p` are not sent when `isReasoningModel(model)` and the explicit effort (`reasoning.effort`, else `reasoning_effort`) is not the string `'none'`. The rule applies in `review()` and `respond()`. A passthrough `provider_options.openai.temperature` is not touched. Classic models, including a classic model pinned to `/responses`, are unchanged. The drops are recorded as key-only notes.

### D5 — `respond()` stays on `/chat/completions`

`respond()` applies the D4 rule, keeps `seed` and `max_output_tokens`, and is otherwise unchanged. A 400 with `param: 'seed'` maps through D11.

### D6 — `chat-latest` joins the shared predicate

`REASONING_MODEL_RE` in `@prisma-bot/shared` gains an exact, anchored `chat-latest$` alternative. One change moves routing, `tool_choice`, the token parameter, the tokenizer, the input ceiling, the default output cap and the empty-review notice together. `chat-latest-2026` and `chat-latestx` do not match.

### D7 — the default output cap is family-aware (pending ratification)

When `OPENAI_MAX_OUTPUT_TOKENS` is unset, the default is 4,096 for classic models and 32,768 for `isReasoningModel` slugs, resolved by `resolveOpenAIDefaultMaxOutputTokens(model)` in both the adapter and the worker. The adapter resolves it per request, for the model that request uses, so a `request_shaping.model` override gets its own family's default; the worker passes `maxOutputTokens` to the adapter only when the env var is set, and then it applies to every model. The worker's value for the deployment model (or the env value) is passed to the orchestrator as `providerLimits.maxOutputTokens`, and `reserved_output` becomes `max(chunking.reserved_output_tokens, cap, generation.max_output_tokens)`; the repo's `generation.max_output_tokens` is reserved because the adapter sends it in place of the cap. When that reservation leaves a non-positive `hard_cap_in` or absolute cap, planning falls back to `chunking.reserved_output_tokens`, logs `pipeline.budget.output_cap_exceeds_window` (warn) and adds a configuration note naming the keys, instead of skipping every file.

### D8 — the tokenizer family is a rule

`resolveOpenAITokenizerFamily(model)` returns `o200k` for `isReasoningModel(model)` or `/^gpt-4(o|\.1|\.5)/i`, and `cl100k` otherwise. `OPENAI_TOKENIZER_FAMILY_MAP` is removed. Unknown slugs and gateway deployment names stay `cl100k`: over-counting is safe.

### D9 — the default model is `gpt-6-luna` (ratified 2026-10-16)

`OPENAI_DEFAULT_MODEL` moves from `gpt-4o` to `gpt-6-luna`, OpenAI's named replacement for the retired `gpt-4o` and `gpt-4.1` snapshots, in this release. The maintainer ratified the flip on 2026-10-16. `OPENAI_CAPABILITIES` is derived from the default through the resolvers the constructor uses, so it reads `deterministic_seed: false`, `max_context_tokens: 922000` and `tokenizer_family: 'o200k'`. No startup warning is logged.

Consequence: a deployment without `OPENAI_MODEL` changes behavior on upgrade. It moves from `gpt-4o` on `/chat/completions` (seeded, 4,096 output cap, 128,000 input ceiling, forced tool, sampling forwarded) to `gpt-6-luna` on `/responses` (no seed, 32,768 output cap, 922,000 input ceiling, `tool_choice: 'required'`, `generation.temperature` / `top_p` dropped). `OPENAI_MODEL=gpt-4o` is the opt-out: it restores the previous behavior until the snapshot shuts down on 2027-01-14.

### D10 — one empty-review notice

`reasoningModelNoFindingsNotice(model)` in `apps/github-app/src/provider-notices.ts` replaces the three copies of the advice. It names the `provider.usage` event, the output cap and the effort, and no longer recommends a classic model or `OPENAI_TOOL_CHOICE=required`. The sentence "is a reasoning model" is kept because an eval fixture asserts it.

### D11 — errors carry `param` and `code`, and remedies are keyed on `param`

The transport copies `error.param`. The `capability` error variant gains optional `param` and `code`; the `transport` variant gains optional `retry_after_ms`. A 400 with `code` `unsupported_value` or `unsupported_parameter` is a `capability` error whatever the wording. A 429 `insufficient_quota` is a non-retryable `rate_limit`, which the job queue classifies as `non_transient`. A 5xx carries `retry_after_ms` when `Retry-After` is present. `capabilityRemedyNotice(message, meta?)` evaluates, in order: the chat-with-tools signature (`OPENAI_API_STYLE` remedy), the effort remedy (`param` is `reasoning_effort` or `reasoning.effort`, and `code` is `unsupported_value` or the message starts "Unsupported value"), the per-`param` remedy (`temperature`, `top_p`, `top_logprobs`, `logprobs`, `seed`, `max_tokens`), and otherwise no remedy. An unknown `param` gets the generic notice.

### Addendum — `cache_write_tokens` in `provider.usage`

`OpenAIUsageTelemetry` gains `cache_write_tokens`, read from `input_tokens_details` (`/responses`) or `prompt_tokens_details` (`/chat/completions`) and omitted when absent. It is additive and does not reopen D1–D11.

## Rationale

- **D1 — 922,000, not 1,050,000 and not 272,000.** The orchestrator uses the field as an input ceiling, so 1,050,000 yields a plan above the maximum input and invites `context_length_exceeded`. 272,000 encodes a price boundary, not a capability, and the cost guard already exists twice (`chunking.call_token_budget`, `MAX_TOKENS_PER_PR`). gpt-5.x and o-series windows are not published in the research this ADR rests on, so they keep 128,000; classic models keep it to stay byte-identical. The resolver is a prefix rule, narrower than "gpt-6 and later": a future `gpt-7` is unknown, and 128,000 over-chunks (safe) where 922,000 could overflow. Rejected: a schema change (per-model capability fields) for one consumer; revisit when a second reader appears.
- **D2 — guard in the adapter, limit in `deps`.** The dangerous case is a deployment on `gpt-6-*` with a repo overriding to a 128K model: the orchestrator would plan 844K batches for a model that returns 400. The adapter is the only component that sees `request_shaping.model`, and `over_budget` already degrades to a split. Separately, planning up to 844K while the adapter rejects above `MAX_TOKENS_PER_PR` (120,000) would split every large batch twice and land files in `notReviewedFiles`; making the worker's own comment ("the orchestrator plans within `MAX_TOKENS_PER_PR`") true is the smallest fix. Rejected: a per-request `Provider.capabilitiesFor(model)`, an ADR-002 interface change across four adapters, left to its own ADR as ADR-007 already reserved.
- **D3 — verbatim, because a substitution is invisible.** Adapter notes have no channel to `config_notes`, so "normalize with a note" is silent in practice and changes cost, latency and quality, unlike dropping an inert field (D4). A per-model table is stale on the next codename, a family rule needs a second regex and still cannot split `none` (rejected by `gpt-6-astra`, accepted by `gpt-6-sol`). The API's own 400 lists the supported values and is never stale. Rejected: nearest-supported substitution; falling back to the default. This contradicts OpenAI's migration checklist (`minimal` to `low`) on purpose, so it is pending ratification. Revisit once a provider-note channel exists.
- **D4 — sampling has no effect on a reasoning model.** `generation` is vendor-neutral first-class config, and a repo tuned for another provider must not 400 on a model switch. Keying on the model predicate rather than the endpoint keeps a classic model pinned to `/responses` forwarding sampling. Rejected: a `gpt-6`-only rule (a second regex); leaving the values (a hard failure on neutral config). Rejection on gpt-5.x and o-series is assumed, so stripping there fixes a latent 400 at worst.
- **D5 — chat without tools is supported on GPT-6.** `max_completion_tokens` is already selected for reasoning models, and routing `respond()` to `/responses` would need a new output parser and lose `seed`, which ADR-007 declined. `seed` on chat for GPT-6 is unconfirmed, so a `seed` remedy (D11) is the honest handling instead of a pre-emptive drop. Reverse if `seed` is confirmed rejected.
- **D6 — one token fixes six behaviors.** The alternative, three global env vars (`OPENAI_API_STYLE`, `OPENAI_TOKEN_PARAM`, `OPENAI_TOOL_CHOICE`) for one alias, affects every other model. That `chat-latest` accepts `tool_choice: 'required'` on `/responses` is inferred, not observed.
- **D7 — pending ratification.** The cap includes reasoning tokens. At 4,096 a medium-effort review truncates and each `output_truncated` split costs a real call. 32,768 clears OpenAI's 25,000 guidance with room for the findings JSON and is a quarter of the 128,000 ceiling. The worker resolves the cap for batch planning, so the family default must live where the worker resolves it as well as in the adapter, and `reserved_output` must follow it or `hard_cap_in` under-reserves. Rejected: keeping 4,096 (broken by default); documenting only.
- **D8 — one family predicate, an honest vocabulary rule.** GPT-6 is empirically `o200k` (not an OpenAI statement), and no newer encoding exists in the tokenizer libraries, so `o200k` is the best estimate. A larger future vocabulary would tokenize to fewer tokens, so it does not under-count. Reusing `isReasoningModel` adds no fourth family classification; the classic arm is a vocabulary rule. Rejected: extending the slug table (stale per codename); defaulting unknown slugs to `o200k` (could under-count a `cl100k` model).
- **D9 — flip now, ratified.** The `gpt-4o` default has a fixed end (2027-01-14), so every unconfigured deployment changes model by then regardless. Flipping in the release that makes the GPT-6 family correct end to end (window, tokenizer, output cap, sampling, remedies) moves those deployments to a supported model while the `OPENAI_MODEL=gpt-4o` opt-out still works, instead of at a forced deadline. The cost is a behavior change (endpoint, `tool_choice`, seed, output cap, window and spend) with no operator action; it is documented in `docs/model-compatibility.md` § Default model and `docs/deployment.md`. Rejected: keeping `gpt-4o` with a `warn` startup event (the earlier proposal: non-breaking, but it only defers the same change to the shutdown date and depends on operators reading logs); docs only (nobody reads docs for a default they never set).
- **D10 — one helper, in the app.** The three copies drifted, and the app's notice module is already the single text home shared by the orchestrator and the worker. Rejected: placing product copy in `@prisma-bot/shared`, a vendor-neutral library with no other consumer.
- **D11 — `code` and `param` are the stable fields.** Message strings come from bug reports and may change. Both fields are carried because remedies are keyed on `param` and gated by `code`: the chat-with-tools rejection also carries `param: 'reasoning_effort'` with a null `code`, so the effort remedy must not fire on it, and the existing signature is evaluated first. Rejected: message-only regexes; treating `unsupported_parameter` as retryable.

## Interface changes

### New / changed exports (`@prisma-bot/provider-openai`)

- `resolveOpenAIContextWindow(model)`, `OPENAI_MAX_INPUT_TOKENS_DEFAULT` (128,000), `OPENAI_MAX_INPUT_TOKENS_GPT6` (922,000), `OPENAI_MAX_INPUT_TOKENS_CHAT_LATEST` (272,000).
- `resolveOpenAIDefaultMaxOutputTokens(model)`, `DEFAULT_MAX_OUTPUT_TOKENS` (4,096, now exported), `DEFAULT_MAX_OUTPUT_TOKENS_REASONING` (32,768).
- `resolveExplicitReasoningEffort(bag)`, `shouldStripSampling(model, explicitEffort)`, `SAMPLING_KEYS_STRIPPED`.
- `resolveOpenAITokenizerFamily(model)` — now a rule. `OPENAI_TOKENIZER_FAMILY_MAP` is **removed**.
- `OpenAIUsageTelemetry.cache_write_tokens`.
- `OPENAI_DEFAULT_MODEL` is `gpt-6-luna` (was `gpt-4o`); `OPENAI_CAPABILITIES` is derived from it (D9).
- `OpenAIHttpError.error.param` (`client.ts`); `mapOpenAIError` maps `unsupported_value` / `unsupported_parameter`, `insufficient_quota` and 5xx `Retry-After`.

### App (`apps/github-app`)

- `reasoningModelNoFindingsNotice(model)`, `capabilityRemedyNotice(message, meta?)` and `withCapabilityRemedy(notice, message, meta?)` with `CapabilityErrorMeta = { param?, code? }`.
- `OrchestratorDeps.providerLimits?: { maxTokensPerCall?: number; maxOutputTokens?: number }` (type `ProviderLimits`); `buildProvider` returns it alongside the provider.
- Job queue: a `rate_limit` error with `retryable: false` is `non_transient`.

### Shared (`@prisma-bot/shared`)

- `REASONING_MODEL_RE` gains `chat-latest$`.
- `ProviderErrorSchema`: `capability` gains optional `param` and `code`; `transport` gains optional `retry_after_ms`. Variants stay `.strict()`; additive only.
- `ProviderCapabilitiesSchema.max_context_tokens` — description only.

### New log event

- `pipeline.budget.output_cap_exceeds_window` (`warn`) — `{ window, reserved_output_requested, reserved_output_applied, hard_cap_in, absolute_cap_tokens }`.
- `provider.usage` gains `cache_write_tokens`; `provider.error` may carry `param`, `code` and `retry_after_ms`. See `docs/observability.md`.

### Unchanged

`Provider`, `ProviderReviewInput` / `ProviderReviewOutput`, `GenerationSchema`, `RepoConfigSchema`, `OPENAI_PASSTHROUGH_DENYLIST` (12 keys), `store: false`, the review prompt, the tool schema, and no new env vars. Classic-model chat request bodies are byte-identical to the pre-GPT-6 snapshot.

## Trade-offs

- **Anthropic batch planning is now bounded by `MAX_TOKENS_PER_PR`.** The orchestrator plans `effectiveBudget` no higher than the provider's own per-call limit. For Anthropic (200K window) batches are planned at up to 120,000 tokens instead of 172,904. Those larger batches were already rejected by the adapter guard and split, so this removes a wasted call; it is still a visible planning change.
- **A classic model under `MAX_TOKENS_PER_PR` above 123,904 rejects over-window batches up front.** The guard now caps at the model window less the request's output cap (128,000 − 4,096 = 123,904 for `gpt-4o` at the default cap), so such a batch fails with `over_budget` and is split, where it previously reached the API and failed with `context_length_exceeded`. At the default `MAX_TOKENS_PER_PR` (120,000) nothing changes.
- **Worst-case output spend is 8× higher on reasoning models when the env var is unset.** 32,768 versus 4,096 per call. It is a ceiling, not typical spend; `OPENAI_MAX_OUTPUT_TOKENS` restores any value.
- **Sampling-drop and denylist notes still have no outward channel.** The notes recorded by D4 reach no check-run summary, as with the original denylist keys (ADR-007 § Trade-offs).
- **Verbatim effort means a visible 400 instead of a silent fix.** A repo with `reasoning_effort: minimal` fails on GPT-6 with a remedy notice until the operator changes it.
- **gpt-5.x and o-series stay at 128,000.** Their input limits are not in the evidence base; this over-chunks if they are larger and never overflows.

## Consequences (now)

- All five IDs (`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6.1-sol`, `chat-latest`) route to `/responses` with `tool_choice: 'required'` and `max_output_tokens`, with family-correct window, tokenizer and default output cap.
- Vendor-neutral `generation` config no longer 400s on a switch to a reasoning model.
- Every GPT-6 parameter rejection becomes a `capability` error with a `param`-targeted remedy; quota exhaustion stops retrying.
- Deployments that set `OPENAI_MODEL` to a classic model are unaffected.
- Deployments that never set `OPENAI_MODEL` move from `gpt-4o` to `gpt-6-luna` on upgrade, with that model's endpoint, seed, output cap and window (D9); `OPENAI_MODEL=gpt-4o` opts out until 2027-01-14.

## Consequences (later)

- **A provider-note channel.** Forwarding ignored-field and dropped-sampling notes into `config_notes` needs a `Provider`-interface change and its own ADR; with it, D3 can be revisited (`minimal` to `low` with a visible note).
- **Per-request capabilities.** The window now varies by request model; a guard compensates. A third per-request capability would justify `Provider.capabilitiesFor(model)`.
- **Add gpt-5.x and o-series windows** to `resolveOpenAIContextWindow` once OpenAI publishes them.
- **Revisit `respond()` and `seed`** if `seed` on chat is confirmed rejected for GPT-6 (strip it for reasoning models on chat), or if `chat-latest` rejects `tool_choice: 'required'` on `/responses`.

## Testing

Acceptance scenarios from the spec (`docs/_planning/gpt6-compat/spec.md` § 5):

- **AS-1** — the five IDs route to `/responses` with `required`, `max_output_tokens: 32768`, `store: false`, no seed or chat token field (`provider.test.ts`).
- **AS-2** — `isReasoningModel` accepts the five IDs and rejects `chat-latest-2026`, `chat-latestx` (`model-slug.test.ts`).
- **AS-3** — `resolveOpenAIContextWindow`: 922,000 / 272,000 / 128,000 cases, including `gpt-60`.
- **AS-4** — the constructor derives `max_context_tokens` per model; explicit `capabilities` win.
- **AS-5** — `resolveOpenAITokenizerFamily` rule cases; the map is no longer exported.
- **AS-6** — sampling is stripped with an implicit effort on a reasoning model.
- **AS-7** — sampling is forwarded when the explicit effort is `none`; native spelling wins.
- **AS-8** — a classic model pinned to `/responses` keeps sampling.
- **AS-9** — a passthrough `temperature` is not stripped.
- **AS-10** — `respond()` strips sampling and keeps `seed` on reasoning models; classic unchanged.
- **AS-11** — the per-call guard is bounded by the request model's window.
- **AS-12** — the orchestrator caps `effectiveBudget` by `providerLimits` and reserves the provider output cap (`orchestrator.test.ts`).
- **AS-13** — default output caps: 32,768 reasoning, 4,096 classic; an explicit option wins.
- **AS-14** — error mapping for the verbatim API strings, `insufficient_quota`, and 503 `Retry-After` (`error-mapping.test.ts`, `transport.test.ts`).
- **AS-15** — the queue classifies a non-retryable `rate_limit` as `non_transient`.
- **AS-16** — remedy selection precedence, including the chat-with-tools trap and unknown `param` (`provider-notices.test.ts`).
- **AS-17** — the shared empty-review notice and its three call sites.
- **AS-18** — superseded by D9 as ratified: there is no default-model warning. Instead, `OPENAI_DEFAULT_MODEL` is `gpt-6-luna`, an unconfigured provider declares `deterministic_seed: false`, `max_context_tokens: 922000` and `tokenizer_family: 'o200k'` (equal to `OPENAI_CAPABILITIES`), and sends `/responses` with `tool_choice: 'required'`, `max_output_tokens: 32768` and no seed (`provider.test.ts`).
- **AS-19** — classic request bodies are byte-identical to the pre-GPT-6 snapshot.
- **AS-20** — an eval fixture for `openai/gpt-6-astra` empty reviews.
- **AS-21** — `cache_write_tokens` from either endpoint, omitted when absent.

## References

- [ADR-002](adr-002-provider-abstraction.md) § Decision — vendor primitive confined to `client.ts`.
- [ADR-005](adr-005-openai-provider.md) — capability constants this ADR amends.
- [ADR-006](adr-006-diff-chunking-stability.md) — window, `reserved_output` and `over_budget` handling this ADR amends.
- [ADR-007](adr-007-openai-responses-endpoint.md) — Responses routing, effort translation and the capability notice.
- `docs/model-compatibility.md` — the per-family, effort, sampling, window and remedy tables.
- OpenAI model pages: `developers.openai.com/api/docs/models/gpt-6-astra`, `.../gpt-6-sol`, `.../gpt-6-luna`, `.../gpt-6.1-sol`, `.../chat-latest`.
- OpenAI: `developers.openai.com/api/docs/guides/latest-model`, `.../guides/reasoning`, `.../guides/migrate-to-responses`, `.../deprecations`, `.../api-reference/responses/create`.
