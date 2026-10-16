# Reasoning report — GPT-6 / GPT-6.1 compatibility trade-offs

> FORGE, deep tier, single trace. 2026-10-16. Evidence: `research-digest.md` (H for OpenAI docs, M for GitHub-sourced strings), `scout-report.md` (H), source read directly (H). `requires_checker: false` (no verdict deploys, deletes, spends, or publishes).
> Paths are relative to the repo root.

## D1 — Context window for the GPT-6 family

**Verdict:** Resolve `max_context_tokens` per model to **922,000** for `gpt-6*` / `gpt-6.1*` (272,000 for `chat-latest` if D6 lands); everything else, including unknown slugs, stays 128,000; no schema change.

**Why:** The orchestrator uses the field as an *input* ceiling (`orchestrator.ts:840-845,865`), so 1,050,000 yields `hard_cap_in` = 963,404 > the 922,000 max-input limit and invites `context_length_exceeded`. 272,000 encodes a price, not a capability, and the cost guard already exists twice: `chunking.call_token_budget` and `MAX_TOKENS_PER_PR` (default 120,000, below the cliff). gpt-5.x and o-series windows are not in the digest → UNKNOWN → keep 128,000 (status quo, no regression); gpt-4o/gpt-4.1 stay 128,000 to keep the classic path behavior-identical.

**Rejected:** (a) 1,050,000 — overflows max input. (c) 272,000 — cost policy in a capability field. (d) new schema fields — cross-provider `.strict()` change (`provider.ts:355-368`) for one consumer; revisit when a second reader appears.

**Implementer constraints:**
- Add `resolveOpenAIContextWindow(model)` beside `resolveOpenAITokenizerFamily` (`index.ts:624`); prefix rule, not a slug table; wire in the constructor with the `options.capabilities?.max_context_tokens ??` precedent (`index.ts:1086-1088`).
- **Hard:** `effectiveBudget` must be ≤ the adapter's `maxTokensPerCall` (`index.ts:1123-1141`, fed by `worker.ts:81`). Today 105,944 < 120,000 masks the gap; at 922K, batches of 844K split twice (`orchestrator.ts:924`, 1088-1108) to 211K and go to `notReviewedFiles`. Make the worker comment at `worker.ts:67-68` true (min of both) or thread the guard value into `deps`.
- Document in `model-compatibility.md`: the 2× long-context price applies above 272K input; `MAX_TOKENS_PER_PR` / `call_token_budget` are the knobs.
- Update the `max_context_tokens` JSDoc (`provider.ts:360`) to say "max input tokens per call".

**Reverses if:** OpenAI publishes a gpt-5.x window (then add it) or the orchestrator grows a second consumer needing output ceilings (then D1-d).

## D2 — Per-model capability resolution timing

**Verdict:** Keep construction-time resolution; add an adapter-side per-request guard `min(maxTokensPerCall, resolveOpenAIContextWindow(model))` in `review()`; defer per-request `capabilities` to its own ADR.

**Why:** The dangerous direction is deployment `OPENAI_MODEL=gpt-6-*` with a repo overriding to a 128K model: the orchestrator plans 844K batches for a model that 400s. The adapter is the only component that sees `request_shaping.model` (`index.ts:1146`) and `over_budget` already degrades via split (`orchestrator.ts:1082`), so the guard converts an abort into a split/not-reviewed note. The opposite direction (repo overrides to a larger model) only over-chunks. ADR-007 "Consequences (later)" already reserves the interface change for a separate ADR.

**Rejected:** Per-request `Provider.capabilitiesFor(model)` — ADR-002 interface change across four adapters, out of proportion for this scope.

**Implementer constraints:**
- The guard compares the serialized-prompt estimate against the raw input ceiling; it does not need chunking's reservations.
- `respond()` uses `this.model` only (`index.ts:1334`); no change there.
- Accepted blast radius: a repo override to a larger-window model gets the deployment window (more calls, never a 400).

