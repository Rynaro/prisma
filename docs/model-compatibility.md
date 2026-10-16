# Model Compatibility

This document describes how the review bot handles different OpenAI model families, the reasoning-model compatibility considerations, and the remedies available when a model under-produces findings or the API rejects a request parameter. Facts about GPT-6 and GPT-6.1 are as published by OpenAI on 2026-10-16; the error strings quoted below come partly from public bug reports and may change wording. See [ADR-008](architecture-decision-records/adr-008-gpt6-model-family-compatibility.md) for the decisions behind them.

## Model families

| Model family | Examples | Endpoint (`OPENAI_API_STYLE=auto`) | Tool-choice mode | Token parameter | Deterministic seed | Input ceiling | Default output cap | Notes |
|---|---|---|---|---|---|---|---|---|
| Classic (proven) | `gpt-4o`, `gpt-4.1`, `gpt-4`, `gpt-3.5-turbo` | `/chat/completions` | Forced-specific function object | `max_tokens` | Yes | 128,000 | 4,096 | Default behavior. Byte-identical to pre-v0.10.0 requests. No regression. |
| Reasoning (o-series) | `o1`, `o3`, `o4-mini` | `/responses` | `'required'` (auto) | `max_output_tokens` | No | 128,000 (assumed) | 32,768 | OpenAI's guidance is that reasoning models belong on the Responses API. The cap includes reasoning tokens. |
| Reasoning (gpt-5 … gpt-5.5) | `gpt-5`, `gpt-5.4-nano`, `gpt-5.5` | `/responses` | `'required'` (auto) | `max_output_tokens` | No | 128,000 (assumed) | 32,768 | Function tools are rejected on `/chat/completions` at any reasoning effort other than `none` from GPT-5.4 onward. |
| Reasoning (gpt-5.6) | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | `/responses` | `'required'` (auto) | `max_output_tokens` | No | 128,000 (assumed) | 32,768 | Same rejection, and `reasoning_effort: 'none'` is not an escape (see below). |
| Reasoning (GPT-6) | `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna` | `/responses` | `'required'` (auto) | `max_output_tokens` | No | 922,000 | 32,768 | Window 1,050,000, max input 922,000, max output 128,000. `max` effort is new. Sampling parameters are rejected at any effort other than `none`. |
| Reasoning (GPT-6.1) | `gpt-6.1-sol` | `/responses` | `'required'` (auto) | `max_output_tokens` | No | 922,000 | 32,768 | Same limits as GPT-6. Rejects `none` and `minimal` effort, so chat with tools has no working effort. |
| Alias | `chat-latest` | `/responses` | `'required'` (auto) | `max_output_tokens` | No | 272,000 | 32,768 | The ChatGPT-tracking alias (window 400,000, max input 272,000). See [chat-latest](#chat-latest). |

"Input ceiling" is the maximum input tokens per call that the adapter reports as `capabilities.max_context_tokens`; classic, gpt-5.x, o-series and unknown slugs keep 128,000 because OpenAI's input limit for them is not recorded here. "Default output cap" applies when `OPENAI_MAX_OUTPUT_TOKENS` is unset (see [Default output budget](#default-output-budget)).

### Reasoning effort × endpoint

The rejection depends on the effective reasoning effort as well as the family, and the effort is often implicit — the model's own default applies when the config sets nothing.

| Model | Effective reasoning effort | `/chat/completions` + function tools | `/responses` + function tools |
|---|---|---|---|
| `gpt-4o`, `gpt-4.1` | n/a (not a reasoning model) | Works | Works (`OPENAI_API_STYLE=responses`) |
| `gpt-5`, `gpt-5.4-*`, `gpt-5.5` | default (`medium`) or explicit `low`/`medium`/`high`/`xhigh` | Rejected (HTTP 400, `capability`) | Works |
| `gpt-5`, `gpt-5.4-*`, `gpt-5.5` | `none` | Accepted, with the quality warning below | Works |
| `gpt-5.6-sol`/`-terra`/`-luna` | default (`medium`) or any explicit effort | Rejected (HTTP 400, `capability`) | Works |
| `gpt-5.6-*` | `none` | Accepted, with the quality warning below | Works |
| `gpt-6-astra`, `gpt-6.1-sol` | any supported effort | Rejected: tool calling requires Responses | Works |
| `gpt-6-astra`, `gpt-6.1-sol` | `none` | Rejected: the model does not support `none` | Rejected: the model does not support `none` |
| `gpt-6-sol`, `gpt-6-luna` | default (`medium`) or any explicit effort other than `none` | Rejected (HTTP 400, `capability`) | Works |
| `gpt-6-sol`, `gpt-6-luna` | `none` | Accepted, with the quality warning below | Works |

Because the effort is not always visible to the adapter — it can arrive as `reasoning_effort`, as a native `reasoning` object, or as the model default — `auto` routes on the model-family predicate (`isReasoningModel`) rather than on the effort. That is the same predicate that selects `tool_choice`, the token parameter, the tokenizer, the input ceiling and the default output cap. Chat Completions is not deprecated; it remains the endpoint for classic models.

### Reasoning effort × model

Prisma forwards the configured effort verbatim (`provider_options.openai.reasoning_effort`, or `reasoning.effort` on `/responses`); it does not translate or substitute values. When the model does not support the value, the API's 400 message lists the supported ones, and Prisma maps that error to a `capability` notice (see [Unsupported value / parameter rejections](#unsupported-value--parameter-rejections)).

| Effort | `gpt-6-astra` | `gpt-6-sol` | `gpt-6-luna` | `gpt-6.1-sol` |
|---|---|---|---|---|
| `none` | Rejected | Accepted | Accepted | Rejected |
| `minimal` | Rejected | Rejected | Rejected | Rejected |
| `low`, `medium`, `high`, `xhigh` | Accepted | Accepted | Accepted | Accepted |
| `max` (`/responses` only) | Accepted | Accepted | Accepted | Accepted |

The default effort is `medium` (stated for `gpt-6-sol`, `gpt-6-luna` and `gpt-6.1-sol`; implied by OpenAI's reasoning guide for `gpt-6-astra`). OpenAI's migration guidance for a request that used `minimal` is to start with `low` and compare results. The two rejections reported for `none` on `gpt-6-astra` / `gpt-6.1-sol`:

```
# Chat Completions, reasoning_effort: 'none'
Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported values are: 'low', 'medium', 'high', and 'xhigh'.

# Responses, reasoning.effort: 'none'
Unsupported value: 'none' is not supported with the '<model>' model. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'.
```

Prisma does not rewrite `minimal` to `low` or `none` to `low`: a substitution would change cost, latency and review quality without a visible record, because the adapter's ignored-field notes have no channel to the check run today.

### Sampling parameters

Reasoning-family models reject `temperature` and `top_p` (and `top_logprobs`, and `logprobs` on chat) at any reasoning effort other than `none`; on `gpt-6-astra` and `gpt-6.1-sol` that is every request, since `none` is unavailable. `generation` is the vendor-neutral config surface, so the adapter drops the normalized values instead of failing a model switch:

- `generation.temperature` and `generation.top_p` are **dropped** when the model is a reasoning-family model and `reasoning_effort` / `reasoning.effort` is not explicitly `none`. An unset effort counts as not `none`. The native `reasoning.effort` wins over `reasoning_effort` when both are set.
- With an explicit `none` (accepted by `gpt-6-sol` and `gpt-6-luna`), the values are forwarded.
- A passthrough `provider_options.openai.temperature` (or `top_p`) is forwarded untouched: the operator addressed the wire directly. A model that rejects it returns a 400 that surfaces as a `capability` notice.
- Classic models are unchanged, including a classic model pinned to `/responses` with `OPENAI_API_STYLE=responses`: sampling is still sent.
- `respond()` (the comment-reply flow, always on `/chat/completions`) follows the same rule, and `seed` is kept. Whether `/chat/completions` accepts `seed` on GPT-6 is unconfirmed; a rejection surfaces with the `seed` remedy below.
- `generation.max_output_tokens` is never dropped.

The drops are recorded as key-only notes (`generation.temperature ignored (reasoning model)`), which do not reach the check-run summary yet (ADR-007 § Trade-offs).

### Context window and long-context pricing

`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna` and `gpt-6.1-sol` have a 1,050,000-token window, a 922,000-token maximum input and a 128,000-token maximum output. `chat-latest` has a 400,000-token window and a 272,000-token maximum input. The adapter reports the maximum input (922,000 for the GPT-6 family, 272,000 for `chat-latest`, 128,000 otherwise) as `max_context_tokens`; for GPT-6, 128,000 is the output ceiling, not the input limit.

OpenAI prices prompts above 272,000 input tokens at 2× the input rate (and 1.5× the output rate). That is a cost boundary, not an API limit. The cost knobs are:

- `MAX_TOKENS_PER_PR` (default `120000`): the per-call input budget. The adapter bounds each call by `min(MAX_TOKENS_PER_PR, model window − output cap)`, reserving the output cap that request carries, and the worker passes the same limit to the orchestrator so batches are planned within it. That includes a single file sent alone: a file above `MAX_TOKENS_PER_PR` is skipped at planning instead of being rejected and retried.
- `chunking.call_token_budget` in `.github/review-bot.yml`: the per-batch budget. The effective plan uses the smallest of it, the model-derived ceiling and `MAX_TOKENS_PER_PR`.

A per-repo `model:` override to a model with a smaller window than the deployment model is guarded per request: an estimate above that model's window, less its output cap, is rejected up front (`over_budget`) and the orchestrator splits the batch, instead of the API returning `context_length_exceeded`.

### Default output budget

When `OPENAI_MAX_OUTPUT_TOKENS` is unset, the cap is 4,096 for classic models and 32,768 for reasoning-family models. The cap includes reasoning tokens, so a medium-effort GPT-6 review truncates at 4,096; OpenAI's guidance is to reserve at least 25,000 tokens for reasoning and output. The default is resolved per request from the model that request uses, so a per-repo `model:` override gets its own family's default, not the deployment model's. An explicit `OPENAI_MAX_OUTPUT_TOKENS` applies to every model, and `generation.max_output_tokens` wins over both. The worker and the standalone adapter resolve the same default.

Batch planning reserves `max(chunking.reserved_output_tokens, cap, generation.max_output_tokens)` for output, where the cap is `OPENAI_MAX_OUTPUT_TOKENS` or the deployment model's default, so input batches leave room for the output; a larger repo value still applies. If that reservation leaves no input budget in the window, the orchestrator logs `pipeline.budget.output_cap_exceeds_window` (warn), adds a configuration note, and plans with `chunking.reserved_output_tokens` instead.

The model ceiling is 128,000 output tokens. The 32,768 default raises the worst-case output spend per call to 8× the old 4,096 default on reasoning models; it is a ceiling, not typical spend.

### chat-latest

`chat-latest` tracks the model behind ChatGPT, and OpenAI updates its snapshot without notice. OpenAI recommends the `gpt-6-*` family (currently `gpt-6-astra`) for production API use. Reviews on `chat-latest` are not reproducible across a snapshot change. Prisma routes it as a reasoning model (`/responses`, `tool_choice: 'required'`); that `chat-latest` accepts `'required'` on `/responses` is inferred, not observed. If it rejects it, `OPENAI_TOOL_CHOICE` and `OPENAI_API_STYLE` are the escape hatches.

### Request-field translation on `/responses`

| Concern | `/chat/completions` | `/responses` |
|---|---|---|
| System message | `messages[0]` with `role: system` | `instructions` |
| Remaining turns | `messages[1..]` | `input` |
| Tool | nested under a `function` key | flat `{ type, name, description, parameters }` |
| Output cap | `max_tokens` / `max_completion_tokens` | `max_output_tokens` (neither chat spelling is accepted) |
| Reasoning effort | `reasoning_effort: 'high'` | `reasoning: { effort: 'high' }` |
| Deterministic seed | `seed: 42` | not supported — not sent |
| Server-side retention | n/a | `store: false` (always) |
| Conversation state | n/a | `previous_response_id` / `conversation` are never sent |

`provider_options.openai` may use either spelling. When both `reasoning` and `reasoning_effort` are set, the native `reasoning` object wins field by field — the legacy scalar fills `effort` only when the object does not set it. When both `max_output_tokens` and a chat token spelling are set, the native `max_output_tokens` wins.

### Deterministic seed

`/responses` has no `seed` parameter. When a model routes there, no seed is sent — neither the `generation.seed` / `deterministic_seed` value nor a raw `provider_options.openai.seed` — and the adapter declares `capabilities.deterministic_seed: false` rather than promising a determinism the endpoint cannot deliver.

If you need seeded runs, use a classic model. Pinning an affected gpt-5.4+ family back to chat with `OPENAI_API_STYLE=chat` is **not** a working alternative: it restores the rejection this routing exists to fix.

### Token usage

Every review call emits a `provider.usage` log event carrying `input_tokens`, `output_tokens`, `cached_input_tokens`, `reasoning_tokens` and `cache_write_tokens` (counts only, no content), normalized across both endpoints; each field is omitted when the endpoint did not report it. `reasoning_tokens` shows whether a large `OPENAI_MAX_OUTPUT_TOKENS` was consumed by reasoning rather than by findings — the usual cause of a truncated review on a reasoning model.

## Function tools rejected on /chat/completions

**Symptom**: every review fails with a `capability` error and no findings are produced:

```
Review unavailable - the AI provider rejected the request (capability: Function tools with
reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use function
tools, use /v1/responses or set reasoning_effort to 'none'.)
```

**Root cause**: from GPT-5.4 onward the reasoning families do not accept function tools on
`/chat/completions` at any reasoning effort other than `none`, and the review flow always sends
the single `submit_review_findings` tool. The rejection fires on the model's default effort, so
it needs no explicit `reasoning_effort` in the config to trigger.

**The fix**: the adapter routes reasoning-family models to `/responses`, which accepts the same
tool and the same `tool_choice: 'required'`. The request is the same prompt and schema in the
Responses spelling — see the translation table above. `reasoning_effort` is translated to
`reasoning: { effort }` rather than forwarded, because `/responses` rejects unknown top-level
parameters with HTTP 400; forwarding it would trade a 400 on one endpoint for a 400 on the other.

`reasoning_effort: 'none'` also clears the 400 and is **not** recommended: it turns reasoning
off, and the failure mode that replaces the 400 is a malformed findings payload rather than a
visible error, so reviews are dropped silently. Set `OPENAI_API_STYLE` if you need to pin an
endpoint:

```
# Route reasoning-family models to /responses, leave classic models on chat (default)
OPENAI_API_STYLE=auto

# Use /responses for every model
OPENAI_API_STYLE=responses

# Pin /chat/completions for every model (pre-Responses behavior).
# The escape hatch for an OPENAI_BASE_URL gateway that does not expose /responses.
OPENAI_API_STYLE=chat
```

When this rejection reaches the check run, the summary and the comment reply name
`OPENAI_API_STYLE` as the remedy rather than the model setting.

## The empty-review symptom

**Symptom**: a PR with obvious issues receives a clean "no findings" review in 1-3 seconds. The check run shows `provider.output findings_count: 0`.

**Root cause**: reasoning models (gpt-5+/o-series/gpt-6/`chat-latest`) use interleaved thinking before responding. When `tool_choice` forces a specific named function (`{ type: 'function', function: { name: '...' } }`), the model short-circuits its thinking step and calls the tool immediately with an empty `findings` array. The result is a silent, clean review that incorrectly passes every PR.

**The fix (v0.10.0+)**: the adapter now auto-detects reasoning models via the `isReasoningModel` heuristic and sends `tool_choice: 'required'` instead. With a single tool registered, the model must call it but is free to reason first. A conservative system-message nudge also reinforces that the model should only submit an empty array when there are genuinely no issues.

## Remedies

### Check the usage event

Read the `provider.usage` event for the review. `reasoning_tokens` near zero means the model skipped reasoning; a large count with no findings usually means the output cap was consumed by reasoning.

### Increase output token budget

The reasoning-family default is already 32,768 (4,096 for classic models). Raise it when `reasoning_tokens` approaches the cap, or when the effort is `high` or above. On GPT-6, with 922,000 input tokens, a larger cap costs little input room:

```
OPENAI_MAX_OUTPUT_TOKENS=65536
```

On a 128K-window model the output cap comes out of the same window: 65,536 cuts the input budget of every batch by more than half (105,944 to 44,504 tokens at the default chunking settings). A cap the window cannot hold logs `pipeline.budget.output_cap_exceeds_window`, and planning falls back to `chunking.reserved_output_tokens`; lower the cap.

### Raise the reasoning effort

A reasoning model that reports no findings on a diff with obvious issues may be reasoning too little. Set `provider_options.openai.reasoning_effort` to a higher value the model supports (see [Reasoning effort × model](#reasoning-effort--model)). Do not set `none`.

### Manual override: OPENAI_TOOL_CHOICE

`auto` already sends `'required'` to every reasoning-family model, so setting `required` is not a remedy for an empty review on a model the adapter recognizes. The override remains an escape hatch for a model the predicate does not recognize, or for a gateway:

```
# Force 'required' for all requests (a model the predicate does not recognize)
OPENAI_TOOL_CHOICE=required

# Force the forced-specific object (useful when a proxy rejects 'required').
# Do not set this on a reasoning model: it is the cause of the empty-review symptom above.
OPENAI_TOOL_CHOICE=forced

# Let the adapter decide (default)
OPENAI_TOOL_CHOICE=auto
```

### Switch to a classic model

If you do not need reasoning capabilities, `gpt-4.1` is a classic model with proven tool-call reliability and strong review quality:

```yaml
# .github/review-bot.yml
model: openai/gpt-4.1
```

OpenAI has announced that the dated `gpt-4o` and `gpt-4.1` snapshots shut down on 2027-01-14, with `gpt-6-luna` as the named replacement. Treat a classic model as a short-term choice.

### Set OPENAI_MODEL explicitly

`OPENAI_MODEL` defaults to `gpt-4o`. When it is unset, the worker logs a `worker.provider.openai_default_model` warning at startup:

> OPENAI_MODEL is unset; the default `gpt-4o` resolves to a snapshot scheduled for shutdown on 2027-01-14 (replacement: `gpt-6-luna`). Set OPENAI_MODEL explicitly before then; see docs/model-compatibility.md.

Set `OPENAI_MODEL` (or `model:` in `.github/review-bot.yml`) before that date. The default itself has not changed, so existing deployments keep their current behavior until you do.

## Notice in check-run and comment reply

When the adapter is called with a reasoning-family model and the provider returns zero findings on a non-trivial diff, the orchestrator emits a model-aware notice in the check-run summary and the comment reply (the check-run summary prefixes it with `ℹ️`):

> `<model>` is a reasoning model and reported no findings. If you expected some, check the `provider.usage` log event: `reasoning_tokens` near zero means the model skipped reasoning (do not set `reasoning_effort: 'none'`; unset `OPENAI_TOOL_CHOICE=forced`); a large count with an empty result usually means a tight output cap — raise `OPENAI_MAX_OUTPUT_TOKENS` (≥ 25,000 on GPT-6) or the effort. See docs/model-compatibility.md.

This notice is only emitted when:
1. Files were actually sent to the provider (the diff is non-trivial — not prefilter-excluded).
2. The configured model slug is a reasoning-family model.
3. The provider returned zero findings.

A classic model returning zero findings on a real diff is a legitimately clean PR — no notice is emitted in that case.

## Unsupported value / parameter rejections

A 400 with `code: unsupported_value` or `code: unsupported_parameter` is classified as a `capability` error, regardless of the message wording, and is never retried. The error carries the API's `param` and `code`, and the check-run summary and comment reply append a remedy keyed on `param`:

| `param` | Condition | Remedy text |
|---|---|---|
| `reasoning_effort`, `reasoning.effort` | `code` is `unsupported_value`, or the message starts with "Unsupported value" | Remedy: this model does not support the configured reasoning effort; the provider message lists the supported values. `none` is rejected by `gpt-6-astra` and `gpt-6.1-sol`; `minimal` by every GPT-6 model. Change `provider_options.openai.reasoning_effort` (or `reasoning.effort`). See `docs/model-compatibility.md` § Reasoning effort × model. |
| `temperature`, `top_p`, `top_logprobs`, `logprobs` | any | Remedy: this model rejects `<param>` at its reasoning effort. Remove it from `generation` / `provider_options.openai` in `.github/review-bot.yml`. See `docs/model-compatibility.md` § Sampling parameters. |
| `seed` | any | Remedy: this model rejects `seed`. Remove `generation.seed` for this model. |
| `max_tokens` | any | Remedy: this model requires `max_completion_tokens`. Unset `OPENAI_TOKEN_PARAM` (auto) or set it to `max_completion_tokens`. |

Two rules keep the remedy honest:

- The chat-with-function-tools rejection also carries `param: 'reasoning_effort'` with a null `code`. It is matched first and gets the `OPENAI_API_STYLE` remedy (see above), not the effort remedy.
- When a gateway behind `OPENAI_BASE_URL` returns an `unsupported_parameter` error for a `param` that is not in the table (for example `store` or `reasoning`), the summary shows the generic capability notice. No remedy is guessed.

Two related provider-error changes: a 429 with `code: insufficient_quota` is reported as a non-retryable `rate_limit` error (the job queue treats it as non-transient), and a 5xx error carries `retry_after_ms` when the response had a `Retry-After` header. See `docs/observability.md` § Event taxonomy (`provider.error`).

## Configuration reference

See `docs/deployment.md` for the full env-var reference including `OPENAI_TOOL_CHOICE`, `OPENAI_TOKEN_PARAM`, `OPENAI_MAX_OUTPUT_TOKENS`, and `OPENAI_API_STYLE`.
