# Implementation Spec — Easy Prisma Settings (vendor-neutral config DX)

Status: **implemented** (2026-06-14, branch `feat/config-dx-easy-settings`). Methodology: SPECTRA. Intent: `CHANGE` (additive, non-breaking). Complexity: 9/12. Confidence: 88%.

### R1 refinement — slug provider ≠ active provider

Recorded during implementation. When `parseModelSlug` returns a `provider` that differs from `deps.provider.name` (the env-selected adapter), the orchestrator does **not** forward `resolvedModel` to `request_shaping.model`. Forwarding a model name known to a different provider to the active adapter would produce a 404 / capability mismatch on the wire. Instead:

- `request_shaping.model` is omitted (the adapter uses its own default model).
- A config note is appended: `model slug provider "<slug-provider>" does not match the active provider "<active-provider>"; model name not forwarded`.
- `provider_options` keying still uses `deps.provider.name` (the actually-active adapter), so the slug-named bag only applies when its key matches the active adapter (consistent with AS-10, G9).

This matches OQ-1's "no adapter switching" contract and keeps the wire safe. A future release that does switch adapters by config can remove this guard.

> Source of truth for the *design* (schema, P1–P6, nomenclature, leveling, precedence, back-compat) is [`design.md`](./design.md). This spec makes that design **buildable and testable** — it does not redesign it. Where this spec and `design.md` disagree, `design.md` wins and this spec has a bug.

---

## 0. Context anchors (file:line)

| Concern | Anchor |
|---|---|
| Outer repo config schema, `provider`/`model` defaults, strict-vs-nonstrict | `packages/shared/src/schemas/config.ts:143-198` (provider `:147`, model `:148`) |
| `ChunkingSchema` — precedent for a nested `.strict()` block with `.default()` | `packages/shared/src/schemas/config.ts:92-109` |
| `DEFAULT_REPO_CONFIG` = `RepoConfigSchema.parse({})` | `packages/shared/src/schemas/config.ts:207` |
| `language_overrides` partial-subset schema | `packages/shared/src/schemas/config.ts:119-134` |
| `ProviderRequestShapingSchema` (carries `model` + `deterministic_seed` today) | `packages/shared/src/schemas/provider.ts:33-40` |
| `ProviderReviewInputSchema` (`.strict()`, holds `request_shaping?`) | `packages/shared/src/schemas/provider.ts:42-56` |
| `ProviderCapabilities` | `packages/shared/src/schemas/provider.ts:141-149` |
| `resolveTokenParam` + `NEWER_MODEL_RE` heuristic | `packages/providers/openai/src/index.ts:50-78` |
| OpenAI per-request resolution (`request_shaping?.model ?? this.model`), token-param select, seed | `packages/providers/openai/src/index.ts:333-353` |
| `OpenAIChatCompletionsArgs` wire shape | `packages/providers/openai/src/client.ts:39-58` |
| `createOpenAIClient` body serialization (`JSON.stringify` elides `undefined`) | `packages/providers/openai/src/client.ts:87-101` |
| `OpenAIProviderOptions` (`maxOutputTokens`, `tokenParamStyle`) | `packages/providers/openai/src/index.ts:144-177` |
| `buildProviderInput` (`cfg.model` → `request_shaping`) | `apps/github-app/src/pipeline/orchestrator.ts:303-341` (model wiring `:334-336`) |
| Worker provider selection / env wiring (`OPENAI_MODEL`/`OPENAI_TOKEN_PARAM`/`OPENAI_MAX_OUTPUT_TOKENS`) | `apps/github-app/src/worker.ts:122-163` |
| `buildConfigReply` | `apps/github-app/src/worker.ts:315-354` (`model` line `:318`) |
| Warn-and-ignore unknown-key policy (non-strict outer object) | `packages/config/src/config-loader/parse.ts:43-77`; policy note `config.ts:136-142` |
| Config spec `provider`/`model` sections | `docs/config-spec.md:35-49`; precedence matrix `:320`; worked example `:335-394` |
| Eval runner consumes `provider.calls[0]` + `config_overrides` deep-merge | `evals/runner/src/pipeline-runner.ts:223,310-316` |
| FakeProvider records calls + `output_lazy(input)` seam | `packages/providers/fake/src/index.ts` (`recordedCalls`, `FakeStep.output_lazy`) |

**Adapter scope note.** Grep confirms only the **OpenAI** adapter reads `request_shaping`. `anthropic`, `copilot`, `fake` ignore it today. This spec wires the generic mechanism end-to-end but only implements vendor translation for OpenAI (see §6 Out of scope).

---

## 1. Summary of the change

Three additive, all-optional config surfaces in `.github/review-bot.yml`, plumbed through `request_shaping` to the active adapter:

1. **`model:` as a `provider/name` slug** — `openai/gpt-5.4-nano`. Bare name → default provider. Legacy `provider:` + `model:` still parse (deprecated). Conflict → resolve + warn, never reject.
2. **`generation:` block** — normalized `max_output_tokens`, `temperature`, `top_p`, `seed`. Adapter translates to vendor dialect (e.g. `max_output_tokens` → `max_tokens` **or** `max_completion_tokens` via the existing `resolveTokenParam`).
3. **`provider_options:` map** keyed by provider slug — raw passthrough, forwarded untouched to the active provider's request, **minus a denylist** (§3.7). Precedence: `provider_options` (raw) **>** `generation` (normalized) **>** Prisma/env defaults.

Zero-config invariant: every field optional; absent → byte-for-byte today's behavior.

---

## 2. GIVEN/WHEN/THEN acceptance stories

IDs are referenced by validation gates (§3) and the test plan (§7).

### Group A — Model slug parsing & resolution

- **AS-1 (bare name → default provider).**
  GIVEN `model: gpt-4o` and no `provider:` key, WHEN config is parsed, THEN the resolved selection is `{ provider: <default>, model: "gpt-4o" }`; `request_shaping.model` sent to the adapter is the **bare** `"gpt-4o"` (no slug, no provider prefix) so `resolveTokenParam` and the OpenAI wire `model` are unchanged from today.

- **AS-2 (slug parses provider + name).**
  GIVEN `model: openai/gpt-5.4-nano`, WHEN parsed, THEN resolved `{ provider: "openai", model: "gpt-5.4-nano" }`; `request_shaping.model = "gpt-5.4-nano"`; provider selection (which adapter the worker instantiates) is **not** changed by config in this release (see OQ-1) — the slug provider is recorded/echoed and used for `provider_options` keying, but the active adapter is still chosen by env keys.

- **AS-3 (legacy provider + model still works).**
  GIVEN legacy `provider: anthropic` + `model: claude-sonnet-4.5` (no `/`), WHEN parsed, THEN resolved `{ provider: "anthropic", model: "claude-sonnet-4.5" }`; identical behavior to today (`docs/config-spec.md:35-49`); a **deprecation note** is emitted to config notes.

- **AS-4 (conflict: legacy provider vs slug → resolve + warn).**
  GIVEN `provider: anthropic` AND `model: openai/gpt-5.4-nano` (slug names a different provider), WHEN parsed, THEN the **slug wins** (`provider: openai`, `model: gpt-5.4-nano`), config is **NOT rejected**, and a warning note is appended: `model slug provider "openai" overrides deprecated provider: "anthropic"`. (Decision: slug is the newer, more specific surface; it wins. Consistent with `design.md` "warn-and-ignore on conflict".)

### Group B — `generation` reaches the OpenAI adapter

- **AS-5 (`max_output_tokens` → token param).**
  GIVEN `generation.max_output_tokens: 8192` and resolved model `gpt-5.4-nano`, WHEN the OpenAI adapter builds the request, THEN `args.max_completion_tokens === 8192` (because `NEWER_MODEL_RE` matches `gpt-5`) and `args.max_tokens` is absent; GIVEN model `gpt-4o` instead, THEN `args.max_tokens === 8192` and `max_completion_tokens` absent. This makes the v0.8.1 `resolveTokenParam` behavior **config-driven** (was env-only via `OPENAI_MAX_OUTPUT_TOKENS`).

- **AS-6 (`seed` → deterministic_seed).**
  GIVEN `generation.seed: 42`, WHEN the adapter builds the request, THEN `args.seed === 42` (threaded via `request_shaping.deterministic_seed`, the existing field at `provider.ts:36`).

- **AS-7 (`temperature` / `top_p` plumbed).**
  GIVEN `generation.temperature: 0.2` and `generation.top_p: 0.9`, WHEN the adapter builds the request, THEN `args.temperature === 0.2` and `args.top_p === 0.9` reach the wire (new optional fields on `OpenAIChatCompletionsArgs`).

### Group C — `provider_options` raw passthrough & precedence

- **AS-8 (raw passthrough forwarded).**
  GIVEN `provider_options.openai.reasoning_effort: low` and active provider `openai`, WHEN the adapter builds the request, THEN `args.reasoning_effort === "low"` is forwarded untouched (key + value verbatim, no rename, no validation).

- **AS-9 (escape hatch wins on collision).**
  GIVEN BOTH `generation.max_output_tokens: 4096` AND `provider_options.openai.max_tokens: 1000` with a classic model (`gpt-4o`), WHEN the request is built, THEN `args.max_tokens === 1000` (the raw bag overrides the normalized field — precedence P5). The normalized value is discarded for that field.

- **AS-10 (non-active provider bag ignored).**
  GIVEN `provider_options: { openai: {...}, anthropic: { thinking: {...} } }` and the active adapter is OpenAI, WHEN the request is built, THEN only `provider_options.openai` is applied; the `anthropic` sub-bag is **never** read for this call (no leakage of one vendor's knobs into another's request).

