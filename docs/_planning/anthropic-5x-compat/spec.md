# Spec — Claude 5.x (Haiku 5.5 / Sonnet 5.5 / Opus 5.5 / Fable 5.1) model-family compatibility for the Anthropic adapter

- Task label: `RAMZA [claude-opus-5-5 | Unknown] - Spec Anthropic 5.x model-family compatibility`
- Status: Proposed, 2026-10-16
- Base: `feat/anthropic-5x-model-compat` @ `b441099` (v0.15.0)
- RS tier: `full`, applied by hand. `bin/ramza-*` tools are not available on this host, so the right-sizing, lint, freeze, drift and confidence rubrics below were all applied by hand.
- Inputs (the evidence base; decisions are settled and not re-opened): `docs/_planning/anthropic-5x-compat/research-digest.md`, `scout-report.md`, `reasoning-report.md` (FORGE D1–D14).
- Ratifications (recorded by the orchestrator, 2026-10-16):
  - D11: `claude-sonnet-5-5` is the default model.
  - D9: server-side fallbacks are deferred.
  - D5 + D3: 16,384 default output cap for Claude 5.x, and no default `effort`.
  - No `[USER-RATIFY]` item is still open.
- **Choices RAMZA made inside FORGE's delegation** (flagged so a reviewer can check them):
  - **R1.** `ANTHROPIC_TOOL_CHOICE` takes `auto | forced | unforced`. `auto` means "use the rule", the same meaning as `OPENAI_TOOL_CHOICE=auto`. This settles the naming note in D1. Because of it, the D10 forced-tool remedy names `unforced`.
  - **R2.** The refusal notice says "the bot's `review` command" instead of `@<bot> review`. No bot handle reaches the orchestrator.
  - **R3.** Files in a declined batch get their own note. The existing "Not reviewed" note names `max_provider_calls_per_pr` and would misdiagnose a refusal.
  - **R4.** The strict schema copy forces `additionalProperties: false` on every object node.
  - **R5.** The smoke script reports `EMPTY` (non-zero exit) when a model returns zero findings on the seeded bug.
  - **R6.** The refusal `category` is sanitized to `[a-z0-9_]{1,64}`; anything else becomes `none`.
  - **R7.** `worker.provider.selected` carries `model` for Anthropic.
  - **R8.** Every Anthropic remedy text starts with `Remedy:`, like the existing ones.
- Hand-applied gates:
  - **Right-sizing = full:** 4 packages plus an app, new env vars, additive cross-package schema fields, user-visible notices, and a new script.
  - **Lint:** every acceptance scenario (AS) has Given/When/Then and a test anchor, or an explicit manual check.
  - **Freeze:** D1–D14 are inputs, not re-opened.
  - **Drift:** each § 3 subsection names the FORGE decision it implements, and § 8 declares the file scope.
  - **Confidence = 0.79, VALIDATE band:** Evidence 0.80, Logic 0.85, Constraints 0.85, Sensitivity 0.65. The user's live smoke run (§ 3.17) is the validation step.
- Validation gates (host equivalents, per repo practice): `pnpm run typecheck && pnpm run lint && pnpm test && bash scripts/check-vendor-isolation.sh && ./node_modules/.bin/tsx evals/runner/src/cli.ts --all`. The pre-release live check is user-run and never part of CI (§ 3.17).

## 1. Problem statement and goals

What breaks today for an Anthropic deployment, in priority order (scout FINDING-001..012, FORGE GAP-2):

1. **Every unconfigured review fails with a 404, and nobody sees it.**
   - `ANTHROPIC_DEFAULT_MODEL = 'claude-3-5-sonnet-latest'` (`packages/providers/anthropic/src/index.ts:30`) is retired.
   - The 404 maps to `transport, retryable: false` (`packages/providers/anthropic/src/error-mapping.ts:221`), and `classifyRetry` treats every `transport` error as `transient` (`apps/github-app/src/queue/job-queue.ts:94-95`).
   - Result: PR events retry 3 times silently, and commands get up to 3 misleading "Sorry…" replies (`apps/github-app/src/worker.ts:881-893`).
2. **There is no way to move off the retired default.**
   - The worker reads no model env var (`worker.ts:183-202`).
   - The adapter fixes the model at construction (`index.ts:198`) and never reads `request_shaping` (0 references).
   - So a repo setting `model: anthropic/claude-sonnet-5-5` is silently dropped.
3. **Forced tool choice.** `tool_choice: { type: 'tool', name }` (`index.ts:251`) is a 400 on Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1. On Haiku 5.5 it skips thinking (digest § 6), which is the same shape as Prisma's OpenAI empty-review incident.
4. **A 4096-token cap while thinking is on by default** (`index.ts:67`, `worker.ts:189`). Thinking counts toward `max_tokens`, so outputs are systematically truncated (`output_truncated`) and every truncation costs a split-retry (digest § 2).
5. **Refusals are misclassified.** `stop_reason: 'refusal'` (HTTP 200) falls through to "missing tool_use block" (`index.ts:168-171`) or "no text content" (`index.ts:140-143`). That gives the wrong error kind and the wrong remedy.
6. **400s that miss the keyword heuristic are retried.** The heuristic is at `error-mapping.ts:206-219`. Examples that miss it: "prompt is too long", "credit balance is too low".
7. **Capabilities are static.**
   - The window is 200,000 for every model (`index.ts:36`); Claude 4.6+ and 5.x have 1M.
   - The `anthropic-approx` estimate is chars/4 × 1.15 (`packages/shared/src/tokens/estimator.ts:93`). It can under-count the 5.x and Opus 4.7+ tokenizers by up to about 35%.
8. **No telemetry and no empty-review notice.** Anthropic emits no `provider.usage` event. The empty-review notice is gated on `isReasoningModel` only (`apps/github-app/src/pipeline/orchestrator.ts:398`, `:1586`).
9. **The docs and config are out of date.**
   - `docs/config-spec.md:87` promises a `provider_options` passthrough that the adapter does not do.
   - The `provider_options.anthropic.thinking` example (`config-spec.md:97-100`) is a 400 on every 5.x model.
   - No Anthropic model, output-cap or tool-choice env vars are documented.

**Goals:**
- An unconfigured deployment reviews on `claude-sonnet-5-5`, and both `ANTHROPIC_MODEL` and a repo `model: anthropic/<id>` take effect.
- Claude 5.x IDs get:
  - the unforced bundle (`tool_choice: auto`, a strict tool, a prompt nudge, and one retry);
  - a 16,384 default cap;
  - a 1M window;
  - an estimate that does not under-count.
- Claude 4.x and older keep today's request bytes, except where § 5 AS-6 lists a deliberate change.
- Refusals, retired IDs and every 400 of type `invalid_request_error` become non-transient errors with a visible, targeted notice.
- `provider.usage` parity with OpenAI, and a Claude-specific empty-review notice.
- OpenAI and Copilot wire bytes stay unchanged.
- A live smoke script the user can run before release.

## 2. Non-goals

These are the D14 cuts plus the alternatives FORGE rejected.

- **Out of scope for the SDK and transport:**
  - No SDK bump past `@anthropic-ai/sdk` 0.32.1.
  - No streaming.
  - No Bedrock, Vertex or Foundry clients.
  - No Prisma base-URL setting or docs. The SDK's implicit `ANTHROPIC_BASE_URL` stays undocumented and unsupported.
  - No beta endpoint or `betas` header.
  - `AnthropicClientLike` (`index.ts:53-57`) is unchanged.
- **Out of scope for request features:**
  - No server-side fallbacks (D9, deferred; the opt-in shape is recorded in ADR-009).
  - No prompt caching (`cache_control`).
  - No structured outputs (`output_config.format`) in place of the tool.
  - No `ANTHROPIC_EFFORT` env var.
  - No per-model effort table.
  - No forwarding of `generation.temperature`, `generation.top_p` or `generation.seed`.
- **`respond()` gets only two changes:** the D5 cap and the D8 refusal check. It does not get the model override, the provider-options bag, effort, telemetry or the retry.
- **No error-plumbing changes:**
  - No new `ProviderError` kind.
  - No `classifyRetry` change: the cross-provider fix for `transport.retryable === false` is out of scope.
  - No new orchestrator outcome kind for refusals.
  - The worker's `review`-command reply on a refusal stays "Review complete!…"; the check run carries the refusal notice. This is the same as the pre-existing malformed-output behavior.
- **No interface or orchestrator-gate changes:**
  - No per-request `capabilities` interface.
  - No change to the orchestrator's budget math.
  - No empty-review notice for repos without `model:` (known gap, carried over from D12).
- **Untouched code and tests:**
  - Copilot and OpenAI adapters: no file changes under `packages/providers/openai` or `packages/providers/copilot`.
  - Shared prompt and schema: no change under `packages/shared/src/prompt`.
  - The stale-but-harmless test strings `claude-sonnet-4.5` (`packages/shared/tests/model-slug.test.ts:40,60,170`; `apps/github-app/tests/pipeline/orchestrator.test.ts:2208`), `claude-4-class-model-id` (`packages/config/tests/config-loader.test.ts:8,70`) and the keys-only echo test `anthropic: { thinking: 'enabled' }` (`apps/github-app/tests/worker/command-dispatch.test.ts:891`). They exercise parsing and echo, not model validity.
- **No live calibration** of the D7 margin with `count_tokens`.

## 3. Design

**Common rules:**
- New helpers are pure and exported so they can be unit-tested.
- Adapter helpers live in `packages/providers/anthropic/src/index.ts` unless stated otherwise. The model-ID parser lives in `packages/shared/src/model-slug.ts`.
- Notes are key-only and stay local (G-1).
- `exactOptionalPropertyTypes` is on, so optional fields must be built conditionally.
- **Declaration order matters.** Module-level constants and regexes used by the resolvers must be declared above `DEFAULT_CAPABILITIES` (`index.ts:32`). That literal calls the resolvers at module load, and a `const` declared later would throw a temporal dead zone (TDZ) error.

### 3.1 Claude model-ID parser and adaptive-thinking predicate — implements D1 (shared half)

**Where:** `packages/shared/src/model-slug.ts`, after `isReasoningModel` (`:98-100`) and before `ParsedModelSlug` (`:102`). `REASONING_MODEL_RE` (`:75`) and its JSDoc are not touched.

```ts
export interface ClaudeModelId {
  family: string;            // lower-cased letters: opus | sonnet | haiku | fable | mythos | …
  major: number;
  minor: number | undefined; // undefined for `claude-opus-5` and when the group is a date
}
const CLAUDE_MODEL_ID_RE = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i;
export function parseClaudeModelId(model: string): ClaudeModelId | undefined;
export function isClaudeAdaptiveThinkingModel(model: string): boolean; // parsed !== undefined && parsed.major >= 5
```

**Parse rules:**
1. **Unanchored and case-insensitive.** `us.anthropic.claude-opus-5-5`, `anthropic.claude-sonnet-4-6-v1:0` and `CLAUDE-OPUS-5-5` all parse. `family` is lower-cased.
2. **The family must be letters.** So version-first IDs return `undefined`: `claude-3-5-sonnet-latest`, `claude-3-opus-20240229`.
3. **An 8-digit group is a date, never a version.**
   - `claude-opus-4-20250514` → `{opus, 4, undefined}`.
   - An 8-digit major group → `undefined`.
4. **Examples:**
   - `claude-sonnet-4-5-20250929` → `{sonnet, 4, 5}`
   - `claude-fable-5-1` → `{fable, 5, 1}`
   - `claude-foo-6` → `{foo, 6, undefined}`
   - `claude-sonnet-4.5` → `{sonnet, 4, undefined}`