**Reverses if:** a third per-request-varying capability appears.

## D3 — Reasoning-effort normalization on the Responses path

**Verdict:** (b) Forward verbatim; make the 400 actionable via D11; no per-model table.

**Why:** `toResponsesArgs` notes have no channel to `config_notes` (ADR-007 § Trade-offs), so "normalize with a note" is silent in practice and changes what the operator gets (cost/latency/quality), unlike a dropped no-op field. A sol/luna/astra/6.1 table is stale on the next codename; a family rule needs a major-version parser (a second regex) and still cannot split `none` (astra rejects, sol accepts). The API's own 400 lists the supported values, which is self-describing and never stale.

**Rejected:** (a) nearest-supported — invisible substitution, new table or regex. (c) drop to default — discards operator intent silently.

**Implementer constraints:**
- No change to `toResponsesArgs` effort logic (`index.ts:300-330`).
- `model-compatibility.md` gets an effort × model matrix (`none`: sol/luna only; `minimal`: never on GPT-6; `max`: new).
- Revisit `minimal`→`low` only when a provider-note channel exists.

**Reverses if:** the note channel lands, or OpenAI starts rejecting `medium` default on some variant (then a model table is unavoidable).

## D4 — Sampling parameters on reasoning models

**Verdict:** (a) Strip normalized `generation.temperature` / `top_p` when `isReasoningModel(model)` and the explicitly configured effort is not `'none'`, in both `review()` and `respond()`; passthrough keys ride untouched.

**Why:** `generation` is vendor-neutral first-class config; a repo tuned for Anthropic parity must not 400 on model switch. Sampling has no effect on a reasoning model, so dropping it loses nothing (the distinguishing fact versus D3). Keying on the model predicate, not the endpoint, keeps a classic model pinned to `OPENAI_API_STYLE=responses` forwarding sampling. o-series/gpt-5.x rejection is [ASSUMPTION, M]; stripping there fixes a latent 400 at worst and drops an inert parameter.

**Rejected:** (b) gpt-6-only — second regex. (c) leave — hard failure on vendor-neutral config.

**Implementer constraints:**
- Apply at `index.ts:1211-1216` and `:1341-1346`; read explicit effort from `provider_options.openai.reasoning_effort` or `reasoning.effort` (native wins, ADR-007 D3).
- Do not touch `applyProviderOptions` output: an explicit passthrough `temperature` is the operator addressing the wire.
- Byte-identical for classic: the predicate is false for gpt-4o/gpt-4.1.
- `logprobs` / `top_logprobs` are passthrough-only; out of scope.

**Reverses if:** OpenAI documents sampling as accepted at non-`none` effort on a reasoning model.

## D5 — The `respond()` flow

**Verdict:** Keep `/chat/completions`; apply D4 stripping; keep `seed`.

**Why:** GPT-6 accepts chat without tools (digest §2); `max_completion_tokens` is already selected by `resolveTokenParam`; routing through `/responses` needs a new `output_text` parser and loses `seed`, which ADR-007 explicitly declined. `seed` on chat is UNCONFIRMED, so a D11 `param: seed` remedy is the honest handling rather than a pre-emptive drop.

**Rejected:** Route reasoning models to `/responses` — new extraction path, seed loss, no confirmed gain.

**Implementer constraints:** test matrix includes a mocked 400 `param: "seed"` through `respond()`; truncation detection at `index.ts:1358-1376` is unchanged.

**Reverses if:** chat is deprecated for GPT-6 or `seed` is confirmed rejected (then strip seed for reasoning models on chat; still do not re-route).

## D6 — The `chat-latest` alias

**Verdict:** Add `chat-latest` (exact, anchored) to `REASONING_MODEL_RE` in `model-slug.ts:65`.

