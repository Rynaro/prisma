# Research digest — Claude Haiku 5.5 / Sonnet 5.5 / Opus 5.5 / Fable 5.1 API contract (as of 2026-10-16)

> Phase: Research + Digest for the "Anthropic 5.x model-family compatibility" feature (sibling of `docs/_planning/gpt6-compat/`).
> Source: Anthropic's Claude API reference as bundled with the Claude API skill (model catalog + model-migration guide, cached 2026-10-06). No live API calls were made.
> Consumers: ATLAS (scout), FORGE (trade-offs), RAMZA (spec), Vivi (implementation), IDG (docs/ADR).

## 1. Model IDs

Bare first-party IDs, **no date suffix, no `-latest` alias** for the new generation. Bedrock prefixes `anthropic.`; Vertex/Foundry use the bare ID.

| Model | ID | Context (input) | Max output | $/MTok in / out |
|---|---|---|---|---|
| Claude Fable 5.1 | `claude-fable-5-1` | 1M | 128K | 10 / 50 |
| Claude Fable 5 (prev) | `claude-fable-5` | 1M | 128K | 10 / 50 |
| Claude Opus 5.5 | `claude-opus-5-5` | 1M | 128K | 4 / 20 |
| Claude Opus 5 (prev) | `claude-opus-5` | 1M | 128K | 5 / 25 |
| Claude Opus 4.8 / 4.7 / 4.6 | `claude-opus-4-8` / `-4-7` / `-4-6` | 1M | 128K | 5 / 25 |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 1M | 128K | 2 / 10 |
| Claude Sonnet 5 (prev) | `claude-sonnet-5` | 1M | 128K | 2 / 10 |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M | 128K | 3 / 15 |
| Claude Haiku 5.5 | `claude-haiku-5-5` | 1M | 128K | 0.10 / 0.50 (≤100K prompt), 0.50 / 2.50 above |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | 64K | 1 / 5 |

Also served: `claude-mythos-5-1` / `claude-mythos-5` (Project Glasswing only; same surface as Fable 5.1 / Fable 5).

