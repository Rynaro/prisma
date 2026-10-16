# Spec — GPT-6 / GPT-6.1 model-family compatibility for the OpenAI adapter

- Task label: `RAMZA [Fable 5.1 | Unknown] - Spec GPT-6 / 6.1 compatibility`
- Status: Proposed — 2026-10-16
- RS tier: `full` (hand-applied; `bin/ramza-*` tools are unavailable in this host, so the right-sizing, lint, freeze, drift and confidence rubrics below were applied by hand)
- Inputs (evidence base; decisions settled): `docs/_planning/gpt6-compat/research-digest.md`, `docs/_planning/gpt6-compat/scout-report.md`, `docs/_planning/gpt6-compat/reasoning-report.md` (FORGE D1–D11)
- `[USER-RATIFY]`: D3 (forward effort verbatim), D7 (32,768 reasoning-family default output cap), D9 (keep `gpt-4o` default + startup warning). All three are specified fully; implementation proceeds unless the user reverses one.
- Hand-applied gates: right-sizing = full (≥5 files, env/doc surface, cross-package schema); lint = every AS has Given/When/Then and a test anchor; freeze = D1–D11 are inputs, not re-opened; drift = each § 3 subsection names the FORGE decision it implements; confidence = 0.80 (VALIDATE, pending the three ratifications).
- Validation gates: `make typecheck && make lint && make test && make eval` (host equivalents: `pnpm run typecheck && pnpm run lint && pnpm test && ./node_modules/.bin/tsx evals/runner/src/cli.ts --all`).
- Orchestrator addendum: § 3.12 (usage telemetry) was added by the orchestrator after RAMZA's hand-back; it is additive and does not reopen D1–D11.

## 1. Problem statement and goals

What breaks today on `gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna` / `gpt-6.1-sol` / `chat-latest`, in priority order:

1. **Wrong window → over-chunking.** `OPENAI_CAPABILITIES.max_context_tokens = 128000` (`packages/providers/openai/src/index.ts:644`) feeds `hard_cap_in` (`apps/github-app/src/pipeline/orchestrator.ts:840-845`). GPT-6 accepts 922,000 input tokens; Prisma plans 105,944-token batches, roughly 8× more calls than needed.
2. **`cl100k` over-count for gpt-5.6+ / gpt-6.** `OPENAI_TOKENIZER_FAMILY_MAP` (`index.ts:584-626`) is exact-match; `gpt-5.6-sol`, every `gpt-6*` and `chat-latest` fall to `cl100k` (digest § 9: o200k is the evidence).
3. **`temperature` / `top_p` 400 via `generation`.** Forwarded unconditionally (`index.ts:1216-1221`, `:1343-1348`); GPT-6 rejects them at any effort other than `none` (digest § 4).
4. **4096 cap truncation.** `OPENAI_MAX_OUTPUT_TOKENS` defaults to 4096 (`apps/github-app/src/worker.ts:202`); the cap includes reasoning tokens, so a medium-effort GPT-6 review truncates systematically and burns split-retries.
5. **`chat-latest` misroute.** Not matched by `REASONING_MODEL_RE` (`packages/shared/src/model-slug.ts:67`) → chat + `max_tokens` + forced function → 400.
6. **Stale notices / remedies.** Empty-review advice ("try `openai/gpt-4.1`, set `OPENAI_TOOL_CHOICE=required`") exists in three copies (`orchestrator.ts:378`, `:1506`, `worker.ts:709`); the capability remedy matches one signature (`apps/github-app/src/provider-notices.ts:29-30`); `unsupported_value` / `unsupported_parameter` codes and `param` are ignored (`packages/providers/openai/src/error-mapping.ts:230-252`).
7. **Stale docs** (scout FINDING-012).

Goals: all five IDs route to `/responses` with `tool_choice: 'required'` and `max_output_tokens`; window, tokenizer and default output cap are family-correct; vendor-neutral `generation` config never 400s on a model switch; every GPT-6 400 becomes a `capability` error with a `param`-targeted remedy; classic-model wire bytes are unchanged.

## 2. Non-goals

- No per-request `capabilities` (`Provider.capabilitiesFor(model)`); no new `ProviderCapabilities` fields (D1-d, D2 rejected).
- No effort normalization (`minimal`→`low`, `none`→`low`); no per-model effort table (D3).
- No `/responses` for `respond()` (D5); no new tool types (`async`, `tool_search`, `custom`); no `prompt_cache_options`, `service_tier`, `verbosity` handling.
- No default-model flip (D9); no new env vars; no `GenerationSchema` growth.
- No change to classic-model wire bytes (`gpt-4o`, `gpt-4.1`, `gpt-4`, `gpt-3.5-turbo` on chat).
- `OPENAI_TIMEOUT_MS` wiring (pre-existing gap, OQ-3); gpt-5.x / o-series window values (UNKNOWN, stay 128,000).

## 3. Design

New helpers are pure, exported for unit tests, and live in `packages/providers/openai/src/index.ts` unless stated. Notes are key-only (G-1).

### 3.1 Context window resolver — implements D1