### Group D — Invariants & resilience

- **AS-11 (zero-config invariant).**
  GIVEN a config with NO `model`/`generation`/`provider_options` (or an empty file), WHEN the full pipeline runs, THEN the OpenAI request args are **byte-for-byte identical** to today: `model = OPENAI_DEFAULT_MODEL` (or `OPENAI_MODEL` env), `max_*tokens = 4096` (or `OPENAI_MAX_OUTPUT_TOKENS`), no `temperature`/`top_p`/`seed`, no extra keys. `DEFAULT_REPO_CONFIG` snapshot unchanged for all pre-existing keys.

- **AS-12 (unknown nested keys → warn-and-ignore).**
  GIVEN `generation.frobnicate: 1` or `provider_options.openai` containing keys, WHEN parsed: unknown keys under **`generation`** are warn-and-ignored (NOT rejected); **`provider_options.<provider>`** is an open bag — any key is accepted (that's the point of the escape hatch) and forwarded subject to the denylist. Neither rejects the file. Consistent with the outer warn-and-ignore policy (`config.ts:136-142`, `parse.ts`).

---

## 3. Validation gates (pass/fail, mechanically checkable)

Each gate is a binary check a reviewer or CI can run. `[AS-n]` links the story it enforces.

| # | Gate | Pass criterion | Mech. check |
|---|---|---|---|
| G1 | **Back-compat preserved** | All pre-existing tests + eval fixtures green, unmodified. `DEFAULT_REPO_CONFIG` adds only new keys with empty/absent defaults; no existing key's default changes. | `pnpm test` green; diff of `RepoConfigSchema.parse({})` shows only additive keys. `[AS-11]` |
| G2 | **Slug parsing rules** | `parseModelSlug` returns `{provider, model}` for: `a/b`→`{a,b}`; `b`→`{provider:undefined, model:b}`. Rejects/sanitizes malformed (§4). | Unit table test. `[AS-1,AS-2,AS-3]` |
| G3 | **Precedence / merge order** | Final adapter request = `defaults` ← `generation`-normalized ← `provider_options[active]`-raw (last wins), minus denylist. | Adapter unit test asserts merged args. `[AS-9]` |
| G4 | **Escape-hatch-wins** | A `provider_options` key that maps to the same wire field as a `generation` field → raw value present, normalized value absent. | `args.max_tokens === <raw>` test. `[AS-9]` |
| G5 | **Warn-on-conflict, never reject** | Legacy `provider:` ≠ slug provider → parse succeeds + warning note present. | Loader test asserts non-throw + note substring. `[AS-4]` |
| G6 | **Zero-config invariant** | Empty config produces request args byte-identical to pre-change snapshot. | Snapshot/golden test on built `OpenAIChatCompletionsArgs`. `[AS-11]` |
| G7 | **No secret leakage through passthrough logs** | No `provider_options` value, no `generation` value, no `request_shaping` content is ever logged. `provider.called`/`provider.error` log fields unchanged (still no bodies). | Grep adapter + orchestrator for new `log/emit` of shaping content → must be empty; review-checklist item. `[AS-8]` |
| G8 | **Denylist enforced** | Any denylisted key (§3.7) present in `provider_options[active]` is dropped before the wire and a note is emitted; structured-output contract (tools/tool_choice) intact. | Adapter test: inject `tool_choice: "none"` via passthrough → request still forces `submit_review_findings`. `[AS-8 neg]` |
| G9 | **Non-active bag isolation** | Only `provider_options[activeProviderName]` is read. | Adapter test with two sub-bags asserts only active applied. `[AS-10]` |
| G10 | **Type safety / no vendor types leak** | No vendor SDK type added; `request_shaping` stays Zod-validated; `OpenAIChatCompletionsArgs` stays the only vendor wire shape (ADR-002). | `tsc` + `biome` clean; vendor-isolation lint rules (3) still pass. |

**G7 detail (no secret leakage).** `provider_options` is raw user input that *could* contain an API key, org id, or PII. The denylist (§3.7) does not include credentials by name (we cannot enumerate every vendor's auth field), so the mitigation is **structural**: passthrough values are forwarded into the request body only and are **never** routed to any logger. The existing invariant "adapters never log request/response bodies" (`provider.ts:24-26`, observability.md) already covers this — the gate is to confirm no *new* log statement violates it. The `Authorization` header is set in `client.ts:99` from the adapter's own `apiKey`, independent of `provider_options`, so passthrough cannot overwrite credentials on the wire (the body is merged, not the headers).

### 3.7 Escape-hatch denylist (Prisma-critical fields the raw bag may NOT override)

The OpenAI structured-output contract depends on forced function-calling (`submit_review_findings`) and a single tool. `provider_options.openai` keys matching this denylist are **dropped** (with a config note), so the escape hatch cannot break the review contract:

| Denylisted key | Why |
|---|---|
| `model` | Model is resolved from the slug / `request_shaping.model`; passthrough must not silently retarget the model (breaks `resolveTokenParam` invariants + observability). |
| `messages` | The prompt is Prisma-owned (`buildPrompt`); overriding it discards the review instructions. |
| `tools` | Must remain the single `submit_review_findings` function tool. |
| `tool_choice` | Must remain forced to `submit_review_findings`; `"none"`/`"auto"` breaks structured output. |
| `stream` | Pipeline consumes a single JSON response; streaming breaks `extractToolCallArguments`. |
| `n` | Multiple choices break the `choices[0]` extraction contract. |
| `response_format` | Conflicts with the function-calling structured-output path. |

`max_tokens` / `max_completion_tokens` / `seed` / `temperature` / `top_p` are **NOT** denylisted — overriding them is the intended escape hatch (AS-9). The denylist is a constant in the OpenAI adapter (`OPENAI_PASSTHROUGH_DENYLIST`), unit-tested against G8. When a denylisted key is dropped, append a config note: `provider_options.openai.<key> ignored (Prisma-managed field)`.

---

## 4. Edge cases & failure modes

| Case | Decision | Rationale |
|---|---|---|
| **Malformed slug `openai/`** (trailing slash, empty name) | Treat as **no model override**; emit warning note `invalid model slug "openai/": empty model name`. Do NOT reject the file. | Robustness over strictness; falls back to env/default model. |
| **Malformed slug `/gpt-4o`** (empty provider) | Treat as **bare name** `gpt-4o` (provider undefined → default). Warn `model slug "/gpt-4o": empty provider, using default`. | Most charitable parse; the user clearly wants `gpt-4o`. |
| **Malformed slug `a/b/c`** (>1 slash) | Reject the slug as a model override → warn `invalid model slug "a/b/c": expected provider/name`; fall back to env/default. Do NOT reject the file. | Ambiguous; safer to ignore than guess. |
| **Unknown provider in slug** (`acme/foo`) | Parse succeeds (`provider: acme`, `model: foo`). Since this release does not switch adapters by config (OQ-1), the active adapter still applies; `request_shaping.model = "foo"` is sent to whatever adapter the worker selected. Emit note `model slug provider "acme" is not a recognized provider; the active provider will be used`. | Forward-compat: don't hard-fail on a provider Prisma hasn't shipped. |
| **Unknown provider key in `provider_options`** (`provider_options.acme.x`) | Accepted by schema (open record). At apply time only `provider_options[activeProviderName]` is read, so `acme` is simply never applied. No warning required (it's a valid forward-compat bag). | Mirrors AS-10; matches Vercel `providerOptions` semantics. |
| **Empty `generation: {}` / `provider_options: {}`** | No-op; identical to absent. Both default to `{}`. | Zero-config invariant (AS-11). |
| **Empty sub-bag `provider_options.openai: {}`** | No-op. | Same. |
| **`generation` setting the vendor doesn't support** (e.g. `top_p` on a model that rejects it) | **Passthrough to the wire** (do NOT pre-emptively drop). If the vendor 400s, the existing error-mapping path (`mapOpenAIError`) classifies it as `capability`/`schema_validation` and the orchestrator publishes `review_unavailable`. | Prisma cannot maintain a per-model support matrix; honesty over silent dropping. Documented in OQ-3. |
| **Passthrough overriding a Prisma-critical field** | Denylisted (§3.7) → dropped + note. | Protects structured-output contract (G8). |
| **`language_overrides` carrying `model`/`generation`/`provider_options`** | **In scope to define, not necessarily to implement:** `language_overrides` is a per-language subset of top-level keys (`config.ts:119-134`). Add `model`/`generation`/`provider_options` as **optional** members of `LanguageOverrideSchema` for schema symmetry, BUT mark application as OQ-4 (the pipeline resolves one config per PR, not per file/language at provider-call time today). Default recommendation: accept in schema, do **not** apply per-language in this release; emit no behavior change. | Avoids silently advertising a feature the pipeline can't honor mid-call. |
| **`generation.max_output_tokens` vs `OPENAI_MAX_OUTPUT_TOKENS` env** | Config wins when present; env is the default when config absent. (§5 env-default interaction.) | Repo config overrides deployment default (design.md back-compat). |
| **`provider_options.openai.max_tokens` on a `gpt-5*` model** | Raw key wins as-written: if the user writes `max_tokens` for a model that needs `max_completion_tokens`, that is *their* explicit choice (escape hatch). Do NOT auto-translate raw keys. | Escape hatch = verbatim; translation only applies to `generation`. |

---

## 5. File-by-file change map

Ordered by dependency (schema → interface → adapter → orchestrator → worker → docs/eval). Every change is additive.

### 5.1 `packages/shared/src/schemas/config.ts`
- **Add `GenerationSchema`** (new, `.strict().default({})`), modeled on `ChunkingSchema` (`:92-109`):
  - `max_output_tokens: z.number().int().positive().optional()`
  - `temperature: z.number().min(0).max(2).optional()`
  - `top_p: z.number().min(0).max(1).optional()`
  - `seed: z.number().int().optional()`
  - `.strict()` so unknown nested keys are caught → but see note: `.strict()` would *reject*. To honor **warn-and-ignore** (AS-12), use the **non-strict** default (`.strip`, like the outer object at `:136-142`) for `generation`, and let the loader's keyset-diff warn. **Decision: non-strict `generation`** (consistency with outer policy beats `chunking`'s strictness — `chunking` is fully-known, `generation` is a forward-compat surface). Document this divergence inline.
- **Add `ProviderOptionsSchema`** = `z.record(z.string().min(1), z.record(z.string().min(1), z.unknown())).default({})` — outer key = provider slug, inner = open bag of arbitrary values. Forward-compat by construction.
- **Wire into `RepoConfigSchema`** (`:143-198`): add `generation: GenerationSchema`, `provider_options: ProviderOptionsSchema`. Keep `provider` (`:147`) and `model` (`:148`) exactly as-is (no type change — `model` stays `z.string().min(1).optional()`; slug is parsed at resolution time, not in Zod, to keep warn-not-reject semantics).
- **`DEFAULT_REPO_CONFIG`** (`:207`) is auto-derived; new keys default to `{}` → snapshot test must be updated to include `generation: {}`, `provider_options: {}` (this is the *only* expected change to the default object; G1/G6).
- **Add to `LanguageOverrideSchema`** (`:119-134`) as optional members per §4 (schema-only; application deferred OQ-4).
- **Export** `parseModelSlug(model, legacyProvider, defaultProvider) → { provider, model, notes: string[] }` — pure resolver implementing §4 slug rules + AS-1..AS-4. Lives here (shared) or in a new `model-slug.ts` in `packages/shared/src/`; **recommend a dedicated `packages/shared/src/model-slug.ts`** for unit isolation. Returns resolved provider/model + warning notes (never throws).

### 5.2 `packages/shared/src/schemas/provider.ts`
- **Extend `ProviderRequestShapingSchema`** (`:33-40`) — keep `model`, `deterministic_seed`, `capability_hints`; ADD:
  - `generation: z.object({ max_output_tokens, temperature, top_p, seed }).partial().optional()` (normalized bag, all optional) — or reuse the `GenerationSchema` shape.
  - `provider_options: z.record(z.string(), z.unknown()).optional()` — the **already-narrowed** raw bag for the **active** provider only (orchestrator passes `provider_options[activeProvider]`, not the whole map; keeps the adapter from having to know its own slug-vs-map relationship and prevents cross-vendor leakage at the boundary). Stays `.strict()` at the input level except this open record. (Note: the request-shaping object is `.strict()`; the open record is a *value*, so strictness is preserved.)
- No change to `ProviderCapabilities` required for this release (no new capability flag; `deterministic_seed` already exists). OQ-5 covers a future `normalized_generation` capability.

### 5.3 `packages/providers/openai/src/index.ts` + `client.ts`
- **`client.ts` `OpenAIChatCompletionsArgs`** (`:39-58`): add optional `temperature?: number`, `top_p?: number`, and an index signature `[k: string]: unknown` (or a typed `extra` merge) to carry raw passthrough. `JSON.stringify` already elides `undefined` (`:87-101`) so absent fields never hit the wire.
- **`index.ts review()`** (`:330-353`): after building base `args`, apply the precedence merge in this order (last wins):
  1. **Defaults** — `model` (resolved), token param via `resolveTokenParam`, `maxOutputTokens` default (existing path `:341-348`).
  2. **`generation` (normalized)** — from `input.request_shaping?.generation`:
     - `max_output_tokens` → overwrite `args[tokenParam]` (replaces the default budget). The token-param *key* is still chosen by `resolveTokenParam(model, tokenParamStyle)` — so a `gpt-5*` model gets `max_completion_tokens`, a classic model gets `max_tokens` (AS-5).
     - `seed` → also accepted here as a source for `args.seed` (note: `request_shaping.deterministic_seed` remains the existing path; `generation.seed` should be threaded into `deterministic_seed` by the orchestrator so the adapter reads ONE field — see 5.4). Pick one source of truth: **orchestrator maps `generation.seed` → `request_shaping.deterministic_seed`**; adapter does not read `generation.seed` separately. (Avoids two seed sources.)
     - `temperature` → `args.temperature`; `top_p` → `args.top_p`.
  3. **`provider_options` (raw, active provider only)** — from `input.request_shaping?.provider_options`: for each `[k,v]`, if `k ∈ OPENAI_PASSTHROUGH_DENYLIST` → skip + push note; else `args[k] = v` (verbatim, last-wins over generation). This is the escape hatch (AS-8, AS-9).
- **Add `OPENAI_PASSTHROUGH_DENYLIST`** constant (§3.7) + a small `applyProviderOptions(args, bag) → { args, droppedNotes }` pure helper (exported for unit test, mirrors `resolveTokenParam` exportability at `:70`).
- **Adapter never logs** the merged args (preserve `provider.ts:24-26`; G7).

### 5.4 `apps/github-app/src/pipeline/orchestrator.ts` — `buildProviderInput` (`:303-341`)
- Today only `cfg.model` → `request_shaping.model` (`:334-336`). Replace with the resolved-shaping build:
  1. Call `parseModelSlug(cfg.model, cfg.provider, <defaultProvider>)` → `{ provider: resolvedProvider, model: resolvedModel, notes }`. Push `notes` into the orchestrator's `allNotes` (config notes already flow to the publisher — `:552`).
  2. Set `request_shaping.model = resolvedModel` (bare name, AS-1/AS-2) when defined.
  3. Set `request_shaping.generation = cfg.generation` (omit if empty).
  4. Map `cfg.generation.seed` → `request_shaping.deterministic_seed` (single seed source, per 5.3).
  5. Set `request_shaping.provider_options = cfg.provider_options[resolvedProvider]` — **narrow to the active provider's bag here** (AS-10, G9). The orchestrator knows the active provider name from `deps.provider.name` (the `Provider` interface exposes `name` — `provider-interface.ts:28`). **Decision: key the bag by `deps.provider.name` (the actually-active adapter), not the slug provider** — because adapter selection is env-driven this release (OQ-1). If the slug provider ≠ active provider, the slug-named bag still applies only if it matches `deps.provider.name`. Document this in the merge note.
- `buildProviderInput` signature gains the active provider name (pass `deps.provider.name` or the whole provider). The function is called in both single-call (`:897`) and chunked (`:713`) paths — both must pass it.

### 5.5 `apps/github-app/src/worker.ts`
- **`buildProvider` (`:122-163`)** — env defaults are unchanged and remain the deployment-level baseline:
  - `OPENAI_MODEL` (`:128-131`) still sets the adapter's default `model` — overridden per-request when config supplies a slug (AS-2) or stays when config is silent (AS-11).
  - `OPENAI_TOKEN_PARAM` (`:141-148`) stays the ops-level token-param override; documented as equivalent to a `provider_options.openai` style override for the token field.
  - `OPENAI_MAX_OUTPUT_TOKENS` (`:154-160`) stays the default output budget; `generation.max_output_tokens` overrides it per-request.
- **`buildConfigReply` (`:315-354`)** — extend the effective-config echo:
  - Echo the **resolved** model slug (run the same `parseModelSlug` and print `model: <provider>/<name>` when a provider is known, else the bare name) so operators see what actually resolved.
  - If `config.generation` is non-empty, print a `generation:` block (each set field). Do NOT print `provider_options` **values** verbatim if there's any chance of secrets — **print keys only** under each provider, e.g. `provider_options:\n  openai: [reasoning_effort, verbosity]` (key list, not values). This satisfies G7 in the reply surface too.

### 5.6 Docs
- **`docs/config-spec.md`** — rewrite §`model` (`:43-49`), mark §`provider` (`:35-41`) deprecated-but-supported; add §`generation` and §`provider_options` with the denylist table; update the precedence matrix (`:320`) and worked example (`:335-394`). Add a migration note (legacy → slug).
- **`deployment.md` § Config** — note `generation.*` / `provider_options.openai.*` are repo-level equivalents/overrides of `OPENAI_*` env defaults.

### 5.7 Tests / evals — see §7.

---

## 6. Out of scope / non-goals

- **No adapter switching by config.** The active provider is still chosen by env API keys in `buildProvider`; the slug provider is parsed/echoed/used-for-bag-keying but does not re-route to a different adapter this release (OQ-1). 
- **No Anthropic / Copilot `generation` translation or passthrough beyond the generic mechanism.** Their request builders differ and don't read `request_shaping` today. The generic `request_shaping.generation` + `provider_options` plumbing is added, but only the **OpenAI** adapter consumes it. Anthropic/Copilot ignore it (no regression). A future PR wires each adapter's translation.
- **Default model stays `gpt-4o`** (`OPENAI_DEFAULT_MODEL`, `index.ts:94`). No change.
- **No model-registry / aliasing / capability-discovery feature.** No `gpt5`→`gpt-5.4-nano` alias map; the slug is taken literally.
- **No new vendor wire field validation.** Raw passthrough is forwarded un-validated by design (P3/P5); we do not add per-vendor field whitelists beyond the denylist.
- **No per-language application of `model`/`generation`/`provider_options`** (schema-only; OQ-4).

---

## 7. Test plan (the eval suite MUST be run)

Run order and required-green set. All must pass before merge (G1).

### 7.1 Schema unit tests — `packages/shared/tests/schemas.test.ts` (+ new `model-slug.test.ts`)
- `parseModelSlug` table (G2): `a/b`, `b`, `openai/gpt-5.4-nano`, `openai/`, `/gpt-4o`, `a/b/c`, legacy `provider+model`, conflict `provider:anthropic + openai/x` → assert resolved `{provider,model}` + expected notes (AS-1..AS-4, edge cases §4).
- `GenerationSchema`/`ProviderOptionsSchema`: valid parse, range rejection on `temperature: 3` (out of [0,2] → schema_violation is acceptable here; ranges are *known* keys), unknown nested key under `generation` warn-and-ignored (AS-12), open bag accepts arbitrary keys.
- `DEFAULT_REPO_CONFIG` snapshot updated to include `generation: {}`, `provider_options: {}` and **nothing else** changed (G1/G6).

### 7.2 OpenAI adapter mapping + precedence — `packages/providers/openai/tests/provider.test.ts`
- AS-5: `generation.max_output_tokens` → correct token-param key per model (`gpt-4o` vs `gpt-5.4-nano`) (G3).
- AS-6: `generation.seed`/`deterministic_seed` → `args.seed`.
- AS-7: `temperature`/`top_p` reach `args`.
- AS-8: `provider_options.openai.reasoning_effort` forwarded verbatim.
- AS-9: collision → raw wins (`args.max_tokens === <raw>`) (G4).
- G8: denylisted keys (`tool_choice`, `tools`, `stream`, `model`, ...) dropped; forced `submit_review_findings` intact; dropped-notes returned.
- G6: zero-shaping request byte-identical to current golden (snapshot of `OpenAIChatCompletionsArgs`).

### 7.3 Config-loader back-compat — `packages/config/tests/config-loader.test.ts`, `example-config.test.ts`
- Legacy `provider:` + `model:` still parses unchanged (AS-3) + deprecation note (G5).
- Conflict warns, does not throw (AS-4, G5).
- Empty / all-absent config → defaults (AS-11).
- The verbatim worked-example block in `config-spec.md` still parses (example-config test).

### 7.4 Orchestrator — `buildProviderInput`
- `request_shaping` carries resolved `model` (bare), `generation`, narrowed `provider_options[active]` (G9 boundary); non-active sub-bag absent from the input (AS-10).

### 7.5 Worker `buildConfigReply`
- Echoes resolved slug + `generation` block when set; `provider_options` shown as **key lists only** (G7).

### 7.6 Eval scenario — round-trip (REQUIRED; `evals/`)
- **New fixture** `evals/fixtures/generation-provider-options-roundtrip.yaml` + scenario entry in `evals/scenarios.yaml` (tag e.g. `model_settings_threading`):
  - `config_overrides`: `model: openai/gpt-5.4-nano`, `generation: { max_output_tokens: 8192, temperature: 0.2, seed: 42 }`, `provider_options: { openai: { reasoning_effort: low } }`.
  - The runner's `FakeProvider` records `calls[0]` (`pipeline-runner.ts:310-316`); assert `request_shaping.model === "gpt-5.4-nano"`, `request_shaping.generation.max_output_tokens === 8192`, `request_shaping.provider_options.reasoning_effort === "low"`, and `request_shaping.deterministic_seed === 42`. Pipeline `publication_state: succeeded` (zero behavior break).
  - Add a second tiny scenario asserting **zero-config** still succeeds and `request_shaping` has no `generation`/`provider_options` (AS-11). (May reuse an existing harmless fixture with an added assertion.)
- **Run the suite:** `pnpm --filter @prisma-bot/eval-runner eval` (or repo eval script). Refresh `evals/last-report.md`. The chunking-regression lesson (design.md) requires the eval suite be **run**, not just unit tests.

### 7.7 Full gate
`pnpm typecheck && pnpm lint && pnpm test` green; eval suite green (G1, G10).

---

## 8. Scoring rubric — "done well"

| Dimension | Weight | Excellent (5) | Adequate (3) | Failing (1) |
|---|---|---|---|---|
| **Back-compat** | 25% | All existing tests + evals green untouched; `DEFAULT_REPO_CONFIG` diff is exactly the 2 new empty keys; zero-config byte-identical (G1/G6). | Green but default snapshot drift explained. | Any existing test changed to pass; behavior change with empty config. |
| **Precedence correctness** | 20% | `provider_options` > `generation` > defaults proven by tests incl. collision (G3/G4); denylist enforced (G8). | Precedence right, denylist partial. | Normalized beats raw, or denylist missing. |
| **Slug robustness** | 15% | All §4 malformed cases warn-not-reject; conflict resolves + warns (G2/G5). | Common cases handled; a malformed case throws. | Malformed slug rejects the file. |
| **Vendor neutrality / isolation** | 15% | No vendor type leaks; non-active bag never read (G9/G10); only OpenAI consumes shaping; others unaffected. | Mostly isolated. | Cross-vendor leakage or a vendor type in shared. |
| **Secret/log safety** | 10% | No shaping content logged anywhere; config-reply shows keys-only (G7). | Logs clean; reply shows values. | A passthrough value hits a log. |
| **Testability + eval run** | 10% | Unit + adapter + loader + orchestrator + worker + **eval round-trip** all present and run. | Unit tests present, eval skipped. | No eval; precedence untested. |
| **Docs** | 5% | config-spec model/provider/generation/provider_options + denylist + migration all updated; worked example parses. | Partial doc update. | Docs unchanged. |

**Done-well bar:** weighted ≥ 4.0 with **no dimension < 3** and **Back-compat = 5**.

---

## 9. Open questions (each with a recommended default — execution NOT blocked)

| # | Question | Recommended default (use unless a human overrides) |
|---|---|---|
| **OQ-1** | Should a `model:` slug whose provider differs from the env-selected adapter actually **switch** the active adapter (e.g. `anthropic/...` forces the Anthropic adapter even if `OPENAI_API_KEY` is set)? | **No (this release).** Adapter selection stays env-key-driven in `buildProvider`. The slug provider is parsed, echoed, and used to key `provider_options`, but does not re-route. Switching by config requires multi-key availability + a selection-precedence design — defer to a follow-up. Emit a note when slug provider ≠ active provider. |
| **OQ-2** | Where does `parseModelSlug` live — inline in `config.ts`, or a dedicated `packages/shared/src/model-slug.ts`? | **Dedicated `model-slug.ts`** — pure, unit-isolated, importable by orchestrator + worker + tests without pulling the whole schema. |
| **OQ-3** | When `generation` sets a field the active vendor rejects (e.g. unsupported `top_p`), drop it pre-emptively or pass through and let the vendor 400? | **Pass through.** Prisma cannot maintain a per-model support matrix; the existing `mapOpenAIError` path surfaces a `capability`/`schema_validation` → `review_unavailable` with a clear notice. Document the behavior. |
| **OQ-4** | Should `model`/`generation`/`provider_options` be **applied** per-`language_overrides`, or only accepted in the schema? | **Schema-only this release.** The pipeline resolves one config per PR, not per file at provider-call time; per-language model settings need a provider-call-per-language redesign. Accept in `LanguageOverrideSchema` for forward-compat; do not apply. |
| **OQ-5** | Should `ProviderCapabilities` gain a `normalized_generation` / per-knob support flag so the orchestrator can drop unsupported `generation` fields before the call? | **Not now.** Adds surface without a consumer (OQ-3 chose passthrough). Revisit when a second adapter implements translation. |
| **OQ-6** | `generation.temperature` range — clamp to `[0,2]` (OpenAI) or accept any number and let the vendor validate? | **Validate `[0,2]` at schema level** (known key, reject out-of-range like other known keys). It's a normalized field, so a stable cross-vendor range is correct; users wanting exotic values use `provider_options` (escape hatch). `top_p` → `[0,1]`. |
| **OQ-7** | Should the config-reply (`buildConfigReply`) echo `provider_options` **values** or **keys only**? | **Keys only** (per provider). Eliminates any chance of echoing a secret a user mistakenly placed in the bag (G7). |

---

## 10. Self-verification (SPECTRA Test phase)

- **Structural:** all 5 required deliverable sections present (stories, gates, denylist, file-map, test plan + OQs); every integration point cites file:line (§0).
- **Dependency:** all touched files confirmed to exist and were read; `buildProviderInput` call sites (single + chunked) both covered (§5.4); FakeProvider `calls` seam + eval `config_overrides` merge confirmed present (§7.6).
- **Adversarial:** secret-leakage (G7) and structured-output-break (G8/denylist) explicitly closed; non-active-bag leakage (G9) closed; two-seed-source ambiguity resolved (single source via orchestrator, §5.3/5.4); `.strict()` vs warn-and-ignore tension on `generation` resolved with documented rationale (§5.1); env-vs-config precedence pinned (§5.5).
- **Residual risk:** OQ-1 (adapter switching) is the one genuinely open product decision; recommended default keeps the change non-breaking and ships value (model slug + generation + OpenAI passthrough) without it.

**Confidence: 88%** — Pattern match high (mirrors the existing `chunking` nested-block + `resolveTokenParam`/`request_shaping` precedents); requirements clear (design.md decided the schema); decomposition stable; the only <100% factor is OQ-1's product call, which has a safe default.
