# ADR-007 — OpenAI Responses Endpoint: Selection, State Policy, Reasoning Translation, and Seed Capability

## Status

Proposed — 2026-09-07. Supersedes the `deterministic_seed: true` capability declaration recorded in [ADR-005 § Rationale](adr-005-openai-provider.md); every other decision in ADR-005 stands. ADRs are immutable once accepted; superseding decisions require a new ADR that explicitly references this one.

## Context

ADR-005 targeted one endpoint: `createOpenAIClient` built exactly `${baseUrl}/chat/completions`, and `review()` had nowhere else to send a request. From the GPT-5.4 generation onward OpenAI rejects **function tools combined with reasoning on `/v1/chat/completions`**, in the API's own words:

```
Function tools with reasoning_effort are not supported for gpt-5.6-luna in
/v1/chat/completions. To use function tools, use /v1/responses or set
reasoning_effort to 'none'.
```

The review flow always carries the single `submit_review_findings` function tool, so every affected model is unusable for reviews. The rejection fires on the model's default effort, so it needs no explicit configuration to trigger. `mapOpenAIError` classifies it as `capability` and the check run degrades gracefully, but the only in-product remedies were `reasoning_effort: 'none'` — which clears the 400 and then returns out-of-vocabulary `severity` values that fail `ProviderReviewOutputSchema`, dropping the review silently — or rolling back to a classic model.

Adding `/responses` is not a rename of `/chat/completions`. It is a second request contract that rejects unknown top-level parameters with HTTP 400, and it differs from the chat contract in four ways this adapter must decide about, beyond the message/tool/token-cap spellings that are mechanical:

1. **Endpoint selection.** Which models must be routed, given that the rejection depends on the effective reasoning effort and the effort is not always visible to the adapter.
2. **State and retention.** `/responses` can attach a call to server-side state (`previous_response_id`, `conversation`) and can retain the response (`store`). Diff hunks and context files are customer source.
3. **Reasoning effort.** Spelled `reasoning_effort` on chat and `reasoning: { effort }` on Responses, with both spellings reachable through the `provider_options.openai` escape hatch.
4. **Seed.** `/chat/completions` accepts an integer `seed`; `/responses` has no such field. ADR-005 made `deterministic_seed: true` the OpenAI adapter's differentiator against Anthropic and Copilot.

Context: issue #40 (acceptance criteria in Gherkin), PR #41, and the review of commit `46e2fd8`, which found that an endpoint change alone left the incident configuration producing an invalid request.

## Decision

### D1 — `auto` selects the endpoint with the shared reasoning-family predicate

`resolveApiStyle(model, override)` returns `'responses'` when `isReasoningModel(model)` and `'chat'` otherwise. `OPENAI_API_STYLE` overrides it: `chat` pins the pre-Responses behavior, `responses` routes every model, invalid values fall back to `auto`.

`isReasoningModel` is the existing single source of truth in `@prisma-bot/shared`, already used by `resolveTokenParam`, `resolveToolChoice`, and the orchestrator's `no_findings` hint. This adapter adds no fourth classification of its own.

### D2 — the review is one stateless call, enforced in two places

`store` is always the literal `false`. `previous_response_id` and `conversation` can never reach the transport. Both are enforced twice: the passthrough denylist drops them out of `provider_options.openai` with a key-only ignored-field note, and `toResponsesArgs` strips them unconditionally from the request it builds. `input`, `instructions` and `store` join the denylist as the Responses spellings of already-protected fields.

### D3 — reasoning effort is translated, with the native spelling winning field by field

On the Responses path, `reasoning_effort` becomes `reasoning: { effort }`, and no top-level `reasoning_effort` is sent. When a native `reasoning` object is also supplied, the native object wins field by field: the legacy scalar fills `effort` only when the native object does not set it. A native `reasoning` that is not a plain object is forwarded verbatim and the legacy key is dropped. Chat requests keep the flat `reasoning_effort` spelling unchanged.

### D4 — `deterministic_seed` is a property of the endpoint, not of the vendor

No `seed` is sent to `/responses`, in either the normalized (`request_shaping.deterministic_seed`) or raw passthrough spelling, and a key-only note records the drop. `OpenAIProvider` derives `capabilities.deterministic_seed` as `resolveApiStyle(deploymentModel, apiStyle) === 'chat'`; an explicit `capabilities` bag from the caller still wins, mirroring the `tokenizer_family` precedent. Chat-routed deployments keep `deterministic_seed: true` and keep sending the seed.

### D5 — one effective output cap is resolved before serialization

Precedence on the Responses path, honoring the documented `provider_options > generation > deployment default` rule:

1. `provider_options.openai.max_output_tokens` — the native Responses spelling.
2. `max_completion_tokens`, then `max_tokens` — the chat spellings, which already carry whichever of provider_options / generation / deployment default won on the chat path.

Neither chat token field reaches `/responses`. A non-numeric native override is ignored with a note in favor of the resolved chat value.

### D6 — per-call token telemetry, additive to the adapter only