```ts
export const OPENAI_MAX_INPUT_TOKENS_DEFAULT = 128_000;   // classic, gpt-5.x, o-series, unknown
export const OPENAI_MAX_INPUT_TOKENS_GPT6 = 922_000;      // digest § 10: max input, not the 1.05M window
export const OPENAI_MAX_INPUT_TOKENS_CHAT_LATEST = 272_000;
const GPT6_WINDOW_RE = /^gpt-6(?:\.\d+)?(?:-|$)/i;
export function resolveOpenAIContextWindow(model: string): number;
```

Rule, in order: (1) `GPT6_WINDOW_RE.test(model)` → 922,000; (2) `model.toLowerCase() === 'chat-latest'` → 272,000; (3) else 128,000. Decided narrower than "gpt-6 and later": a future `gpt-7` is UNKNOWN, and 128,000 over-chunks (safe) whereas 922,000 risks `context_length_exceeded`. `gpt-6`, `gpt-6.1`, `gpt-6-astra`, `gpt-6.1-sol` match; `gpt-60` does not. gpt-5.x and o-series stay 128,000 (UNKNOWN per D1). Placed beside `resolveOpenAITokenizerFamily`.

Constructor (`index.ts:1083-1101`): add `max_context_tokens: options.capabilities?.max_context_tokens ?? resolveOpenAIContextWindow(this.model)` — same precedence as `tokenizer_family`. The `OPENAI_CAPABILITIES` literal stays 128000 (correct for the default model). JSDoc on `ProviderCapabilitiesSchema.max_context_tokens` (`packages/shared/src/schemas/provider.ts:360`) reworded to "maximum input tokens per call"; no schema change. Classic: `gpt-4o` → 128,000, identical.

### 3.2 Per-request input guard and worker coupling — implements D2 (and D1's hard constraint)

**Adapter guard** (`index.ts:1123-1142`): move `const model = input.request_shaping?.model ?? this.model` above the guard. Activation unchanged (`this.maxTokensPerCall !== undefined`). Threshold:

```
windowFor(model) = model === this.model
  ? this.capabilities.max_context_tokens          // explicit capabilities win for the deployment model
  : resolveOpenAIContextWindow(model)
inputCap = Math.min(this.maxTokensPerCall, windowFor(model))
```

Throw `over_budget` with `hard_cap_in: inputCap` when `estimate > inputCap`; message `request exceeds per-call token budget: estimated ${estimate} tokens, cap ${inputCap}`. The orchestrator already splits on `over_budget` (`orchestrator.ts:1080-1108`). Classic: `min(120000, 128000) = 120000`, identical. `respond()` unchanged.

**Worker coupling.** Today the orchestrator plans up to `hard_cap_in` (844,364 at 922K) while the adapter rejects above `MAX_TOKENS_PER_PR` (120,000, `worker.ts:81`), so every large batch would split twice and land in `notReviewedFiles`. Chosen fix (smallest blast radius: one optional deps field, two `Math` calls, no config mutation): make the comment at `worker.ts:67-68` true.

- `OrchestratorDeps` (`orchestrator.ts:156-197`) gains `providerLimits?: { maxTokensPerCall?: number; maxOutputTokens?: number }` (export the type as `ProviderLimits`).
- `orchestrator.ts:845`: `effectiveBudget = Math.min(chunking.call_token_budget, hard_cap_in, deps.providerLimits?.maxTokensPerCall ?? Number.POSITIVE_INFINITY)`.
- `orchestrator.ts:841`: `reservedOutput = Math.max(chunking.reserved_output_tokens, deps.providerLimits?.maxOutputTokens ?? 0)` (the D7 coupling, § 3.7); `absoluteCapTokens` (`:865`) follows automatically.
- `buildProvider` (`worker.ts:132`) returns `{ provider, providerLimits }`; `:457` destructures; both `runPipeline` calls (`:641`, `:910`) pass `providerLimits`. Build the object conditionally (`exactOptionalPropertyTypes`: omit keys rather than assign `undefined`). Anthropic/Copilot arms pass their `MAX_TOKENS_PER_PR` and resolved cap; the Fake arm passes `{}`.

Classic OpenAI: `min(1_000_000, 105_944, 120_000) = 105_944` and `max(4096, 4096)`, identical. Anthropic deployments (200K window): batches are now planned ≤ 120,000 instead of 172,904; per the worker's own description (`worker.ts:60-69`) those batches were already rejected by the adapter guard and split, so this removes a wasted call. State it in the PR description.

### 3.3 Reasoning effort — implements D3 `[USER-RATIFY]`

No change to `toResponsesArgs` effort logic (`index.ts:289-320`). `none`, `minimal`, `max` are forwarded verbatim; the API's 400 becomes actionable via § 3.11. `docs/model-compatibility.md` gets the effort × model matrix (§ 7).

### 3.4 Sampling parameters on reasoning models — implements D4

```ts
export function resolveExplicitReasoningEffort(bag: Record<string, unknown> | undefined): string | undefined;
export function shouldStripSampling(model: string, explicitEffort: string | undefined): boolean;
export const SAMPLING_KEYS_STRIPPED = ['temperature', 'top_p'] as const;
```

