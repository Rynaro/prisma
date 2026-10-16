# Scout report — OpenAI model-family assumptions (GPT-6 / GPT-6.1 compatibility)

> ATLAS scout, standard tier, read-only. 2026-10-16. Base: `main` @ `f28be3e`.
> DECISION_TARGET: enumerate every place where an OpenAI *model-family* assumption is encoded, so a spec can make Prisma fully compatible with the GPT-6 and GPT-6.1 families.

Paths are relative to the repo root.

## Already known to the orchestrator (not re-scouted)

- `packages/providers/openai/src/index.ts` — `resolveTokenParam`, `resolveApiStyle`, `toResponsesArgs`, `resolveToolChoice`, `OPENAI_PASSTHROUGH_DENYLIST`, `OPENAI_TOKENIZER_FAMILY_MAP` (exact-match map, falls back to `cl100k`), `OPENAI_CAPABILITIES` (`max_context_tokens: 128000` hardcoded at `:644`), `OpenAIProvider.review()` / `respond()`, `extractUsage`, `isOutputTruncated`.
- `packages/providers/openai/src/client.ts` — wire shapes (`OpenAIChatCompletionsArgs`, `OpenAIResponsesArgs`, `OpenAITextCompletionArgs`), `createOpenAIClient`.
- `packages/shared/src/model-slug.ts` — `REASONING_MODEL_RE = /^(o[1-9]|gpt-(?:[5-9]|\d{2,}))/i`, `isReasoningModel`.
- `packages/shared/src/tokens/estimator.ts` — js-tiktoken, `cl100k` / `o200k` / `anthropic-approx`.
- `docs/model-compatibility.md`.

## Findings

**FINDING-001 — the orchestrator's no-findings notice is the only runtime use of `isReasoningModel` outside the adapter.**
- `apps/github-app/src/pipeline/orchestrator.ts:43` imports it.
- `:377-378` appends: "`<model>` is a reasoning model and may be under-producing … try `openai/gpt-4.1` or set `OPENAI_TOOL_CHOICE=required` (see docs/model-compatibility.md)".
- `:1485-1506` is the "no findings" comment path; builds `reasoningNotice` with the same advice, hardcoding `openai/gpt-4.1`.
- Implication: the regex already matches `gpt-6*` / `gpt-6.1*`, so the notice fires for them. Its advice (try gpt-4.1, set `tool_choice=required`) is stale for a model that routes to `/responses` with `required` already.

**FINDING-002 — `apps/github-app/src/worker.ts` duplicates the same advice.**
- `worker.ts:709` repeats the reasoning-model reply text and recommends gpt-4.1.
- Implication: the text lives in three places (`orchestrator.ts:378`, `:1506`, `worker.ts:709`).

**FINDING-003 — the `capability` remedy is a narrow regex pair.**
- `apps/github-app/src/provider-notices.ts:29` `FUNCTION_TOOLS_ON_CHAT_RE = /function tool/i`; `:30` `CHAT_COMPLETIONS_RE = /chat\/completions/i`.
- `:17-21`, `:33-43` hold the gpt-5.6-luna example and the remedy text (names `OPENAI_API_STYLE`, warns against `reasoning_effort: 'none'`).
- Implication: a GPT-6/6.1 rejection worded differently (unsupported effort value, unsupported sampling parameter) gets only the generic notice. ADR-007 line 129 flags a future family that rejects tools on Responses as needing a third routing arm.

**FINDING-004 — the worker parses env values leniently; no allowed-value validation for the model.**
- `worker.ts:169-236` builds `OpenAIProvider`. `:175` `OPENAI_MODEL` free string; `:179` `OPENAI_BASE_URL`; `:188-195` `OPENAI_TOKEN_PARAM` (`max_tokens` | `max_completion_tokens` | `auto`, else silently ignored); `:202` `OPENAI_MAX_OUTPUT_TOKENS` via `resolveMaxOutputTokens(..., 4096)`; `:211-214` `OPENAI_TOOL_CHOICE`; `:222-225` `OPENAI_API_STYLE`; `:231-233` `onUsage` → `log('provider.usage', { provider: 'openai', ...usage })`.
- `OPENAI_TIMEOUT_MS` is not read anywhere in `apps/` (confirmed by the orchestrator via grep) — pre-existing gap, unrelated to GPT-6.
- `main.ts:115-119` only checks that a provider key exists.
- Comment at `worker.ts:217` hardcodes "gpt-5.6*, gpt-6+".

