# Model Compatibility

This document describes how the review bot handles different OpenAI model families, the reasoning-model compatibility considerations, and the remedies available when a model under-produces findings.

## Model families

| Model family | Examples | Tool-choice mode | Token parameter | Notes |
|---|---|---|---|---|
| Classic (proven) | `gpt-4o`, `gpt-4.1`, `gpt-4`, `gpt-3.5-turbo` | Forced-specific function object | `max_tokens` | Default behavior. Byte-identical to pre-v0.10.0 requests. No regression. |
| Reasoning (gpt-5+) | `gpt-5`, `gpt-5.4-nano`, `gpt-5-nano` | `'required'` (auto) | `max_completion_tokens` | Reasoning models need `tool_choice: 'required'` to reason before calling the tool. |
| Reasoning (o-series) | `o1`, `o3`, `o4-mini` | `'required'` (auto) | `max_completion_tokens` | Same as gpt-5+ family. Larger output budget recommended (`OPENAI_MAX_OUTPUT_TOKENS`). |

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

See `docs/deployment.md` for the full env-var reference including `OPENAI_TOOL_CHOICE`, `OPENAI_TOKEN_PARAM`, and `OPENAI_MAX_OUTPUT_TOKENS`.