**Why:** It is reasoning-capable and on both endpoints; today it gets chat + `max_tokens` + forced function, a near-certain 400. One token in the shared predicate fixes routing, `tool_choice`, token param, tokenizer (D8) and window (D1) together; the escape-hatch route needs three deployment-wide env vars for one alias.

**Rejected:** Leave — predictable failure. Escape hatch only — `OPENAI_API_STYLE` + `OPENAI_TOKEN_PARAM` + `OPENAI_TOOL_CHOICE`, all global.

**Implementer constraints:** add positive case in `model-slug.test.ts`; document that OpenAI recommends `gpt-6-*` for production and that the alias's snapshot changes without notice (reviews non-reproducible).

## D7 — Default output budget

**Verdict:** (b) Family-aware default: 4096 classic, **32,768** for `isReasoningModel(model)` when `OPENAI_MAX_OUTPUT_TOKENS` is unset.

**Why:** The cap includes reasoning tokens; at 4096 a medium-effort GPT-6 review truncates systematically, and each `output_truncated` split costs a real call (`orchestrator.ts:1008-1075`). 32,768 clears OpenAI's ≥25,000 floor with room for the findings JSON, is 1/4 of the 128,000 ceiling, and bounds worst-case per-call output spend; it is a ceiling, not spend.

**Rejected:** (a) keep 4096 — broken by default on GPT-6. (c) docs only — same.

**Implementer constraints:**
- The worker always passes a number (`worker.ts:202`), so `DEFAULT_MAX_OUTPUT_TOKENS` (`index.ts:1063`) never applies in production; the family default must live where `resolveMaxOutputTokens` resolves per job.
- **Coupling:** the effective output cap and `chunking.reserved_output_tokens` must stay equal by default (they are today via `resolveMaxOutputTokens` priority); apply N to both. Otherwise `hard_cap_in` under-reserves on any true-128K reasoning model.
- Classic stays 4096 (byte-identical).

**Reverses if:** telemetry shows `reasoning_tokens` routinely > 28K (raise) or operators report runaway output cost (lower).

## D8 — Tokenizer family resolution

**Verdict:** Replace the exact-match map with a rule: `isReasoningModel(m) || /^gpt-4(o|\.1|\.5)/i.test(m)` → `o200k`, else `cl100k`.

**Why:** GPT-6 is empirically o200k-identical (M) and js-tiktoken 1.0.21 ships nothing newer, so `o200k` is both best estimate and still non-under-counting (any larger future vocab tokenizes to fewer tokens). Reusing `isReasoningModel` keeps one family predicate; the classic-o200k arm is a vocabulary rule, not a family classification. `cl100k` fallback stays: over-counting is safe for gateway deployment names.

**Rejected:** Extend the slug table — stale per codename. Default `o200k` for unknown — could under-count a cl100k model.

**Implementer constraints:** remove `OPENAI_TOKENIZER_FAMILY_MAP` (`index.ts:584-621`) or keep it test-only; `OPENAI_CAPABILITIES.tokenizer_family` default unchanged; add gpt-5.6-sol / gpt-6-astra / gpt-6.1-sol / chat-latest cases.

## D9 — `OPENAI_DEFAULT_MODEL = 'gpt-4o'`

**Verdict:** **Keep** `gpt-4o` for this change; add a startup warning when `OPENAI_MODEL` is unset naming 2027-01-14 and `gpt-6-luna`; flip the default in its own release before shutdown. This is a recommendation to keep; the user should ratify it.

**Why:** Flipping changes every axis at once for unconfigured deployments (endpoint, tool_choice, seed loss, output cap, cost profile) with no operator action, which violates the classic-path regression principle three months before it is forced. A warning is non-breaking and visible.

**Rejected:** Change now — silent multi-axis behavior change. Keep + docs only — nobody reads docs for a default they never set.

**Implementer constraints:** emit next to `worker.provider.selected` (`worker.ts:234`); update `install-github-app.md:114`, `deployment.md:78`, `.env.example`.