**FINDING-005 — `GenerationSchema` is closed and narrow.**
- `packages/shared/src/schemas/config.ts:99-124`: `max_output_tokens` int positive (`:106`), `temperature` 0–2 (`:112`), `top_p` 0–1 (`:116`), `seed` int (`:122`). Nothing else.
- `ProviderOptionsSchema` is `record(string, record(string, unknown))` (`:145-147`).
- `packages/shared/src/schemas/provider.ts:62` types `request_shaping.provider_options` as `record(unknown)`; `:48` and `:243` carry `generation`.
- Implication: no enum for `reasoning_effort` / `verbosity` / `reasoning`, so new GPT-6 values pass through untouched (no early validation). `temperature` / `top_p` are always forwarded when set, and GPT-6 rejects them.

**FINDING-006 — the orchestrator maps config into `request_shaping` without model-family branching.**
- `orchestrator.ts:455-461` drops the model when the slug's provider differs from the active provider; `:465-470` `hasGeneration` checks four fields; `:475-477` takes `provider_options[activeProvider]`; `:479-501` sets `request_shaping.model`, `generation`, `deterministic_seed` (from `generation.seed`), `provider_options`.
- Implication: any new generation field must be added to the hand-maintained `hasGeneration` list at `:467-470`.

**FINDING-007 — error mapping marks many 400s as `capability`.**
- `packages/providers/openai/src/error-mapping.ts:213` 401/403 → `auth`; `:217` 429 → `rate_limit` (+ `retry_after_ms`); `:226` 5xx → retryable `transport`; `:233` 400 with `errorCode === 'context_length_exceeded' || 'model_not_found'` → `capability`; `:239-247` `looksLikeCapability` when type ∈ {`invalid_request_error`, `invalid_request`, `model_not_found`} AND message includes any of `model`, `unsupported`, `capability`, `tool`, `function` → `capability`; `:251`, `:254` else non-retryable `transport`.
- No check on `unsupported_parameter` / `unsupported_value` codes, nor on `param`.
- Implication: a GPT-6 400 for `temperature` ("Unsupported parameter: 'temperature' is not supported with this model.") contains "unsupported" → `capability`, but with no targeted remedy.

**FINDING-008 — `max_context_tokens: 128000` drives all chunking; it is per-adapter, not per-model.**
- Hardcode: `packages/providers/openai/src/index.ts:644`. Only reader: `orchestrator.ts:840` → `:843` `safety = ceil(safety_fraction × window)`, `:844` `hard_cap_in = window − reserved_output − prompt_overhead − safety`, `:845` `effectiveBudget = min(chunking.call_token_budget, hard_cap_in)`, `:865` `absoluteCapTokens = window − reservedOutput − promptOverhead`, `:849` reads `tokenizer_family`.
- Schema: `packages/shared/src/schemas/provider.ts:360` (`max_context_tokens` int positive), `:365` (`tokenizer_family` enum `cl100k | o200k | anthropic-approx`).
- Copilot also 128000 (`packages/providers/copilot/src/index.ts:47`); Anthropic and fake 200000.
- Implication: GPT-6's 1.05M window / 922K max input makes Prisma chunk far too aggressively. `capabilities` is a static object derived at construction, so the window cannot vary with a per-request `request_shaping.model`.

**FINDING-009 — tokenizer dependency is `js-tiktoken@1.0.21` (latest on npm).**
- `packages/shared/package.json:15` pins `^1.0.21`; lockfile resolves `1.0.21`.
- Installed `node_modules/js-tiktoken/dist/ranks/` contains exactly: `cl100k_base`, `gpt2`, `o200k_base`, `p50k_base`, `p50k_edit`, `r50k_base`. No `o200k_harmony`, no newer encoding. (Verified by the orchestrator via shell.)
- The package's model-name switch knows gpt-4o / gpt-4.1 / gpt-4.5 and stops there; `getEncoding('o200k_base')` works regardless.