**Single source of truth.** This parser is the only Claude family source. Tool-choice mode (§ 3.2), the default cap (§ 3.6), the window (§ 3.7), the tokenizer (§ 3.8) and the empty-review gate (§ 3.13) all derive from it (G-2). Its JSDoc names those consumers and says "do not extend `REASONING_MODEL_RE` for Claude". The module header (`:40-43`) gains a "Claude model-ID parser" banner.

### 3.2 Tool choice: forced path vs unforced bundle — implements D1 (adapter half)

```ts
export type AnthropicToolChoiceStyle = 'auto' | 'forced' | 'unforced'; // ANTHROPIC_TOOL_CHOICE (R1)
export type AnthropicToolChoiceMode = 'forced' | 'unforced';
export function providerOptionsEnableThinking(bag: Record<string, unknown> | undefined): boolean;
export function resolveAnthropicToolChoiceMode(
  model: string,
  bag: Record<string, unknown> | undefined,
  style: AnthropicToolChoiceStyle = 'auto',
): AnthropicToolChoiceMode;
export const ANTHROPIC_TOOL_NUDGE =
  '\n\nAnalyze the diff thoroughly, then call submit_review_findings exactly once with every real finding; use an empty findings array only if there are genuinely no issues. Your answer is read only from that tool call; plain text is discarded.';
```

**`providerOptionsEnableThinking(bag)`** is true when `bag.thinking` is a plain object whose `type` is `'adaptive'` or `'enabled'`.

**`resolveAnthropicToolChoiceMode`**, in order:
1. `style === 'forced'` → `forced`.
2. `style === 'unforced'` → `unforced`.
3. Otherwise → `unforced` when `isClaudeAdaptiveThinkingModel(model) || providerOptionsEnableThinking(bag)`, else `forced`.

