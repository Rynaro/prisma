# Research digest — GPT-6 / GPT-6.1 API contract (as of 2026-10-16)

> Compiled by a web-research agent from OpenAI's developer docs (now hosted at `developers.openai.com/api/docs/*`; `platform.openai.com/docs/*` 301-redirects there), the openai-python SDK types, the tiktoken repo, and GitHub bug reports for verbatim error strings. Secondary sources are marked. Items marked UNCONFIRMED could not be verified against a primary source.

## 1. Model IDs

- **GPT-6 (API):** `gpt-6-astra` (2026-09-03), `gpt-6-sol` and `gpt-6-luna` (2026-09-22). One snapshot each, same string as the ID. No dated snapshot IDs, no `-latest`, no mini/nano/codex/pro/terra variants. [models/gpt-6-astra, models/gpt-6-sol, models/gpt-6-luna, changelog]
- **GPT-6.1 (API):** only `gpt-6.1-sol` (2026-09-29). No `gpt-6.1-astra` / `gpt-6.1-luna` / bare `gpt-6.1`. [models/gpt-6.1-sol, pricing]
- Pricing lists exactly four GPT-6-generation IDs: `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`. The openai-python `ChatModel` enum has the same four; `ResponsesModel` has no GPT-6-only entries.
- "Pro" is not a model: it is `reasoning.mode: "pro"` on GPT-5.6 / GPT-6 via Responses (`gpt-5-pro` was deprecated to `gpt-5.6-sol` + `reasoning.mode: pro`). [deprecations, responses/create]
- No bare `gpt-6` / `gpt-6.1` alias (`models/gpt-6` is 404). Contrast: `gpt-5.6` aliases to `gpt-5.6-sol`.
- **ChatGPT-tracking alias is now bare `chat-latest`** (400K context, 272K max input, Chat Completions + Responses, snapshot updated regularly). Old `gpt-5.x-chat-latest` IDs are deprecated. OpenAI recommends the GPT-6 family (currently `gpt-6-astra`) for production API, not `chat-latest`. [models/chat-latest, changelog]
- Azure Foundry lists versions `gpt-6-astra 2026-09-03`, `gpt-6-sol 2026-09-22`, `gpt-6-luna 2026-09-22`, `gpt-6.1-sol 2026-09-29` (Azure deployment versions, not OpenAI slugs; secondary).

## 2. Endpoints

- All four models: `v1/chat/completions`, `v1/responses`, `v1/batch`. Not: Realtime, Assistants, Fine-tuning, Embeddings, legacy Completions.
- **`gpt-6-astra` and `gpt-6.1-sol`: Chat Completions accepted only for requests without tools.** "GPT-6 Astra and GPT-6.1 Sol support Chat Completions, but tool calling requires Responses." / "Chat Completions does not support function calling with GPT-6 Astra or GPT-6.1 Sol." [guides/latest-model, guides/reasoning]
- **`gpt-6-sol` and `gpt-6-luna`:** "support function calling in Chat Completions only with `reasoning_effort: "none"`." Any other effort (including the default `medium`, i.e. omitting the field) with `tools` present is a 400. [guides/latest-model, models/gpt-6-sol]
- General rule since GPT-5.4: "Chat Completions does not support tool calling with `reasoning_effort` values other than `none`." [guides/migrate-to-responses]
- **Chat Completions is not deprecated:** "While Chat Completions remains supported, Responses is recommended for all new projects." No deprecation entry in 2026. [migrate-to-responses, deprecations]
- New endpoints, not needed here: `POST /v1/decisions` (beta, `gpt-6-luna` only, no function tools); Agents API beta (2026-09-10); Responses multi-agent beta for GPT-5.6 and GPT-6.1 Sol. `/v1/responses` remains the recommended route for stateless function calling.

## 3. Reasoning parameters