- `resolveExplicitReasoningEffort`: native wins (ADR-007 D3). If `bag.reasoning` is a plain object with a string `effort`, return it; else if `bag.reasoning_effort` is a string, return it; else `undefined`.
- `shouldStripSampling` = `isReasoningModel(model) && explicitEffort !== 'none'` (strict equality; a non-string effort counts as not-`none`).
- Provenance by ordering, not tracking: the strip applies in Step 2 (`index.ts:1208-1224`), before `applyProviderOptions` (Step 3). When true, `generation.temperature` / `generation.top_p` are not assigned and notes `generation.temperature ignored (reasoning model)` / `generation.top_p ignored (reasoning model)` are pushed to a local `notes` array (collected with `droppedNotes`; still no channel to `config_notes`, ADR-007 § Trade-offs). A passthrough `provider_options.openai.temperature` rides untouched: the operator addressed the wire.
- `generation.max_output_tokens` is never stripped; `seed` is untouched (§ 3.5).
- Keyed on the model predicate, not the endpoint: `gpt-4o` under `OPENAI_API_STYLE=responses` still forwards sampling. Classic: predicate false, byte-identical.

### 3.5 `respond()` — implements D5

Stays on `/chat/completions` via `textCompletion` (`index.ts:1313-1396`). No `provider_options` reach `respond()`, so effort is always implicit: when `isReasoningModel(this.model)`, skip `generation.temperature` / `top_p` (same notes as § 3.4); keep `generation.seed` and `max_output_tokens`. Truncation detection (`:1364-1384`) unchanged. A 400 with `param: 'seed'` maps through § 3.11 (`UNSUPPORTED_PARAM_REMEDY.seed`).

### 3.6 `chat-latest` in the shared predicate — implements D6

`packages/shared/src/model-slug.ts:67`:

```ts
const REASONING_MODEL_RE = /^(o[1-9]|gpt-(?:[5-9]|\d{2,})|chat-latest$)/i;
```

Exact, anchored alternation. Cascades through the single predicate to: token param (`max_completion_tokens`), `tool_choice: 'required'`, api style (`/responses`), tokenizer (§ 3.8), window (§ 3.1: 272,000), reasoning nudge, default output cap (§ 3.7), and the empty-review notice (§ 3.10). Update the JSDoc at `:44-66`.

### 3.7 Family-aware default output cap — implements D7 `[USER-RATIFY]`

```ts
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;              // classic (was module-private, index.ts:1063)
export const DEFAULT_MAX_OUTPUT_TOKENS_REASONING = 32_768;
export function resolveOpenAIDefaultMaxOutputTokens(model: string): number; // isReasoningModel ? 32_768 : 4096
```

- Adapter (`index.ts:1104`): `this.maxOutputTokens = options.maxOutputTokens ?? resolveOpenAIDefaultMaxOutputTokens(this.model)`. Standalone and worker agree (G-9).
- Worker (`worker.ts:202`): `resolveMaxOutputTokens('OPENAI_MAX_OUTPUT_TOKENS', resolveOpenAIDefaultMaxOutputTokens(opts.model ?? OPENAI_DEFAULT_MODEL))`. Env wins when set, numeric and positive (existing parser). Comment at `:196-201` updated.
- Coupling: the resolved number is `providerLimits.maxOutputTokens` (§ 3.2), so the orchestrator reserves `max(chunking.reserved_output_tokens, cap)`. A repo `chunking.reserved_output_tokens` above the cap still wins (more conservative). Classic: 4096/4096, identical. Applies to `respond()` too (`max_completion_tokens: 32768` on reasoning models).

### 3.8 Tokenizer family rule — implements D8

Replace `OPENAI_TOKENIZER_FAMILY_MAP` and `resolveOpenAITokenizerFamily` (`index.ts:571-626`):

```ts
const O200K_CLASSIC_RE = /^gpt-4(o|\.1|\.5)/i;   // vocabulary rule, not a family classification
export function resolveOpenAITokenizerFamily(model: string): TokenizerFamily {
  return isReasoningModel(model) || O200K_CLASSIC_RE.test(model) ? 'o200k' : 'cl100k';
}
```

`OPENAI_TOKENIZER_FAMILY_MAP` is removed (its only consumer is the resolver; tests that imported it are rewritten to assert the resolver, AS-5). `OPENAI_CAPABILITIES.tokenizer_family: 'o200k'` unchanged. Unknown slugs and gateway names stay `cl100k` (over-count is safe). `gpt-4o` / `gpt-4.1` → `o200k`, `gpt-4` / `gpt-3.5-turbo` → `cl100k`: identical to the map.

### 3.9 Default model warning — implements D9 `[USER-RATIFY]`

`OPENAI_DEFAULT_MODEL = 'gpt-4o'` unchanged. In `provider-notices.ts`:

```ts
export const OPENAI_DEFAULT_MODEL_WARNING =
  'OPENAI_MODEL is unset; the default `gpt-4o` resolves to a snapshot scheduled for shutdown on 2027-01-14 (replacement: `gpt-6-luna`). Set OPENAI_MODEL explicitly before then; see docs/model-compatibility.md.';
```

In `buildProvider` (`worker.ts:234`), right after `log('worker.provider.selected', { provider: 'openai' })`, only in the OpenAI arm and only when `model === undefined`: `log('worker.provider.openai_default_model', { level: 'warn', model: OPENAI_DEFAULT_MODEL, shutdown: '2027-01-14', replacement: 'gpt-6-luna', message: OPENAI_DEFAULT_MODEL_WARNING })`. (`log` spreads the payload after `level: 'info'`, so `level: 'warn'` overrides.) Never emitted when `OPENAI_MODEL` is set or for other providers.