**What the rule implies:**
- An explicit env style beats the rule. The repo bag can turn the bundle on, never off, because `tool_choice` is denylisted (§ 3.5).
- Unparseable names and aliases get `forced` (today's bytes).
- An unknown `claude-*-6` gets `unforced`.

**Wire shapes** (key order is part of the contract):

| Mode | Request object sent to `messages.create` |
|---|---|
| `forced` (unchanged) | `{ model, max_tokens, system: prompt.system, messages: prompt.messages, tools: [{ name, description, input_schema }], tool_choice: { type: 'tool', name: 'submit_review_findings' } }` |
| `unforced` | `{ model, max_tokens, system: prompt.system + ANTHROPIC_TOOL_NUDGE, messages: prompt.messages, tools: [{ name, description, input_schema: toAnthropicStrictSchema(prompt.tool.input_schema), strict: true }], tool_choice: { type: 'auto', disable_parallel_tool_use: true } }` |

**Where the nudge goes.** The nudge is appended in `index.ts`, not in `prompt.ts`. `buildPrompt(...).system` stays `IMMUTABLE_SYSTEM_PROMPT` (the test at `packages/providers/anthropic/tests/prompt.test.ts:28` pins it). The shared prompt, OpenAI's `REASONING_NUDGE` (`packages/providers/openai/src/index.ts:1388`) and Copilot's bytes are untouched.

**Missing-call policy:**
- Unforced path only: at most one identical retry (the same `args` object) when no `submit_review_findings` `tool_use` block comes back.
- A second miss throws `{ kind: 'schema_validation', message: "anthropic response did not call 'submit_review_findings' (tool_choice auto) after 1 retry" }`.
- The forced path never retries. It keeps today's message, `anthropic response missing tool_use block for tool 'submit_review_findings'` (`index.ts:168-171`).
- Implementation: refactor `extractToolUseInput` (`:148-172`) into `findToolUseInput(response, toolName): { found: true; input: unknown } | { found: false }`. It keeps today's two throws ("was not an object", "missing content array"), so those never retry.

**`AnthropicProviderOptions`** (`index.ts:69-89`) gains two fields:
- `toolChoiceStyle?: AnthropicToolChoiceStyle`
- `onUsage?: (usage: AnthropicUsageTelemetry) => void` (§ 3.14)

### 3.3 Strict wire schema — implements D2

**Where:** `packages/providers/anthropic/src/prompt.ts`. `buildPrompt` (`:35-54`) and `PromptShape` (`:25-33`) are unchanged.

```ts
export const ANTHROPIC_STRICT_SCHEMA_KEYWORDS = [
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description',
] as const;
export function toAnthropicStrictSchema(schema: object): object;
```

**The copy is a recursive deep copy built from an allowlist:**
- It walks every node, recursing into each value under `properties` (property names are kept) and into `items`.
- It keeps only allowlisted keys, in input order. Arrays (`required`, `enum`) are copied.
- Every node with `type === 'object'` gets `additionalProperties: false`: kept in place if present, appended if absent (R4).
- Everything else is dropped. Today that means `minLength`, `maxLength`, `minimum`, `maximum` and `maxItems` (`packages/shared/src/prompt/review-prompt.ts:80-120,158`).
- The input is never mutated.

**Why an allowlist.** A keyword added later to the shared schema is dropped from the Anthropic copy rather than turning every 5.x review into a 400.

**What stripping costs.** The stripped bounds are model hints only:
- Zod (`ProviderReviewOutputSchema`) stays authoritative.
- The highlights cap is enforced by the validator (`packages/core/src/validator-ranker/validator/index.ts:306`).
- Highlight `maxLength` 200/500 were hints only.

**Where it is used:** only on the unforced path. Re-export it from the bottom of `index.ts` (`:358-362`).

### 3.4 Thinking and effort — implements D3

Prisma never sends `thinking` and never sends a default `effort`. Model defaults apply: `medium` on Opus 5.5 and Haiku 5.5, `high` elsewhere.

`effort` reaches the wire only from the repo bag (§ 3.5):
- **Flat `effort`** maps to `output_config.effort`.
- **Native `output_config.effort`** wins over the flat key.
- Values are forwarded verbatim and not validated. An unsupported value reaches the effort remedy (§ 3.11).
- `thinking` is not denylisted. An operator-set `thinking` is forwarded, and a resulting 400 gets the thinking remedy.

### 3.5 `request_shaping`: model, generation, passthrough bag — implements D4

**Model** (`review()` only): `const model = input.request_shaping?.model ?? this.model;`.

**Generation:**
- `generation.max_output_tokens` becomes `max_tokens` (precedence in § 3.6).
- `temperature`, `top_p`, `seed` and `deterministic_seed` are never read.
- The orchestrator side (`orchestrator.ts:490-544`) already forwards model, generation and the active provider's bag; it is unchanged.

**Passthrough bag:**

```ts
export const ANTHROPIC_PASSTHROUGH_DENYLIST: ReadonlySet<string> = new Set([
  'model', 'messages', 'system', 'tools', 'tool_choice', 'stream', // Prisma-managed
  'betas', 'mcp_servers', 'container',                              // data boundary / header smuggling
  'fallbacks',                                                       // spend routing (D9)
]);
export const ANTHROPIC_OUTPUT_CONFIG_DENYLIST: ReadonlySet<string> = new Set(['format']);
export function applyAnthropicProviderOptions(
  args: Record<string, unknown>,
  bag: Record<string, unknown>,
): { args: Record<string, unknown>; droppedNotes: string[] };
```

`applyAnthropicProviderOptions` works on a shallow copy of `args` and never mutates `args` or `bag`. It iterates `bag` in order:
1. **Denylisted key:** add the note `provider_options.anthropic.<k> ignored (Prisma-managed field)` and skip the key.
2. **`effort`:** hold it.
3. **`output_config` that is a plain object:** copy it without `format`. If `format` was there, add the note `provider_options.anthropic.output_config.format ignored (Prisma-managed field)`. Assign the copy.
4. **Anything else:** assign it verbatim. This covers `thinking`, `temperature`, `top_p`, `top_k`, `max_tokens`, `metadata`, `service_tier`, `inference_geo` and so on.
5. **After the loop, a held `effort`:**
   - If `output_config` is absent, set `output_config = { effort }`.
   - If it is a plain object without `effort`, set `{ ...output_config, effort }`.
   - Otherwise drop the flat key with the note `provider_options.anthropic.effort ignored (output_config.effort is set)`.

**Applied** after the base args are built. Notes are collected locally, as in OpenAI's `applyProviderOptions` (`openai/src/index.ts:538-553`), and never logged.

**`respond()`** keeps `this.model` and gets no bag. `ProviderRespondInput` has no `request_shaping`.

### 3.6 Output cap — implements D5 (ratified)

```ts
export const ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS = 4096;            // replaces private DEFAULT_MAX_OUTPUT_TOKENS (index.ts:67)
export const ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS_THINKING = 16_384;
export function resolveAnthropicDefaultMaxOutputTokens(
  model: string,
  bag?: Record<string, unknown>,
): number; // isClaudeAdaptiveThinkingModel(model) || providerOptionsEnableThinking(bag) ? 16_384 : 4096
```

**Constructor** (`index.ts:200`): change to `this.explicitMaxOutputTokens = options.maxOutputTokens` (`number | undefined`). The fixed `maxOutputTokens` field goes away.

**`review()` effective cap**, highest precedence first:
1. bag `max_tokens`, when it is a positive integer;
2. `generation.max_output_tokens`;
3. `this.explicitMaxOutputTokens` (`ANTHROPIC_MAX_OUTPUT_TOKENS`);
4. `resolveAnthropicDefaultMaxOutputTokens(model, bag)`.

**How the cap is used in `review()`:**
- `args.max_tokens` is set to the effective cap before the bag merge. The bag then rewrites it with its own value, if present.
- The guard (§ 3.7), `output_truncated.requested_max_tokens` and the truncation message `(max_tokens: <n>)` all use the effective cap.
- The default keys on the model and the bag, not on `ANTHROPIC_TOOL_CHOICE`.

**`respond()`** uses `this.explicitMaxOutputTokens ?? resolveAnthropicDefaultMaxOutputTokens(this.model)`.

**Worker coupling** (§ 3.16): `providerLimits.maxOutputTokens = envMax ?? resolveAnthropicDefaultMaxOutputTokens(model ?? ANTHROPIC_DEFAULT_MODEL)` (G-8).

16,384 is below the ~21K non-streaming threshold of newer SDKs. No streaming is added.

### 3.7 Context window and per-request guard — implements D6

```ts
export const ANTHROPIC_CONTEXT_WINDOW_DEFAULT = 200_000;  // Claude 4.5 and older, unknown IDs
export const ANTHROPIC_CONTEXT_WINDOW_LONG = 1_000_000;   // Claude 4.6+ and every 5.x
export function resolveAnthropicContextWindow(model: string): number;
```

**Rule:** `parsed && (parsed.major >= 5 || (parsed.major === 4 && parsed.minor !== undefined && parsed.minor >= 6))` gives 1,000,000; everything else gives 200,000.

**Constructor** (`index.ts:197`), following the OpenAI precedent (`openai/src/index.ts:1273-1279`):

```ts
const base = options.capabilities ?? DEFAULT_CAPABILITIES;
this.capabilities = {
  ...base,
  max_context_tokens: options.capabilities?.max_context_tokens ?? resolveAnthropicContextWindow(this.model),
  tokenizer_family: options.capabilities?.tokenizer_family ?? resolveAnthropicTokenizerFamily(this.model),
};
```

`DEFAULT_CAPABILITIES` (`index.ts:32-43`) derives `max_context_tokens` and `tokenizer_family` from the resolvers for `ANTHROPIC_DEFAULT_MODEL`, so the literal cannot drift.

**Guard** (replaces `index.ts:215-233`; active only when `maxTokensPerCall !== undefined`):

```
windowFor(model) = model === this.model ? this.capabilities.max_context_tokens : resolveAnthropicContextWindow(model)
familyFor(model) = model === this.model ? this.capabilities.tokenizer_family   : resolveAnthropicTokenizerFamily(model)
guardCap  = Number.isFinite(this.maxTokensPerCall) ? this.maxTokensPerCall : Number.POSITIVE_INFINITY
inputCap  = Math.min(guardCap, windowFor(model) − effectiveCap)
estimate  = estimatePromptTokens(serializeForEstimate(input), familyFor(model))
estimate > inputCap → throw over_budget { estimated_tokens: estimate, hard_cap_in: inputCap,
                       message: `request exceeds per-call token budget: estimated ${estimate} tokens, cap ${inputCap}` }
```

**Effect on Claude 4.5 and older:** at the default `MAX_TOKENS_PER_PR=120000`, `inputCap = min(120000, 195904) = 120000`, the same as today.

**Not changed:** the `respond()` guard (chars/4; `:304-314`) and the orchestrator's budget math.

### 3.8 Tokenizer family — implements D7

**Shared** (additive):
- `packages/shared/src/tokens/estimator.ts`:
  - `:43` `TokenizerFamily` gains `'anthropic-approx-v2'`.
  - Add `export const SAFETY_MARGIN_ANTHROPIC_V2 = 1.55;` beside `SAFETY_MARGIN` (`:93`, unchanged at 1.15).
  - `:128-131` branches explicitly: `'anthropic-approx'` → `Math.ceil((text.length / 4) * SAFETY_MARGIN)`; `'anthropic-approx-v2'` → `Math.ceil((text.length / 4) * SAFETY_MARGIN_ANTHROPIC_V2)`.
  - **Hazard:** the BPE fallback at `:134` would otherwise silently use `cl100k`.
  - Update the doc comments at `:9-10`, `:36-42` and `:119`.
- `packages/shared/src/schemas/provider.ts:381`: the enum gains `'anthropic-approx-v2'`. Update the JSDoc at `:362-368`.

**Adapter:**

```ts
const CLAUDE_VERSION_FIRST_RE = /claude-\d/i; // tokenizer vocabulary rule only; never decides routing (G-2)
export function resolveAnthropicTokenizerFamily(model: string): TokenizerFamily;
```

**Rule:**
- If the ID parses:
  - `major >= 5` → `'anthropic-approx-v2'`.
  - `family === 'opus' && major === 4 && (minor ?? 0) >= 7` → `'anthropic-approx-v2'`.
  - Otherwise → `'anthropic-approx'`.
- If it does not parse:
  - `CLAUDE_VERSION_FIRST_RE` matches → `'anthropic-approx'`.
  - Otherwise (aliases, unknown names) → `'anthropic-approx-v2'`. Over-counting is the safe direction.

**Who uses which family:** the orchestrator plans with the deployment model's family (`orchestrator.ts:939`, unchanged). The adapter guard uses the request model's family (§ 3.7).

**Legacy blast radius:** none. Tests calibrated to 1.15 are untouched: `estimator.test.ts:79-125`, `packages/core/tests/batcher/*`, `orchestrator.test.ts:1011-1180`.

### 3.9 Refusal — implements D8

**Schema** (`packages/shared/src/schemas/provider.ts:316-322`): the `schema_validation` variant gains `code: z.string().min(1).optional()`, documented as "vendor-neutral sub-classification; `refusal` = the provider's safety classifier declined (ADR-009 D8)". The variant stays `.strict()`.

**Adapter** (`review()` and `respond()`):
- Check `stop_reason === 'refusal'` immediately after usage telemetry, before truncation and before reading any content. Partial content is discarded.
- Throw:

  ```ts
  { kind: 'schema_validation', code: 'refusal',
    message: `anthropic declined the request: stop_reason refusal (category: ${category})` }
  ```

- `readRefusalCategory(response)` (module-private) returns `stop_details.category` when it is a string matching `/^[a-z0-9_]{1,64}$/`, else `'none'` (R6). Branch on `stop_reason`, never on `stop_details` (it may be null).
- `stop_details.explanation` is never read into any message, log or notice (G-1).
- No retry: D1's retry never fires on a refusal.

**Notices** (`apps/github-app/src/provider-notices.ts`, new exports):

```ts
export function isRefusalError(value: ProviderError): boolean;          // kind === 'schema_validation' && code === 'refusal'
export function refusalCategoryFromMessage(message: string): string;   // /\(category: ([a-z0-9_]+)\)/ → group 1, else 'none'
export function refusalNotice(categories: readonly string[]): string;
export function declinedFilesNote(paths: readonly string[], categories: readonly string[]): string;
```

**Notice texts:**
- Categories render as `` `cyber` ``, joined by `, `. An empty list renders `` `none` ``.
- **`refusalNotice(['cyber'])`** = the U+26A0 warning-sign prefix that the capability notices use (`orchestrator.ts:826`), then: "Review unavailable — the provider's safety classifier declined to review this diff (category: `cyber`). This is not a configuration error; it can happen on security-related code. Re-run the review with the bot's `review` command, or pin a different model for this repository with `model:` in `.github/review-bot.yml`." (R2)
- **`declinedFilesNote(['a.ts','b.ts'], ['cyber'])`** = ``" Not reviewed (the provider's safety classifier declined this section; category: `cyber`): a.ts, b.ts. This is not a configuration error; re-run the review or pin a different model with `model:` in `.github/review-bot.yml`."`` It has a leading space, like the sibling notes (R3).

**Orchestrator** (`apps/github-app/src/pipeline/orchestrator.ts`):
- **Imports:** add `isRefusalError`, `refusalCategoryFromMessage`, `refusalNotice` and `declinedFilesNote` to the import at `:48`.
- **`providerErrorDetailFields` (`:411-424`):** also log `code` when `value.kind === 'schema_validation' && value.code !== undefined`.
- **Single-call path (`:1510-1534`):** in the `schema_validation` branch, pass `notice: refusalNotice([refusalCategoryFromMessage(err.value.message)])` to `publishSummaryOnly` when `isRefusalError(err.value)` (conditional spread). Everything else is unchanged: state `succeeded`, outcome `malformed_provider_output`, rejection entry, no retry.
- **Chunked path:**
  - Declare `const declinedFiles: string[] = []; const declinedCategories: string[] = [];` beside `truncatedFiles` (`:995`).
  - In the `schema_validation` branch (`:1272-1277`), when `isRefusalError`, add the batch's paths and the category (deduped), then keep `failedBatches.push(batchIdx); continue;`.
  - Compose the notice (`:1350-1379`): add `declinedFileNote = declinedFiles.length > 0 ? declinedFilesNote(declinedFiles, declinedCategories) : ''`, appended after `truncatedFileNote`.
  - All-failed path (`:1311-1321`): pass `notice: refusalNotice(declinedCategories)` when `declinedFiles.length > 0`.

**Worker ask path** (`apps/github-app/src/worker.ts:881-893`): when `isRefusalError(err.value)`, the reply body is `refusalNotice([refusalCategoryFromMessage(err.value.message)])` instead of the generic "Sorry, I encountered an error…". The worker still re-throws, and `classifyRetry` maps `schema_validation` to `non_transient`, unchanged.

### 3.10 Server-side fallbacks — implements D9 (ratified: deferred)

Nothing ships:
- No `fallbacks` and no beta header.
- No `beta.messages.create` on `AnthropicClientLike`.
- `fallbacks` and `betas` are denylisted in the bag (§ 3.5).

ADR-009 records the opt-in shape for later:
- `ANTHROPIC_FALLBACKS=default`, set by deployment env only;
- header `server-side-fallback-2026-07-01`;
- Opus 5/5.5, Fable 5.1 and Sonnet 5.5 only;
- a summary note naming the model that actually served the request.

### 3.11 Error mapping and remedies — implements D10

**Mapper** (`packages/providers/anthropic/src/error-mapping.ts:180-222`; update the header table at `:13-20`). New order:
1. Network/timeout, 401/403, 429: unchanged.
2. **5xx (including 529):** `{ kind: 'transport', message, retryable: true }`, plus `retry_after_ms` when `readRetryAfterMs(err)` is defined.
3. **404, any body:** `{ kind: 'capability', message, code: 'not_found_error' }`.
4. **400 with `readErrorType(err) === 'invalid_request_error'`:** `{ kind: 'capability', message, code: 'invalid_request_error' }`, whatever the wording.
5. **Any other 400:** `{ kind: 'transport', message, retryable: false }`.
6. **Anything else:** unchanged.

The keyword heuristic `looksLikeCapability` (`:209-214`) is removed. Its condition already required `invalid_request_error`, so rule 4 covers every case it caught.

**Remedies** (`apps/github-app/src/provider-notices.ts`):
- `CapabilityErrorMeta` (`:100-103`) gains `provider?: string | undefined`.
- **`capabilityRemedyNotice` (`:121-139`).** New first statement: `if (meta?.provider === 'anthropic') return anthropicRemedy(message, meta.code);`. The OpenAI branch is otherwise byte-identical, and it still serves `openai`, `copilot`, `fake` and an absent provider.
- **`anthropicRemedy`** (module-private) is first match wins:

| # | Trigger | Remedy |
|---|---|---|
| 1 | `code === 'not_found_error'` | "Remedy: the configured Claude model ID was not found — it is retired or misspelled (`claude-3-5-sonnet-latest` and every Claude 3.x ID are retired). Set `ANTHROPIC_MODEL`, or `model: anthropic/<id>` in `.github/review-bot.yml`, for example `claude-sonnet-5-5`. See `docs/model-compatibility.md` § Anthropic." |
| 2 | `/tool_choice/i` and `/not supported/i` | "Remedy: this model rejects forced tool choice. Prisma sends `tool_choice: auto` to Claude 5.x model IDs automatically; for an alias or gateway name in front of a Claude 5.x model, set `ANTHROPIC_TOOL_CHOICE=unforced` (and `ANTHROPIC_MAX_OUTPUT_TOKENS=16384`), and unset `ANTHROPIC_TOOL_CHOICE=forced` if it is set." |
| 3 | `/thinking\.type/i` | "Remedy: remove `provider_options.anthropic.thinking`. Claude 5.x thinks adaptively; use `provider_options.anthropic.effort` to control depth." |
| 4 | `/output_config\.effort\|\beffort\b/i` | "Remedy: this model does not support the configured `effort`. Claude 5.x accepts `low`, `medium`, `high`, `xhigh` or `max`; Claude 4.6 models have no `xhigh`; Haiku 4.5 and Sonnet 4.5 accept no effort. Change or remove `provider_options.anthropic.effort` (or `output_config.effort`). See `docs/model-compatibility.md` § Anthropic." |
| 5 | `/\b(?:temperature\|top_p\|top_k)\b/i` | "Remedy: remove `temperature` / `top_p` / `top_k` from `provider_options.anthropic`; Claude 5.x rejects them (Sonnet 5.5 and Haiku 5.5 accept only the defaults)." |
| 6 | `/prompt is too long/i` | "Remedy: the request exceeded the model's context window. Lower `MAX_TOKENS_PER_PR` or `chunking.call_token_budget`." |
| 7 | otherwise | `undefined` (the generic notice stands) |

**Call sites** pass the provider name:
- check-run summary, `orchestrator.ts:825-829`: `{ param: err.value.param, code: err.value.code, provider: deps.provider.name }`;
- ask reply, `worker.ts:861-865`: `{ ..., provider: provider.name }`. The provider from `worker.ts:536` is in scope.

**Consequences now visible:**
- A retired or misspelled model publishes a "Review unavailable" summary with the 404 remedy (closes GAP-2).
- Billing 400s and the Fable ZDR 400 become `capability`, and their safe message shows in the generic notice.

### 3.12 Default model and `ANTHROPIC_MODEL` — implements D11 (ratified)

- `index.ts:26-30`: `export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';`. The comment cites ADR-009 D11, the retirement of `claude-3-5-sonnet-latest`, and the vendor's "Sonnet 3.x → `claude-sonnet-5-5`" guidance.
- `DEFAULT_CAPABILITIES` therefore resolves to 1,000,000 / `'anthropic-approx-v2'`.
- `ANTHROPIC_MODEL` is wired in the worker (§ 3.16).
- This lands in its own commit (§ 8, commit 4).

### 3.13 Empty-review notice — implements D12

**`reasoningModelNoFindingsNotice(model)`** (`provider-notices.ts:165-167`) dispatches internally:
- If `isClaudeAdaptiveThinkingModel(model)` (imported from `@prisma-bot/shared`), it returns:

  > `` `<model>` thinks before answering (adaptive thinking) and reported no findings. If you expected some, check the `provider.usage` log event: `output_tokens` in the low tens means the model answered without thinking — unset `ANTHROPIC_TOOL_CHOICE=forced` if set; otherwise raise `provider_options.anthropic.effort` (Opus 5.5 and Haiku 5.5 default to `medium`). See docs/model-compatibility.md § Anthropic. ``

- Otherwise it returns today's OpenAI string, byte-identical (eval fixtures assert its substrings).
- Update the JSDoc (`:155-164`).

**Gate** (orchestrator): add a local helper `const thinksBeforeAnswering = (m: string): boolean => isReasoningModel(m) || isClaudeAdaptiveThinkingModel(m);` and use it at `:398` (`buildEmptyReviewNotice`, both paths) and at `:1586` (single-call `isReasoning`). Import `isClaudeAdaptiveThinkingModel` at `:44`.

**Unchanged:** the outcome detail `reasoning_model_empty` (no schema change) and the worker reply at `worker.ts:787-789`, which keys on the outcome flag.

### 3.14 Usage telemetry — implements D13

```ts
export interface AnthropicUsageTelemetry {
  endpoint: 'messages';
  model: string;                  // the model sent (after request_shaping.model)
  input_tokens?: number;          // input_tokens + cache_read_input_tokens + cache_creation_input_tokens (total prompt)
  output_tokens?: number;         // includes thinking
  cached_input_tokens?: number;   // cache_read_input_tokens
  cache_write_tokens?: number;    // cache_creation_input_tokens
}
export function extractAnthropicUsage(response: unknown, model: string): AnthropicUsageTelemetry;
```

**`extractAnthropicUsage` is tolerant:**
- A missing or non-object `usage` yields `{ endpoint, model }`.
- A field is present only when its source is a number (`null` and absent values are omitted, never zero-filled).
- `input_tokens` is present only when raw `usage.input_tokens` is a number; the cache counts are added only when they are numbers.

**When `review()` calls `onUsage`:** once per API call, immediately after a response arrives and before the refusal and truncation checks, so the D1 retry reports twice. Exceptions from `onUsage` are swallowed.

**Not reported:**
- `respond()` never calls `onUsage`.
- There is no `reasoning_tokens` field.

### 3.15 Scope cuts — implements D14

See § 2. Nothing in this spec adds streaming, an SDK bump, fallbacks, prompt caching, structured outputs, sampling forwarding, an effort env var, per-request capabilities, or a `classifyRetry` change.

### 3.16 Worker wiring — assembles D1 (env), D5, D11 and D13

`apps/github-app/src/worker.ts:183-202` (Anthropic arm), mirroring the OpenAI arm (`:231-314`):

```ts
const opts: AnthropicProviderOptions = { apiKey: anthropicKey };
if (VALID_MAX_TOKENS_PER_PR !== undefined) opts.maxTokensPerCall = VALID_MAX_TOKENS_PER_PR;
const model = await tryGetSecret(secretSource, 'ANTHROPIC_MODEL');
if (model !== undefined) opts.model = model;
const envMaxOutputTokens = readPositiveIntEnv('ANTHROPIC_MAX_OUTPUT_TOKENS');
if (envMaxOutputTokens !== undefined) opts.maxOutputTokens = envMaxOutputTokens;
const maxOutputTokens =
  envMaxOutputTokens ?? resolveAnthropicDefaultMaxOutputTokens(model ?? ANTHROPIC_DEFAULT_MODEL);
const toolChoiceRaw = await tryGetSecret(secretSource, 'ANTHROPIC_TOOL_CHOICE');
if (toolChoiceRaw === 'auto' || toolChoiceRaw === 'forced' || toolChoiceRaw === 'unforced') {
  opts.toolChoiceStyle = toolChoiceRaw;
}
opts.onUsage = (usage: AnthropicUsageTelemetry): void => {
  log('provider.usage', { provider: 'anthropic', ...usage });
};
log('worker.provider.selected', { provider: 'anthropic', model: model ?? ANTHROPIC_DEFAULT_MODEL });
return { provider: new AnthropicProvider(opts), providerLimits: limitsFor(maxOutputTokens) };
```

**What changes around it:**
- The constant 4096 at `:189` goes away.
- Invalid `ANTHROPIC_TOOL_CHOICE` values are silently ignored.
- Update the import at `:13`, the selection doc at `:52-54`, and the `resolveMaxOutputTokens` comment at `:127-128` ("the OpenAI and Anthropic arms read their env var through `readPositiveIntEnv`").
- Add `provider: provider.name` at `:864` (§ 3.11) and the refusal reply at `:881-893` (§ 3.9).
- `resolveMaxOutputTokens` stays; only the Copilot arm uses it now.

### 3.17 Live smoke script (user deliverable)

**File:** `scripts/smoke/anthropic-models.ts`. It runs one live `AnthropicProvider.review()` per model on a fixed diff and prints a one-line verdict per model. It is never run by `pnpm test` or CI.

**CLI contract:**

```
Usage: ./node_modules/.bin/tsx scripts/smoke/anthropic-models.ts [options] [model ...]
Models:  positional args, else ANTHROPIC_SMOKE_MODELS (comma-separated), else
         claude-opus-5-5 claude-sonnet-5-5 claude-haiku-5-5.
         claude-fable-5-1 is opt-in: name it explicitly (needs 30-day retention; ZDR orgs get a 400).
Options: --effort <level>  send provider_options.anthropic.effort (→ output_config.effort)
         --allow-empty     a zero-finding review does not fail the run
         -h, --help        print usage, exit 0
Env:     ANTHROPIC_API_KEY (required, never printed)
         ANTHROPIC_TOOL_CHOICE, ANTHROPIC_MAX_OUTPUT_TOKENS (parsed exactly as the worker parses them)
Exit:    0 every model PASS · 1 any FAIL or EMPTY · 2 usage error or missing key
```

**Behavior:**
1. **Parse and check first, before any client exists.**
   - The key check: when `ANTHROPIC_API_KEY` is unset or empty, write `[anthropic-smoke] ANTHROPIC_API_KEY is not set; no calls were made.` to stderr and exit 2.
   - Model IDs must match `/^[A-Za-z0-9._:-]{1,100}$/`; otherwise exit 2.
   - Unknown flags: exit 2.
2. **Header line:** `[anthropic-smoke] models=<list> tool_choice_style=<auto|forced|unforced> max_output_tokens=<n|default> effort=<value|default>`.
3. **One client per model, run sequentially.** For each model:
   - Build the real SDK client through the adapter package: `createAnthropicClient({ apiKey, timeoutMs: 180_000 })`.
   - Wrap it in a recording `AnthropicClientLike` whose `messages.create(args)` records only these fields of `args`: `tool_choice.type`, `tools[0].strict === true`, `max_tokens`, `output_config.effort`. It awaits the real `messages.create(args)`, records only `stop_reason`, and returns the response untouched.
   - Construct `new AnthropicProvider({ apiKey, model, client: wrapper, onUsage, …toolChoiceStyle/maxOutputTokens when set })`, with no `maxTokensPerCall`.
   - Call `review(SMOKE_INPUT)`. When `--effort` is given, add `request_shaping: { provider_options: { effort } }`.
4. **Per-model verdict:**
   - `PASS`: resolved with `findings.length >= 1`.
   - `EMPTY`: resolved with 0 findings (R5; `--allow-empty` makes it non-failing).
   - `FAIL`: threw.
5. **Per-model line** (fields omitted when absent):

   `[anthropic-smoke] <model> <PASS|EMPTY|FAIL> findings=<n> [kind=<kind> code=<code> message="<≤200 chars>"] calls=<n> tool_choice=<auto|tool|…> strict=<true|false> max_tokens=<n> effort=<v|default> stop_reasons=<a,b> input_tokens=<Σ> output_tokens=<Σ> cached_input_tokens=<Σ> cache_write_tokens=<Σ> elapsed_ms=<n>`

   - `calls` counts recorded `messages.create` invocations, so `calls=2` shows the D1 retry fired.
   - The token fields are sums over `onUsage` events.
6. **Final line:** `[anthropic-smoke] result: <passed>/<total> PASS`, then exit per the contract.

**Fixed input** (a correctness bug, deliberately not security code, so the `cyber` classifier is not triggered):

```ts
const SMOKE_INPUT = { files: [{ path: 'src/smoke/sum.ts', language: 'ts', hunks: [{
  id: 'H1', line_start: 1, line_end: 7,
  content: ['+export function sum(xs: number[]): number {', '+  let total = 0;',
            '+  for (let i = 0; i <= xs.length; i++) {', '+    total += xs[i];', '+  }',
            '+  return total;', '+}'].join('\n'),
}] }] };
```

**Constraints:**
- **Imports:**
  - Only `node:` built-ins and `../../packages/providers/anthropic/src/index.js`, using the named imports `AnthropicProvider`, `createAnthropicClient`, `type AnthropicClientLike`, `type AnthropicToolChoiceStyle` and `type AnthropicUsageTelemetry`.
  - A bare `@prisma-bot/provider-anthropic` import does **not** resolve from `scripts/`. Workspace packages are linked per consumer (e.g. `packages/providers/anthropic/node_modules/@prisma-bot/shared`), and the repo root has no `node_modules/@prisma-bot`. The relative import resolves, and the adapter's own imports resolve from its package directory.
  - Do not import `@prisma-bot/shared`. Type the input as `Parameters<AnthropicProvider['review']>[0]`, and read errors by duck-typing `err.value.{kind, code, message}`, which avoids a dual-module `instanceof`.
- **Vendor isolation (G-5):**
  - No SDK import.
  - The file must not contain the literal text `from '@anthropic-ai/sdk'` anywhere, comments included. `scripts/check-vendor-isolation.sh:25,99-102` greps `scripts/` for that text.
- **What it must never print:**
  - the key, `system`, `messages` or tool input;
  - finding text, response content, `stop_details.explanation` or `zod_issues`.
- **Error `message` handling:**
  - Print the adapter's safe message: either text the adapter wrote, or vendor error text already scrubbed by `mapAnthropicError` (capped at 500 characters, and already logged in production as `provider.error.message`). Truncate it to 200 characters and collapse newlines.
  - A throw that is not a `ProviderErrorThrowable` prints `kind=unexpected name=<err.name>` only.
  - Redaction backstop: every output line passes through `line.split(apiKey).join('[redacted]')`.
- **Output style:** use `process.stdout.write` / `process.stderr.write` (the repo style in `scripts/replay-webhook.ts`). Biome lints `scripts/` (`biome.json` does not ignore it).
- **Not wired anywhere that runs automatically:** not in the `Makefile`, root `package.json` scripts, `.github/workflows/ci.yml`, or vitest (`vitest.config.ts:5-12` only globs `*.test.ts` under `apps/`, `packages/` and `evals/runner/`).
- **Not typechecked:** `scripts/` is outside every workspace tsconfig, the same as `scripts/replay-webhook.ts`. That is acceptable, and the offline checks in AS-28 load the import graph.

**Exact commands** (run from the repo root after `pnpm install`; also listed in § 7):

```bash
read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY   # keeps the key out of shell history
./node_modules/.bin/tsx scripts/smoke/anthropic-models.ts
# optional: Fable 5.1 and the legacy forced path in the same run
./node_modules/.bin/tsx scripts/smoke/anthropic-models.ts claude-opus-5-5 claude-sonnet-5-5 claude-haiku-5-5 claude-fable-5-1 claude-haiku-4-5
# optional: exercise the effort mapping
./node_modules/.bin/tsx scripts/smoke/anthropic-models.ts --effort medium
```

**What a green run confirms:**
- **D1:** no forced-choice 400 on Opus 5.5 or Sonnet 5.5; the unforced bundle is accepted.
- **D2:** strict mode accepts the stripped schema. A 400 naming `strict` or the schema triggers D2's one-line revert: drop `strict: true` and keep the rest of the bundle.
- **D5:** no truncation at 16,384.
- **D10:** every 400 surfaces as `capability` with a code.
- **D13:** usage counts are present.

The refusal path cannot be triggered deterministically; AS-11 and AS-21 cover it offline.

### 3.18 `review()` and `respond()` control flow (normative order)

**`review(input)`:**
1. Resolve the request:
   - `model` (§ 3.5);
   - `bag` (plain-object `provider_options`, else `undefined`);
   - `generation`;
   - `mode = resolveAnthropicToolChoiceMode(model, bag, this.toolChoiceStyle)`;
   - `effectiveCap` (§ 3.6).
2. Guard (§ 3.7).
3. `prompt = buildPrompt(input)`. Build the base `args` for `mode` (§ 3.2, key order as in the table), with `max_tokens: effectiveCap`. If a bag exists, apply `applyAnthropicProviderOptions` (§ 3.5).
4. Attempt loop, `maxAttempts = mode === 'unforced' ? 2 : 1`:
   1. call `client.messages.create(args)`, mapping any throw through `mapAnthropicError` (as at `:253-258`);
   2. `onUsage` (§ 3.14);
   3. refusal (§ 3.9);
   4. `stop_reason === 'max_tokens'` → `output_truncated` with `requested_max_tokens: effectiveCap`;
   5. `findToolUseInput`: if found, stop the loop; if not found and another attempt remains, retry; otherwise throw (§ 3.2).
5. Zod-parse with `ProviderReviewOutputSchema`, as at `:277-285`.

**`respond(input)`:**
1. Guard: unchanged.
2. Args: `{ model: this.model, max_tokens: cap, system, messages }` (§ 3.6).
3. Call.
4. Refusal check.
5. Truncation check.
6. `extractTextContent`.
7. Zod-parse.

## 4. Config / env surface

| Surface | Status | Behavior |
|---|---|---|
| `ANTHROPIC_MODEL` | **new** | Deployment model. Unset means `claude-sonnet-5-5`. Read through `SecretSource` like `OPENAI_MODEL`. |
| `ANTHROPIC_MAX_OUTPUT_TOKENS` | changed default | Unset: 4096 for Claude 4.x and older, and for unparseable aliases; 16,384 for Claude 5.x (or when the repo bag enables thinking), resolved per request. Set: applies to every model. Non-positive or non-numeric values are ignored. Caps above ~21K need streaming on newer SDKs (not supported). |
| `ANTHROPIC_TOOL_CHOICE` | **new** | `auto` (default; rule: Claude 5.x → unforced, otherwise forced) \| `forced` (always `{type:'tool'}`) \| `unforced` (always the auto bundle). For an alias in front of a 5.x model, set `unforced` together with `ANTHROPIC_MAX_OUTPUT_TOKENS=16384`. Invalid values are ignored. |
| `MAX_TOKENS_PER_PR` | unchanged | Doc note: Haiku 5.5 bills 5× above 100K prompt tokens, so `≤ 95000` keeps it in the cheap tier. |
| repo `model: anthropic/<id>` | now honored | `review()` only. |
| repo `generation.max_output_tokens` | now honored by Anthropic | Overrides `ANTHROPIC_MAX_OUTPUT_TOKENS`. |
| repo `generation.temperature` / `top_p` / `seed` | still ignored by Anthropic | |
| repo `provider_options.anthropic` | now forwarded | 10-key denylist plus nested `output_config.format`. A flat `effort` maps to `output_config.effort` (native wins). `thinking` / sampling keys go out verbatim. Precedence on the wire: bag > `generation` > env > family default. |
| `provider.usage` log event | now emitted for Anthropic | `provider: 'anthropic'`, `endpoint: 'messages'`, field mapping as in § 3.14. |
| `worker.provider.selected` | gains `model` for Anthropic | R7 |
| `provider.error` / `provider.batch.error` | `code` on `schema_validation` | `refusal`. Anthropic `capability` errors carry `code` (`not_found_error` \| `invalid_request_error`); Anthropic `transport` errors carry `retry_after_ms` on 5xx/529. |

## 5. Acceptance scenarios

Each scenario names the test file and the describe block to extend or add. "Base snapshot" means a literal written first and confirmed green on unmodified `b441099` (§ 8).

**AS-1 Claude model-ID parser.**
- **Given** `parseClaudeModelId` / `isClaudeAdaptiveThinkingModel`.
- **When** called on each input.
- **Then:**

| Input | Parse result | Predicate |
|---|---|---|
| `claude-opus-5-5` | `{opus, 5, 5}` | true |
| `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`, `claude-mythos-5-1`, `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, `claude-foo-6`, `us.anthropic.claude-opus-5-5`, `CLAUDE-OPUS-5-5` | parsed | true |
| `claude-opus-4-8`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5` | parsed | false |
| `claude-opus-4-20250514` | `{opus, 4, undefined}` | false |
| `claude-sonnet-4-5-20250929` | `{sonnet, 4, 5}` | false |
| `claude-3-5-sonnet-latest`, `claude-3-opus-20240229`, `gpt-6-astra`, `my-alias`, `''` | `undefined` | false |

  Also, `isReasoningModel('claude-opus-5-5') === false`.
- **Test anchor:** `packages/shared/tests/model-slug.test.ts`, new `describe('parseClaudeModelId / isClaudeAdaptiveThinkingModel (ADR-009 D1)')` after `isReasoningModel` (`:203`).

**AS-2 Tool-choice mode.**
- **Given** `resolveAnthropicToolChoiceMode`.
- **Then:**
  - style `auto`: every true ID in AS-1 → `unforced`.
  - `claude-haiku-4-5`, `claude-opus-4-8`, `my-alias` → `forced`.
  - `claude-haiku-4-5` with bag `{ thinking: { type: 'adaptive' } }` or `{ thinking: { type: 'enabled', budget_tokens: 2048 } }` → `unforced`; with `{ thinking: { type: 'disabled' } }` → `forced`.
  - style `unforced` + `my-alias` → `unforced`.
  - style `forced` + `claude-opus-5-5` → `forced`.
- **Test anchor:** `packages/providers/anthropic/tests/provider.test.ts`, new `describe('resolveAnthropicToolChoiceMode (ADR-009 D1)')`.

**AS-3 Default cap.**
- **Given** `resolveAnthropicDefaultMaxOutputTokens`.
- **Then:**
  - 5.x IDs → 16,384.
  - `claude-haiku-4-5`, `claude-opus-4-8`, `my-alias` → 4096.
  - `claude-haiku-4-5` + bag thinking `enabled` → 16,384.
- **Test anchor:** same file, new `describe('resolveAnthropicDefaultMaxOutputTokens (ADR-009 D5)')`.

**AS-4 Window and tokenizer resolvers.**
- **Given** `resolveAnthropicContextWindow`.
  - **Then** 5.x, `claude-opus-4-8/4-7/4-6` and `claude-sonnet-4-6` → 1,000,000.
  - `claude-haiku-4-5`, `claude-sonnet-4-5-20250929`, `claude-opus-4-20250514`, `claude-opus-4-1`, `claude-3-5-sonnet-latest`, `my-alias` → 200,000.
- **Given** `resolveAnthropicTokenizerFamily`.
  - **Then** 5.x, `claude-opus-4-7`, `claude-opus-4-8`, `my-alias` → `'anthropic-approx-v2'`.
  - `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-20250514`, `claude-3-5-sonnet-latest` → `'anthropic-approx'`.
- **Test anchor:** same file, new `describe('resolveAnthropicContextWindow / resolveAnthropicTokenizerFamily (ADR-009 D6/D7)')`.

**AS-5 Constructor capabilities.**
- **Given** `model: 'claude-haiku-4-5'`.
  - **Then** `max_context_tokens === 200000` and `tokenizer_family === 'anthropic-approx'`.
- **Given** `model: 'claude-opus-5-5'`.
  - **Then** 1,000,000 and `'anthropic-approx-v2'`.
- **Given** explicit `capabilities` with `max_context_tokens: 50000`.
  - **Then** 50,000 (explicit wins).
- **Test anchor:** `AnthropicProvider` (`provider.test.ts:48`), `it('derives max_context_tokens and tokenizer_family per model; explicit capabilities win')`.

**AS-6 Pre-5 forced path is byte-identical (gate G-3).**
- **Given** recording clients, the existing `validInput` and no `request_shaping`.
- **When** `review()` runs for each of `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-8` and `my-claude-alias`, and `respond()` runs for `claude-haiku-4-5`.
- **Then**, for `review()`:
  - `JSON.stringify(create.mock.calls[0][0])` equals `JSON.stringify({ model, max_tokens: 4096, system: IMMUTABLE_SYSTEM_PROMPT, messages: buildPrompt(validInput).messages, tools: [{ name: 'submit_review_findings', description: TOOL_DESCRIPTION, input_schema: buildToolInputSchema(undefined) }], tool_choice: { type: 'tool', name: 'submit_review_findings' } })`;
  - exactly one call.
- **And** the same holds with `positive_feedback: { max_items: 3 }`.
- **And** `respond()` equals `JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 4096, system, messages })`.
- **Base snapshot:** this test is written first and passes on the unmodified adapter.
- **Deliberate changes** that this scenario does not cover, all of which need repo or env opt-in:
  - (a) the unconfigured default model (D11);
  - (b) a repo `model:` override (D4);
  - (c) `generation.max_output_tokens` (D4);
  - (d) the `provider_options.anthropic` merge, where thinking turns on the unforced bundle and the 16,384 cap (D1/D4/D5);
  - (e) the guard's window-minus-output term and per-model family (D6/D7). These change no request bytes: `over_budget` only above `MAX_TOKENS_PER_PR=195904` on 200K models, and Opus 4.7/4.8 planning and guarding at 1.55;
  - (f) 404 and `invalid_request_error` become `capability` (D10);
  - (g) `provider.usage` is emitted (D13).
- **Test anchor:** `provider.test.ts`, new `describe('pre-5 request bytes (ADR-009 G-3)')`.

**AS-7 Unforced bundle on the wire.**
- **Given** each of `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`, `claude-mythos-5-1`, `claude-opus-5` and `claude-foo-6`.
- **When** `review()` runs.
- **Then:**
  - `tool_choice` deep-equals `{ type: 'auto', disable_parallel_tool_use: true }`;
  - `tools[0].strict === true`;
  - `tools[0].input_schema` deep-equals `toAnthropicStrictSchema(buildToolInputSchema(undefined))`;
  - `system === IMMUTABLE_SYSTEM_PROMPT + ANTHROPIC_TOOL_NUDGE`;
  - `max_tokens === 16384`;
  - there are no `thinking`, `output_config`, `temperature`, `top_p`, `top_k` or `seed` keys.
- **And** `respond()` on `claude-sonnet-5-5` sends `{ model, max_tokens: 16384, system: <unchanged, no nudge>, messages }` with no `tools`.
- **Test anchor:** `provider.test.ts`, new `describe('Claude 5.x unforced tool bundle (ADR-009 D1/D2/D5)')`.

**AS-8 Strict schema copy.**
- **Given** `toAnthropicStrictSchema` applied to `buildToolInputSchema(undefined)` and to `buildToolInputSchema({ max_items: 3 })`.
- **Then:**
  - the serialized result contains none of `minLength`, `maxLength`, `minimum`, `maximum`, `maxItems`;
  - it keeps `type`, `properties` (all names), `required`, `enum` (severity and category values), `description` and `items`;
  - every `type: 'object'` node has `additionalProperties: false`;
  - the input deep-equals a `structuredClone` taken before the call (no mutation);
  - an injected unknown keyword (`{ type: 'string', pattern: 'x' }`) is dropped.
- **Test anchor:** `packages/providers/anthropic/tests/prompt.test.ts`, new `describe('toAnthropicStrictSchema (ADR-009 D2)')`.

**AS-9 OpenAI, Copilot and shared-schema bytes unchanged (gate G-4).**
- **Given** base snapshots of `JSON.stringify(buildToolInputSchema(undefined))` and `JSON.stringify(buildToolInputSchema({ max_items: 3 }))`, both containing `"minLength":1`, `"minimum":1`, `"maximum":1`, `"maxLength":200` and `"maxItems":3`.
- **When** the PR lands.
- **Then:**
  - both equal the snapshots;
  - the OpenAI and Copilot test suites pass with no edits;
  - `git diff --stat b441099 -- packages/providers/openai packages/providers/copilot packages/shared/src/prompt` is empty (reviewer check).
- **Test anchor:** `packages/shared/tests/review-prompt.test.ts`, `describe('buildToolInputSchema')` (`:235`), `it('shared tool schema bytes are pinned (OpenAI/Copilot wire)')`.

**AS-10 Missing tool call.**
- **Given** the `claude-sonnet-5-5` provider, a first response `{ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'x' }] }` and a second response with a valid `tool_use`.
  - **When** `review()` runs.
  - **Then** it resolves; `create` is called twice with deep-equal args; `onUsage` fires twice.
- **Given** both responses lack the tool call.
  - **Then** it throws `schema_validation`, the message contains `did not call 'submit_review_findings'` and `after 1 retry`, and there are 2 calls.
- **Given** `claude-haiku-4-5` with a missing call.
  - **Then** it throws after 1 call with the unchanged message `anthropic response missing tool_use block for tool 'submit_review_findings'`.
- **Given** a valid `tool_use` whose input fails Zod, on the unforced path.
  - **Then** `schema_validation` after 1 call.
- **Test anchor:** `provider.test.ts`, new `describe('missing tool call retry (ADR-009 D1)')`.

**AS-11 Refusal in the adapter.**
- **Given** `{ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'SECRET-EXPLANATION' }, content: [] }`.
  - **When** `review()` runs on `claude-sonnet-5-5`.
  - **Then** it throws `{ kind: 'schema_validation', code: 'refusal', message: 'anthropic declined the request: stop_reason refusal (category: cyber)' }` after 1 call (no retry); the message does not contain `SECRET-EXPLANATION`; `onUsage` fired once.
- **And** these variants:
  - `stop_details: null` → `(category: none)`;
  - `category: 'Cyber Stuff!'` → `none`;
  - `stop_reason: 'refusal'` with a valid `tool_use` block still throws a refusal.
- **And** `respond()` with the same response throws the same refusal.
- **Test anchor:** `provider.test.ts`, new `describe('refusal (ADR-009 D8)')`, plus a sibling in `describe('respond()')` (`:255`).

**AS-12 Output-cap precedence and truncation.**
- **Given** `claude-sonnet-5-5` and a `max_tokens` stop.
  - **Then** `output_truncated` with `requested_max_tokens: 16384` and a message containing `(max_tokens: 16384)`.
- **Given** `maxOutputTokens: 8192`.
  - **Then** 8192 is sent for both `claude-sonnet-5-5` and `claude-haiku-4-5`.
- **Given** `maxOutputTokens: 8192` and `generation.max_output_tokens: 12000`.
  - **Then** 12000 is sent and reported.
- **Given** also bag `max_tokens: 9000`.
  - **Then** 9000 is sent and reported.
- **Given** the unforced path and `{ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '' }] }`.
  - **Then** `output_truncated` after 1 call.
- **And** for `respond()`: `claude-sonnet-5-5` → 16,384; `claude-haiku-4-5` → 4096.
- **Test anchor:** `provider.test.ts`, new `describe('output cap (ADR-009 D4/D5)')`.

**AS-13 Model override.**
- **Given** a `claude-haiku-4-5` provider and `request_shaping.model: 'claude-sonnet-5-5'`.
  - **When** `review()` runs.
  - **Then** the wire carries `model: 'claude-sonnet-5-5'`, the unforced bundle and 16,384.
- **Given** the reverse (a `claude-sonnet-5-5` provider, override `claude-haiku-4-5`).
  - **Then** forced and 4096.
- **And** `respond()` always sends `this.model`.
- **Test anchor:** `provider.test.ts`, new `describe('request_shaping.model (ADR-009 D4)')`.

**AS-14 Sampling and seed are never sent.**
- **Given** `generation: { temperature: 0.2, top_p: 0.9, seed: 1 }` and `deterministic_seed: 1`.
- **When** `review()` runs on `claude-haiku-4-5` and on `claude-sonnet-5-5`.
- **Then** the body has no `temperature`, `top_p`, `top_k` or `seed`.
- **Test anchor:** same describe as AS-13.

**AS-15 Passthrough bag.**
- **Given** `{ effort: 'medium' }`.
  - **Then** `output_config: { effort: 'medium' }` and no top-level `effort`.
- **Given** `{ effort: 'low', output_config: { effort: 'high' } }`.
  - **Then** `output_config.effort === 'high'`.
- **Given** `{ output_config: { format: { type: 'json_schema' }, effort: 'low' } }`.
  - **Then** `output_config` deep-equals `{ effort: 'low' }`.
- **Given** each of the 10 denylisted keys with hostile values.
  - **Then** `model`, `system`, `messages`, `tools` and `tool_choice` are unchanged, and `stream`, `betas`, `mcp_servers`, `container` and `fallbacks` are absent.
- **Given** `{ thinking: { type: 'enabled', budget_tokens: 2048 }, temperature: 0.5, service_tier: 'auto', max_tokens: 9000 }` on `claude-haiku-4-5`.
  - **Then** all four are forwarded verbatim, the unforced bundle is sent and `max_tokens === 9000`.
- **And:**
  - `ANTHROPIC_PASSTHROUGH_DENYLIST` has exactly the 10 keys;
  - `applyAnthropicProviderOptions` mutates neither input;
  - the returned notes contain key names and no values.
- **Test anchor:** `provider.test.ts`, new `describe('provider_options.anthropic passthrough (ADR-009 D3/D4)')`.

**AS-16 Per-request guard.**
- **Given** a `claude-sonnet-5-5` provider, `maxTokensPerCall: 2_000_000`, and an input with one 800,000-character hunk.
  - **When** `review()` runs with `request_shaping.model: 'claude-haiku-4-5'`.
  - **Then** it throws `over_budget` with `hard_cap_in: 195904` and `estimated_tokens === estimatePromptTokens(serializeForEstimate(input), 'anthropic-approx')`; `create` is not called.
  - **And** without the override, the call proceeds (cap 983,616).
- **Given** a `claude-haiku-4-5` provider with `maxTokensPerCall: 120000` and an oversized input.
  - **Then** `hard_cap_in: 120000` (today's value).
- **Given** explicit `capabilities.max_context_tokens: 50000` on `claude-sonnet-5-5`.
  - **Then** cap 33,616.
- **Test anchor:** `provider.test.ts`, new `describe('per-request guard (ADR-009 D6/D7)')`. The existing `:145` test stays green.

**AS-17 Estimator v2.**
- **Given** any prompt.
- **Then:**
  - `estimatePromptTokens(p, 'anthropic-approx-v2') === Math.ceil((text.length / 4) * 1.55)`;
  - it is ≥ the `'anthropic-approx'` estimate and > chars/4;
  - `SAFETY_MARGIN === 1.15` and `SAFETY_MARGIN_ANTHROPIC_V2 === 1.55`;
  - the existing `anthropic-approx` tests are unchanged.
- **Test anchor:** `packages/shared/tests/tokens/estimator.test.ts`, new `describe('anthropic-approx-v2 family (ADR-009 D7)')` beside `:79`.

**AS-18 Error mapping.**
- **Given** each digest § 13 string, sent with `status: 400` and `error: { type: 'error', error: { type: 'invalid_request_error', message } }`:
  1. `tool_choice: type "tool" and "any" are not supported for this model.`
  2. `"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.`
  3. `output_config.effort 'xhigh' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.`
  4. `role 'system' is not supported on this model`
  5. `prompt is too long: 1048576 tokens > 1000000 maximum`
  6. `Your credit balance is too low to access the Anthropic API.`
  - **Then** each maps to `{ kind: 'capability', code: 'invalid_request_error' }`.
- **Given** a 404 with body type `not_found_error` and message `model: claude-3-5-sonnet-latest`, and a 404 with no body.
  - **Then** both map to `{ kind: 'capability', code: 'not_found_error' }`.
- **Given** a 400 with no type.
  - **Then** `transport` with `retryable: false`.
- **Given** a 503 with `retry-after: '3'`.
  - **Then** `transport`, `retryable: true`, `retry_after_ms: 3000`.
- **Given** a 529.
  - **Then** `transport` with `retryable: true`.
- **And** the 8 existing tests (`:5-82`) pass unedited.
- **Test anchor:** `packages/providers/anthropic/tests/error-mapping.test.ts`, `describe('mapAnthropicError')`.

**AS-19 Remedy selection.** Given `capabilityRemedyNotice(message, { provider: 'anthropic', code })`, the Anthropic remedies resolve as follows:

| Input | Expected remedy |
|---|---|
| `code: 'not_found_error'` | names `ANTHROPIC_MODEL` and `claude-sonnet-5-5` |
| string 1 | names `ANTHROPIC_TOOL_CHOICE=unforced` |
| string 2 | the thinking remedy (not the effort one) |
| string 3 | the effort remedy |
| `temperature: Input should be 1` | the sampling remedy |
| string 5 | the budget remedy |
| string 6 | `undefined` |

**Negatives:**
- `capabilityRemedyNotice('tool_choice … not supported', { provider: 'openai' })` → `undefined`.
- `capabilityRemedyNotice(INCIDENT_MESSAGE, { provider: 'anthropic' })` → not `RESPONSES_REMEDY`.
- An Anthropic 404 never yields an OpenAI remedy.

All existing tests (`:27-140`) pass unedited.

- **Test anchor:** `apps/github-app/tests/provider-notices.test.ts`, new `describe('capabilityRemedyNotice — Anthropic (ADR-009 D10)')`.

**AS-20 Remedy wiring at the call site.**
- **Given** `new FakeProvider({ name: 'anthropic', script: [{ kind: 'error', error: { kind: 'capability', code: 'not_found_error', message: 'model: claude-3-5-sonnet-latest' } }] })`.
  - **When** `runPipeline` runs.
  - **Then** the published notice contains `Remedy: the configured Claude model ID was not found`.
- **And** the same script with the default `name` (`fake`) gets no Anthropic remedy.
- **And** the existing OpenAI remedy tests (`:664`, `:698`) are unchanged.
- **Test anchor:** `apps/github-app/tests/pipeline/orchestrator.test.ts`, `describe('runPipeline')` (`:222`), `it('capability error: an anthropic provider gets the Anthropic remedy (ADR-009 D10)')`.

**AS-21 Refusal notices.**
- **Helpers:**
  - `refusalCategoryFromMessage` on the AS-11 message → `cyber`, and on `'malformed output'` → `none`.
  - `refusalNotice(['cyber'])` contains `safety classifier`, `` `cyber` ``, `not a configuration error` and `review` command.
  - `declinedFilesNote(['a.ts'], ['cyber'])` starts with a space and lists `a.ts`.
- **Single-call path:**
  - **Given** a FakeProvider error `{ kind: 'schema_validation', code: 'refusal', message: <AS-11 message> }`.
  - **Then** state `succeeded`, outcome `malformed_provider_output`, the notice equals `refusalNotice(['cyber'])`, and the `provider.error` event carries `code: 'refusal'`.
  - **And** a plain `schema_validation` keeps `notice === undefined`.
- **Chunked path:**
  - **Given** batch 0 refused and batch 1 returning a finding.
  - **Then** the chunked notice contains `declinedFilesNote` with batch 0's paths and `cyber`, batch 1's finding is published, and the review is not clean.
  - **And** when every batch is refused, the outcome is `malformed_provider_output` with notice `refusalNotice([...])`.
- **Test anchors:**
  - `provider-notices.test.ts`, new `describe('refusal notices (ADR-009 D8)')`;
  - `orchestrator.test.ts`, `describe('runPipeline')` near `:507`, `it('refusal → refusal notice, succeeded, no retry')`;
  - `describe('runPipeline — diff chunking')` (`:1009`), two `it`s next to `:1345`.

**AS-22 Claude empty-review notice.**
- **Given** `reasoningModelNoFindingsNotice('claude-sonnet-5-5')`.
  - **Then** it contains `adaptive thinking`, `provider.usage`, `output_tokens`, `ANTHROPIC_TOOL_CHOICE=forced`, `provider_options.anthropic.effort` and `docs/model-compatibility.md`.
  - It does not contain `reasoning_tokens` or `OPENAI_`.
- **And** `reasoningModelNoFindingsNotice('gpt-6-astra')` equals the base-snapshot literal (OpenAI text byte-identical).
- **Given** `model: anthropic/claude-sonnet-5-5` and a FakeProvider returning `findings: []`.
  - **When** `runPipeline` runs.
  - **Then** the outcome is `{ kind: 'no_findings', detail: { reasoning_model_empty: true, model: 'claude-sonnet-5-5' } }`, and the notice is the existing info-sign prefix plus the helper text.
  - **And** `anthropic/claude-haiku-4-5` gets no notice.
- **Test anchors:**
  - `provider-notices.test.ts`, `describe('reasoningModelNoFindingsNotice')` (`:142`), two `it`s;
  - `orchestrator.test.ts`, `describe('runPipeline — no_findings reasoning model hint')` (`:2275`), `it('Claude 5.x adaptive-thinking model gets the Claude notice; claude-haiku-4-5 gets none')`.

**AS-23 Usage telemetry.**
- **Given** `extractAnthropicUsage` on `{ usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 } }`.
  - **Then** `{ endpoint: 'messages', model, input_tokens: 130, output_tokens: 50, cached_input_tokens: 20, cache_write_tokens: 10 }`.
- **Given** null cache fields.
  - **Then** they are omitted and `input_tokens: 100`.
- **Given** no `usage`.
  - **Then** `{ endpoint, model }`.
- **And** in `review()`:
  - `onUsage` fires once per call, including on `max_tokens` and refusal responses;
  - it carries the override model;
  - a throwing `onUsage` does not fail the review;
  - `respond()` never calls it.
- **Test anchor:** `provider.test.ts`, new `describe('usage telemetry (ADR-009 D13)')`, mirroring `packages/providers/openai/tests/provider.test.ts:2583-2640`.

**AS-24 Schema additions.**
- **Given** `ProviderErrorSchema`.
  - **Then** `{ kind: 'schema_validation', message: 'x', code: 'refusal' }` parses; `code: ''` is rejected; unknown keys are still rejected.
- **Given** `ProviderCapabilitiesSchema`.
  - **Then** `'anthropic-approx-v2'` is accepted and `'anthropic-approx-v3'` is rejected.
- **Test anchor:** `packages/shared/tests/schemas.test.ts`, `describe('ProviderErrorSchema — capability param/code and transport retry_after_ms')` (`:1282`), plus a capabilities `it`.

**AS-25 Default model flip.**
- **Given** `ANTHROPIC_DEFAULT_MODEL`.
  - **Then** it is `'claude-sonnet-5-5'`.
- **Given** a provider with no `model`.
  - **Then** it sends `model: 'claude-sonnet-5-5'`, the unforced bundle and `max_tokens: 16384`; its capabilities are 1,000,000 / `'anthropic-approx-v2'`.
- **Edits to existing tests:**
  - AC1.5 (`provider.test.ts:246-252`) is pinned to `model: 'claude-haiku-4-5'` (4096 still holds);
  - add `it('AC1.5b: default model claude-sonnet-5-5 sends max_tokens 16384')`;
  - the capabilities test (`:49-59`) asserts both values;
  - `:113` adds `expect(create).toHaveBeenCalledTimes(2)`.
- **Test anchor:** `provider.test.ts`, `describe('AnthropicProvider')`.

**AS-26 Worker wiring.** This is boot-path code, like the rest of `buildProvider`, and is not unit-tested. Verify it by code review against § 3.16, plus the typecheck.
- **Given** only `ANTHROPIC_API_KEY`.
  - **Then** `worker.provider.selected` is `{ provider: 'anthropic', model: 'claude-sonnet-5-5' }` and `providerLimits.maxOutputTokens === 16384`.
- **Given** `ANTHROPIC_MODEL=claude-haiku-4-5`.
  - **Then** 4096.
- **Given** `ANTHROPIC_MAX_OUTPUT_TOKENS=8000`.
  - **Then** 8000.
- **Given** `ANTHROPIC_TOOL_CHOICE=bogus`.
  - **Then** it is ignored.
- **And** `provider.usage` events carry `provider: 'anthropic'` and `endpoint: 'messages'`.
- The resolver itself is covered by AS-3.

**AS-27 Eval fixtures.**
- **Given** these changes:
  - `evals/runner/src/schema.ts:225-233`: `ProviderErrorFixtureSchema` gains `code: z.string().min(1).optional()`;
  - `evals/runner/src/pipeline-runner.ts:152-158`: the `schema_validation` branch forwards `code` when present;
  - `evals/fixtures/thinking-model-empty-review-claude.yaml`: a copy of `reasoning-model-empty-review-gpt6.yaml` with `model: anthropic/claude-sonnet-5-5`, `summary_contains: ["adaptive thinking", "claude-sonnet-5-5", "ANTHROPIC_TOOL_CHOICE"]` and `summary_not_contains: ["reasoning_tokens", "OPENAI_", "gpt-4.1"]`;
  - `evals/fixtures/refusal-declined-review.yaml`: a copy of `malformed-provider-output.yaml` whose script is `{ kind: error, error: { kind: schema_validation, code: refusal, message: "anthropic declined the request: stop_reason refusal (category: cyber)" } }`, with `rejection_reasons: ["provider_output_zod_failed"]` and `summary_contains: ["safety classifier", "`cyber`", "not a configuration error"]`;
  - both registered in `evals/scenarios.yaml` after `:65`, with tags `reasoning_model_compatibility` / `provider_schema_failure_handling`.
- **When** `./node_modules/.bin/tsx evals/runner/src/cli.ts --all` runs.
- **Then** every scenario passes, including the two existing reasoning-model fixtures, unedited.

**AS-28 Smoke script, offline checks** (Vivi runs these; they make no network calls).
- `env -u ANTHROPIC_API_KEY ./node_modules/.bin/tsx scripts/smoke/anthropic-models.ts; echo $?` → `2`, with the "not set; no calls were made" line on stderr.
- `--help` → exit 0.
- `--bogus` → exit 2.
- `ANTHROPIC_API_KEY=x ./node_modules/.bin/tsx scripts/smoke/anthropic-models.ts 'bad model!'` → exit 2.
- `grep -rn "anthropic-models" Makefile package.json vitest.config.ts .github` → no hits.
- `bash scripts/check-vendor-isolation.sh` and `pnpm run lint` are green.

**AS-29 Smoke script, live run** (user-run, pre-release).
- **Given** a valid key.
- **When** the first command in § 3.17 runs.
- **Then:**
  - exit 0, with three `PASS` lines showing `tool_choice=auto strict=true max_tokens=16384`;
  - with `claude-haiku-4-5` appended, its line shows `tool_choice=tool strict=false max_tokens=4096` and `PASS`;
  - no output line contains the key, the system prompt, diff text or finding text.

## 6. Guards

- **G-1 No values in notes, logs or smoke output.** Notes are key-only. The refusal path surfaces the sanitized `category` only, never `explanation`. `provider.usage` carries counts only. The smoke script prints only the fields listed in § 3.17.
- **G-2 One Claude family parser.**
  - `parseClaudeModelId` decides tool-choice mode, default cap, window, tokenizer and the empty-review gate.
  - `REASONING_MODEL_RE` is untouched.
  - The other new regexes decide no routing:
    - `CLAUDE_VERSION_FIRST_RE` is a tokenizer vocabulary rule only;
    - the remedy regexes and `refusalCategoryFromMessage` only select notice text.
- **G-3 Pre-5 request bytes are unchanged** without opt-in (AS-6).
- **G-4 OpenAI and Copilot wire bytes, and the shared schema, are unchanged** (AS-9). The OpenAI remedy branch and the OpenAI empty-review text are byte-identical (AS-19, AS-22).
- **G-5 Vendor isolation (ADR-002).** No `@anthropic-ai/sdk` import outside `packages/providers/anthropic/src/client.ts`. `AnthropicClientLike` is unchanged. The smoke script is SDK-free and goes through the adapter package.
- **G-6 Schema changes are additive only.** `schema_validation.code` and the new tokenizer enum member. Variants stay `.strict()`. No new `ProviderError` kind, and `classifyRetry` is unchanged.
- **G-7 Prisma sends nothing on its own initiative.** It never itself sends `thinking`, `temperature`, `top_p`, `top_k`, `seed` or `output_config`. Only the repo bag does, verbatim; `effort` is mapped, never validated.
- **G-8 Standalone equals worker.** `resolveAnthropicDefaultMaxOutputTokens` is the single source for the adapter's default and the worker's `providerLimits.maxOutputTokens`.
- **G-9 Bounded retry.** At most one extra call, only on the unforced path, only on a missing tool call. Never on a refusal, truncation, Zod failure or thrown error.
- **G-10 Nothing beyond scope.** No streaming, SDK bump, beta endpoint, fallbacks or prompt caching.
- **G-11 The smoke script is never automatic.** It never runs in `pnpm test`, `make`, or CI, and it makes no call without a key.

## 7. Documentation deliverables (IDG)

**`docs/model-compatibility.md`:** a new `## Anthropic (Claude)` section before `## Configuration reference` (`:254`), covering:
- **Model table:** ID, window, default cap, tool-choice mode and tokenizer family for Opus/Sonnet/Haiku 5.5, Fable 5.1, Opus 4.8/4.7/4.6, Sonnet 4.6, Haiku 4.5, and retired 3.x.
- **Forced vs unforced tool choice:** why 5.x uses `auto`, the strict tool, and the one-retry policy.
- **`ANTHROPIC_TOOL_CHOICE`:** values, and the alias recipe (`unforced` + `ANTHROPIC_MAX_OUTPUT_TOKENS=16384`).
- **Thinking and effort:** Prisma never sends `thinking`; model defaults apply; the effort × model matrix (`xhigh` absent on 4.6; none on Haiku 4.5 / Sonnet 4.5); "lower `effort` rather than starving the cap".
- **Sampling:** 5.x rejection rules.
- **Output cap:** 4096 / 16,384, and the ~21K streaming limit.
- **Refusals:** what the notice means; security code may trigger `cyber`; fallbacks deferred.
- **Retired IDs and the 404 remedy.**
- **The § 3.11 remedy list.**
- **The § 3.13 notice text.**
- **Haiku 5.5 long-prompt pricing:** `MAX_TOKENS_PER_PR ≤ 95000`.
- **Token usage:** `provider.usage` for Anthropic (`:117`).
- **Live smoke check:** the § 3.17 commands and what a green run confirms.

**`docs/deployment.md`:**
- New rows for `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_OUTPUT_TOKENS` and `ANTHROPIC_TOOL_CHOICE` (`config`), after `:64`.
- `:97`: `MAX_TOKENS_PER_PR` names all three adapters, plus the Haiku 5.5 note.
- `:137-139`: add the three commented knobs to the env block.

**`docs/config-spec.md`:**
- `:64`: "Overrides `OPENAI_MAX_OUTPUT_TOKENS` / `ANTHROPIC_MAX_OUTPUT_TOKENS` … Anthropic default 4096 Claude 4.x / 16384 Claude 5.x".
- `:70`: "Anthropic honors `max_output_tokens` and ignores `temperature`/`top_p`/`seed`; Copilot ignores `generation`".
- `:97-100`: replace the `thinking` example with `effort: medium`.
- After the OpenAI denylist (`:103`): a new `#### Denylist (Anthropic)` (10 keys plus `output_config.format`, and the flat-`effort` mapping).
- `:494`: "1,000,000 Claude 4.6+/5.x, 200,000 Claude 4.5 and older".

**`docs/observability.md`:**
- `:43` `provider.usage`: names both adapters, the `messages` endpoint value and the Anthropic field mapping.
- `:45` `provider.error`: `code: refusal` on `schema_validation`; Anthropic `capability.code` (= error type); `retry_after_ms` on Anthropic 5xx/529.
- `worker.provider.selected` gains `model` (Anthropic).

**`docs/install-github-app.md`:**
- `:105`: optional Anthropic overrides (`ANTHROPIC_MODEL` default `claude-sonnet-5-5`, `ANTHROPIC_MAX_OUTPUT_TOKENS`, `ANTHROPIC_TOOL_CHOICE`), mirroring `:112-115`.
- `:107`: drop "the only adapter that honors … a per-request model override".

**Other docs:**
- `README.md:108`: "Anthropic Claude (reference adapter; default `claude-sonnet-5-5`)".
- `docs/open-questions.md:108`: append "Default model `claude-sonnet-5-5`, configurable via `ANTHROPIC_MODEL` (ADR-009)".
- `docs/contributing.md:124`: "(the OpenAI and Anthropic adapters resolve it per model; see ADR-008 / ADR-009)".

**Env and config examples:**
- `.env.example:19-21` and `deploy/.env.prod.example:32-34`: add `ANTHROPIC_MODEL=`, `ANTHROPIC_MAX_OUTPUT_TOKENS=` and `ANTHROPIC_TOOL_CHOICE=`, each with a one-line comment in the OpenAI style (`:33-36` / `:46-49`).
- `config/deploy.yml:87-91`: the same three as commented `clear` entries: `# ANTHROPIC_MODEL: ""`, `# ANTHROPIC_MAX_OUTPUT_TOKENS: ""  # default 4096 Claude 4.x / 16384 Claude 5.x`, `# ANTHROPIC_TOOL_CHOICE: ""  # auto (default) | forced | unforced`.
- `.github/review-bot.yml.example:31` → `# model: anthropic/claude-sonnet-5-5`.

**ADR-009:** `docs/architecture-decision-records/adr-009-anthropic-5x-model-family-compatibility.md` (new; 009 is the next free number after `adr-008-gpt6-model-family-compatibility.md`). ADR-008 style.
- **Status:** Proposed, 2026-10-16.
- **Amends:** ADR-006 (the `anthropic-approx` margin becomes a per-model family; the 200K window assumption) and ADR-008 (remedy meta gains `provider`; `code` on `schema_validation`; Anthropic parity for `provider.usage`). Records the OQ-1 default model. Supersedes nothing.
- **Sections:**
  - Context: the digest deltas and GAP-2.
  - Decision: D1–D14, one paragraph each.
  - Rationale: the three ratifications, the rejected alternatives from the reasoning report, and R1–R8.
  - Interface changes:
    - shared exports: `parseClaudeModelId`, `isClaudeAdaptiveThinkingModel`, `SAFETY_MARGIN_ANTHROPIC_V2`, the `'anthropic-approx-v2'` family, `schema_validation.code`;
    - adapter exports: the resolvers, constants, `ANTHROPIC_TOOL_NUDGE`, `ANTHROPIC_PASSTHROUGH_DENYLIST`, `applyAnthropicProviderOptions`, `toAnthropicStrictSchema`, `extractAnthropicUsage`, `AnthropicUsageTelemetry`, `AnthropicToolChoiceStyle`, the new options;
    - notice helpers;
    - env vars and log fields.
  - Trade-offs:
    - an extra call when the unforced path misses;
    - strict loses length hints;
    - the 1.55 margin means about 26% less diff per call;
    - the output ceiling is 4×;
    - `schema_validation` is a misnomer for a refusal;
    - the empty-review gate reads `config.model`;
    - provider notes are still unsurfaced.
  - Consequences now and later:
    - fallbacks opt-in shape (`ANTHROPIC_FALLBACKS=default`);
    - `count_tokens` calibration;
    - re-check on any SDK bump;
    - the `classifyRetry` fix.
  - Testing: the AS map.
  - References.

## 8. Implementation order for Vivi (with commit plan)

Every commit leaves the full validation gate green: `pnpm run typecheck && pnpm run lint && pnpm test && bash scripts/check-vendor-isolation.sh && ./node_modules/.bin/tsx evals/runner/src/cli.ts --all`.

1. **`feat(shared): Claude model-ID parser, anthropic-approx-v2 estimator family, schema_validation.code`**
   - First, write the AS-9 pinned-bytes test and see it green on the base.
   - Then make the § 3.1 parser, the § 3.8 shared half (estimator branch, enum, constant), and the § 3.9 schema field.
   - Tests: AS-1, AS-9 (test part), AS-17, AS-24.
2. **`feat(anthropic): Claude 5.x request shaping`**
   - Scope: tool choice, strict schema, output cap, window and tokenizer, `request_shaping`, refusal, usage telemetry, error mapping.
   - Step 0: write AS-6 and see it green against the **unmodified** adapter.
   - Then make § 3.2–§ 3.8 (adapter halves), § 3.9 (adapter), § 3.11 (mapper), § 3.14 and § 3.18, in `packages/providers/anthropic/src/{index,prompt,error-mapping}.ts`.
   - `ANTHROPIC_DEFAULT_MODEL` stays `claude-3-5-sonnet-latest` in this commit. `DEFAULT_CAPABILITIES` therefore still resolves to 200,000 / `'anthropic-approx'`, and every existing adapter test stays green unedited.
   - Tests: AS-2–AS-8, AS-10–AS-16, AS-18, AS-23.
3. **`feat(github-app): Anthropic worker wiring, refusal and remedy notices, Claude empty-review notice`**
   - Scope: § 3.9 (notices, orchestrator, worker ask reply), § 3.11 (remedies and both call sites), § 3.13, § 3.16.
   - Tests: AS-19–AS-22; AS-26 by review.
4. **`feat(anthropic): default model is now claude-sonnet-5-5`**
   - Scope: § 3.12, plus the test edits listed in AS-25.
   - Mirrors the shape of PR #43's `feat(openai): default model is now gpt-6-luna`.
5. **`test(evals): Claude empty-review and refusal scenarios`**
   - Scope: AS-27 (the runner `code` passthrough, two fixtures, `scenarios.yaml`).
6. **`chore(scripts): live Anthropic model smoke check`**
   - Scope: § 3.17; AS-28.
   - Commits 5 and 6 may be squashed into one if preferred.
7. **IDG: `docs: ADR-009 and Anthropic 5.x compatibility docs`**
   - Scope: § 7.

**Declared change scope (drift check).** Anything outside this list is drift:
- `packages/shared/src/{model-slug.ts,tokens/estimator.ts,schemas/provider.ts}`
- `packages/shared/tests/{model-slug,review-prompt,schemas}.test.ts`, `packages/shared/tests/tokens/estimator.test.ts`
- `packages/providers/anthropic/src/{index,prompt,error-mapping}.ts`, `packages/providers/anthropic/tests/*`
- `apps/github-app/src/{worker.ts,provider-notices.ts,pipeline/orchestrator.ts}`
- `apps/github-app/tests/{provider-notices.test.ts,pipeline/orchestrator.test.ts}`
- `evals/runner/src/{schema,pipeline-runner}.ts`, `evals/fixtures/{thinking-model-empty-review-claude,refusal-declined-review}.yaml`, `evals/scenarios.yaml`
- `scripts/smoke/anthropic-models.ts`
- IDG: `docs/**`, `README.md`, `.env.example`, `deploy/.env.prod.example`, `config/deploy.yml`, `.github/review-bot.yml.example`

`packages/providers/{openai,copilot}/**`, `packages/shared/src/prompt/**`, `packages/providers/anthropic/src/client.ts` and `apps/github-app/src/queue/**` must show no diff.

## 9. Open questions

- **OQ-1 Strict acceptance of the stripped schema with optional properties** (D2, confidence M). It is not observed live. The AS-29 smoke run is the check. If it fails, the reversal is a one-line change: drop `strict: true` and keep the rest of the bundle.
- **OQ-2 Thinking skip under forced choice on Opus 5, Sonnet 5 and Fable 5** (D1, M). This is assumed, and `auto` is the safe direction either way. No action unless Anthropic documents otherwise.
- **OQ-3 Strict tool on a pre-5 model when the repo bag enables thinking.** It is assumed to be supported. If a 4.x model rejects it, the operator removes `thinking` from the bag. `ANTHROPIC_TOOL_CHOICE=forced` is not a fix, because forced choice combined with thinking is also rejected.
- **OQ-4 Refusal on the `review` command.** The comment reply still says "Review complete!…". The check run carries the refusal notice. This is pre-existing behavior for malformed output; a dedicated outcome kind is a follow-up.
- **OQ-5 The empty-review gate reads the repo's `config.model` only** (D12 known gap). A repo on the deployment default, or on an alias, gets no Claude notice.
- **OQ-6 Calibrating the D7 margin.** 1.55 rests on the unverified 1.15 legacy bound. A `messages.count_tokens` pass over representative diffs is a follow-up.
- **OQ-7 The smoke script is not typechecked** by `pnpm run typecheck` (`scripts/` sits outside every workspace tsconfig, like `scripts/replay-webhook.ts`). AS-28 loads its import graph. A `scripts/tsconfig.json` would be a separate decision.

Could not verify: no commands could be run in this read-only role, so `typecheck`, `lint`, `test`, `eval`, and the smoke script's module resolution under tsx (inferred from the `node_modules` layout) are unexecuted, and live vendor behavior (D1/D2 wire acceptance) stays untested until the user's smoke run.