**FINDING-010 — tests that pin model slugs or families.**
- `packages/shared/tests/model-slug.test.ts` `:205-233` reasoning cases (gpt-5.4-nano, gpt-5-nano, gpt-5, gpt-6 at `:217` "gpt-6 (future)", gpt-10 `:221`, o1, o3, o4-mini); `:238-254` classic cases; `:259` empty; `:263`, `:267` case-insensitive.
- `packages/providers/openai/tests/provider.test.ts` `:489-534` `resolveTokenParam` auto (gpt-6 at `:513`); `:545-557` overrides; `:590-608`, `:758-770` token param through provider; `:996-1047` `resolveToolChoice` auto (no gpt-6 case); `:1071-1198` tool_choice + prompt per family; `:1250-1403` `/responses` routing (`:1289` `resolveApiStyle`, `:1302` gpt-5.6); `:1504-1580` effort translation; `:1688-1711` endpoint selection (gpt-5.5 `:1689`, gpt-5.6 variants `:1705`); `:1754-1800` seed + capability; `:1886-1944` usage + `onUsage`. No gpt-6.1 case; no gpt-6 routing-to-responses case.
- `packages/providers/openai/tests/transport.test.ts` `:106` gpt-5.6 → `/v1/responses`; `:156` classic → chat; `:197` base URL; `:210` function_call item past a reasoning item; `:310`, `:322` error mapping from `/responses`.
- `apps/github-app/tests/provider-notices.test.ts` `:11`, `:14`, `:21`, `:31`, `:37` (`gpt-9`), `:39` (128000 context message must not trigger the remedy).
- `apps/github-app/tests/pipeline/orchestrator.test.ts` `:635-665` #40 remedy; `:1904-1933` request_shaping; `:2027` gpt-5.4-nano hint, `:2048` o3 hint, `:2067` gpt-4o no hint, `:2100-2128`.
- `apps/github-app/tests/worker/command-dispatch.test.ts` `:775-882` configuration echo.
- `packages/shared/tests/schemas.test.ts` `:789-898` Generation + provider_options (`reasoning_effort: 'low'` at `:870`).
- `evals/runner/tests/pipeline-runner.test.ts:132-183` uses `fake/gpt-5.4-nano`.

**FINDING-011 — evals contain no model-family logic.**
- `evals/scenarios.yaml:58-61` (`reasoning-model-empty-review`, tag `reasoning_model_compatibility`); `evals/fixtures/reasoning-model-empty-review.yaml:12` (`model: openai/gpt-5.4-nano`), asserting "reasoning model" and "gpt-5.4-nano" (`:84-85`); `evals/fixtures/generation-provider-options-roundtrip.yaml:11,20,27`.
- Fake provider declares only `max_context_tokens: 200000` (`packages/providers/fake/src/index.ts:23`).

**FINDING-012 — documentation is stale or hardcodes families.**
- `docs/install-github-app.md:107` says the OpenAI adapter targets `/chat/completions` only (stale since ADR-007); `:114` `OPENAI_MODEL` default `gpt-4o`.
- `docs/deployment.md:78` default; `:81` "o-series, gpt-5"; `:158-172` env docs; `:170` "gpt-5.6* and later majors".
- `docs/config-spec.md:50-56`, `:630-735` use `gpt-5.4-nano`; `:56` "gpt-5+/o-series"; `:64`, `:87-95` `max_output_tokens` + passthrough; `:494` "128_000 (OpenAI)".
- `docs/contributing.md:124` cites 128000. `adr-005-openai-provider.md:17` chat-only; `docs/open-questions.md:94` repeats it. ADR-007 lines 32-34, 63, 89, 101, 108-113, 129 are the current design. `adr-006-diff-chunking-stability.md:33,43,65` window/family/enum.
- `.env.example:26-29`, `deploy/.env.prod.example:39-42`, `config/deploy.yml:87-101` list only key / model / base URL — none list `OPENAI_TOKEN_PARAM`, `OPENAI_TOOL_CHOICE`, `OPENAI_API_STYLE`, `OPENAI_MAX_OUTPUT_TOKENS`.

## GAPs

- GAP-2: `packages/providers/openai/src/prompt.ts` and `docs/observability.md` `provider.usage` field list not read.
- GAP-4: `repo-config.ts`, `docker-compose.yml`, `error-mapping.ts` head (`readErrorCode` / `readErrorType`) not fully verified.
- GAP-5: the real GPT-6/6.1 wire contract is external — see `research-digest.md`.

## Recommended handoff

RAMZA for spec. Suggested scope: per-model capability resolver (window + tokenizer) replacing the static `max_context_tokens`; effort / sampling normalization on the Responses path; shared notice-text helper; widened error-mapping codes with `param`-aware remedies; a gpt-6 / gpt-6.1 test matrix; doc refresh.