### 3.10 Empty-review notice helper — implements D10

`apps/github-app/src/provider-notices.ts`:

```ts
export function reasoningModelNoFindingsNotice(model: string): string;
```

Returns FORGE's sentence verbatim minus the leading emoji (the emoji is a call-site prefix, because `orchestrator.ts:375` already opens its notice with `ℹ️`):

> `` `<model>` is a reasoning model and reported no findings. If you expected some, check the `provider.usage` log event: `reasoning_tokens` near zero means the model skipped reasoning (do not set `reasoning_effort: 'none'`; unset `OPENAI_TOOL_CHOICE=forced`); a large count with an empty result usually means a tight output cap — raise `OPENAI_MAX_OUTPUT_TOKENS` (≥ 25,000 on GPT-6) or the effort. See docs/model-compatibility.md.``

Call sites: `orchestrator.ts:378` → `notice += ` + space + helper; `orchestrator.ts:1506` → `ℹ️ ` + helper; `worker.ts:709` → helper. Keeps "is a reasoning model" and the slug (eval fixture `evals/fixtures/reasoning-model-empty-review.yaml:84-85`). No mention of `gpt-4.1`.

### 3.11 Error mapping, `param`, and remedies — implements D11

**Transport** (`packages/providers/openai/src/client.ts:165-170`, `:247-252`): `OpenAIHttpError.error` gains `param?: string`; copy `innerError.param` when it is a string. Additive.

**Schema** (`packages/shared/src/schemas/provider.ts:293-299`, `:274-279`), additive only, variants stay `.strict()`:
- `capability` gains `param: z.string().min(1).optional()` and `code: z.string().min(1).optional()` (both needed: remedies are keyed by `param` and gated by `code`).
- `transport` gains `retry_after_ms: z.number().int().nonnegative().optional()`.

**Mapper** (`error-mapping.ts`): add `readErrorParam(err)` mirroring `readErrorCode`. New order:
1. network/timeout, 401/403: unchanged.
2. 429: `readErrorCode(err) === 'insufficient_quota'` → `{ kind: 'rate_limit', message, retryable: false }` (no `retry_after_ms`); else unchanged.
3. 5xx: `{ kind: 'transport', message, retryable: true }` plus `retry_after_ms` when `readRetryAfterMs(err)` is defined (503 `server_is_overloaded`, digest § 8).
4. 400: `code ∈ {context_length_exceeded, model_not_found, unsupported_value, unsupported_parameter}` → `capability`; else the existing `looksLikeCapability` heuristic → `capability`; else non-retryable `transport`. Every `capability` result carries `code` and `param` when present (conditional assignment; the inferred type has no `| undefined`).

**Queue** (`apps/github-app/src/queue/job-queue.ts:94-95`): `case 'rate_limit': return err.value.retryable === false ? 'non_transient' : 'rate_limited'`. Quota exhaustion stops retrying.

