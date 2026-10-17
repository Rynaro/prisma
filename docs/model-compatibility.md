# Model Compatibility

This document describes how the review bot handles different OpenAI and Anthropic model families, the reasoning-model compatibility considerations, and the remedies available when a model under-produces findings or the API rejects a request parameter. The Anthropic family is in [§ Anthropic](#anthropic). Facts about GPT-6 and GPT-6.1 are as published by OpenAI on 2026-10-16; the error strings quoted below come partly from public bug reports and may change wording. See [ADR-008](architecture-decision-records/adr-008-gpt6-model-family-compatibility.md) for the decisions behind them.

## Model families

| Model family | Examples | Endpoint (`OPENAI_API_STYLE=auto`) | Tool-choice mode | Token parameter | Deterministic seed | Input ceiling | Default output cap | Notes |
|---|---|---|---|---|---|---|---|---|
| Classic (proven) | `gpt-4o`, `gpt-4.1`, `gpt-4`, `gpt-3.5-turbo` | `/chat/completions` | Forced-specific function object | `max_tokens` | Yes | 128,000 | 4,096 | Byte-identical to pre-v0.10.0 requests. No regression. Opt in with `OPENAI_MODEL` (see [Default model](#default-model)). |
| Reasoning (o-series) | `o1`, `o3`, `o4-mini` | `/responses` | `'required'` (auto) | `max_output_tokens` | No | 128,000 (assumed) | 32,768 | OpenAI's guidance is that reasoning models belong on the Responses API. The cap includes reasoning tokens. |
| Reasoning (gpt-5 … gpt-5.5) | `gpt-5`, `gpt-5.4-nano`, `gpt-5.5` | `/responses` | `'required'` (auto) | `max_output_tokens` | No | 128,000 (assumed) | 32,768 | Function tools are rejected on `/chat/completions` at any reasoning effort other than `none` from GPT-5.4 onward. |
| Reasoning (gpt-5.6) | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | `/responses` | `'required'` (auto) | `max_output_tokens` | No | 128,000 (assumed) | 32,768 | Same rejection, and `reasoning_effort: 'none'` is not an escape (see below). |
| Reasoning (GPT-6) | `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna` | `/responses` | `'required'` (auto) | `max_output_tokens` | No | 922,000 | 32,768 | Window 1,050,000, max input 922,000, max output 128,000. `max` effort is new. Sampling parameters are rejected at any effort other than `none`. `gpt-6-luna` is the default model. |
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

### Default model

`OPENAI_MODEL` defaults to `gpt-6-luna`, OpenAI's named replacement for the retired `gpt-4o` / `gpt-4.1` snapshots ([ADR-008](architecture-decision-records/adr-008-gpt6-model-family-compatibility.md) D9). It was `gpt-4o`.

A deployment that never set `OPENAI_MODEL` changes behavior when it upgrades. It moves from `gpt-4o` on `/chat/completions` (seeded, 4,096 output cap, 128,000 input ceiling) to `gpt-6-luna` on `/responses` (no seed, 32,768 output cap, 922,000 input ceiling), with `tool_choice: 'required'` and without `generation.temperature` / `top_p`. To keep the old behavior, set `OPENAI_MODEL=gpt-4o`; that works until the `gpt-4o` snapshot shuts down on 2027-01-14.

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

## Anthropic

This section covers the Anthropic adapter (`packages/providers/anthropic`) and the Claude 5.x model family. Facts are as published by Anthropic on 2026-10-16, as collected in the research digest; the error strings are the vendor's and may change wording. The decisions behind the adapter are in [ADR-009](architecture-decision-records/adr-009-anthropic-5x-model-family-compatibility.md).

The adapter picks the request shape from the parsed model ID. An ID it cannot read (an alias or a gateway name) gets the forced request, a 4,096 cap, a 200,000-token window and the larger token estimate. See [Tool choice](#tool-choice) and [Context window and token estimate](#context-window-and-token-estimate).

### Model families

| Model | Example ID | Input window | Default output cap | Thinking by default | Tool-choice mode (`auto`) | Tokenizer family | Notes |
|---|---|---|---|---|---|---|---|
| Opus 5.5 | `claude-opus-5-5` | 1,000,000 | 16,384 | Yes (adaptive) | Unforced | `anthropic-approx-v2` | Default effort `medium`. Vendor default for new code. |
| Sonnet 5.5 | `claude-sonnet-5-5` | 1,000,000 | 16,384 | Yes (adaptive) | Unforced | `anthropic-approx-v2` | Default model (`ANTHROPIC_DEFAULT_MODEL`). Default effort `high`. |
| Haiku 5.5 | `claude-haiku-5-5` | 1,000,000 | 16,384 | Yes (adaptive) | Unforced | `anthropic-approx-v2` | Default effort `medium`. Price steps up above 100,000 prompt tokens; see [Long-prompt pricing](#long-prompt-pricing). |
| Fable 5.1 | `claude-fable-5-1` | 1,000,000 | 16,384 | Yes (adaptive) | Unforced | `anthropic-approx-v2` | Opt-in only. Needs 30-day data retention; ZDR organizations get `400 invalid_request_error`. Default effort `high`. |
| Other 5.x | `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5` | 1,000,000 | 16,384 | Yes (adaptive) | Unforced | `anthropic-approx-v2` | Same rules as 5.5. Any unrecognized major version of 6 or higher gets the same treatment. |
| Opus 4.8 / 4.7 | `claude-opus-4-8`, `claude-opus-4-7` | 1,000,000 | 4,096 | No | Forced | `anthropic-approx-v2` | Thinking is off unless the repo bag enables it, which also raises the default cap to 16,384. |
| Opus 4.6 | `claude-opus-4-6` | 1,000,000 | 4,096 | No | Forced | `anthropic-approx` | No `xhigh` effort. |
| Sonnet 4.6 | `claude-sonnet-4-6` | 1,000,000 | 4,096 | No | Forced | `anthropic-approx` | No `xhigh` effort. |
| Haiku 4.5 | `claude-haiku-4-5` | 200,000 | 4,096 | No | Forced | `anthropic-approx` | Accepts no `effort`; a configured value is a 400. |
| Claude 4.5 and older (other than the rows above) | `claude-sonnet-4-5` | 200,000 | 4,096 | No | Forced | `anthropic-approx` | Accepts no `effort`. |
| Retired 3.x | `claude-3-5-sonnet-latest`, `claude-3-5-sonnet-20241022`, `claude-3-7-sonnet-20250219`, `claude-3-opus-20240229` | n/a | n/a | n/a | n/a | n/a | Returns `404 not_found_error`. The adapter's former default was `claude-3-5-sonnet-latest`. |

"Default output cap" applies when `ANTHROPIC_MAX_OUTPUT_TOKENS` is unset (see [Output cap](#output-cap)). "Tool-choice mode" is the adapter's choice for `ANTHROPIC_TOOL_CHOICE=auto`; the override is in [ANTHROPIC_TOOL_CHOICE](#anthropic_tool_choice). A model not listed is routed by the rules above: a parseable ID is judged by its major and minor version, and an ID that cannot be parsed gets the forced request, a 4,096 cap, a 200,000-token window and the v2 estimator. Vendor deprecations recorded in the digest (for example `claude-opus-4-1`, `claude-opus-4-20250514`) are not in the table; check the vendor's deprecation page for them.

### Tool choice

The review call asks the model to call one tool, `submit_review_findings`. How it is asked depends on the family:

- **Forced (Claude 4.x and older, and aliases).** `tool_choice: { type: 'tool', name: 'submit_review_findings' }`, the historical request. It is never retried.
- **Unforced (Claude 5.x, and any model whose repo bag enables thinking).** `tool_choice: { type: 'auto', disable_parallel_tool_use: true }`, with three additions:
  - the tool is sent with `strict: true`, against a wire copy of the schema that keeps only the keywords Anthropic's strict mode accepts (`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `description`), with `additionalProperties: false` on every object. The shared schema is unchanged, and Zod still enforces the bounds the wire copy drops (length, range and count limits);
  - a short instruction is appended to the system prompt, saying to call the tool exactly once and that plain text is discarded;
  - if the response has no `submit_review_findings` call, the adapter sends the same request once more. A second miss fails the batch with the message `anthropic response did not call 'submit_review_findings' (tool_choice auto) after 1 retry`.

Forced tool choice is a 400 on Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1, so the rule sends those models down the unforced path. On Haiku 5.5, forced calls skip thinking (the response starts with the tool call), so Haiku 5.5 is also unforced. `auto` does not guarantee a call, which is why the presence check and the one retry exist. Each API call emits a `provider.usage` event, so a retried batch shows two.

#### ANTHROPIC_TOOL_CHOICE

| Value | Behavior |
|---|---|
| `auto` (default) | The rule above: Claude 5.x and thinking-enabled bags get unforced; everything else forced. |
| `forced` | Always the forced request. Do not set this on a 5.x model: it is a 400 on Opus 5.5, Sonnet 5.5 and Fable 5.1, and it skips thinking on Haiku 5.5. |
| `unforced` | Always the unforced request. |

Any other value is ignored, and the rule applies. A repo bag with a `thinking` block of type `adaptive` or `enabled` turns the unforced path on, but a bag cannot turn it off, because `tool_choice` is denylisted.

**Alias recipe.** A gateway name or alias in front of a 5.x model cannot be read by its version, so the rule sends it forced. Set both:

```
ANTHROPIC_TOOL_CHOICE=unforced
ANTHROPIC_MAX_OUTPUT_TOKENS=16384
```

The first makes the request unforced. The second sets the thinking model's cap, because an alias gets 4,096 by default.

### Strict tool schema

The strict wire copy is a limitation, not a change of meaning. Dropped hints (`minLength`, `maxLength`, `minimum`, `maximum`, `maxItems`) are still checked after the response, and the validator enforces the highlights cap. What changes is that the model is told fewer bounds in the schema. If Anthropic's strict mode rejects a 5.x request for a schema reason (a 400 naming `strict` or the schema), the adapter's fix is to drop `strict: true` and keep the rest of the request shape; the revert is a one-line change, and the live smoke check (below) is how to find out.

### Thinking and effort

Prisma never sends a `thinking` block of its own. The model's default applies:

- **Claude 5.x thinks adaptively, by default.** Thinking is always on for Opus 5.5 and Fable 5.1. `thinking: { type: 'disabled' }` and `thinking: { type: 'enabled', budget_tokens }` are 400s on the 5.x family (the exact rules vary by model, and Prisma sends neither).
- **Claude 4.8 / 4.7 / 4.6 and Haiku 4.5 do not think by default.** An operator who sets `thinking` in `provider_options.anthropic` gets whatever the vendor accepts for that model. `thinking.type: 'enabled'` is deprecated on 4.6 and is a 400 on 4.7 and 4.8.

Effort is sent only when a repo sets it, as `provider_options.anthropic.effort` (mapped to `output_config.effort`) or as native `output_config.effort`, which wins if both are set. The value is forwarded as written. Model defaults apply otherwise: `medium` on Opus 5.5 and Haiku 5.5, `high` on the other models.

| Effort | Opus 5.5, Opus 5, Fable 5.1, Sonnet 5.5, Sonnet 5, Haiku 5.5 | Opus 4.8, Opus 4.7 | Opus 4.6, Sonnet 4.6 | Haiku 4.5, Sonnet 4.5 |
|---|---|---|---|---|
| `low` | Accepted | Accepted | Accepted | Error (400) |
| `medium` | Accepted (default on Opus 5.5 and Haiku 5.5) | Accepted | Accepted | Error (400) |
| `high` | Accepted (default on the other 5.x models) | Accepted (default) | Accepted (default) | Error (400) |
| `xhigh` | Accepted | Accepted | Error (400): no `xhigh` on 4.6 | Error (400) |
| `max` | Accepted | Accepted | Accepted | Error (400) |

Lower `effort` rather than starving the cap. A smaller `max_tokens` truncates thinking and findings alike; a lower effort reduces how much the model thinks. If the effort is unsupported, the request returns a 400 that gets the effort remedy below.

### Sampling parameters

Prisma does not send `temperature`, `top_p` or `top_k` to Claude; `generation.temperature`, `generation.top_p` and `generation.seed` are never read by the Anthropic adapter. A passthrough of these keys through `provider_options.anthropic` is forwarded, and the vendor's rules then apply:

- `temperature`, `top_p` and `top_k` are removed (400) on Fable 5 and 5.1, Opus 5.5, Opus 5, Opus 4.8, Opus 4.7 and Sonnet 5.
- On Sonnet 5.5 and Haiku 5.5, only the defaults are accepted: `temperature` must be 1, `top_p` 0.99, sending both is a 400, and any `top_k` is a 400.
- Assistant prefill (a trailing assistant turn) is a 400 on every 4.6 and newer model.

The remedy for a 400 on these keys is in the table below.

### Output cap

`max_tokens` is required. Its default depends on the model:

| Model | Default with `ANTHROPIC_MAX_OUTPUT_TOKENS` unset | Why |
|---|---|---|
| Claude 5.x | 16,384 | Thinking counts toward `max_tokens`, so a 4,096 cap truncates a thinking model before it reports findings. |
| Claude 4.x and older, aliases | 4,096 | The historical default. |
| Any model, when the repo bag sets `thinking` to `adaptive` or `enabled` | 16,384 | Same reason. |

The precedence for a request, highest first: the repo's `provider_options.anthropic.max_tokens`, then `generation.max_output_tokens`, then `ANTHROPIC_MAX_OUTPUT_TOKENS` (which applies to every model), then the table above. A non-positive or non-numeric environment value is ignored. A response that stops on `max_tokens` is reported as `output_truncated` with the cap that was requested, and the orchestrator splits the batch.

The pinned SDK does not guard non-streaming requests by size. Newer SDKs refuse a non-streaming request whose expected time exceeds about ten minutes, which is roughly `max_tokens` above 21,000. The adapter does not stream, so 16,384 is the ceiling it is designed for; a larger value needs a streaming change first.

The batch planner's output reservation is derived from the model and the environment, not from the repo bag. A 4.x model with a `thinking` block in the bag therefore sends 16,384 while the planner reserves 4,096. An over-budget batch then degrades to a split rather than failing silently, but the planner's reservation is short for that configuration (see [ADR-009 § Trade-offs](architecture-decision-records/adr-009-anthropic-5x-model-family-compatibility.md#trade-offs)).

### Context window and token estimate

Input windows are 1,000,000 tokens for Claude 5.x and for Claude 4.6 and newer, and 200,000 for Claude 4.5 and older and for IDs the adapter does not recognize. The adapter uses the window of the model each request uses, reserving that request's output cap, and the guard fails a request over `min(MAX_TOKENS_PER_PR, window − output cap)` before it is sent. `MAX_TOKENS_PER_PR` is the binding limit at the default settings.

The estimate uses one of two families:

- `anthropic-approx-v2` (Claude 5.x, Opus 4.7 and newer, and unknown aliases): characters ÷ 4, times 1.55. The vendor reports that Sonnet 5.5 and Haiku 5.5 count the same text as about 30% more tokens than Sonnet 4.6 and Haiku 4.5, and the Opus 4.7 tokenizer uses between 1.0× and 1.35× the older count.
- `anthropic-approx` (Claude 4.6 and older, and version-first IDs such as `claude-3-…`): characters ÷ 4, times 1.15.

Unknown aliases get the larger estimate on purpose: over-counting only makes a batch smaller. The margin is an estimate, not a measurement; a count-tokens calibration is a follow-up (ADR-009 OQ-6).

Known limitation: the `@bot ask` path guards its request with characters ÷ 4 and no margin, so on a 5.x model that guard can under-count by up to about 30%. The review path is unaffected.

#### Long-prompt pricing

Haiku 5.5's per-token price rises by a factor of five above 100,000 prompt tokens, according to the research digest (2026-10-16). `MAX_TOKENS_PER_PR` defaults to a value above that, so set it to `95000` or lower to keep every batch in the cheaper tier. The `MAX_TOKENS_PER_PR` setting is shared with the other providers; see [deployment.md](deployment.md).

### Refusals

A refusal is a safety classifier declining to review. Anthropic returns it as a normal response with `stop_reason: 'refusal'` and a `stop_details.category`, not as an error. The adapter:

- checks for it before reading any content, and discards partial content;
- reports it as a `schema_validation` error with `code: 'refusal'` and the category in the message;
- never retries it, and never reads the vendor's explanation text into a message, log or notice.

The categories are an open set. The ones the digest names are `cyber`, `bio`, `frontier_llm`, `reasoning_extraction` and `general_harms`, and `none` is shown when the vendor gives no category. Source-code vulnerability review is allowed under `cyber`, but benign security tooling can be declined, and security-related diffs are the most likely to be declined.

Two notices carry the refusal. Both say it is not a configuration error:

> Review unavailable — the provider's safety classifier declined to review this diff (category: `cyber`). This is not a configuration error; it can happen on security-related code. Re-run the review with the bot's `review` command, or pin a different model for this repository with `model:` in `.github/review-bot.yml`.

The check-run summary prefixes this with the warning sign the capability notices use. When a chunked review declines only some batches, the rest of the review is published and the declined files are listed:

> Not reviewed (the provider's safety classifier declined this section; category: `cyber`): a.ts, b.ts. This is not a configuration error; re-run the review or pin a different model with `model:` in `.github/review-bot.yml`.

The note has a leading space, like the other "not reviewed" notes, and names no call budget. The categories shown are the ones reported for the declined batches, deduplicated.

Server-side fallbacks, which would route a declined request to another model, are deferred (ADR-009 D9). Nothing in the adapter falls back to a different model. To change the model for a repository, use `model:` in `.github/review-bot.yml`.

A command reply (`review` or `ask`) that fails with a refusal carries the same notice. Known gap: the check run carries the refusal notice, but the wording of a review command's reply may still read as a completed review (ADR-009 OQ-4).

### Retired IDs and the 404 remedy

A model ID that Anthropic has retired returns `404 not_found_error`. Such a request is not retried. The check-run summary (or the command reply) shows the remedy below. The deployment's model is set with `ANTHROPIC_MODEL`; a repo overrides it with `model: anthropic/<id>` in `.github/review-bot.yml`.

```
ANTHROPIC_MODEL=claude-sonnet-5-5
```

A deployment that never set `ANTHROPIC_MODEL` was failing every review with a 404 on the retired default. On upgrade it runs `claude-sonnet-5-5`, with the 5.x request shape. A deployment that pinned a 4.x model in the repo keeps the 4.x behavior: forced tool choice, a 4,096 cap, and the window its family has.

### Remedies

The adapter maps errors by their status and error type, not by their wording. A 400 whose type is `invalid_request_error` is a `capability` error whatever its message says, and a 404 is a `capability` error too; neither is retried. A 5xx, including 529, carries `retry_after_ms` when the response has a `Retry-After` header. Any other 400 is reported as a transport error with no remedy.

When a `capability` error reaches the check run or the command reply, the first matching remedy below is appended. Each remedy begins with `Remedy:`, like the OpenAI remedies. A message that matches none of them shows the generic notice.

| Trigger | Remedy text |
|---|---|
| The error code is `not_found_error` (404) | Remedy: the configured Claude model ID was not found — it is retired or misspelled (`claude-3-5-sonnet-latest` and every Claude 3.x ID are retired). Set `ANTHROPIC_MODEL`, or `model: anthropic/<id>` in `.github/review-bot.yml`, for example `claude-sonnet-5-5`. See `docs/model-compatibility.md` § Anthropic. |
| The message mentions `tool_choice` and "not supported" | Remedy: this model rejects forced tool choice. Prisma sends `tool_choice: auto` to Claude 5.x model IDs automatically; for an alias or gateway name in front of a Claude 5.x model, set `ANTHROPIC_TOOL_CHOICE=unforced` (and `ANTHROPIC_MAX_OUTPUT_TOKENS=16384`), and unset `ANTHROPIC_TOOL_CHOICE=forced` if it is set. |
| The message mentions `thinking.type` | Remedy: remove `provider_options.anthropic.thinking`. Claude 5.x thinks adaptively; use `provider_options.anthropic.effort` to control depth. |
| The message mentions `output_config.effort` or `effort` | Remedy: this model does not support the configured `effort`. Claude 5.x accepts `low`, `medium`, `high`, `xhigh` or `max`; Claude 4.6 models have no `xhigh`; Haiku 4.5 and Sonnet 4.5 accept no effort. Change or remove `provider_options.anthropic.effort` (or `output_config.effort`). See `docs/model-compatibility.md` § Anthropic. |
| The message mentions `temperature`, `top_p` or `top_k` | Remedy: remove `temperature` / `top_p` / `top_k` from `provider_options.anthropic`; Claude 5.x rejects them (Sonnet 5.5 and Haiku 5.5 accept only the defaults). |
| The message says "prompt is too long" | Remedy: the request exceeded the model's context window. Lower `MAX_TOKENS_PER_PR` or `chunking.call_token_budget`. |

The first matching row wins, so a 404 always gets the model-ID remedy.

### Empty-review notice for Claude

Claude 5.x thinks before it answers. When a review of a non-trivial diff returns no findings, the check-run summary and the command reply show this notice (the check-run summary prefixes it as it does the OpenAI notice). It is emitted only when files were sent to the provider and the configured model is a thinking model:

> `<model>` thinks before answering (adaptive thinking) and reported no findings. If you expected some, check the `provider.usage` log event: `output_tokens` in the low tens means the model answered without thinking — unset `ANTHROPIC_TOOL_CHOICE=forced` if set; otherwise raise `provider_options.anthropic.effort` (Opus 5.5 and Haiku 5.5 default to `medium`). See docs/model-compatibility.md § Anthropic.

Read the `provider.usage` event for the review (see [Token usage](#token-usage)). `output_tokens` in the low tens means the model answered without thinking, which is the forced-choice symptom. A large count with no findings means the cap was consumed by thinking; raise `ANTHROPIC_MAX_OUTPUT_TOKENS` or the effort. The gate reads the repo's configured model only, so a repo on the deployment default, or on an alias, gets no Claude notice.

### Token usage

Every Anthropic review call emits a `provider.usage` log event with `provider: 'anthropic'` and `endpoint: 'messages'`, and the model that was sent. Counts only, no content:

- `input_tokens` is the total prompt: the uncached input plus the cache reads and cache writes.
- `output_tokens` includes thinking.
- `cached_input_tokens` is the cache reads, and `cache_write_tokens` is the cache writes.

A field is omitted when the response did not report it. There is no reasoning-token field for Anthropic. The event fires once per API call, before the refusal and truncation checks, so a retried batch shows two events. `respond()` (the `@bot ask` flow) does not emit it.

### Live smoke check

The adapter's request shape is checked against the live API by a script that is run by hand. It is never run in CI, and it is not part of `pnpm test`. It costs a few cents per run, because it sends one small seeded-bug review per model.

Read the key without putting it in shell history, then run the script from the repository root after `pnpm install`:

```bash
read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY
./node_modules/.bin/tsx scripts/smoke/anthropic-models.ts
```

The default models are `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`. Options and inputs (from `scripts/smoke/anthropic-models.ts --help`, which makes no network call):

- **Models.** Positional arguments, then the comma-separated `ANTHROPIC_SMOKE_MODELS`, then the defaults. `claude-fable-5-1` is opt-in and must be named explicitly, because it needs 30-day retention and ZDR organizations get a 400 for it. A model ID may contain letters, digits, `.`, `_`, `:` and `-`, up to 100 characters.
- **`--effort <level>`.** Sends `provider_options.anthropic.effort` for every model, which the adapter maps to `output_config.effort`.
- **`--allow-empty`.** A review that returns zero findings does not fail the run.
- **`-h`, `--help`.** Prints usage and exits 0.
- **`ANTHROPIC_TOOL_CHOICE`, `ANTHROPIC_MAX_OUTPUT_TOKENS`.** Read the same way the worker reads them, so the run exercises the same configuration.

A missing `ANTHROPIC_API_KEY` exits with code 2 before any call is made, and any unknown flag does too.

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Every model passed. |
| `1` | At least one model failed (`FAIL`) or returned no findings (`EMPTY`), unless `--allow-empty` covers the `EMPTY` cases. An unexpected crash of the script also exits 1. |
| `2` | Usage error, or `ANTHROPIC_API_KEY` is not set. |

The run prints a header line, one verdict line per model, and a summary. The key, the prompt, the response content, the tool input and the vendor's explanation text are never printed. A verdict line has this shape (the values here are illustrative):

```
[anthropic-smoke] claude-sonnet-5-5 PASS findings=1 calls=1 tool_choice=auto strict=true max_tokens=16384 effort=default stop_reasons=tool_use input_tokens=1234 output_tokens=567 cached_input_tokens=0 cache_write_tokens=0 elapsed_ms=8000
[anthropic-smoke] result: 3/3 PASS
```

A green run confirms the following:

- No forced-choice 400 on Opus 5.5 or Sonnet 5.5, and the unforced request bundle is accepted.
- Strict mode accepts the stripped schema. A 400 naming `strict` or the schema is the one-line revert described under [Strict tool schema](#strict-tool-schema).
- The 16,384 cap does not truncate the seeded review.
- Every 400 surfaces as a `capability` error with a code.
- Usage counts are present in the `provider.usage` sums.

The refusal path cannot be triggered on purpose. The smoke input is a plain correctness bug, deliberately not security code, so it does not trip `cyber`. The refusal path is covered offline by the tests listed in ADR-009.

`calls=2` on a line means the unforced retry fired for that model.

## Configuration reference

See `docs/deployment.md` for the full env-var reference including `OPENAI_TOOL_CHOICE`, `OPENAI_TOKEN_PARAM`, `OPENAI_MAX_OUTPUT_TOKENS`, and `OPENAI_API_STYLE`.