`OpenAIProviderOptions.onUsage` receives a normalized `OpenAIUsageTelemetry` record (`endpoint`, `model`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `reasoning_tokens`) after every `review()` call, before truncation detection. The worker wires it to the process logger as the `provider.usage` event. Counts only; no prompt or response content.

### D7 — the capability notice names the remedy

When a `capability` error's message identifies a function-tool rejection on `/chat/completions`, the check-run summary and the comment reply append a remedy naming `OPENAI_API_STYLE` in both directions, and explicitly warn against `reasoning_effort: 'none'`. Every other capability failure gets the generic notice unchanged.

## Rationale

- **D1 — the predicate, not a family regex.** The rejection is a function of both the model family and the effective reasoning effort, and the effort can arrive as `provider_options.openai.reasoning_effort`, as a native `reasoning` object, or as the model's own default when neither is set. An adapter that routes on the family alone cannot see the configuration that determines whether the request is legal. Routing on `isReasoningModel` covers `gpt-5.5` with `reasoning_effort: high` — the configuration in the incident report — and it is the selector the issue proposed. Measurements showing `gpt-5.5` passing on `/chat/completions` were taken in the default configuration only and do not validate the `high` case. Deployments behind a gateway that does not expose `/responses` pin `OPENAI_API_STYLE=chat`; that escape hatch is why the broader default is safe.
- **D2 — `store: false` is not the whole boundary.** `store` governs whether *this* response is retained. It does not govern whether prior state is *read*: a valid, accessible `previous_response_id` brings turns Prisma never rendered into the review, and `conversation` attaches the call to an object with its own persistence semantics. A review is one call with one rendered prompt (issue #40 § Out of scope). Enforcing in both the denylist and the mapping means neither layer is load-bearing alone.
- **D3 — native wins, because it names the endpoint.** An operator who writes `reasoning: { effort: 'xhigh' }` addressed this endpoint's own contract; an operator who writes `reasoning_effort` wrote the chat spelling of the same intent. Merging field-by-field rather than replacing wholesale keeps a `reasoning` object that carries only `summary` from silently discarding the effort the operator also set.
- **D4 — capability honesty is a project rule.** `contributing.md` § "Declare capabilities honestly" and ADR-004's precedent require the flag to say what the vendor actually supports. Since the same adapter now speaks two contracts and only one of them has a seed, the flag has to follow the endpoint or it becomes a false promise. Deriving it from the deployment model plus `apiStyle` is the honest approximation available at construction time; a per-request `request_shaping.model` that routes one call differently is covered by the note.
- **D5 — the precedence was documented but not implemented.** The previous mapping spread the passthrough bag and then assigned the chat-derived cap over it, so `provider_options.openai.max_output_tokens: 32000` was copied and then overwritten with 4096, inverting the documented order and causing avoidable truncation. Resolving one value before building the body makes the order explicit and testable.
- **D6 — additive, per issue #40 § Out of scope.** The `Provider` interface and `ProviderReviewOutput` are unchanged. A constructor-time sink is the only seam that adds telemetry without a cross-package contract change. `reasoning_tokens` is the field that answers the operating question a Responses-routed reasoning model raises: whether a large cap was consumed by reasoning or by findings.
- **D7 — the generic notice was actionable for the wrong failure.** "The configured model is unavailable to your API key" points at the model when the fix is the endpoint. The remedy is appended only on a matched signature so unrelated capability failures are unaffected.

## Interface changes

### New / changed exports (`@prisma-bot/provider-openai`)

- `ApiStyle`, `resolveApiStyle(model, override)` — endpoint selection.
- `toResponsesArgs(args)` — now returns `{ args, notes }` rather than bare args.
- `RESPONSES_STATE_LINKING_KEYS` — the state fields stripped unconditionally.
- `OpenAIUsageTelemetry`, `extractUsage(response, endpoint, model)`, `OpenAIProviderOptions.onUsage`.
- `OPENAI_PASSTHROUGH_DENYLIST` grows from 7 to 12 keys.
- `OpenAIClientLike.responses?` — optional, so an injected client predating Responses support keeps the chat path.
- `OpenAIResponsesArgs.reasoning` (`client.ts`).

### New env var

- `OPENAI_API_STYLE` = `auto` (default) | `chat` | `responses`.

### New log event

- `provider.usage` — `{ provider, endpoint, model, input_tokens?, output_tokens?, cached_input_tokens?, reasoning_tokens? }`. Counts only.

### Unchanged

`Provider`, `ProviderReviewInput` / `ProviderReviewOutput`, `RepoConfigSchema`, `packages/core`, the review prompt, the tool schema, and the eval harness. Classic-model chat requests are byte-identical to v0.14.0.

## Trade-offs

- **`auto` now moves models that work today.** The o-series and gpt-5/gpt-5.4/gpt-5.5 move from `/chat/completions` to `/responses`. OpenAI's guidance is that reasoning models belong on Responses, and the endpoint accepts the same prompt, tool and `tool_choice`, but this is a behavior change for deployments that were not failing. `OPENAI_API_STYLE=chat` restores the old routing in one env var.
- **Seed determinism is lost for Responses-routed models.** A deployment that sets `generation.seed` on a reasoning model loses the seed. The alternative — pinning it to chat — is not a remedy, because chat is where its tool/reasoning combination is rejected. The capability flag and the note make the loss visible instead of silent.
- **Telemetry is process-scoped, not job-scoped.** `onUsage` is a constructor-time sink, so `provider.usage` carries no PR/job trace fields. Correlating a usage record with a specific review means reading the surrounding log stream. Job-scoped telemetry needs a `Provider`-interface change.
- **Ignored-field notes are produced but not yet surfaced.** `applyProviderOptions` returns `droppedNotes` and `toResponsesArgs` returns `notes`, and both are unit-tested, but `review()` has no channel to the check-run summary's `config_notes` because `ProviderReviewOutput` is `.strict()` and carries no notes field. This gap predates this ADR and applies equally to the seven original denylist keys.

## Rejected alternatives

- **Route only `gpt-5.6*` and later majors.** Narrower and lower-risk, but it leaves `gpt-5.5` with `reasoning_effort: high` on the endpoint that rejects it — the reported configuration. Rejected as an incomplete fix for the incident it claims to close.
- **Forward `reasoning_effort` unchanged and let the API decide.** Trades a 400 on one endpoint for a 400 on the other. Rejected.
- **Recommend `reasoning_effort: 'none'`.** Clears the rejection and then produces out-of-vocabulary `severity` values that fail `ProviderReviewOutputSchema`, so reviews are dropped without a visible error. OpenAI's own model guide also states the next family does not support `none`. Rejected as a remedy; documented as a trap.
- **Keep `deterministic_seed: true` and drop the seed quietly.** Cheapest, and dishonest: the capability bag is a contract other components read. Rejected.
- **Throw a `capability` error when a seed is set on a Responses-routed model.** Honest, and it turns a determinism preference into a total review failure for a configuration that is otherwise fine. Rejected as disproportionate.
- **A second regex for "Responses-only tool support".** A third model classification to keep in sync with `isReasoningModel`. Rejected in favor of the shared predicate.
- **Add `usage` to `ProviderReviewOutput`.** The natural home for telemetry, and it changes a cross-package schema that issue #40 puts out of scope, for all four adapters at once. Rejected for this change; see Consequences (later).
- **Route `respond()` to `/responses` as well.** `respond()` sends no tools and takes no such rejection. Left on `/chat/completions`; issue #40 accepts either.

## Consequences (now)

- Reasoning-family models produce reviews again, including the incident configuration `model: openai/gpt-5.6-luna` with `provider_options.openai.reasoning_effort: high`.
- Classic-model deployments are unaffected: same endpoint, same body, same capability flags.
- Reasoning-model deployments that set `generation.seed` lose determinism and see `deterministic_seed: false`.
- Operators get a `provider.usage` log line per review call and an endpoint-specific remedy in the check-run summary for this rejection.

## Consequences (later)

- **A provider-note channel.** When one exists, `review()` should forward `applyProviderOptions().droppedNotes` and `toResponsesArgs().notes` into `config_notes` so ignored-field and dropped-seed notes reach the check-run summary. That requires a `Provider`-interface or `ProviderReviewOutput` change and belongs in its own ADR.
- **Job-scoped usage telemetry.** The same interface change would let `provider.usage` carry the PR/job trace fields and let the orchestrator record usage per batch on the chunked path.
- **`capabilities` as a per-request question.** `deterministic_seed` is the first capability that varies with the resolved endpoint rather than the vendor. If a second appears, `ProviderCapabilities` may need to become a function of the request rather than a constructor-time bag.
- **A future family that rejects tools on Responses too** would need a third routing arm; the `OPENAI_API_STYLE` override is the interim escape hatch in both directions.

## Testing

- `packages/providers/openai/tests/provider.test.ts` — endpoint selection (reasoning families, named gpt-5.6 variants, classic preservation, both overrides), reasoning translation and precedence, the one-shot boundary, seed handling and the capability declaration, output-cap precedence, and usage normalization.
- `packages/providers/openai/tests/transport.test.ts` — the production `createOpenAIClient` against a mocked HTTP boundary: URL, serialized body, missing/malformed function calls, truncation, and the existing 400 → `capability` mapping.
- `apps/github-app/tests/provider-notices.test.ts` and `apps/github-app/tests/pipeline/orchestrator.test.ts` — the remedy notice, and its absence on unrelated capability failures.

## References

- Issue #40 (acceptance criteria), PR #41, review of commit `46e2fd8`.
- [ADR-002](adr-002-provider-abstraction.md) § Decision — vendor primitive confined to `client.ts`.
- [ADR-005](adr-005-openai-provider.md) § Rationale — the `deterministic_seed: true` declaration this ADR narrows.
- [ADR-006](adr-006-diff-chunking-stability.md) § Interface changes — `output_truncated` and the output-budget knobs.
- `docs/model-compatibility.md` § Model families — the model/endpoint/effort matrix.
- OpenAI: reasoning guide, migration-to-Responses guide, conversation-state guide.