**Notices** (`provider-notices.ts`): `capabilityRemedyNotice(message, meta?)` and `withCapabilityRemedy(notice, message, meta?)` with `CapabilityErrorMeta = { param?: string | undefined; code?: string | undefined }` (existing one-argument calls keep compiling). Precedence:
1. `FUNCTION_TOOLS_ON_CHAT_RE && CHAT_COMPLETIONS_RE` → `RESPONSES_REMEDY`, unchanged and evaluated first (the chat+tools rejection also carries `param: 'reasoning_effort'` with `code: null`, FORGE's trap).
2. `param ∈ {'reasoning_effort', 'reasoning.effort'}` AND (`code === 'unsupported_value'` OR `/^unsupported value/i.test(message)`) → `EFFORT_REMEDY`: "Remedy: this model does not support the configured reasoning effort; the provider message lists the supported values. `none` is rejected by `gpt-6-astra` and `gpt-6.1-sol`; `minimal` by every GPT-6 model. Change `provider_options.openai.reasoning_effort` (or `reasoning.effort`). See `docs/model-compatibility.md` § Reasoning effort × model."
3. `UNSUPPORTED_PARAM_REMEDY[param]`: `temperature` / `top_p` / `top_logprobs` / `logprobs` → "Remedy: this model rejects `<param>` at its reasoning effort. Remove it from `generation` / `provider_options.openai` in `.github/review-bot.yml`. See `docs/model-compatibility.md` § Sampling parameters."; `seed` → "Remedy: this model rejects `seed`. Remove `generation.seed` for this model."; `max_tokens` → "Remedy: this model requires `max_completion_tokens`. Unset `OPENAI_TOKEN_PARAM` (auto) or set it to `max_completion_tokens`."
4. else `undefined` (generic notice). An unknown `param` from a gateway (`store`, `reasoning`) gets the generic notice, never a wrong remedy.

Call sites `orchestrator.ts:781` and `worker.ts:780` pass `{ param: err.value.param, code: err.value.code }` after narrowing `kind === 'capability'`.

### 3.12 Usage telemetry — orchestrator addendum (additive; digest § 8)

`OpenAIUsageTelemetry` (`index.ts`) gains `cache_write_tokens?: number`, read by `extractUsage` from `usage.input_tokens_details.cache_write_tokens` (`/responses`) or `usage.prompt_tokens_details.cache_write_tokens` (`/chat/completions`), omitted when absent (same absent-vs-zero rule as the existing fields). The `provider.usage` log event carries it automatically through the spread in `worker.ts:231-233`. Counts only (G-1). Test: extend `extractUsage` cases in `provider.test.ts` (`:1886-1944`) with one `it('reports cache_write_tokens from either endpoint and omits it when absent')`. Document the field in `docs/observability.md` alongside the other four.

## 4. Config / env surface

No new env vars. `OPENAI_MAX_OUTPUT_TOKENS` default becomes family-aware: 4096 for classic models, 32,768 for reasoning models (`isReasoningModel(OPENAI_MODEL ?? 'gpt-4o')`); an explicit value always wins. New log event `worker.provider.openai_default_model` (warn). One-line doc changes (scout FINDING-012):

| File | Change |
|---|---|
| `docs/deployment.md:78` | add "unset → startup warning; the default snapshot shuts down 2027-01-14, replacement `gpt-6-luna`" |
| `docs/deployment.md:81` | "defaults to `4096` for classic models and `32768` for reasoning models (o-series, gpt-5+, gpt-6, `chat-latest`)" |
| `docs/deployment.md:83` | add `gpt-6-*`, `gpt-6.1-sol`, `chat-latest` to the routed list |
| `docs/deployment.md:161`, `:170` | same default note; replace "gpt-5.6* and later majors" with "reasoning-family models incl. gpt-6 / gpt-6.1 / chat-latest" |
| `docs/install-github-app.md:107` | "targets `/chat/completions` for classic models and `/responses` for reasoning models (ADR-007)" |
| `docs/install-github-app.md:114` | "defaults to `gpt-4o` (startup warning; see deployment.md)" |
| `docs/config-spec.md:56` | "gpt-5+/o-series/gpt-6/chat-latest"; `:64` add "default 4096 classic / 32768 reasoning"; `:494` "128_000 classic OpenAI, 922_000 gpt-6 family, 272_000 chat-latest" |
| `docs/contributing.md:124` | "`max_context_tokens` = maximum input tokens per call (the OpenAI adapter resolves it per model)" |
| `docs/open-questions.md:94` | append "Superseded by ADR-007 (Responses routing) and ADR-008 (per-model window)" |
| `.env.example:27-29`, `deploy/.env.prod.example:40-42` | add `OPENAI_TOKEN_PARAM=`, `OPENAI_MAX_OUTPUT_TOKENS=`, `OPENAI_TOOL_CHOICE=`, `OPENAI_API_STYLE=` with one-line comments |
| `config/deploy.yml:87-88` | add the same four as commented `clear` entries |
| `docs/observability.md` | add `worker.provider.openai_default_model`; add `retry_after_ms`, `param`, `code` where `provider.error` fields are enumerated; add `cache_write_tokens` to `provider.usage` |

## 5. Acceptance scenarios

Each AS names the test file and the describe block to extend (scout FINDING-010) or add.

**AS-1 Reasoning routing for the five IDs.** Given a recording client and model ∈ {`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6.1-sol`, `chat-latest`}, When `review()` runs, Then `client.responses` is called once with `tool_choice: 'required'`, `max_output_tokens: 32768`, `store: false`, and no `max_tokens` / `max_completion_tokens` / `seed`. → `packages/providers/openai/tests/provider.test.ts` `#41 [P2] auto endpoint selection…` (`:1688`): `it('routes every GPT-6 / GPT-6.1 id and chat-latest to /responses with required + max_output_tokens')`.

**AS-2 Predicate.** Given the five IDs plus `GPT-6-ASTRA`, When `isReasoningModel`, Then true; `chat-latest-2026`, `chat-latestx`, `gpt-4o` → false. → `packages/shared/tests/model-slug.test.ts` `isReasoningModel` (`:203`): `it('gpt-6-astra/sol/luna and gpt-6.1-sol are reasoning models')`, `it('chat-latest matches exactly, not as a prefix')`.

**AS-3 Window resolver.** Given `resolveOpenAIContextWindow`, When called with `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6`, Then 922,000; `chat-latest` → 272,000; `gpt-4o`, `gpt-5.6-sol`, `o3`, `gpt-60`, `my-gateway-model` → 128,000. → `provider.test.ts` new `describe('resolveOpenAIContextWindow (ADR-008 D1)')`.

**AS-4 Capabilities wiring.** Given `model: 'gpt-6-sol'` and no `capabilities`, When constructed, Then `capabilities.max_context_tokens === 922000`; explicit `capabilities.max_context_tokens: 50000` → 50,000; `gpt-4o` → 128,000. → `provider.test.ts` `OpenAIProvider` (`:82`): `it('derives max_context_tokens per model; explicit capabilities win')`.

**AS-5 Tokenizer rule.** Given `resolveOpenAITokenizerFamily`, When called with `gpt-5.6-sol`, `gpt-6-astra`, `gpt-6.1-sol`, `chat-latest`, `o3`, `gpt-4o`, `gpt-4.1-nano`, `gpt-4.5`, Then `o200k`; `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo`, `unknown-model` → `cl100k`; and `OPENAI_TOKENIZER_FAMILY_MAP` is no longer exported. → `provider.test.ts`: replace map assertions with `describe('resolveOpenAITokenizerFamily (ADR-008 D8)')`.

**AS-6 Sampling stripped, implicit effort.** Given `gpt-6-astra` and `generation: { temperature: 0.2, top_p: 0.9, max_output_tokens: 8000 }`, no provider_options, When `review()`, Then the `/responses` body has no `temperature` / `top_p` and `max_output_tokens: 8000`. → `OpenAIProvider — generation→vendor mapping (spec § 5.3)` (`:741`): `it('strips generation.temperature/top_p for a reasoning model with implicit effort')`.

**AS-7 Sampling forwarded, explicit `none`.** Given `gpt-6-sol`, the same generation, and `provider_options: { reasoning_effort: 'none' }`, When `review()`, Then `temperature: 0.2`, `top_p: 0.9`, `reasoning: { effort: 'none' }` are on the body; likewise with `{ reasoning: { effort: 'none' }, reasoning_effort: 'high' }` (native wins). → same block: `it('forwards sampling when the explicit effort is none (native spelling wins)')`.

**AS-8 Classic forwards sampling on `/responses`.** Given `gpt-4o`, `apiStyle: 'responses'`, temperature 0.3, When `review()`, Then `temperature: 0.3` is on the body. → same block: `it('keeps sampling for a classic model pinned to /responses')`.

**AS-9 Passthrough untouched.** Given `gpt-6-astra` and `provider_options: { temperature: 0 }`, When `review()`, Then `temperature: 0` reaches the body. → `OpenAIProvider — provider_options passthrough` (`:826`): `it('does not strip a passthrough temperature on a reasoning model')`.

**AS-10 `respond()` strips sampling, keeps seed.** Given `gpt-6.1-sol` and `generation: { temperature: 0.5, top_p: 0.8, seed: 7 }`, When `respond()`, Then `textCompletion` receives `seed: 7`, `max_completion_tokens: 32768`, no `temperature` / `top_p`; with `gpt-4o` all three are forwarded and `max_tokens: 4096`. → `OpenAIProvider — respond()` (`:385`): two `it`s.

**AS-11 Per-request guard.** Given `model: 'gpt-6-astra'`, `maxTokensPerCall: 200_000`, and an input estimating ~130K tokens, When `review()` with `request_shaping.model: 'gpt-4o'`, Then it throws `over_budget` with `hard_cap_in: 128000`; without the override the call succeeds. → `provider.test.ts` `OpenAIProvider` (`:82`): `it('bounds the per-call guard by the resolved model window')`.

**AS-12 Orchestrator coupling.** Given `deps.providerLimits: { maxTokensPerCall: 120000, maxOutputTokens: 32768 }` and a stub provider declaring `max_context_tokens: 922000`, When `runPipeline` plans batches, Then no batch exceeds 120,000 estimated tokens and `hard_cap_in` uses `reserved_output = 32768`; with `providerLimits` absent the plan is unchanged. → `apps/github-app/tests/pipeline/orchestrator.test.ts` `runPipeline — diff chunking` (`:951`): `it('caps effectiveBudget by providerLimits.maxTokensPerCall and reserves the provider output cap')`.

**AS-13 Default output cap.** Given `resolveOpenAIDefaultMaxOutputTokens`, When `gpt-6-sol` / `o3` / `chat-latest` → 32,768; `gpt-4o` / `gpt-4.1` → 4096; a provider built with `maxOutputTokens: 12000` sends 12,000 regardless of family. → `OpenAIProvider — token param per-request wiring` (`:573`): `it('defaults max output to 32768 for reasoning and 4096 for classic; explicit option wins')`.

**AS-14 Error mapping, digest § 13 strings.** Given `mapOpenAIError` with status 400 and: (a) `"Unsupported value: 'reasoning_effort' does not support 'none'…"` with `error: { type: 'invalid_request_error', param: 'reasoning_effort', code: 'unsupported_value' }` → `capability`, `param: 'reasoning_effort'`, `code: 'unsupported_value'`; (b) `"Unsupported parameter: 'temperature' is not supported with this model."` with `param: 'temperature'`, `code: null` → `capability`, `param: 'temperature'`, no `code`; (c) `"Unsupported parameter: 'max_tokens' … Use 'max_completion_tokens' instead."` → `capability`; (d) the chat+tools rejection with `param: 'reasoning_effort'`, `code: null` → `capability`, `param` set, no `code`; (e) `{ code: 'unsupported_parameter', param: 'store' }` with a neutral message → `capability`. 429 `insufficient_quota` → `rate_limit`, `retryable: false`, no `retry_after_ms`. 503 with `retry-after: 3` → `transport`, `retryable: true`, `retry_after_ms: 3000`. → `packages/providers/openai/tests/error-mapping.test.ts` `mapOpenAIError`: amend T14 (`:73-81`, `retryable` becomes `false`), add seven `it`s. `packages/providers/openai/tests/transport.test.ts` `OpenAI transport boundary — error mapping` (`:286`): `it('forwards error.param from a /responses 400 into the capability error')`.

**AS-15 Queue classification.** Given `{ kind: 'rate_limit', retryable: false }`, When `classifyRetry`, Then `non_transient`; `retryable` undefined or true → `rate_limited`. → `apps/github-app/tests/queue/classify-retry.test.ts`: `it('treats a non-retryable rate_limit (insufficient_quota) as non_transient')`.

**AS-16 Remedy selection.** Given `capabilityRemedyNotice(message, meta)`: (a) chat+tools message with `{ param: 'reasoning_effort' }` → the `OPENAI_API_STYLE` remedy, not the effort remedy; (b) "Unsupported value…" with `{ param: 'reasoning_effort', code: 'unsupported_value' }` → effort remedy naming `gpt-6-astra`; (c) `{ param: 'temperature' }` → sampling remedy naming `generation`; (d) `{ param: 'seed' }` → seed remedy; (e) `{ param: 'max_tokens' }` → `OPENAI_TOKEN_PARAM` remedy; (f) `{ param: 'store', code: 'unsupported_parameter' }` → `undefined`; (g) one-argument calls unchanged. → `apps/github-app/tests/provider-notices.test.ts` `capabilityRemedyNotice` (`:13`): six `it`s; `withCapabilityRemedy` (`:44`): `it('passes param/code meta through')`.

**AS-17 Notice helper and call sites.** Given `reasoningModelNoFindingsNotice('gpt-6-astra')`, Then it contains "`gpt-6-astra` is a reasoning model", "provider.usage", "OPENAI_MAX_OUTPUT_TOKENS", and not "gpt-4.1". Given a FakeProvider returning zero findings with `model: openai/gpt-6-astra`, When `runPipeline`, Then the summary contains that text and the outcome detail is `{ reasoning_model_empty: true, model: 'gpt-6-astra' }`; with `openai/gpt-4o` no notice. → `provider-notices.test.ts` new `describe('reasoningModelNoFindingsNotice')`; `orchestrator.test.ts` `runPipeline — no_findings reasoning model hint` (`:2022`): amend the `gpt-5.4-nano` / `o3` expectations (`:2027`, `:2048`), add `gpt-6-astra`; `apps/github-app/tests/worker/command-dispatch.test.ts` `chunked review reply text` (`:678`) sibling `it('no_findings reply for a reasoning model uses the shared helper')`.

**AS-18 Startup warning.** Given `OPENAI_DEFAULT_MODEL_WARNING`, Then it names `2027-01-14`, `gpt-6-luna` and `OPENAI_MODEL`. → `provider-notices.test.ts` new `describe('OPENAI_DEFAULT_MODEL_WARNING')`. The emission gate in `buildProvider` is boot-path only (like the rest of `buildProvider`, not unit-tested); verify manually: `worker.provider.openai_default_model` appears with `OPENAI_MODEL` unset and is absent when set.

**AS-19 Classic byte-identical regression.** Given recording clients and the existing `validInput` fixture, When `review()` runs for `gpt-4o` and `gpt-4.1` with `generation: { temperature: 0.2, top_p: 0.9 }` and `deterministic_seed: 1`, and `respond()` runs for both with `generation: { temperature: 0.2, top_p: 0.9, seed: 1 }`, Then the captured args deep-equal an inline snapshot taken on `main@f28be3e` before any change (`max_tokens: 4096`, forced-function `tool_choice`, sampling present). → `provider.test.ts` `OpenAIProvider — tool_choice + prompt per model family` (`:1071`): `it('classic request bodies are byte-identical to the pre-GPT-6 snapshot')`. `transport.test.ts:156` (classic → chat) stays green.

**AS-20 Eval fixture.** Given `evals/fixtures/reasoning-model-empty-review-gpt6.yaml` (copy of `reasoning-model-empty-review.yaml` with `model: openai/gpt-6-astra` and `summary_contains: ["reasoning model", "gpt-6-astra", "OPENAI_MAX_OUTPUT_TOKENS"]`) registered in `evals/scenarios.yaml` after `:61` with tag `reasoning_model_compatibility`, When `make eval`, Then both fixtures pass.

**AS-21 Usage telemetry (addendum § 3.12).** Given a `/responses` payload with `usage.input_tokens_details.cache_write_tokens: 512` and a chat payload with `usage.prompt_tokens_details.cache_write_tokens: 256`, When `extractUsage`, Then `cache_write_tokens` is 512 / 256; absent → key omitted. → `provider.test.ts` `extractUsage` block (`:1886`).

## 6. Guards

- **G-1 No values in notes or logs.** New notes name keys only; `provider.usage` and the warn event carry no prompt or config values.
- **G-2 One family predicate.** No new regex decides routing, `tool_choice`, token param or the notice. The only added regexes are `O200K_CLASSIC_RE` (vocabulary) and `GPT6_WINDOW_RE` (window version); both documented as such and never consulted for routing.
- **G-3 Classic byte-identical.** AS-19 is the gate; any diff fails the PR.
- **G-4 Denylist unchanged.** `OPENAI_PASSTHROUGH_DENYLIST` (`index.ts:500-514`) stays 12 keys; sampling keys are not added.
- **G-5 `store: false` and state-linking stripping unchanged** in `toResponsesArgs`.
- **G-6 ADR-002 vendor isolation.** No `fetch(` outside `client.ts`, no SDK import; `scripts/check-vendor-isolation.sh` green.
- **G-7 Schema additive-only.** `ProviderErrorSchema` and `ProviderCapabilitiesSchema` gain only optional fields; variants stay `.strict()`; no `GenerationSchema` change.
- **G-8 Effort verbatim.** No code path rewrites `reasoning.effort` / `reasoning_effort` values.
- **G-9 Standalone = worker.** `resolveOpenAIDefaultMaxOutputTokens` is the single source for both default-cap sites.

## 7. Documentation deliverables (IDG)

- `docs/model-compatibility.md`: in `## Model families` add rows "GPT-6" (`gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna`), `gpt-6.1-sol`, and `chat-latest` (endpoint `/responses`, `'required'`, `max_output_tokens`, seed No, window 922K / 272K, default cap 32,768). New `### Reasoning effort × model`: `none` (sol/luna only), `minimal` (never on GPT-6), `low`–`xhigh` (all), `max` (all GPT-6 via Responses); note the `chat-latest` snapshot changes without notice (non-reproducible reviews) and OpenAI's `gpt-6-*` production recommendation. New `### Sampling parameters`: the D4 rule, passthrough exception, explicit-`none` exception. New `### Context window and long-context pricing`: 922,000 input / 128,000 output; 2× input price above 272K input; `MAX_TOKENS_PER_PR` and `chunking.call_token_budget` are the knobs. Replace the quoted notice at `:144` with § 3.10's text; add the three remedies under a new `## Unsupported value / parameter rejections`.
- Per § 4 table: `docs/deployment.md`, `docs/install-github-app.md`, `docs/config-spec.md`, `docs/contributing.md`, `docs/open-questions.md`, `.env.example`, `deploy/.env.prod.example`, `config/deploy.yml`, `docs/observability.md`.
- `docs/architecture-decision-records/adr-008-gpt6-model-family-compatibility.md` (new, ADR-007 style). Status: Proposed — 2026-10-16; amends ADR-005 (capability constants: `max_context_tokens` per model, `tokenizer_family` as a rule) and ADR-006 (the 128K window assumption; `reserved_output` coupled to the provider cap); supersedes nothing. Sections: Context (digest deltas); Decision D1–D11 (one paragraph each); Rationale (incl. the three `[USER-RATIFY]` items and rejected alternatives from the reasoning report); Interface changes (new exports `resolveOpenAIContextWindow`, `resolveOpenAIDefaultMaxOutputTokens`, `resolveExplicitReasoningEffort`, `shouldStripSampling`, `DEFAULT_MAX_OUTPUT_TOKENS[_REASONING]`, `reasoningModelNoFindingsNotice`, `OPENAI_DEFAULT_MODEL_WARNING`; removed `OPENAI_TOKENIZER_FAMILY_MAP`; schema `capability.param/code`, `transport.retry_after_ms`; `OrchestratorDeps.providerLimits`; the warn event; `cache_write_tokens`); Trade-offs (Anthropic batch planning ≤ `MAX_TOKENS_PER_PR`; 8× worst-case output ceiling; notes still unsurfaced); Consequences now / later (default flip before 2027-01-14; provider-note channel; per-request capabilities); Testing (AS map); References.

## 8. Implementation order for Vivi

Each step leaves `pnpm run typecheck && pnpm run lint && pnpm test` green.

1. **Shared predicate + resolvers.** Take the AS-19 snapshot first. Then `model-slug.ts` regex (§ 3.6); tokenizer rule + map removal (§ 3.8); `resolveOpenAIContextWindow` + constructor wiring (§ 3.1); `resolveOpenAIDefaultMaxOutputTokens` + constants, adapter half (§ 3.7). Tests AS-1–AS-5, AS-13 (adapter part), AS-19.
2. **Sampling strip + per-request guard + telemetry.** § 3.4, § 3.5, § 3.2 adapter guard, § 3.12. Tests AS-6–AS-11, AS-21.
3. **Error mapping + `param` + notices.** `client.ts` param, schema fields, mapper, queue line, remedies, `reasoningModelNoFindingsNotice`, three call sites, meta at the two `withCapabilityRemedy` sites. Tests AS-14–AS-17.
4. **Worker.** `buildProvider` returns `providerLimits`; family-aware `resolveMaxOutputTokens` fallback; `OrchestratorDeps.providerLimits` + the two `Math` lines; default-model warning. Tests AS-12, AS-13 (worker part), AS-18.
5. **Evals.** Sibling fixture + `scenarios.yaml` (AS-20); eval run.
6. **Docs (IDG).** § 4 table, § 7, ADR-008.

## 9. Open questions

- **OQ-1 `seed` on `/chat/completions` for GPT-6.** UNCONFIRMED (digest § 4). Kept and sent (D5); a rejection surfaces as `capability` + seed remedy. Reverse to "strip seed for reasoning models on chat" if confirmed rejected.
- **OQ-2 gpt-5.x / o-series input ceilings.** Not in the digest; stay 128,000. Add arms to `resolveOpenAIContextWindow` when a primary source lands.
- **OQ-3 `OPENAI_TIMEOUT_MS`.** Documented nowhere and read nowhere, though `OpenAIProviderOptions.timeoutMs` exists. Pre-existing gap; recommend out of scope here, tracked separately.
- **OQ-4 `chat-latest` with `tool_choice: 'required'` on `/responses`** is inferred, not observed (D6 confidence 0.75). If it rejects, `OPENAI_API_STYLE` / `OPENAI_TOOL_CHOICE` remain the escape hatches.