- Full API enum (both endpoints): `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; "Not all reasoning models support every value." [responses/create, chat/create, SDK `reasoning_effort.py`]
- **`gpt-6-astra`:** `low`, `medium`, `high`, `xhigh`, `max`. **`none` → HTTP 400** on both endpoints. Default: UNCONFIRMED (reasoning guide implies `medium`). [models/gpt-6-astra, guides/reasoning]
- **`gpt-6-sol` / `gpt-6-luna`:** `none`, `low`, `medium` (default), `high`, `xhigh`, `max`.
- **`gpt-6.1-sol`:** `low`, `medium` (default), `high`, `xhigh`, `max`. "The `none` and `minimal` reasoning efforts are not supported." [models/gpt-6.1-sol, latest-model]
- **`minimal` is not supported on any GPT-6 model.** Migration: "If your existing request uses `minimal`, start with `low` and compare results." [latest-model]
- `max` is new as of GPT-5.6 (2026-07-09), works on GPT-5.6 / GPT-6 via Responses. Azure (secondary): `max` only with GPT-6 / GPT-5.6 on Responses.
- Flat `reasoning_effort` still accepted on Chat Completions; `reasoning.effort` on Responses. [latest-model]
- Other `reasoning` fields on Responses: `summary` (`auto` | `concise` | `detailed`; `generate_summary` deprecated), `mode` (`standard` | `pro`), `context` (`auto` | `current_turn` | `all_turns`; GPT-5.6+ default `all_turns`). No separate thinking-budget field; `max_output_tokens` is the only cap and includes reasoning tokens. [responses/create]
- With `store: false`, reasoning output items carry `encrypted_content` by default; `include: ["reasoning.encrypted_content"]` is accepted for compatibility but not required. [guides/reasoning]
- New: `configuration_update` input item to change effort mid-conversation without breaking the cached prefix (GPT-6 only; multi-turn only — irrelevant to a one-shot call).

## 4. Sampling parameters

- Official rule for all GPT-6 models: "When reasoning effort is not `none`, remove `temperature`, `top_p`, and `top_logprobs`." "For Chat Completions, also remove `logprobs`." "For Responses, remove `message.output_text.logprobs` from `include`." → accepted only at effort `none` on `gpt-6-sol` / `gpt-6-luna`; never accepted on `gpt-6-astra` / `gpt-6.1-sol`. [latest-model]
- Changelog (Astra): no custom `temperature` / `top_p` or `logprobs`.
- Observed rejection (gpt-6-luna, `/v1/responses`, HTTP 400, secondary): `{"error": {"message": "Unsupported parameter: 'temperature' is not supported with this model.", "type": "invalid_request_error", "param": "temperature", "code": null}}`. Same for gpt-6-sol "for every value, including 0".
- `seed`: not a Responses parameter at all. On Chat Completions still documented ("Beta … best effort") with no GPT-6 caveat; actual GPT-6 behaviour on chat UNCONFIRMED.
- `presence_penalty` / `frequency_penalty`: not mentioned in OpenAI's GPT-6 docs; Azure's table is self-contradictory and unreliable. UNCONFIRMED; expect 400 when effort is not `none`.

## 5. Output cap

- Chat: `max_tokens` "is now deprecated in favor of `max_completion_tokens`". Observed on gpt-6-* (secondary): 400 `"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."`
- Responses: `max_output_tokens`, "An upper bound … including visible output and reasoning tokens." Unchanged.
- Ceiling: **128,000 max output tokens** on all four models. No documented minimum. Guidance: "reserving at least 25,000 tokens for reasoning and outputs when you start experimenting". [model pages, guides/reasoning]

## 6. Tool calling

- `tool_choice` on Responses: `"none"`, `"auto"`, `"required"`, `{type:"function", name}`, `{type:"allowed_tools", mode, tools}`, plus `custom` / `mcp` / hosted tool types. Chat keeps `{type:"function", function:{name}}` and `allowed_tools`.
- `parallel_tool_calls` unchanged. `strict`: Responses normalizes schemas into strict mode when possible; Chat stays non-strict by default. Structured outputs supported on all four models.
- Function-call output item unchanged: `{type:"function_call", name, arguments (JSON string), call_id, id?, status?}` plus new optional `async`, `caller`, `namespace`. Chat `choices[0].message.tool_calls[]` unchanged; a `type:"custom"` variant exists.
- New opt-in tool features (no effect on a single forced function tool): `async: true`, `tool_search`, `namespace`, `programmatic_tool_calling`, custom tools with `grammar`, `max_tool_calls` (built-in tools only). `mcp.connector_id` deprecated for models released after 2026-09-01.
- Both `tool_choice: "required"` and `{type:"function", name}` remain valid on `/v1/responses` for all GPT-6 models (observed 200 with a tool call on Astra and 6.1 Sol; secondary).

## 7. Request fields worth knowing

- `text.verbosity`: `low` | `medium` | `high` (default `medium`); works on GPT-6. Chat spelling: top-level `verbosity`. [responses/create, deployment-checklist]
- `service_tier`: `auto` | `default` | `flex` | `scale` | `priority` | `fast` | `ultrafast`. `fast` replaced Priority Processing (`priority` still accepted). `ultrafast` for `gpt-6-astra` (US) and `gpt-6.1-sol` (US/EU), Responses only. Chat enum lacks `ultrafast`.
- `prompt_cache_key`: accepted but "On GPT-5.6 and later, OpenAI handles cache routing automatically; the key is not needed."
- `prompt_cache_retention`: **deprecated**; "For `gpt-5.5`, `gpt-5.5-pro`, and future models, only `24h` is supported." Replacement: `prompt_cache_options: { ttl: "30m" }` (GPT-5.6+ only).
- `safety_identifier`, `metadata`, `truncation` (`auto` | `disabled`, default `disabled` → 400 on overflow), `include`, `background`, `context_management`, `conversation`, `previous_response_id`, `max_tool_calls`, `top_logprobs` unchanged.
- New in 2026 (not required): `moderation` object, `access_programs.cyber`, `prompt_cache_breakpoint`, assistant `phase`.

## 8. Response shape

- Responses `status`: `completed` | `failed` | `in_progress` | `cancelled` | `queued` | `incomplete`.
- `incomplete_details.reason`: `max_output_tokens`, `max_messages`, `content_filter`, `steered` (WebSocket steering only; unreachable on a one-shot HTTP call).
- Chat `finish_reason`: `stop` | `length` | `tool_calls` | `content_filter` | `function_call` (deprecated). Unchanged.
- Responses `usage`: `input_tokens`, `input_tokens_details.{cached_tokens, cache_write_tokens (new)}`, `output_tokens`, `output_tokens_details.reasoning_tokens`, `total_tokens`. Chat `usage.prompt_tokens_details` adds `cache_write_tokens`, `image_tokens`, `text_tokens`; `completion_tokens_details` has `reasoning_tokens`, `text_tokens`, prediction fields.
- Error payload shape unchanged (`error.{message,type,param,code}`). New codes: 429 `rate_limit_error` / `slow_down`; 503 `service_unavailable_error` / `server_is_overloaded` (honour `Retry-After`); 429 on hard spend limits; 400 `invalid_request_error` with `param:"service_tier"`. [guides/error-codes]

## 9. Tokenizer

- OpenAI publishes no encoding for GPT-6. `openai/tiktoken` `model.py` has no `gpt-6` entry (prefix map stops at `gpt-5`); issue #608 ("Update for gpt-6 models", open since 2026-09-24) unanswered. tiktoken encodings: `o200k_base`, `cl100k_base`, `o200k_harmony`, `p50k_*`, `r50k_base`, `gpt2` — nothing new.
- Empirical (secondary, linked in #608): GPT-6 Astra/Sol/Luna produce token counts identical to GPT-5 across a 31-fixture corpus → `o200k_base`.
- `js-tiktoken` latest is 1.0.21; `getEncodingNameForModel` is an exact-name switch with no gpt-5.4+/gpt-6 names (throws "Unknown model"); `getEncoding("o200k_base")` works regardless.
- **Conclusion: use `o200k_base` for `gpt-6*` / `gpt-6.1*`** (best available evidence; officially UNCONFIRMED). Do not rely on model-name lookup.

## 10. Context window / max output

- All four (`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6.1-sol`): **context window 1,050,000; max input 922,000; max output 128,000.** Long-context pricing applies to prompts > 272K input tokens (2× input/cache, 1.5× output). Knowledge cutoffs: Astra & 6.1 Sol 2026-04-30, Sol 2026-04-20, Luna 2026-05-18.
- `chat-latest`: 400,000 / 272,000 / 128,000.

## 11. Prompt caching

- Minimum cacheable prompt 1,024 tokens for GPT-5.6+. Cache writes 1.25× input (not additive); reads 0.1× on most GPT-5.6+ models, **0.05× on `gpt-6.1-sol`**.
- `prompt_cache_options.ttl: "30m"` is the only TTL; `prompt_cache_retention` deprecated. Routing automatic on GPT-5.6+. Up to four breakpoints per request.
- Interaction with `store: false`: nothing indicates caching requires storage (UNCONFIRMED, no contrary evidence).

## 12. Migration notes (GPT-5.x → GPT-6 / 6.1)

- Official checklist: set model; keep effective effort "substituting `low` for `none` on Astra and Sol [6.1]" and test `minimal` → `low`; "Move tool calling to the Responses API"; remove `temperature` / `top_p` / `top_logprobs` (+ `logprobs` on chat / logprobs include on Responses) when effort is not `none`; replace `prompt_cache_retention` with `prompt_cache_options.ttl:"30m"`. [latest-model]
- Breaks on `gpt-6-astra` / `gpt-6.1-sol` that worked on `gpt-5.6-sol`: `reasoning.effort: "none"` (400); Chat Completions with `tools` at effort `none` (400 because `none` itself is rejected); any sampling param at all.
- Still works on `gpt-6-sol` / `gpt-6-luna` as on gpt-5.6: `none` effort; chat-with-tools when `reasoning_effort: "none"`.
- Active shutdowns: `gpt-5.3-codex`, `gpt-5.1` → `gpt-6-sol`; `gpt-5.4-nano` → `gpt-6-luna` (shutdown 2027-04-01); **`gpt-4o-2024-08-06`, `gpt-4o-2024-11-20`, `gpt-4o-mini-2024-07-18`, `gpt-4.1-2025-04-14`, `gpt-4.1-mini-2025-04-14` → `gpt-6-luna`, shutdown 2027-01-14** (announced 2026-10-14); `gpt-5-2025-08-07`, `gpt-5-mini/nano` shutdown 2026-12-11. Assistants API shut down 2026-08-26. [deprecations]

## 13. Verbatim error strings

- Chat + tools + effort not `none` (Astra; same for 6.1 Sol; documented for gpt-5.6-sol): `"Function tools with reasoning_effort are not supported for gpt-6-astra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'."` — `type: "invalid_request_error"`, `param: "reasoning_effort"`, `code: null`; fires even when `reasoning_effort` is omitted. A "for this model" variant has also been observed.
- Chat `reasoning_effort: "none"` on Astra / 6.1 Sol: `"Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported values are: 'low', 'medium', 'high', and 'xhigh'."` — `type: "invalid_request_error"`, `param: "reasoning_effort"`, `code: "unsupported_value"`.
- Responses `reasoning.effort: "none"` on Astra / 6.1 Sol: `"Unsupported value: 'none' is not supported with the '<model>' model. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'."` (HTTP 400).
- Sampling: `"Unsupported parameter: 'temperature' is not supported with this model."` — `type: "invalid_request_error"`, `param: "temperature"`, `code: null` (gpt-6-luna, `/v1/responses`).
- Chat `max_tokens`: `"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."` (gpt-6-*).
- Service tier: `"Invalid service_tier argument: The requested service tier is not allowed for this project."` (`param: "service_tier"`).
- All but the service_tier and gpt-5.6-sol strings come from GitHub bug reports, not OpenAI docs; wording may change.

## Deltas vs Prisma's current GPT-5.x assumptions

- **Routing regex is fine; tokenizer rule is not.** `^(o[1-9]|gpt-(?:[5-9]|\d{2,}))` already matches `gpt-6-*` / `gpt-6.1-*` and routes them to `/v1/responses` (correct and required for tools on Astra / 6.1 Sol). But `OPENAI_TOKENIZER_FAMILY_MAP` is exact-match with a `cl100k` fallback, so `gpt-6*` and even `gpt-5.6-sol` are counted with the wrong vocabulary today.
- **`max_context_tokens: 128000` is wrong for GPT-6:** window 1,050,000, max input 922,000, max output 128,000. 128K is the *output* ceiling. > 272K input triggers 2× pricing — a cost guard, not an API limit.
- **`reasoning_effort` must be validated per model:** `none` is a 400 on `gpt-6-astra` and `gpt-6.1-sol`; `minimal` is a 400 on all GPT-6; `max` is newly valid. `gpt-6-sol` / `gpt-6-luna` still accept `none`.
- **Sampling params on `/responses`:** the current path drops only `seed`. For GPT-6, `temperature`, `top_p`, `top_logprobs` and `include: message.output_text.logprobs` must be stripped whenever effort is not `none` — always on Astra / 6.1 Sol. `presence_penalty` / `frequency_penalty` are not Responses params at all.
- **`respond()` flow (plain `/chat/completions` with `temperature` / `top_p` / `seed`):** 400s on `gpt-6-astra` / `gpt-6.1-sol` (no `none` available). On `gpt-6-sol` / `gpt-6-luna` works only with explicit `reasoning_effort: "none"` (default is `medium`). Either strip sampling params for reasoning models or route this flow through `/responses`. `seed` on chat for GPT-6 is UNCONFIRMED.
- **Classic chat path `max_tokens`:** if a GPT-6 model ever reaches the chat path, `max_tokens` is a 400. `chat-latest` is not matched by the regex and would be sent to chat with `max_tokens` and a forced tool — it is a reasoning-capable alias, so assume it rejects both.
- **`tool_choice: 'required'` on `/responses`** remains valid; the forced single-function object is also valid. No change to the `function_call` output item; ignore the new optional fields.
- **Prompt caching:** translate `prompt_cache_retention` → `prompt_cache_options: { ttl: "30m" }` if ever sent; `prompt_cache_key` harmless but unnecessary.
- **`store: false`:** still correct; reasoning items will carry `encrypted_content` (response larger) — the parser must keep selecting `function_call` items by type.
- **New usage fields:** `input_tokens_details.cache_write_tokens`; `incomplete_details.reason` may be `max_messages` / `steered` (unreachable here).
- **Error handling:** 429 `slow_down` and 503 `server_is_overloaded` with `Retry-After`; treat 400 `code: "unsupported_value"` / `param: "reasoning_effort"` and `"Unsupported parameter: '<param>'"` as configuration errors with a targeted remedy, never retried.
- **Deprecation pressure on the classic path:** the dated gpt-4o / gpt-4.1 snapshots shut down 2027-01-14 (replacement `gpt-6-luna`), so the chat-completions "classic" branch will soon have no first-party models except `chat-latest`.
- **GPT-6 vs GPT-6.1 differences that matter here:** `gpt-6-sol` accepts `none` and chat-with-tools at `none`; `gpt-6.1-sol` does not. 6.1 Sol has cheaper cache reads, the Ultrafast tier, EU-residency Fast mode, and the multi-agent beta. Window, output cap, tool shapes, endpoints are identical.
