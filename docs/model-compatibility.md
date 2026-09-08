# Model Compatibility

This document describes how the review bot handles different OpenAI model families, the reasoning-model compatibility considerations, and the remedies available when a model under-produces findings.

## Model families

| Model family | Examples | Endpoint (`OPENAI_API_STYLE=auto`) | Tool-choice mode | Token parameter | Deterministic seed | Notes |
|---|---|---|---|---|---|---|
| Classic (proven) | `gpt-4o`, `gpt-4.1`, `gpt-4`, `gpt-3.5-turbo` | `/chat/completions` | Forced-specific function object | `max_tokens` | Yes | Default behavior. Byte-identical to pre-v0.10.0 requests. No regression. |
| Reasoning (o-series) | `o1`, `o3`, `o4-mini` | `/responses` | `'required'` (auto) | `max_output_tokens` | No | OpenAI's guidance is that reasoning models belong on the Responses API. Larger output budget recommended (`OPENAI_MAX_OUTPUT_TOKENS`). |
| Reasoning (gpt-5 … gpt-5.5) | `gpt-5`, `gpt-5.4-nano`, `gpt-5.5` | `/responses` | `'required'` (auto) | `max_output_tokens` | No | Function tools are rejected on `/chat/completions` at any reasoning effort other than `none` from GPT-5.4 onward. |
| Reasoning (gpt-5.6 and later) | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | `/responses` | `'required'` (auto) | `max_output_tokens` | No | Same rejection, and `reasoning_effort: 'none'` is not an escape (see below). |

### Reasoning effort × endpoint

The rejection depends on the effective reasoning effort as well as the family, and the effort is often implicit — the model's own default applies when the config sets nothing.

| Model | Effective reasoning effort | `/chat/completions` + function tools | `/responses` + function tools |
|---|---|---|---|
| `gpt-4o`, `gpt-4.1` | n/a (not a reasoning model) | Works | Works (`OPENAI_API_STYLE=responses`) |
| `gpt-5`, `gpt-5.4-*`, `gpt-5.5` | default (`medium`) or explicit `low`/`medium`/`high`/`xhigh` | Rejected (HTTP 400, `capability`) | Works |
| `gpt-5`, `gpt-5.4-*`, `gpt-5.5` | `none` | Accepted, with the quality warning below | Works |
| `gpt-5.6-sol`/`-terra`/`-luna` | default (`medium`) or any explicit effort | Rejected (HTTP 400, `capability`) | Works |
| `gpt-5.6-*` | `none` | Accepted, with the quality warning below | Works |

Because the effort is not always visible to the adapter — it can arrive as `reasoning_effort`, as a native `reasoning` object, or as the model default — `auto` routes on the model-family predicate (`isReasoningModel`) rather than on the effort. That is the same predicate that already selects `tool_choice` and the token parameter.

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

Every review call emits a `provider.usage` log event carrying `input_tokens`, `output_tokens`, `cached_input_tokens` and `reasoning_tokens` (counts only, no content), normalized across both endpoints. `reasoning_tokens` shows whether a large `OPENAI_MAX_OUTPUT_TOKENS` was consumed by reasoning rather than by findings — the usual cause of a truncated review on a reasoning model.

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

**Root cause**: reasoning models (gpt-5+/o-series) use interleaved thinking before responding. When `tool_choice` forces a specific named function (`{ type: 'function', function: { name: '...' } }`), the model short-circuits its thinking step and calls the tool immediately with an empty `findings` array. The result is a silent, clean review that incorrectly passes every PR.

**The fix (v0.10.0+)**: the adapter now auto-detects reasoning models via the `isReasoningModel` heuristic and sends `tool_choice: 'required'` instead. With a single tool registered, the model must call it but is free to reason first. A conservative system-message nudge also reinforces that the model should only submit an empty array when there are genuinely no issues.

## Remedies

### Recommended: upgrade to v0.10.0+

The fix is automatic. Set `model: openai/gpt-5.4-nano` (or any reasoning model slug) in `.github/review-bot.yml` and deploy v0.10.0. The adapter will automatically select `tool_choice: 'required'` for reasoning models.

### Manual override: OPENAI_TOOL_CHOICE

If you are on an older deployment or need to override the heuristic:

```
# Force 'required' for all requests (useful when the heuristic misclassifies)
OPENAI_TOOL_CHOICE=required

# Force the forced-specific object (useful when a proxy rejects 'required')
OPENAI_TOOL_CHOICE=forced

# Let the adapter decide (default)
OPENAI_TOOL_CHOICE=auto
```

### Switch to a classic model

If you do not need reasoning capabilities, `gpt-4.1` is the recommended classic model — it has proven tool-call reliability and strong review quality:

```yaml
# .github/review-bot.yml
model: openai/gpt-4.1
```

### Increase output token budget

Reasoning models may need a larger output window to emit all findings:

```
OPENAI_MAX_OUTPUT_TOKENS=16384
```

## Notice in check-run and comment reply

When the adapter is called with a reasoning-family model and the provider returns zero findings on a non-trivial diff, the orchestrator emits a model-aware notice in the check-run summary and the comment reply:

> Review produced no findings. The configured model (`gpt-5.4-nano`) is a reasoning model and may be under-producing with this review flow. If you expected findings, try `openai/gpt-4.1`, or set `OPENAI_TOOL_CHOICE=required`. See docs/model-compatibility.md.

This notice is only emitted when:
1. Files were actually sent to the provider (the diff is non-trivial — not prefilter-excluded).
2. The configured model slug is a reasoning-family model.
3. The provider returned zero findings.

A classic model returning zero findings on a real diff is a legitimately clean PR — no notice is emitted in that case.

## Configuration reference

See `docs/deployment.md` for the full env-var reference including `OPENAI_TOOL_CHOICE`, `OPENAI_TOKEN_PARAM`, `OPENAI_MAX_OUTPUT_TOKENS`, and `OPENAI_API_STYLE`.