**Retired (404):** `claude-3-5-sonnet-20241022`, `claude-3-5-sonnet-20240620`, `claude-3-7-sonnet-20250219`, `claude-3-5-haiku-20241022`, `claude-3-opus-20240229`, `claude-3-sonnet-20240229`. Replacement guidance: Sonnet 3.x → `claude-sonnet-5-5`, Haiku 3.x → `claude-haiku-5-5`. `claude-3-5-sonnet-latest` (Prisma's current default) resolved to a now-retired 3.5 Sonnet snapshot.
**Deprecated:** `claude-3-haiku-20240307` (retired 2026-04-19), `claude-opus-4-20250514` / `claude-sonnet-4-20250514` (TBD), `claude-opus-4-1` (retires 2026-08-05).

Anthropic's own guidance: default new code to `claude-opus-5-5`; "Sonnet"/"Haiku" without a version means `claude-sonnet-5-5` / `claude-haiku-5-5`; use Fable only when explicitly asked (pricing above Opus tier, 30-day data retention required — ZDR orgs get `400 invalid_request_error`).

## 2. Thinking

| Model | Omitting `thinking` | `{type:"disabled"}` | `{type:"enabled", budget_tokens}` |
|---|---|---|---|
| Fable 5 / 5.1 | adaptive (always on) | 400 | 400 |
| Opus 5.5 | adaptive (always on) | **400 at every effort** | 400 |
| Opus 5 | adaptive | accepted only at effort ≤ `high` | 400 |
| Opus 4.8 / 4.7 | **no thinking** | accepted | 400 |
| Sonnet 5.5 | adaptive | **400** (use `{type:"between_tools"}` at effort ≤ `high`, Sonnet 5.5 only) | 400 |
| Sonnet 5 | adaptive | accepted | 400 |
| Haiku 5.5 | adaptive | accepted only at effort ≤ `high` | 400 |
| Opus 4.6 / Sonnet 4.6 | no thinking | n/a | deprecated, still works |
| Haiku 4.5 and older | no thinking | n/a | the only thinking mode |

Consequences for any caller that never mentioned thinking (Prisma today):
- **Thinking counts toward `max_tokens`.** A cap sized for a no-thinking route gets consumed by thinking → `stop_reason: "max_tokens"` with a `thinking` block and no text/tool output. Anthropic: "Size `max_tokens` for the thinking as well as the reply"; 16K is the non-streaming default they recommend, 64K for long agentic turns (streaming).
- **Response can begin with `thinking` blocks**; under the default `display: "omitted"` their `thinking` field is an empty string. Read content by `type`, never by position.
- `thinking.display: "summarized"` opts into readable summaries (visibility only; billing identical).

## 3. Effort (`output_config.effort`, GA, no beta header)

- Levels: `low` | `medium` | `high` | `xhigh` | `max` on Fable 5/5.1, Opus 5.5/5/4.8/4.7, Sonnet 5.5/5, Haiku 5.5. Opus 4.6 / Sonnet 4.6: `low`..`high`, `max` (no `xhigh`). Opus 4.5: `low`/`medium`/`high`. **Errors on Sonnet 4.5 / Haiku 4.5.**
- Location: `output_config: { effort }` (not top-level).
- **Defaults differ per model:** `medium` on Opus 5.5 and Haiku 5.5; `high` everywhere else (incl. Sonnet 5.5, Fable 5.1). Anthropic: "Set `effort` explicitly" because levels are recalibrated between generations.
- Starting points (vendor): Opus 5.5 `medium`; Sonnet 5.5 `medium` for agentic/multistep tool use, `low` for chat/classification/extraction; Haiku 5.5 `medium` default, `high` for strict instruction following.
- Effort is the only lever for thinking depth on Opus 5.5 / Fable 5.1 (thinking can't be turned off).

## 4. Sampling parameters

- `temperature` / `top_p` / `top_k`: **removed (400)** on Fable 5/5.1, Opus 5.5/5/4.8/4.7, Sonnet 5. **Non-default values 400** on Sonnet 5.5 and Haiku 5.5 (`temperature` must be 1, `top_p` 0.99; sending both is a 400; any `top_k` is a 400). Allowed on Opus 4.6 / Sonnet 4.6 / Haiku 4.5 and older.
- Assistant prefill (last assistant turn): 400 on every 4.6+ model incl. all 5.x.

## 5. Output cap

- Parameter name is unchanged: `max_tokens` (required).
- Ceiling: 128K on every 4.6+/5.x model (64K on Haiku 4.5). SDKs require streaming for very large values (TS SDK 0.32.1, the version Prisma pins, has **no** non-streaming size guard; newer SDKs reject non-streaming requests whose expected time exceeds 10 min — roughly `max_tokens` > ~21K).
- Vendor recommendation: ~16,000 for non-streaming requests; raise or lower `effort` rather than starving the cap.

## 6. Tool calling

- **Forced tool use is rejected (400)** on **Fable 5.1, Mythos 5.1, Opus 5.5, Sonnet 5.5** — `tool_choice: {type:"tool", name}` and `{type:"any"}` — on Messages, Batches and count_tokens. Verbatim: `tool_choice: type "tool" and "any" are not supported for this model.` This is a model-specific restriction, not a consequence of thinking: Fable 5, Opus 5, Sonnet 5 and older still accept forced tool choice.
- **Haiku 5.5 accepts forced tool choice, but "forced tool calls skip thinking"**: the response starts with the tool call and has no `thinking` block. Vendor: "To let the model think before it calls a tool, use `tool_choice: {type:"auto"}` and say in the prompt when to use the tool." (Same shape as Prisma's OpenAI empty-review lesson: forcing a named tool short-circuits reasoning.)
- Vendor migration pattern for "always call this one tool":
  1. `tool_choice: {type:"auto"}` (or omit it),
  2. a prompt instruction naming the tool and saying the call is required,
  3. `strict: true` on the tool definition (schema must set `additionalProperties: false` on every object) to keep schema-valid arguments,
  4. **check that a `tool_use` block was produced and retry if it wasn't** (`auto` does not guarantee a call).
  - Alternative when the tool exists only to get JSON back: structured outputs (`output_config.format`).
- `disable_parallel_tool_use: true` still works with `auto` (means "at most one call").
- **Strict / structured-output JSON-Schema limits:** not supported — recursive schemas, numerical constraints (`minimum`, `maximum`, `multipleOf`), string constraints (`minLength`, `maxLength`), complex array constraints, `additionalProperties` other than `false`. (The SDK helpers strip these and validate client-side; a hand-written schema sent raw must not contain them.) New schemas pay a one-time compilation latency (24 h cache).
- Tool-call `input` JSON escaping may differ (unicode / forward-slash) on 4.6+ — always parse, never string-match.

## 7. Request fields worth knowing

| Field | Where | Notes |
|---|---|---|
| `output_config.effort` | body | §3 |
| `thinking` | body | §2; omit for the 5.x family |
| `fallbacks` | body, **beta** endpoint/header | §9 |
| `strict` | per tool definition | §6 |
| `inference_geo` | body | 4.6+; not relevant here |
| `speed: "fast"` | beta, Opus 5.5/5/4.8 only | not relevant here |

## 8. Response shape

- `content[]` may contain `thinking` (possibly empty text), `text`, `tool_use`, and on fallback a `fallback` block (`{type:"fallback", from:{model}, to:{model}}`).
- On Opus 5.5 / Sonnet 5.5 / Fable 5.1, text the model writes between tool calls comes back as progress-update `thinking` blocks (empty by default).
- `stop_reason` values: `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, **`refusal`**.
- **`refusal`** (HTTP 200): safety classifiers decline a request. `stop_details` = `{type:"refusal", category, explanation}`; categories are an open set — `cyber`, `bio`, `frontier_llm`, `reasoning_extraction`, `general_harms`, or `null`. Branch on `stop_reason`, never on `stop_details` (may be `null`). Pre-output refusal → empty `content`; mid-stream refusal → partial content that must be discarded. Present on Fable 5/5.1, Opus 5.5/5 (and 4.7+ cyber safeguards), Sonnet 5.5 (five categories), Haiku 5.5 (four categories, new vs Haiku 4.5). Vendor note: "finding vulnerabilities in source code is allowed" under `cyber`, but benign security tooling can false-positive.
- `usage`: `input_tokens`, `output_tokens` (includes thinking), `cache_creation_input_tokens`, `cache_read_input_tokens`; with fallbacks, `usage.iterations[]` with a `fallback_message` entry identifies the served-by model; top-level `model` names the model that produced the message.

## 9. Refusal fallbacks (beta)

- Server-side: `fallbacks: "default"` + beta header `server-side-fallback-2026-07-01` (routes by refusal category; no model list to maintain). Array form `fallbacks: [{model}]` uses the *different* header `server-side-fallback-2026-06-01`; mixing header and form is a 400.
- Available on the Claude API and Claude Platform on AWS only — **not** Bedrock / Vertex / Foundry, **not** Batches.
- Supported requesters: Fable 5.1, Opus 5.5, Opus 5; Sonnet 5.5 only in the `"default"` form (retries `cyber` / `frontier_llm` on Sonnet 5 only). **Haiku 5.5 has no server-side fallback** — a fallback list is a 400 and `"default"` leaves the decline in place.
- Triggers on policy declines only (not rate limits / 5xx). Fallback attempts bill at the fallback model's rate.
- Vendor default: opt in for Fable 5.1 / Opus 5.5 / Opus 5 / Sonnet 5.5 code; tell the user it's enabled.
- In SDK 0.32.1: `client.beta.messages.create({ betas: [...], ...body })` maps `betas` to the `anthropic-beta` header and forwards unknown body keys (`fallbacks`) unchanged.

## 10. Tokenizer

- Opus 4.7 introduced a new tokenizer; Opus 4.8, Opus 5/5.5 and Fable 5/5.1 share it. Sonnet 5/5.5 and Haiku 5.5 use a newer tokenizer that counts the same text as **~30% more tokens** than Sonnet 4.6 / Haiku 4.5; the Opus 4.7 tokenizer uses ~1.0×–1.35× the tokens of older models.
- Vendor guidance: re-baseline with `messages.count_tokens` — never a third-party BPE.
- Prisma's `anthropic-approx` estimator is `chars/4 × SAFETY_MARGIN (1.15)` (`packages/shared/src/tokens/estimator.ts:93`); a 1.30–1.35× token inflation on code-heavy text can exceed that margin.

## 11. Prompt caching

- Minimum cacheable prefix: 512 tokens on Opus 5/5.5, Fable 5/5.1, Haiku 5.5 (was 4,096 on Haiku 4.5, 1,024 on Opus 4.8). Caches are model-scoped. Changing top-level `effort` between requests invalidates the messages cache. Not in scope for Prisma today (no `cache_control` sent).

## 12. Migration notes (Claude 3.x / 4.x → 5.x)

- Model-ID swap is mandatory for anything on a retired 3.x ID (404).
- Remove `thinking` budgets, sampling params, prefill.
- Replace forced `tool_choice` with `auto` + instruction + `strict` + presence check on the four models in §6.
- Raise `max_tokens` (thinking consumes it), set `effort` explicitly.
- Handle `stop_reason: "refusal"` before reading content; opt into fallbacks where supported.
- Thinking blocks must be passed back unchanged in multi-turn tool loops (Prisma is single-turn — no replay concern).

## 13. Verbatim error strings

```
tool_choice: type "tool" and "any" are not supported for this model.
"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
"thinking.type.enabled" is not supported for this model. ...
"thinking.type.disabled" is not supported for this model. Use "thinking.type.between_tools" for the lowest thinking setting, or "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.   (Sonnet 5.5)
"thinking.type.between_tools" is not supported for this model.
output_config.effort 'xhigh' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.
role 'system' is not supported on this model
```
All are HTTP 400 `invalid_request_error`. Retired IDs return HTTP 404 `not_found_error`.

## Deltas vs Prisma's current Anthropic assumptions

| Prisma today (`packages/providers/anthropic/src/index.ts`) | Reality for the 5.x family |
|---|---|
| `ANTHROPIC_DEFAULT_MODEL = 'claude-3-5-sonnet-latest'` | Retired → every review 404s when the model is unset. |
| `tool_choice: { type: 'tool', name }` on every review | 400 on Opus 5.5 / Sonnet 5.5 / Fable 5.1; skips thinking on Haiku 5.5 (and likely Opus 5 / Sonnet 5 / Fable 5). |
| `max_tokens` default 4096 (`DEFAULT_MAX_OUTPUT_TOKENS`, `worker.ts` `ANTHROPIC_MAX_OUTPUT_TOKENS`) | Thinking counts toward it → systematic `output_truncated` on thinking-default models. |
| No `effort` sent | Opus 5.5 / Haiku 5.5 silently run at `medium`; others at `high`. |
| `stop_reason` handled: `max_tokens` only | `refusal` → empty/partial content → currently surfaces as `schema_validation` ("missing tool_use block") — wrong kind, wrong remedy. |
| `max_context_tokens: 200000` for every model | 1M on every 4.6+/5.x model; 200K only on Haiku 4.5 and older. |
| `anthropic-approx` chars/4 × 1.15 | New tokenizers inflate tokens up to ~1.35× — the "never under-counts" claim needs checking. |
| `@anthropic-ai/sdk` 0.32.1 | Works (body forwarded untyped); `beta.messages.create({betas})` available for the fallback header. |
| No usage telemetry for Anthropic | OpenAI path emits `provider.usage`; parity would add input/output/cache tokens. |
