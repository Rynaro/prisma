# ADR-009 — Anthropic Claude 5.x Model-Family Compatibility: Tool Choice, Strict Schema, Output Budget, Window, Tokenizer, Refusals, and Error Remedies

## Status

Proposed — 2026-10-16. Amends [ADR-006](adr-006-diff-chunking-stability.md) (the `anthropic-approx` margin becomes a per-model family, and the 200K window assumption becomes a per-model resolution) and [ADR-008](adr-008-gpt6-model-family-compatibility.md) (the remedy meta gains `provider`, `schema_validation` gains `code`, and Anthropic reaches parity with the OpenAI `provider.usage` event). Records the resolution of the model identifier in [OQ-1](../open-questions.md). Supersedes nothing. ADRs are immutable once accepted; superseding decisions require a new ADR that explicitly references this one.

Three decisions were ratified by the maintainer on 2026-10-16: D11 (default `claude-sonnet-5-5`), D9 (server-side fallbacks deferred) and D5 with D3 (16,384 default output cap for Claude 5.x, and no default `effort`). No ratification item is open. The live check that validates the request shape is user-run (see [model-compatibility.md § Anthropic](../model-compatibility.md#anthropic)).

## Context

Anthropic's Claude 5.x family (Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.1, and the 5.0 generation) changed the request contract that the Anthropic adapter was written against. The adapter's defaults were chosen for Claude 4-class models, and its default model ID (`claude-3-5-sonnet-latest`) had since been retired. What changed, per the research digest ([research-digest.md](../_planning/anthropic-5x-compat/research-digest.md), as of 2026-10-16):

- **The default model is gone.** `claude-3-5-sonnet-latest`, the adapter's default and the only model a deployment could reach, resolves to a retired 3.5 Sonnet snapshot. Every review 404s when the model is unset (GAP-2). A 404 was mapped to `transport, retryable: false`, which the job queue treats as transient. Nothing reached the pull request; the comment path replied with a generic error once per attempt. There was no `ANTHROPIC_MODEL` to fix it.
- **Forced tool choice is rejected.** `tool_choice: { type: 'tool', name }` returns HTTP 400 on Fable 5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5. On Haiku 5.5 it is accepted, but forced tool calls skip thinking, which reproduces the silent empty-review failure that ADR-008 D10 already documents for OpenAI.
- **Thinking is adaptive and counts toward the cap.** Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1 think by default. Thinking consumes `max_tokens`, so the 4,096 default truncates them systematically. A `thinking: { type: 'enabled', budget_tokens }` block is a 400 on every 5.x model.
- **Effort is a new knob with per-model defaults.** `output_config.effort` is generally available. The default is `medium` on Opus 5.5 and Haiku 5.5, and `high` on the other 5.x models.
- **Sampling is restricted.** `temperature`, `top_p` and `top_k` are removed on some 5.x models and limited to their defaults on Sonnet 5.5 and Haiku 5.5.
- **Refusals are a stop reason.** `stop_reason: 'refusal'` arrives with HTTP 200 and a `stop_details.category`. The adapter treated it as a missing tool call and raised `schema_validation`, which is the wrong kind and the wrong remedy.
- **Windows are 1M.** Every 4.6+ and 5.x model has a 1,000,000-token window. The adapter reported 200,000 for every model.
- **Tokenizers are denser.** Sonnet 5.5 and Haiku 5.5 count the same text as about 30% more tokens than Sonnet 4.6 and Haiku 4.5, and the Opus 4.7 tokenizer uses 1.0× to 1.35× the older count. The adapter's `chars/4 × 1.15` estimate can under-count on code-heavy diffs.
- **Usage is not reported.** The OpenAI adapter emitted `provider.usage`; the Anthropic adapter did not.
- **Strict tools exist.** `strict: true` on a tool definition guarantees schema-valid arguments, with JSON-Schema limits (no `minLength`, `maxLength`, `minimum`, `maximum` or `maxItems`; no `additionalProperties` other than `false`; no recursion).
- **Server-side fallbacks exist, as a beta.** `fallbacks` with a beta header routes declined requests to another model. It is not available on Bedrock, Vertex, Foundry or Batches, and Haiku 5.5 has none.

The design was worked through as FORGE decisions D1–D14 ([reasoning-report.md](../_planning/anthropic-5x-compat/reasoning-report.md)) and specified in [spec.md](../_planning/anthropic-5x-compat/spec.md). The OpenAI precedents are ADR-007 (Responses routing) and ADR-008 (GPT-6 compatibility, including the `code` and `param` error fields that this ADR reuses).

## Decision

Each decision is listed with its ratification status. "Accepted" means the decision follows from the evidence and was not put to the maintainer.

### D1 — Tool choice is a per-model rule, with an environment escape hatch (accepted)

`review()` uses `tool_choice: { type: 'auto', disable_parallel_tool_use: true }` on every model whose ID parses to a major version of 5 or higher, and on any model whose repo bag enables thinking. Those requests also get the strict tool (D2), an adapter-local nudge appended to `system`, and one retry when no `submit_review_findings` `tool_use` block comes back. Everything else keeps the forced `{ type: 'tool', name }` bytes it has always sent. The rule is a version rule on the shared parser, not a table. Unparseable names and aliases get the forced path. `ANTHROPIC_TOOL_CHOICE` takes `auto` (the default rule), `forced` or `unforced`; invalid values are ignored. `unforced` lets an alias in front of a 5.x model opt in.

### D2 — `strict: true` on the unforced path, with an allowlisted wire copy of the schema (accepted; strict acceptance of optional properties is assumed)

On the unforced path only, the tool's schema is copied through an allowlist (`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `description`). Every object node gets `additionalProperties: false`. Length, range and count hints are dropped from the wire copy, not from the shared schema. Zod stays authoritative and still enforces them. An allowlist means a keyword added later to the shared schema is dropped from the copy rather than turning each 5.x review into a 400. If Anthropic rejects strict acceptance of optional properties, the reversal is one line: drop `strict: true` and keep the rest of the bundle.

### D3 — No default `effort`; the operator's effort is forwarded (ratified, with D5)

Prisma sends no `effort` unless the repo sets one. Model defaults apply: `medium` on Opus 5.5 and Haiku 5.5, `high` elsewhere. A flat `provider_options.anthropic.effort` maps to `output_config.effort`; a native `output_config.effort` wins over it. Values are forwarded verbatim and not validated, so an unsupported value reaches the remedy in D10.

### D4 — `request_shaping` is honored, with a passthrough denylist (accepted)

`review()` honors `request_shaping.model`, and `generation.max_output_tokens` becomes `max_tokens`. `temperature`, `top_p` and `seed` are still never read. The `provider_options.anthropic` bag is forwarded verbatim except for a 10-key denylist (`model`, `messages`, `system`, `tools`, `tool_choice`, `stream`, `betas`, `mcp_servers`, `container`, `fallbacks`) and the nested `output_config.format`. Dropped keys produce key-only notes, which stay local. This closes the passthrough promise in `config-spec.md` that the Anthropic adapter did not keep (FINDING-004 in the scout report). `thinking` and sampling keys are not denylisted; they go out verbatim, and a resulting 400 gets a remedy.

### D5 — The default output cap is 16,384 for thinking models and 4,096 otherwise (ratified, with D3)

`ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS` stays 4,096 for Claude 4.x and older, and for unparseable aliases. For Claude 5.x, or when the repo bag enables thinking, the default is 16,384. The default is resolved per request from the request's model. `ANTHROPIC_MAX_OUTPUT_TOKENS` overrides it for every model. The precedence is the repo bag's `max_tokens`, then `generation.max_output_tokens`, then the env value, then the family default. 16,384 is the vendor's recommendation for non-streaming requests; streaming is not added.

### D6 — The context window is resolved per model (accepted)

`resolveAnthropicContextWindow(model)` returns 1,000,000 for Claude 5.x and for Claude 4.6 and newer, and 200,000 for everything else, including unknown IDs. The constructor derives `capabilities.max_context_tokens` from it, and an explicit `capabilities` option still wins. The per-request guard uses the window of the model that request uses and reserves the request's output cap: `min(MAX_TOKENS_PER_PR, window − output cap)`. Claude 4.5 and older are unaffected at the default `MAX_TOKENS_PER_PR`.

### D7 — The tokenizer family is per model; the 5.x margin is 1.55 (accepted; the margin is assumed)

A new `anthropic-approx-v2` family applies chars/4 times 1.55 to Claude 5.x and to Opus 4.7 and newer. `anthropic-approx` (chars/4 times 1.15) remains for legacy IDs. Unknown aliases get the v2 family, because over-counting is the safe direction. The 1.55 margin is the legacy 1.15 bound times the vendor's upper inflation bound of 1.35, and it rests on the unverified 1.15 legacy bound. A `messages.count_tokens` calibration pass is a follow-up. The shared BPE fallback would otherwise have silently used `cl100k` for these families, so the branch is explicit.

### D8 — A refusal is `schema_validation` with `code: 'refusal'`, and it is never retried (accepted)

`stop_reason: 'refusal'` is checked after usage telemetry and before truncation or any content is read. Partial content is discarded. The adapter throws `schema_validation` with `code: 'refusal'` and the message `anthropic declined the request: stop_reason refusal (category: <category | none>)`. The category is sanitized to `[a-z0-9_]{1,64}`. `stop_details.explanation` is never read into a message, log or notice. The variant stays `schema_validation`, which is a misnomer for a policy decline; the additive `code` makes it distinguishable, and the fail-safe behavior (no retry, not a configuration error) is what matters. The notices are described in [model-compatibility.md § Anthropic](../model-compatibility.md#anthropic).

### D9 — Server-side fallbacks are deferred (ratified)

Nothing ships: there is no `fallbacks` field and no beta header, and `fallbacks` and `betas` are denylisted. The opt-in shape is recorded for later (see Consequences). The vendor default is to turn fallbacks on for the supported models. Deferring departs from that default on purpose: fallback attempts bill at the fallback model's rate, and the adapter would otherwise change which model serves a request without an operator decision.

### D10 — Error mapping by stable fields, and Anthropic-specific remedies (accepted)

The mapper classifies by status and error type, not by message wording. A 404 is `capability` with `code: 'not_found_error'`. A 400 whose error type is `invalid_request_error` is `capability` with `code: 'invalid_request_error'`, whatever the wording. Any other 400 is `transport, retryable: false`. A 5xx, including 529, is `transport, retryable: true` and carries `retry_after_ms` when `Retry-After` is present. The keyword heuristic is removed. `capabilityRemedyNotice` takes a `provider` in its meta; `anthropic` routes to a separate remedy table with first-match-wins rules: retired model (404), forced tool choice, `thinking.type`, effort, sampling parameters, and prompt too long. Every Anthropic remedy starts with `Remedy:`. The OpenAI branch is byte-identical, and the Anthropic table is selected by provider name, never by message content alone.

### D11 — The default model is `claude-sonnet-5-5`, and `ANTHROPIC_MODEL` configures it (ratified)

`ANTHROPIC_DEFAULT_MODEL` is `claude-sonnet-5-5`. It is the vendor-named replacement for the Sonnet 3.x line, priced at half of Opus 5.5, and it defaults to `high` effort. `ANTHROPIC_MODEL` is read through the same secret source as `OPENAI_MODEL`. A repo `model: anthropic/<id>` still overrides it per request. The change flips the default in the release that makes the 5.x family correct end to end. The vendor's retirement of the old default makes the flip mandatory; only the target is a choice.

### D12 — A Claude-specific empty-review notice (accepted)

The shared empty-review notice dispatches on the model family. For `isClaudeAdaptiveThinkingModel` models it gives adaptive-thinking advice that points at `provider.usage` (`output_tokens` in the low tens means no thinking), `ANTHROPIC_TOOL_CHOICE=forced` and `provider_options.anthropic.effort`. The OpenAI text stays byte-identical, because eval fixtures assert its substrings. The gate that decides whether to show the notice now uses `thinksBeforeAnswering(model)`, which is true for reasoning models and for Claude 5.x. It reads the repo's configured model only, so a repo on the deployment default or on an alias gets no Claude notice (OQ-5).

### D13 — Usage telemetry for Anthropic, once per API call (accepted)

`review()` emits `provider.usage` with `provider: 'anthropic'`, `endpoint: 'messages'`, the model sent, and the counts the response reported: `input_tokens` (the total prompt, including cache reads and writes), `output_tokens` (including thinking), `cached_input_tokens` and `cache_write_tokens`. A field is present only when its source is a number. The event is emitted before refusal and truncation checks, so a retry reports twice. `respond()` does not report usage, and there is no `reasoning_tokens` field.

### D14 — Scope cuts (accepted)

Out of scope: streaming, an SDK version bump, server-side fallbacks, prompt caching, structured outputs (`output_config.format`), sampling forwarding, an effort environment variable, per-request capabilities, and any change to `classifyRetry`. The `classifyRetry` treatment of transport errors is a known gap, recorded under Consequences.

## Rationale

- **D1 is a version rule, not a table.** Thinking-by-default starts at major 5 and survives new minors and codenames; a table goes stale on every release. The asymmetry decides the default for an unknown future model: `auto` on a model that would have accepted forced choice costs at most one retry, while forced choice on a model that rejects it is a guaranteed 400. Rejected: `auto` for every Claude model (changes the wire bytes of every 4.x deployment and drops a call guarantee that works there); `auto` only for the four models that reject forced choice (leaves Haiku 5.5 on the forced path, where thinking is skipped).
- **D2 strips at the wire copy, not the shared schema.** The OpenAI and Copilot bytes, the shared prompt and the Zod contract must not change. Rejected: sending the schema unchanged (the 5.x strict contract would not be honored); stripping the shared schema (changes every provider's bytes); `strict` on every Claude request (changes 4.x behavior with no measured benefit).
- **D3 uses model defaults.** The vendor sets the defaults per model and says to set `effort` explicitly because levels are recalibrated between generations. Prisma does not keep a family table that goes stale. Rejected: an explicit per-family default table; an `ANTHROPIC_EFFORT` environment variable (a second knob for a value the repo can already set). The ratification records the cost risk: Sonnet 5.5 and Fable 5.1 run at `high`, and their cost and truncation behavior is unmeasured.
- **D5 uses 16,384 for thinking models.** At 4,096, a thinking model is truncated before its findings. The 4× worst-case output spend is a product cost call, and it was ratified as one. Rejected: keeping 4,096 (broken by default); 32,768 (ADR-008's OpenAI number, which is above the non-streaming threshold of newer SDKs).
- **D6 follows the vendor's window.** A static 1M for every Claude ID would make Claude 4.5 and older look larger than they are. The resolver keeps the 200K answer for them.
- **D7 uses a separate family, not a higher global margin.** Raising `SAFETY_MARGIN` to 1.55 would over-count every legacy Anthropic model and every other caller of the shared estimator. The family rule keeps the legacy bytes. Rejected: a new margin with no family (over-chunks legacy models); keeping 1.15 and relying on the 1M window (the window does not bound the batch planner's budget, `MAX_TOKENS_PER_PR` does).
- **D8 reuses `schema_validation`.** Adding a `refusal` variant to the closed `ProviderError` union would be a schema change across every adapter; an additive `code` is the ADR-008 D11 pattern. Rejected: `capability` with `code: 'refusal'` (a policy decline is not a configuration error and would be read as one); a new `refusal` kind (a wider change for one consumer).
- **D9 defers fallbacks.** Routing a declined request to another model is a product decision about cost and data handling, and it changes which model the operator billed. The opt-in shape is designed, so the deferral costs one more release at most.
- **D10 classifies by stable fields.** Message wording changes; `type` and status do not. Rejected: keeping the keyword heuristic (it misclassifies unrecognized 400s); treating every 400 as retryable (a 400 does not clear on retry).
- **D11 chooses Sonnet over Opus.** The vendor's named replacement for Sonnet 3.x is `claude-sonnet-5-5`, which matches the precedent of ADR-008 D9 (the named replacement for a retired default). Opus 5.5 is the vendor's default for new code and is available by a one-line override.
- **D12 keeps the OpenAI text.** Eval fixtures assert its substrings, and a reasoning-model notice for a Claude model would point at `reasoning_tokens`, which Anthropic does not report.
- **D13 reports only what the response carries.** No zero-filling: a zero would be read as measured usage.

### The three ratifications

- **D11** (`claude-sonnet-5-5`): ratified 2026-10-16.
- **D9** (defer fallbacks): ratified 2026-10-16.
- **D5 and D3** (16,384 cap for Claude 5.x; no default `effort`): ratified 2026-10-16.

### Implementation choices R1–R8

The spec records eight implementation choices that were made inside the FORGE delegation. They are reproduced here so a reviewer can check them:

- **R1.** `ANTHROPIC_TOOL_CHOICE` takes `auto | forced | unforced`, with `auto` meaning "use the rule", the same meaning as `OPENAI_TOOL_CHOICE=auto`. The D10 forced-tool remedy therefore names `unforced`.
- **R2.** The refusal notice says "the bot's `review` command" rather than `@<bot> review`, because no bot handle reaches the orchestrator.
- **R3.** Files in a declined chunked batch get their own note. The "Not reviewed" note names `max_provider_calls_per_pr` and would misdiagnose a refusal.
- **R4.** The strict schema copy forces `additionalProperties: false` on every object node.
- **R5.** The smoke script reports `EMPTY` (non-zero exit) when a model returns zero findings on the seeded bug.
- **R6.** The refusal category is sanitized to `[a-z0-9_]{1,64}`; anything else becomes `none`.
- **R7.** `worker.provider.selected` carries `model` for Anthropic.
- **R8.** Every Anthropic remedy text starts with `Remedy:`, like the existing ones.

## Interface changes

### `@prisma-bot/shared`

- `parseClaudeModelId(model)` and `ClaudeModelId`; `isClaudeAdaptiveThinkingModel(model)` (true for major ≥ 5). `REASONING_MODEL_RE` is not extended for Claude.
- `TokenizerFamily` gains `'anthropic-approx-v2'`; `SAFETY_MARGIN_ANTHROPIC_V2` (1.55). `SAFETY_MARGIN` is unchanged (1.15).
- `ProviderErrorSchema`: the `schema_validation` variant gains an optional `code` (a vendor-neutral sub-classification; `refusal` is the first value). The variant stays `.strict()`.

### `@prisma-bot/provider-anthropic`

- Resolvers: `resolveAnthropicContextWindow`, `resolveAnthropicTokenizerFamily`, `resolveAnthropicToolChoiceMode`, `resolveAnthropicDefaultMaxOutputTokens`, `providerOptionsEnableThinking`.
- Constants: `ANTHROPIC_DEFAULT_MODEL` (`claude-sonnet-5-5`), `ANTHROPIC_CONTEXT_WINDOW_DEFAULT` (200,000), `ANTHROPIC_CONTEXT_WINDOW_LONG` (1,000,000), `ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS` (4,096), `ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS_THINKING` (16,384), `ANTHROPIC_TOOL_NUDGE`, `ANTHROPIC_PASSTHROUGH_DENYLIST`, `ANTHROPIC_OUTPUT_CONFIG_DENYLIST`, `ANTHROPIC_STRICT_SCHEMA_KEYWORDS`.
- Helpers: `applyAnthropicProviderOptions`, `toAnthropicStrictSchema`, `extractAnthropicUsage`; types `AnthropicToolChoiceStyle`, `AnthropicToolChoiceMode`, `AnthropicUsageTelemetry`.
- Options: `AnthropicProviderOptions.toolChoiceStyle` and `AnthropicProviderOptions.onUsage`. `maxOutputTokens` is now the explicit value only; the family default is resolved per request.

### `apps/github-app`

- Notice helpers: `isRefusalError`, `refusalCategoryFromMessage`, `refusalNotice`, `declinedFilesNote`, and `reasoningModelNoFindingsNotice` (now family-aware).
- `CapabilityErrorMeta.provider`; `capabilityRemedyNotice` routes `anthropic` to its own table.
- Log fields: `provider.usage` for Anthropic (`endpoint: 'messages'`); `worker.provider.selected` carries `model`; `provider.error` and `provider.batch.error` carry `code` on `schema_validation`.

### Environment

- `ANTHROPIC_MODEL`: new. Unset means `claude-sonnet-5-5`.
- `ANTHROPIC_MAX_OUTPUT_TOKENS`: the default now depends on the model (4,096 or 16,384). Non-positive and non-numeric values are ignored.
- `ANTHROPIC_TOOL_CHOICE`: new. `auto` (default) | `forced` | `unforced`. Invalid values are ignored.

## Trade-offs

- **An extra call when the unforced path misses.** A `submit_review_findings` call that does not come back is retried once with the same arguments. The cost is one more billed request for that batch.
- **Strict loses length hints.** Zod still enforces them after the response; the model is told fewer bounds. The highlights cap is enforced by the validator.
- **The 1.55 margin is about 26% less diff per call.** The batch planner gets a smaller budget for Claude 5.x than the legacy margin would give. This is the safe direction, and OQ-6 tracks the calibration.
- **The output ceiling for thinking models is 4×.** 16,384 versus 4,096 per call, for worst-case spend. It is a ceiling, not typical spend; `ANTHROPIC_MAX_OUTPUT_TOKENS` restores any value.
- **`schema_validation` is a misnomer for a refusal.** Accepted for the fail-safe behavior, and the `code` field disambiguates it.
- **The empty-review gate reads the repo's configured model.** A repo on the deployment default gets no Claude notice (OQ-5).
- **Provider notes are still unsurfaced.** Dropped `provider_options` keys are recorded as key-only notes in the adapter and reach no check run, as with the OpenAI notes (ADR-007 § Trade-offs).
- **Planning and adapter output reservations can differ for Claude 4.x with a thinking bag.** The worker derives the orchestrator's output reservation from the model alone (`resolveAnthropicDefaultMaxOutputTokens(model)`, with no bag). A 4.x model with `thinking` in the repo bag therefore sends 16,384 while the planner reserves 4,096. The adapter's guard uses the cap it sends, so an over-budget batch degrades to a split rather than failing silently, but the planner's reservation is short by 12,288 tokens for that configuration.

## Consequences (now)

- A retired or misspelled model publishes a "Review unavailable" summary with the 404 remedy, so the failure is visible where it happens (GAP-2 closed).
- Every Claude 5.x review uses the unforced path, with strict tools and the presence check.
- Thinking models get 16,384 output tokens by default, and an `output_truncated` is logged with the requested cap.
- A refusal is reported with its category and never retried. The check run states that it is not a configuration error.
- Operators on an alias in front of a 5.x model use `ANTHROPIC_TOOL_CHOICE=unforced` and `ANTHROPIC_MAX_OUTPUT_TOKENS=16384`.
- Deployments that never set `ANTHROPIC_MODEL` move from the retired default (every review 404s) to `claude-sonnet-5-5` on upgrade. Deployments that pinned a 4.x model in the repo keep 4.x behavior, including forced tool choice and the 4,096 cap.
- `respond()` (the `@bot ask` flow) keeps the chars/4 guard, which has no margin. On a 5.x model that guard can under-count by up to about 30%. The spec kept this unchanged on purpose; it is a known gap.

## Consequences (later)

- **Server-side fallbacks.** The opt-in shape, when it lands: `ANTHROPIC_FALLBACKS=default`, set by deployment env only (never repo config, because it changes the billed model); beta header `server-side-fallback-2026-07-01` with `fallbacks: "default"`; supported models only (Opus 5 and 5.5, Fable 5.1, Sonnet 5.5); and a summary note that names the model that actually served the request. Haiku 5.5 has no server-side fallback.
- **`count_tokens` calibration.** Replace the margin derivation with a `messages.count_tokens` pass over representative diffs (OQ-6), and revisit the 1.55 value from that data.
- **Re-check on any SDK bump.** The pinned SDK (0.32.1) forwards the body untyped and has no non-streaming size guard. A newer SDK rejects non-streaming requests above roughly 21K `max_tokens`; the 16,384 default is chosen to stay under that. Re-check the threshold on every bump, and add streaming before the cap goes higher.
- **The `classifyRetry` treatment of transport errors.** A 404 now maps to `capability` and is non-transient. But a transport error with `retryable: false` (any 400 that is not `invalid_request_error`) is still classified as transient by `classifyRetry`, which ignores `retryable` for transport. Fixing that is a queue change and belongs in its own ADR.
- **Live validation.** The live smoke run (see [model-compatibility.md § Anthropic](../model-compatibility.md#anthropic)) validates D1, D2, D5, D10 and D13. A 400 naming `strict` or the schema triggers the D2 one-line revert.
- **Unforced-path miss rate.** Watch how often the retry fires in production: `provider.usage` is emitted once per API call, so a batch that retried shows two events. If the retry fires often, the nudge or the model choice needs a look.

## Testing

The acceptance scenarios are AS-1 to AS-29 in [spec § 5](../_planning/anthropic-5x-compat/spec.md). The test files follow the declared scope in spec § 8. The AS labels are not embedded in the test names, so the mapping below is by scenario and file.

- **AS-1** model-ID parser: `packages/shared/tests/model-slug.test.ts`.
- **AS-2** tool-choice mode (style, rule, bag): `packages/providers/anthropic/tests/provider.test.ts`.
- **AS-3** default output cap per model and bag: `provider.test.ts`.
- **AS-4** window and tokenizer resolvers: `provider.test.ts`.
- **AS-5** constructor capabilities; an explicit `capabilities` option wins: `provider.test.ts`.
- **AS-6** the pre-5 forced path is byte-identical to the pre-change request: `provider.test.ts`.
- **AS-7** unforced bundle on the wire (key order, `strict`, nudge, `disable_parallel_tool_use`): `provider.test.ts`.
- **AS-8** strict schema copy (allowlist, `additionalProperties: false`, input not mutated): `packages/providers/anthropic/tests/prompt.test.ts`.
- **AS-9** OpenAI, Copilot and shared-schema bytes unchanged: the existing OpenAI and Copilot suites and `packages/shared/tests/review-prompt.test.ts`, with no edits.
- **AS-10** missing tool call: one retry on the unforced path; a second miss throws the named message; the forced path never retries: `provider.test.ts`.
- **AS-11** refusal in the adapter (no retry, category sanitized, explanation not read): `provider.test.ts`.
- **AS-12** output-cap precedence and the truncation message: `provider.test.ts`.
- **AS-13** `request_shaping.model` override, including its window and tokenizer: `provider.test.ts`.
- **AS-14** `temperature`, `top_p` and `seed` are never sent: `provider.test.ts`.
- **AS-15** passthrough bag: denylist notes, `output_config.format`, flat-`effort` mapping, native-wins: `provider.test.ts`.
- **AS-16** per-request guard uses the request model's window and family: `provider.test.ts`.
- **AS-17** estimator v2 branch and the family rule: `packages/shared/tests/tokens/estimator.test.ts`.
- **AS-18** error mapping by status and type; 5xx `retry_after_ms`; keyword heuristic gone: `packages/providers/anthropic/tests/error-mapping.test.ts`.
- **AS-19** Anthropic remedy selection, first match wins, OpenAI branch unchanged: `apps/github-app/tests/provider-notices.test.ts`.
- **AS-20** remedy wiring at both call sites: `apps/github-app/tests/pipeline/orchestrator.test.ts`. The worker's ask reply is verified by review (AS-26).
- **AS-21** refusal notices on the single-call and chunked paths, including the declined-files note: `provider-notices.test.ts` and `orchestrator.test.ts`.
- **AS-22** Claude empty-review notice and its gate on the single-call and batch paths: `provider-notices.test.ts`, `orchestrator.test.ts`, and the eval fixture `evals/fixtures/thinking-model-empty-review-claude.yaml`.
- **AS-23** usage telemetry: totals include cache counts; absent numbers are omitted; the event is emitted before the refusal check: `provider.test.ts`.
- **AS-24** schema additions (`schema_validation.code`, `anthropic-approx-v2`): `packages/shared/tests/schemas.test.ts`.
- **AS-25** default model flip, and the test edits it required: `provider.test.ts`.
- **AS-26** worker wiring: verified by code review against spec § 3.16 and by the typecheck. Not unit-tested, like the rest of `buildProvider`.
- **AS-27** eval fixtures: `evals/fixtures/thinking-model-empty-review-claude.yaml`, `evals/fixtures/refusal-declined-review.yaml` and `evals/scenarios.yaml`, with the runner's `code` passthrough.
- **AS-28** smoke script, offline checks: `--help` prints usage and exits 0 without a key; a run without `ANTHROPIC_API_KEY` exits 2 before any client is built; the file contains no SDK import (the vendor-isolation check). Not part of `pnpm test`.
- **AS-29** smoke script, live run: user-run before release. It is never part of CI. See [model-compatibility.md § Anthropic](../model-compatibility.md#anthropic).

## References

- [ADR-002](adr-002-provider-abstraction.md) § Decision: the vendor primitive is confined to the adapter package.
- [ADR-006](adr-006-diff-chunking-stability.md): the window, the margin and the `reserved_output` coupling this ADR amends.
- [ADR-007](adr-007-openai-responses-endpoint.md): the Responses routing and the capability-notice precedent.
- [ADR-008](adr-008-gpt6-model-family-compatibility.md): the `param` and `code` error fields, the `provider.usage` precedent and the default-model flip precedent.
- [model-compatibility.md § Anthropic](../model-compatibility.md#anthropic): the model table, the remedies, the notice texts and the live smoke check.
- Planning trail (not shipped with the product): [research-digest.md](../_planning/anthropic-5x-compat/research-digest.md) (vendor facts, as of 2026-10-16), [scout-report.md](../_planning/anthropic-5x-compat/scout-report.md) (code findings), [reasoning-report.md](../_planning/anthropic-5x-compat/reasoning-report.md) (D1–D14 and the ratifications), [spec.md](../_planning/anthropic-5x-compat/spec.md) (acceptance scenarios, implementation order and open questions OQ-1 to OQ-7).
- Anthropic: the Claude API model catalog, the model-migration guide and the Messages API reference, as bundled in the research digest §§ 1–13.