## D10 — Notice text

**Verdict:** Replace the advice in all three copies with one helper in `apps/github-app/src/provider-notices.ts` (the existing single-text home shared by orchestrator and worker), not `@prisma-bot/shared`.

**Proposed text:** "ℹ️ `<model>` is a reasoning model and reported no findings. If you expected some, check the `provider.usage` log event: `reasoning_tokens` near zero means the model skipped reasoning (do not set `reasoning_effort: 'none'`; unset `OPENAI_TOOL_CHOICE=forced`); a large count with an empty result usually means a tight output cap — raise `OPENAI_MAX_OUTPUT_TOKENS` (≥ 25,000 on GPT-6) or the effort. See docs/model-compatibility.md."

**Rejected:** `@prisma-bot/shared` — product copy in a vendor-neutral library; no consumer outside the app.

**Implementer constraints:** keep the phrase "is a reasoning model" (eval fixture `reasoning-model-empty-review.yaml:84-85` asserts substrings); call sites `orchestrator.ts:378`, `:1506`, `worker.ts:709`.

## D11 — Error-mapping widening

**Verdict:** Classify 400 `code ∈ {unsupported_value, unsupported_parameter}` as `capability` regardless of wording; select remedies by `param` (`reasoning_effort` → "set a value this model supports; the API message lists them"; `temperature`/`top_p`/`top_logprobs`/`logprobs` → "remove generation.temperature / top_p for this model"; `seed` → "remove generation.seed"); add `Retry-After` to 5xx; carve 429 `insufficient_quota` out as non-retryable.

**Why:** `code`/`param` are the stable fields; message strings are from bug reports and may change. 429 `slow_down` already maps correctly (`error-mapping.ts:217-224`); 503 `server_is_overloaded` already retries but drops `Retry-After` (`:226`).

**Rejected:** Message-only regexes — brittle. Treating `unsupported_parameter` as retryable transport — it is configuration.

**Implementer constraints:**
- **Misclassification trap:** the chat+tools rejection also carries `param: "reasoning_effort"` with `code: null` (digest §13). Gate the "set a supported value" remedy on `code === 'unsupported_value'` (or the "Unsupported value" prefix) and evaluate the existing `RESPONSES_REMEDY` signature first (`provider-notices.ts:29-30`).
- A gateway behind `OPENAI_BASE_URL` returning `unsupported_parameter` for `store` or `reasoning` is still `capability`, but `param` is unknown to the remedy table → generic notice, never a wrong remedy.
- Carrying `param` requires either an optional additive field on `ProviderError`'s capability variant or a deterministic suffix in `message`; never key on full-sentence wording.
- No genuine transport error is affected: all widening is inside `status === 400` with a structured code, plus header reading on 5xx.

## Confidence

- D1: 0.80 — value certain; the `MAX_TOKENS_PER_PR` coupling is the risk.
- D2: 0.75 — guard design is minimal; interface deferral is a judgment call.
- D3: 0.65 — rejects OpenAI's checklist on principle; most contestable.
- D4: 0.80 — gpt-5.x/o-series sampling rejection is assumed, not digested.
- D5: 0.80 — `seed` on chat unconfirmed.
- D6: 0.75 — `chat-latest` wire behavior unverified.
- D7: 0.70 — N is a cost judgment.
- D8: 0.85
- D9: 0.75 — product decision.
- D10: 0.80
- D11: 0.85

## Open for the user

- **D9** — keep `gpt-4o` default with a startup warning, or flip to `gpt-6-luna` now.
- **D7** — accept 32,768 as the reasoning-family default output cap (raises worst-case per-call output spend 8× when the env var is unset).
- **D3** — ratify forwarding effort verbatim (visible 400 with remedy) over OpenAI's recommended silent `minimal`→`low` substitution.

Handoff: → RAMZA for spec; constraints above are the spec's acceptance anchors.
