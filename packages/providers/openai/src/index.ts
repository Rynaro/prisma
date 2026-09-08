import {
  type Provider,
  type ProviderCapabilities,
  ProviderErrorThrowable,
  type ProviderRespondInput,
  type ProviderRespondOutput,
  ProviderRespondOutputSchema,
  type ProviderReviewInput,
  type ProviderReviewOutput,
  ProviderReviewOutputSchema,
  type TokenizerFamily,
  buildRespondPrompt,
  estimatePromptTokens,
  isReasoningModel,
  serializeForEstimate,
} from '@prisma-bot/shared';
import {
  type OpenAIChatCompletionsArgs,
  type OpenAIResponsesArgs,
  type OpenAITextCompletionArgs,
  createOpenAIClient,
} from './client.js';
import { mapOpenAIError } from './error-mapping.js';
import { buildPrompt } from './prompt.js';

// ---------------------------------------------------------------------------
// Token-param resolution — D1 (per-request token-limit parameter selection)
// ---------------------------------------------------------------------------

/**
 * `TokenParamStyle` — the three possible styles for the output-token cap field.
 *
 *   - `'auto'`                   : heuristic selects the correct parameter for
 *                                   the resolved model (default; see
 *                                   `resolveTokenParam` for the regex).
 *   - `'max_tokens'`             : force the classic parameter — useful for
 *                                   proxy gateways that lag OpenAI's rollout or
 *                                   for models that the heuristic misclassifies.
 *   - `'max_completion_tokens'`  : force the newer parameter — useful for
 *                                   custom deployments behind `OPENAI_BASE_URL`
 *                                   that always require the newer field.
 *
 * Operators set this via `OPENAI_TOKEN_PARAM` (deployment.md § Config).
 */
export type TokenParamStyle = 'auto' | 'max_tokens' | 'max_completion_tokens';

/**
 * `resolveTokenParam` — pure helper that maps a model identifier + an optional
 * operator override to the correct token-limit field name.
 *
 * The heuristic delegates to `isReasoningModel` from `@prisma-bot/shared`,
 * which is the single source of truth for the reasoning-family classification
 * (used also by `resolveToolChoice` and the orchestrator's `no_findings` hint).
 *
 * Pattern covered by `isReasoningModel`:
 *   - `o[1-9]`        — o-series reasoning models: o1, o3, o4, …
 *   - `gpt-[5-9]`     — gpt-5, gpt-6, … (gpt-5.4-nano matches on the `5`)
 *   - `gpt-\d{2,}`    — gpt-10, gpt-11, … (future two-digit major versions)
 *
 * Classic models (`gpt-4o`, `gpt-4`, `gpt-4.1`, `gpt-3.5-turbo`) return
 * `max_tokens`; the regex anchored at start avoids suffix false positives.
 *
 * @param model    - The model id as it will be sent in the API request
 *                   (already resolved from per-request shaping or provider
 *                   default; e.g. `"gpt-5.4-nano"`, `"gpt-4o"`, `"o3"`).
 * @param override - An explicit `TokenParamStyle` from the operator. When
 *                   `'max_tokens'` or `'max_completion_tokens'`, the override
 *                   bypasses the heuristic entirely — the escape hatch for
 *                   lagging proxies and misclassified future models. Defaults
 *                   to `'auto'` if omitted, which runs the heuristic.
 *
 * @returns `'max_completion_tokens'` or `'max_tokens'` — the field to populate
 *          on `OpenAIChatCompletionsArgs`. Never both; never neither.
 *
 * Exported for direct unit-testing.
 */
export function resolveTokenParam(
  model: string,
  override: TokenParamStyle = 'auto',
): 'max_tokens' | 'max_completion_tokens' {
  if (override === 'max_tokens') return 'max_tokens';
  if (override === 'max_completion_tokens') return 'max_completion_tokens';
  // auto: delegate to the shared reasoning-family detector.
  return isReasoningModel(model) ? 'max_completion_tokens' : 'max_tokens';
}

// ---------------------------------------------------------------------------
// API-style resolution: which OpenAI endpoint carries the review request
// ---------------------------------------------------------------------------

/**
 * `ApiStyle`, the three possible endpoint selections for `review()`.
 *
 *   - `'auto'`      : heuristic (default); `/responses` for every
 *                     reasoning-family model, `/chat/completions` otherwise.
 *   - `'chat'`      : always `/chat/completions` (the pre-Responses behavior).
 *   - `'responses'` : always `/responses`.
 *
 * Operators set this via `OPENAI_API_STYLE` (deployment.md § Config).
 */
export type ApiStyle = 'auto' | 'chat' | 'responses';

/**
 * `resolveApiStyle`, a pure helper mapping a model identifier plus an optional
 * operator override to the endpoint `review()` will use.
 *
 * ## Why `auto` is the shared reasoning-family predicate
 *
 * The API names the constraint itself:
 *   "Function tools with reasoning_effort are not supported for gpt-5.6-luna in
 *    /v1/chat/completions. To use function tools, use /v1/responses or set
 *    reasoning_effort to 'none'."
 *
 * The rejection is a function of BOTH the family and the effective reasoning
 * effort, and the effort is not reliably visible to this adapter: it can arrive
 * as `provider_options.openai.reasoning_effort`, as a native `reasoning.effort`
 * object, or as the model's own default when neither is set. Selecting on the
 * family alone (an earlier draft matched only `gpt-5.6*` and later majors) left
 * `gpt-5.5` with `reasoning_effort: high` — the configuration in the incident
 * report — on `/chat/completions`, where OpenAI's migration guidance says tool
 * calling is unsupported at any effort other than `none` from GPT-5.4 onward.
 *
 * `reasoning_effort: 'none'` is not a remedy for this flow: it clears the 400
 * and then costs review quality (see docs/model-compatibility.md), and OpenAI's
 * own model guide states that the next family "does not support the `none`
 * reasoning effort" while "tool calling requires Responses".
 *
 * So `auto` delegates to `isReasoningModel` — the same shared predicate that
 * already drives `resolveTokenParam` and `resolveToolChoice`, and the selector
 * the issue proposed. One classification, three decisions, no third regex.
 * Classic families (`gpt-4o`, `gpt-4.1`, `gpt-4`, `gpt-3.5-turbo`) stay on
 * `/chat/completions` and their wire shape is byte-identical to before.
 *
 * A deployment behind an `OPENAI_BASE_URL` gateway that does not expose
 * `/responses` pins `OPENAI_API_STYLE=chat`.
 *
 * @param model    - Bare model identifier (no `provider/` prefix).
 * @param override - Operator override from `OPENAI_API_STYLE`. Defaults to
 *                   `'auto'`, which runs the heuristic.
 *
 * @returns `'responses'` or `'chat'`.
 *
 * Exported for direct unit-testing.
 */
export function resolveApiStyle(model: string, override: ApiStyle = 'auto'): 'chat' | 'responses' {
  if (override === 'chat') return 'chat';
  if (override === 'responses') return 'responses';
  return isReasoningModel(model) ? 'responses' : 'chat';
}

/**
 * `RESPONSES_STATE_LINKING_KEYS`, the request fields that would attach this
 * one-shot review to server-side conversation state.
 *
 * `previous_response_id` continues a stored response chain and `conversation`
 * attaches the call to a Conversation object with its own persistence
 * semantics. Either can pull turns Prisma never rendered into a review, and
 * neither is suppressed by `store: false` — `store` governs whether THIS
 * response is retained, not whether prior state is read. A review is one call
 * with one rendered prompt (issue #40 § Out of scope: "no follow-up turn"), so
 * these fields are stripped unconditionally, in addition to being denylisted
 * out of the passthrough bag upstream.
 *
 * Exported so tests can assert against the set directly.
 */
export const RESPONSES_STATE_LINKING_KEYS = ['previous_response_id', 'conversation'] as const;

/**
 * `toResponsesArgs`, a pure mapping from the `/chat/completions` request Prisma
 * already builds to the `/responses` request shape.
 *
 * Spelling changes:
 *   - system message  -> `instructions` (multiple system messages are joined)
 *   - remaining turns -> `input`
 *   - nested tool     -> flat tool (`{ type, name, description, parameters }`)
 *   - forced tool     -> `{ type: 'function', name }`; `'required'` unchanged
 *   - token cap       -> `max_output_tokens` (see § Output cap below)
 *   - `store: false`  -> Prisma does not use server-side response retention
 *
 * Passthrough keys from `provider_options.openai` (spec § 5.3) ride along, with
 * four endpoint-aware exceptions. `/responses` is a different request contract
 * from `/chat/completions`, not a rename of it, so a key that is valid on one
 * is not automatically valid on the other, and `/responses` rejects unknown
 * top-level parameters with HTTP 400.
 *
 * ## Reasoning effort
 *
 * `/chat/completions` spells it `reasoning_effort: 'high'`; `/responses` spells
 * it `reasoning: { effort: 'high' }` and 400s on the flat key. The legacy field
 * is therefore translated rather than forwarded — without this, the exact
 * configuration in the incident report (`provider_options.openai.
 * reasoning_effort: high`) trades a 400 on one endpoint for a 400 on the other.
 *
 * Precedence, when both spellings are supplied: **the native `reasoning` object
 * wins, field by field.** `reasoning_effort` only fills `effort` when the
 * native object does not set it, so `{ reasoning: { summary: 'auto' },
 * reasoning_effort: 'high' }` yields `{ summary: 'auto', effort: 'high' }`,
 * while `{ reasoning: { effort: 'xhigh' }, reasoning_effort: 'high' }` yields
 * `{ effort: 'xhigh' }`. A native `reasoning` that is not a plain object is
 * forwarded verbatim (the operator addressed the endpoint directly; the API
 * validates it) and the legacy key is dropped with a note.
 *
 * ## Seed
 *
 * `/responses` has no `seed` field. `review()` sets one from
 * `request_shaping.deterministic_seed`, and an operator can also put a raw
 * `seed` in the passthrough bag; both are dropped here with a note rather than
 * sent, because forwarding would 400 and silently keeping the
 * `deterministic_seed` capability would promise a determinism this endpoint
 * does not offer. `OpenAIProvider` reconciles `capabilities.deterministic_seed`
 * for the resolved endpoint (see the constructor). Chat behavior is unchanged.
 *
 * ## Output cap
 *
 * One effective cap is resolved before serialization, honoring the documented
 * `provider_options > generation > deployment default` precedence:
 *
 *   1. `provider_options.openai.max_output_tokens` — the native Responses
 *      spelling. Highest precedence: it names this endpoint's own field.
 *   2. `max_completion_tokens`, then `max_tokens` — the chat spellings, which
 *      by this point already carry whichever of provider_options / generation /
 *      deployment default won on the chat path (`applyProviderOptions` is
 *      last-wins). Between the two, the newer-family spelling wins.
 *
 * Neither chat spelling reaches the wire. A non-numeric native override is
 * ignored (with a note) in favor of the resolved chat value.
 *
 * @returns the mapped args plus key-only `notes` describing every dropped or
 *          translated field. Notes never contain a value (G7).
 *
 * Exported for direct unit-testing.
 */
export function toResponsesArgs(args: OpenAIChatCompletionsArgs): {
  args: OpenAIResponsesArgs;
  notes: string[];
} {
  const {
    messages,
    tools,
    tool_choice,
    max_tokens,
    max_completion_tokens,
    seed: _normalizedSeed,
    ...rest
  } = args;

  const notes: string[] = [];
  const inherited: Record<string, unknown> = rest;

  /**
   * Keys this function decides for itself. Everything else in the bag is
   * forwarded verbatim. Built as an allow-through filter rather than a
   * copy-then-delete so a handled key can never survive into the body by
   * accident, and so the key is genuinely ABSENT (not merely `undefined`) in
   * the object the client receives — an injected client inspects the object,
   * not only its serialization.
   */
  const HANDLED_KEYS = new Set<string>([
    'store',
    'seed',
    'reasoning',
    'reasoning_effort',
    'max_output_tokens',
    ...RESPONSES_STATE_LINKING_KEYS,
  ]);
  const passthrough: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inherited)) {
    if (!HANDLED_KEYS.has(k)) passthrough[k] = v;
  }

  // --- one-shot boundary: no server-side state may be referenced -----------
  for (const key of RESPONSES_STATE_LINKING_KEYS) {
    if (key in inherited) {
      notes.push(`${key} ignored (Prisma reviews are a single stateless call)`);
    }
  }
  // `store` is Prisma-managed and pinned to the literal `false` set below.

  // --- seed: not a Responses field ----------------------------------------
  // Both spellings converge here: `review()` assigns `request_shaping
  // .deterministic_seed` to `args.seed`, and `applyProviderOptions` merges a
  // raw `provider_options.openai.seed` onto the same field (last wins). One
  // destructure therefore covers both, and `seed` stays in HANDLED_KEYS so a
  // future caller cannot reintroduce it through the passthrough bag.
  if (_normalizedSeed !== undefined) {
    notes.push('seed not sent: the Responses API has no deterministic seed parameter');
  }

  // --- reasoning effort: translate the legacy chat spelling ----------------
  const legacyEffort = inherited.reasoning_effort;
  const nativeReasoning = inherited.reasoning;

  let reasoning: unknown;
  const nativeIsPlainObject =
    typeof nativeReasoning === 'object' &&
    nativeReasoning !== null &&
    !Array.isArray(nativeReasoning);
  if (nativeIsPlainObject) {
    const native = { ...(nativeReasoning as Record<string, unknown>) };
    if (legacyEffort !== undefined) {
      if (native.effort === undefined) {
        native.effort = legacyEffort;
        notes.push('reasoning_effort translated to reasoning.effort for the Responses API');
      } else {
        notes.push(
          'reasoning_effort ignored: provider_options.openai.reasoning.effort takes precedence',
        );
      }
    }
    reasoning = native;
  } else if (nativeReasoning !== undefined) {
    // Not an object we can merge into — forward it and let the API validate.
    reasoning = nativeReasoning;
    if (legacyEffort !== undefined) {
      notes.push('reasoning_effort ignored: provider_options.openai.reasoning takes precedence');
    }
  } else if (legacyEffort !== undefined) {
    reasoning = { effort: legacyEffort };
    notes.push('reasoning_effort translated to reasoning.effort for the Responses API');
  }

  // --- output cap: resolve exactly one value before serialization ----------
  const nativeCap = inherited.max_output_tokens;
  let cap: number | undefined;
  if (typeof nativeCap === 'number') {
    cap = nativeCap;
  } else {
    if (nativeCap !== undefined) {
      notes.push('provider_options.openai.max_output_tokens ignored (not a number)');
    }
    cap = max_completion_tokens ?? max_tokens;
  }

  const instructions = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const input = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const responsesArgs: OpenAIResponsesArgs = {
    ...passthrough,
    model: args.model,
    instructions,
    input,
    tools: tools.map((t) => ({
      type: 'function' as const,
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    })),
    tool_choice:
      tool_choice === 'required'
        ? 'required'
        : { type: 'function' as const, name: tool_choice.function.name },
    store: false,
  };

  if (reasoning !== undefined) {
    responsesArgs.reasoning = reasoning;
  }
  if (cap !== undefined) {
    responsesArgs.max_output_tokens = cap;
  }
  return { args: responsesArgs, notes };
}

// ---------------------------------------------------------------------------
// Tool-choice resolution — D2 (per-request tool_choice selection)
// ---------------------------------------------------------------------------

// ToolChoiceStyle: three modes for the tool_choice field per request.
//   'auto'     - heuristic: reasoning models (gpt-5+/o-series) use 'required',
//                classic models (gpt-4o, gpt-4.1) use forced-specific object.
//   'forced'   - always send the forced-specific function object.
//   'required' - always send 'required'.
// Operators set this via OPENAI_TOOL_CHOICE env var (deployment.md - Config).
export type ToolChoiceStyle = 'auto' | 'forced' | 'required';

/**
 * Wire type for the `tool_choice` field on an OpenAI chat completions request.
 * Reasoning models use the string `'required'`; classic models use the
 * forced-specific function object.
 */
export type ResolvedToolChoice = 'required' | { type: 'function'; function: { name: string } };

/**
 * `resolveToolChoice` — pure helper that maps a model identifier, an optional
 * operator style override, and a tool name to the correct `tool_choice` value.
 *
 * Root-cause context (production incident):
 *   Forcing a specific function with `tool_choice: { type: 'function', function:
 *   { name: 'submit_review_findings' } }` short-circuits reasoning on GPT-5/
 *   o-series models. The model skips its interleaved thinking step and calls
 *   the tool immediately with an empty `findings` array, producing a silent
 *   clean review on PRs that should have findings.
 *
 *   OpenAI's recommendation for reasoning models is `tool_choice: 'required'`
 *   (must call a tool; with a single tool registered the model reasons first,
 *   then calls it). Classic models (gpt-4o, gpt-4.1, …) continue to use the
 *   forced-specific object — this is the proven pattern for those families.
 *
 * References:
 *   - https://platform.openai.com/docs/guides/reasoning (tool use section)
 *   - https://platform.openai.com/docs/api-reference/chat/create (tool_choice)
 *
 * @param model     - Bare model identifier (no `provider/` prefix).
 * @param toolName  - The name of the single tool registered on the request
 *                    (e.g. `'submit_review_findings'`).
 * @param style     - Operator override from `OPENAI_TOOL_CHOICE`. When
 *                    `'forced'` or `'required'`, the heuristic is bypassed.
 *                    Defaults to `'auto'`.
 *
 * @returns `'required'` for reasoning models (auto or explicit); a
 *          forced-specific function object for classic models (auto or explicit).
 *
 * Exported for direct unit-testing.
 */
export function resolveToolChoice(
  model: string,
  toolName: string,
  style: ToolChoiceStyle = 'auto',
): ResolvedToolChoice {
  if (style === 'required') return 'required';
  if (style === 'forced') return { type: 'function', function: { name: toolName } };
  // auto: use the reasoning-family heuristic.
  return isReasoningModel(model) ? 'required' : { type: 'function', function: { name: toolName } };
}

// Re-export the shared helper so existing callers that imported from this
// package can still reach it. The canonical import is `@prisma-bot/shared`.
export { isReasoningModel };

/**
 * `OPENAI_PROVIDER_NAME` — canonical `Provider.name` value for the OpenAI
 * adapter. The instance's `name` field is the source of truth; this
 * top-level constant exists so call sites (selector logs, log enrichers,
 * test assertions) do not need to instantiate a provider to compare strings.
 */
export const OPENAI_PROVIDER_NAME = 'openai';

// ---------------------------------------------------------------------------
// Escape-hatch denylist — spec § 3.7, G8
// ---------------------------------------------------------------------------

/**
 * `OPENAI_PASSTHROUGH_DENYLIST` — set of wire-field names that the
 * `provider_options.openai` raw passthrough bag is NEVER allowed to override.
 *
 * These fields are Prisma-managed: overriding them would break the forced-
 * function-calling structured-output contract (`submit_review_findings`) or
 * bypass observability invariants.
 *
 * | Key              | Why protected |
 * |------------------|---------------|
 * | model            | Resolved from slug / request_shaping; passthrough must
 *                     not silently retarget (breaks resolveTokenParam + obs.) |
 * | messages         | Prompt is Prisma-owned (buildPrompt); override discards
 *                     the review instructions. |
 * | tools            | Must remain the single `submit_review_findings` tool. |
 * | tool_choice      | Must remain forced to `submit_review_findings`;
 *                     "none"/"auto" breaks structured output. |
 * | stream           | Pipeline consumes a single JSON response; streaming
 *                     breaks extractToolCallArguments. |
 * | n                | Multiple choices break the choices[0] extraction. |
 * | response_format  | Conflicts with the function-calling path. |
 *
 * The Responses API spells four of the same Prisma-managed concerns
 * differently, and adds two that only exist on that endpoint. Since one bag
 * feeds both endpoints, they are protected in the same list — none of them is
 * a valid `/chat/completions` field either, so nothing on the chat path
 * changes except that an operator now gets a note instead of silence.
 *
 * | Key                  | Why protected |
 * |----------------------|---------------|
 * | input                | The Responses spelling of `messages`. |
 * | instructions         | The Responses spelling of the system message. |
 * | store                | Retention is Prisma-managed and pinned to `false`:
 *                          diff hunks and context files are customer source
 *                          (G7). |
 * | previous_response_id | Continues a stored response chain — would pull
 *                          turns Prisma never rendered into the review. |
 * | conversation         | Attaches the call to a Conversation object with its
 *                          own persistence semantics; `store: false` does not
 *                          suppress it. |
 *
 * The last two are also stripped defensively in `toResponsesArgs`
 * (`RESPONSES_STATE_LINKING_KEYS`) so the one-shot boundary does not depend on
 * this list alone.
 *
 * `max_tokens` / `max_completion_tokens` / `max_output_tokens` / `seed` /
 * `temperature` / `top_p` / `reasoning_effort` / `reasoning` are NOT
 * denylisted — overriding them via escape hatch is the intended use (AS-9,
 * spec § 3.7 last paragraph). `toResponsesArgs` translates or drops those that
 * the Responses contract spells differently or does not accept.
 *
 * Exported so unit tests can assert against it directly (spec § 7.2, G8).
 */
export const OPENAI_PASSTHROUGH_DENYLIST = new Set<string>([
  'model',
  'messages',
  'tools',
  'tool_choice',
  'stream',
  'n',
  'response_format',
  // Responses-API spellings of the same Prisma-managed fields (issue #40).
  'input',
  'instructions',
  'store',
  'previous_response_id',
  'conversation',
]);

/**
 * `applyProviderOptions` — merge a raw `provider_options.openai` bag into an
 * existing `OpenAIChatCompletionsArgs` object, enforcing the denylist.
 *
 * Returns a new `args` object (spread; no mutation) and an array of config
 * notes for any dropped denylisted keys so the orchestrator can surface them
 * in the check-run summary.
 *
 * Precedence: passthrough keys WIN over any previously-set normalized value
 * (design.md P5 "escape hatch wins").
 *
 * G7 invariant: this function MUST NOT log any key or value from `bag`.
 * The returned `droppedNotes` strings only contain the KEY names, not values.
 *
 * Exported for direct unit-testing (spec § 7.2, G8).
 *
 * @param args - The base args object (already includes model + token param +
 *               generation fields). Spread-copied; not mutated.
 * @param bag  - The raw `provider_options[activeProvider]` record.
 * @returns    `{ args: merged, droppedNotes: string[] }`.
 */
export function applyProviderOptions(
  args: OpenAIChatCompletionsArgs,
  bag: Record<string, unknown>,
): { args: OpenAIChatCompletionsArgs; droppedNotes: string[] } {
  const droppedNotes: string[] = [];
  const merged: OpenAIChatCompletionsArgs = { ...args };
  for (const [k, v] of Object.entries(bag)) {
    if (OPENAI_PASSTHROUGH_DENYLIST.has(k)) {
      droppedNotes.push(`provider_options.openai.${k} ignored (Prisma-managed field)`);
      continue;
    }
    merged[k] = v;
  }
  return { args: merged, droppedNotes };
}

/**
 * Default model identifier. Centralized so it can be swapped in one place.
 * Model selection is treated as configuration, not as a vendor type.
 *
 * Per spec D4: GPT-4o as default model. Operators override via `OPENAI_MODEL`.
 */
export const OPENAI_DEFAULT_MODEL = 'gpt-4o';

/**
 * Default base URL for the OpenAI inference endpoint. Operators may
 * override via `OPENAI_BASE_URL` (e.g., for Azure OpenAI or proxy gateways).
 */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

// ---------------------------------------------------------------------------
// Model → tokenizer family map (Phase 2)
// ---------------------------------------------------------------------------

/**
 * OpenAI model → `TokenizerFamily` map (Phase 2).
 *
 * OpenAI uses two BPE vocabularies:
 *   - `cl100k_base` (100k vocab): GPT-4 classic, GPT-3.5-turbo, text-embedding-ada-002.
 *   - `o200k_base` (200k vocab): GPT-4o family, gpt-4.1, o-series (o1/o3/o4), gpt-5*.
 *
 * Conservative choice: when the model slug is not in this map we fall back to
 * `cl100k` (the older, smaller vocab), which over-counts for o200k models —
 * that is safe (never under-counts). The spec allows this conservative default.
 *
 * Exported so adapter tests can assert the mapping directly.
 */
export const OPENAI_TOKENIZER_FAMILY_MAP: Record<string, TokenizerFamily> = {
  // GPT-4o family — o200k_base
  'gpt-4o': 'o200k',
  'gpt-4o-mini': 'o200k',
  'gpt-4o-mini-2024-07-18': 'o200k',
  'gpt-4o-2024-05-13': 'o200k',
  'gpt-4o-2024-08-06': 'o200k',
  'gpt-4o-2024-11-20': 'o200k',
  'gpt-4o-latest': 'o200k',
  // GPT-4.1 family — o200k_base
  'gpt-4.1': 'o200k',
  'gpt-4.1-mini': 'o200k',
  'gpt-4.1-nano': 'o200k',
  // o-series reasoning models — o200k_base
  o1: 'o200k',
  'o1-mini': 'o200k',
  'o1-preview': 'o200k',
  o3: 'o200k',
  'o3-mini': 'o200k',
  o4: 'o200k',
  'o4-mini': 'o200k',
  // gpt-5* — o200k_base (future models in the gpt-5 family)
  'gpt-5': 'o200k',
  // GPT-4 classic family — cl100k_base
  'gpt-4': 'cl100k',
  'gpt-4-turbo': 'cl100k',
  'gpt-4-turbo-preview': 'cl100k',
  'gpt-4-0125-preview': 'cl100k',
  'gpt-4-1106-preview': 'cl100k',
  // GPT-3.5 — cl100k_base
  'gpt-3.5-turbo': 'cl100k',
  'gpt-3.5-turbo-16k': 'cl100k',
  'gpt-3.5-turbo-0125': 'cl100k',
  'gpt-3.5-turbo-1106': 'cl100k',
};

/**
 * Resolve the `TokenizerFamily` for a given OpenAI model slug.
 * Falls back to `'cl100k'` (conservative; never under-counts for unknown models).
 */
export function resolveOpenAITokenizerFamily(model: string): TokenizerFamily {
  return OPENAI_TOKENIZER_FAMILY_MAP[model] ?? 'cl100k';
}

/**
 * `OPENAI_CAPABILITIES` — declared capability set for the OpenAI adapter.
 *
 * Key differentiator vs. Copilot: `deterministic_seed: true` — OpenAI's
 * `/chat/completions` honors an integer `seed` parameter. This is a BOOL
 * (support flag); the INT seed value travels via `ProviderRequestShaping.deterministic_seed`.
 *
 * `tokenizer_family`: defaults to `'o200k'` matching the default model `gpt-4o`.
 * Overridden at construction time via `resolveOpenAITokenizerFamily(model)`.
 *
 * Per chunking-stability-spec.md § Phase 2 "Provider capabilities".
 */
export const OPENAI_CAPABILITIES: ProviderCapabilities = {
  structured_output: true,
  function_calling: true,
  deterministic_seed: true,
  max_context_tokens: 128000,
  tokenizer_family: 'o200k',
};

/**
 * `OpenAIClientLike` — the minimal interface this package consumes from a
 * client. In production, `createOpenAIClient` returns an instance that
 * satisfies this shape; tests inject mock clients.
 *
 * Per ADR-002 § Decision and api-contracts.md § Invariants and error semantics
 * (item 1): no OpenAI / fetch / Response type appears in this signature.
 *
 * Both `max_tokens` and `max_completion_tokens` are optional here because
 * exactly one is set per request (selected by `resolveTokenParam`). The
 * `createOpenAIClient` implementation serialises via `JSON.stringify`, which
 * elides undefined keys, ensuring only the populated field reaches the wire.
 */
export interface OpenAIClientLike {
  chatCompletions(args: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    tools: Array<{
      type: 'function';
      function: { name: string; description: string; parameters: object };
    }>;
    /**
     * tool_choice: 'required' for reasoning models (gpt-5+/o-series, allows
     * interleaved thinking) or a forced-specific function object for classic
     * models (gpt-4o, gpt-4.1). See resolveToolChoice.
     */
    tool_choice: 'required' | { type: 'function'; function: { name: string } };
    max_tokens?: number;
    max_completion_tokens?: number;
    seed?: number;
  }): Promise<unknown>;
  /**
   * `/responses` call, used by `review()` for the model families that reject
   * function tools on `/chat/completions` (see `resolveApiStyle`).
   *
   * Optional so that an injected client predating the Responses support still
   * satisfies this shape; `review()` falls back to `chatCompletions` when the
   * method is absent. `createOpenAIClient` always provides it.
   */
  responses?(args: OpenAIResponsesArgs): Promise<unknown>;
  /**
   * Plain-text (no tools) completion — used by `respond()`
   * (reviewer-interaction, `@bot ask <message>`). See `OpenAITextCompletionArgs`.
   */
  textCompletion(args: OpenAITextCompletionArgs): Promise<unknown>;
}

export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /**
   * Cost-ceiling proxy: characters in stringified input divided by 4 ≈ tokens
   * (rough but bounded). Pre-flight rejection raises a `capability` error with
   * `missing_capability: 'cost_ceiling'` for parity with the other adapters.
   */
  maxTokensPerCall?: number;
  timeoutMs?: number;
  capabilities?: ProviderCapabilities;
  client?: OpenAIClientLike;
  /**
   * `tokenParamStyle` — controls which token-limit parameter is sent per
   * request. Defaults to `'auto'`, which uses `resolveTokenParam`'s heuristic
   * regex to select `max_tokens` (classic families) or `max_completion_tokens`
   * (gpt-5* and o-series). Set to `'max_tokens'` or `'max_completion_tokens'`
   * to override the heuristic — useful for proxy gateways that lag OpenAI's
   * rollout or for misclassified future models.
   *
   * Wired from `OPENAI_TOKEN_PARAM` env var (deployment.md § Config).
   */
  tokenParamStyle?: TokenParamStyle;
  /**
   * `maxOutputTokens` — the output token budget sent per request. Defaults to
   * `4096`, which is byte-identical to the previous hardcoded value. Raise this
   * for reasoning-capable models (o-series, gpt-5) that consume more completion
   * tokens without changing any other behavior.
   *
   * Wired from `OPENAI_MAX_OUTPUT_TOKENS` env var (deployment.md § Config).
   */
  maxOutputTokens?: number;
  /**
   * toolChoiceStyle: controls how tool_choice is set per request.
   * 'auto' (default): reasoning models (gpt-5+/o-series) get 'required',
   * classic models (gpt-4o, gpt-4.1) get the forced-specific function object.
   * 'forced': always send the forced-specific object (bypass heuristic).
   * 'required': always send 'required' (bypass heuristic).
   * Wired from OPENAI_TOOL_CHOICE env var (deployment.md - Config).
   */
  toolChoiceStyle?: ToolChoiceStyle;
  /**
   * `apiStyle` controls which endpoint `review()` posts to. Defaults to
   * `'auto'`, which sends the model families that reject function tools on
   * `/chat/completions` (gpt-5.6*, gpt-6+) to `/responses` and leaves every
   * other model on `/chat/completions`. `'chat'` pins the old behavior;
   * `'responses'` uses `/responses` for every model.
   *
   * Wired from OPENAI_API_STYLE env var (deployment.md - Config).
   */
  apiStyle?: ApiStyle;
  /**
   * `onUsage` — optional sink for per-call token telemetry (see
   * `OpenAIUsageTelemetry`). Called once per `review()` provider call, after
   * the response arrives and BEFORE truncation detection, so a call that hit
   * the output cap still reports where the budget went.
   *
   * Additive and adapter-local: the `Provider` interface and
   * `ProviderReviewOutput` are unchanged (issue #40 § Out of scope). The worker
   * wires this to the process logger as the `provider.usage` audit event.
   *
   * Never allowed to fail a review — the adapter swallows anything this throws.
   */
  onUsage?: (usage: OpenAIUsageTelemetry) => void;
}

/**
 * `OpenAIUsageTelemetry` — vendor-neutral token accounting for one provider
 * call, normalized across the two endpoints' different spellings:
 *
 * | Field                | `/chat/completions`                          | `/responses`                              |
 * |----------------------|----------------------------------------------|-------------------------------------------|
 * | `input_tokens`       | `usage.prompt_tokens`                        | `usage.input_tokens`                      |
 * | `output_tokens`      | `usage.completion_tokens`                    | `usage.output_tokens`                     |
 * | `cached_input_tokens`| `usage.prompt_tokens_details.cached_tokens`  | `usage.input_tokens_details.cached_tokens`|
 * | `reasoning_tokens`   | `usage.completion_tokens_details.reasoning_tokens` | `usage.output_tokens_details.reasoning_tokens` |
 *
 * `reasoning_tokens` is the field that answers the operating question behind
 * issue #40: whether a large `max_output_tokens` was consumed by reasoning or
 * by findings. Fields the endpoint did not report are omitted rather than
 * zero-filled, so absent and zero stay distinguishable.
 *
 * Counts only. No prompt or response content is carried (observability.md:
 * the adapter never logs request or response bodies).
 */
export interface OpenAIUsageTelemetry {
  /** Which endpoint served the call. */
  endpoint: 'chat' | 'responses';
  /** The model actually sent, after `request_shaping.model` resolution. */
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_tokens?: number;
}

interface ToolCall {
  id?: string;
  type: 'function';
  function: { name: string; arguments: string | object };
}

function isToolCall(value: unknown): value is ToolCall {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== 'function') {
    return false;
  }
  const fn = record.function;
  if (typeof fn !== 'object' || fn === null) {
    return false;
  }
  const fnRecord = fn as Record<string, unknown>;
  return typeof fnRecord.name === 'string';
}

function extractToolCallArguments(response: unknown, toolName: string): unknown {
  if (typeof response !== 'object' || response === null) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'openai response was not an object',
    });
  }
  const record = response as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'openai response missing choices array',
    });
  }
  const firstChoice = choices[0];
  if (typeof firstChoice !== 'object' || firstChoice === null) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'openai first choice was not an object',
    });
  }
  const message = (firstChoice as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'openai choice missing message',
    });
  }
  const toolCalls = (message as Record<string, unknown>).tool_calls;
  if (!Array.isArray(toolCalls)) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: `openai response missing tool_calls for tool '${toolName}'`,
    });
  }
  for (const candidate of toolCalls) {
    if (isToolCall(candidate) && candidate.function.name === toolName) {
      const rawArgs = candidate.function.arguments;
      if (typeof rawArgs === 'string') {
        try {
          return JSON.parse(rawArgs);
        } catch {
          throw new ProviderErrorThrowable({
            kind: 'schema_validation',
            message: 'openai tool_call arguments was not valid JSON',
          });
        }
      }
      return rawArgs;
    }
  }
  throw new ProviderErrorThrowable({
    kind: 'schema_validation',
    message: `openai response missing tool_call for tool '${toolName}'`,
  });
}

/**
 * Extract the tool-call arguments from a `/responses` response.
 *
 * The Responses API returns the call as an item in the top-level `output`
 * array (`{ type: 'function_call', name, arguments }`) rather than under
 * `choices[0].message.tool_calls`. Errors mirror `extractToolCallArguments`
 * so the orchestrator sees the same `schema_validation` shape either way.
 */
function extractResponsesToolCallArguments(response: unknown, toolName: string): unknown {
  if (typeof response !== 'object' || response === null) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'openai response was not an object',
    });
  }
  const output = (response as Record<string, unknown>).output;
  if (!Array.isArray(output)) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: `openai response missing output array for tool '${toolName}'`,
    });
  }
  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.type !== 'function_call' || record.name !== toolName) continue;
    const rawArgs = record.arguments;
    if (typeof rawArgs === 'string') {
      try {
        return JSON.parse(rawArgs);
      } catch {
        throw new ProviderErrorThrowable({
          kind: 'schema_validation',
          message: 'openai tool_call arguments was not valid JSON',
        });
      }
    }
    return rawArgs;
  }
  throw new ProviderErrorThrowable({
    kind: 'schema_validation',
    message: `openai response missing tool_call for tool '${toolName}'`,
  });
}

/**
 * `extractUsage` — read the token-accounting block from either endpoint's
 * response into the normalized `OpenAIUsageTelemetry` shape.
 *
 * Tolerant by construction: a response with no `usage` object, a partial one,
 * or non-numeric fields yields a record carrying only `endpoint` and `model`.
 * Telemetry must never be able to fail a review.
 *
 * Exported for direct unit-testing.
 */
export function extractUsage(
  response: unknown,
  endpoint: 'chat' | 'responses',
  model: string,
): OpenAIUsageTelemetry {
  const out: OpenAIUsageTelemetry = { endpoint, model };
  if (typeof response !== 'object' || response === null) return out;
  const usage = (response as Record<string, unknown>).usage;
  if (typeof usage !== 'object' || usage === null) return out;
  const u = usage as Record<string, unknown>;

  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const detail = (key: string, field: string): number | undefined => {
    const d = u[key];
    if (typeof d !== 'object' || d === null) return undefined;
    return num((d as Record<string, unknown>)[field]);
  };

  // `/responses` spells them input/output; `/chat/completions` prompt/completion.
  const input = num(u.input_tokens) ?? num(u.prompt_tokens);
  const output = num(u.output_tokens) ?? num(u.completion_tokens);
  const cached =
    detail('input_tokens_details', 'cached_tokens') ??
    detail('prompt_tokens_details', 'cached_tokens');
  const reasoning =
    detail('output_tokens_details', 'reasoning_tokens') ??
    detail('completion_tokens_details', 'reasoning_tokens');

  if (input !== undefined) out.input_tokens = input;
  if (output !== undefined) out.output_tokens = output;
  if (cached !== undefined) out.cached_input_tokens = cached;
  if (reasoning !== undefined) out.reasoning_tokens = reasoning;
  return out;
}

/**
 * Detect an output-cap truncation on either endpoint.
 *
 * `/chat/completions` reports it as `choices[0].finish_reason === 'length'`;
 * `/responses` reports it as `status: 'incomplete'` with
 * `incomplete_details.reason === 'max_output_tokens'`.
 */
function isOutputTruncated(response: unknown): boolean {
  if (typeof response !== 'object' || response === null) {
    return false;
  }
  const record = response as Record<string, unknown>;
  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const firstChoice = choices[0];
    if (
      typeof firstChoice === 'object' &&
      firstChoice !== null &&
      (firstChoice as Record<string, unknown>).finish_reason === 'length'
    ) {
      return true;
    }
  }
  if (record.status === 'incomplete') {
    const details = record.incomplete_details;
    if (
      typeof details === 'object' &&
      details !== null &&
      (details as Record<string, unknown>).reason === 'max_output_tokens'
    ) {
      return true;
    }
  }
  return false;
}

/** Extract the plain-text assistant reply from a chat-completions response (no tools). */
function extractMessageContent(response: unknown): string {
  if (typeof response !== 'object' || response === null) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'openai response was not an object',
    });
  }
  const record = response as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'openai response missing choices array',
    });
  }
  const firstChoice = choices[0];
  if (typeof firstChoice !== 'object' || firstChoice === null) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'openai first choice was not an object',
    });
  }
  const message = (firstChoice as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'openai choice missing message',
    });
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'openai message missing text content',
    });
  }
  return content.trim();
}

/**
 * `OpenAIProvider` — the OpenAI adapter implementing the `Provider` interface.
 * The vendor surface is the OpenAI chat completions endpoint
 * (`https://api.openai.com/v1/chat/completions`), accessed over the standard
 * OpenAI REST shape.
 *
 * Key differentiator: `deterministic_seed: true` — when the caller supplies
 * `request_shaping.deterministic_seed` (an INT), it is threaded as `seed` into
 * the request. This is the only honest basis for declaring the capability.
 *
 * Invariants (ADR-002, api-contracts.md § Invariants and error semantics):
 *   - Network primitive (`fetch`) is confined to `client.ts`.
 *   - All thrown errors are `ProviderErrorThrowable` instances; raw HTTP
 *     errors are mapped through `mapOpenAIError`.
 *   - Adapter validates the tool-call arguments via `ProviderReviewOutputSchema`;
 *     on failure throws `schema_validation` (item 8).
 *   - Adapter never logs request or response bodies (observability.md §
 *     Event taxonomy: `provider.called` / `provider.error`).
 */
/**
 * Default output token budget. Matches the historical hardcoded value so that
 * deployments that do not set `OPENAI_MAX_OUTPUT_TOKENS` are byte-identical in
 * behavior. Raise via `OpenAIProviderOptions.maxOutputTokens` (or the env var)
 * for reasoning-capable models that may need a larger budget.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export class OpenAIProvider implements Provider {
  readonly name = OPENAI_PROVIDER_NAME;
  readonly capabilities: ProviderCapabilities;

  private readonly client: OpenAIClientLike;
  private readonly model: string;
  private readonly maxTokensPerCall: number | undefined;
  private readonly tokenParamStyle: TokenParamStyle;
  private readonly maxOutputTokens: number;
  private readonly toolChoiceStyle: ToolChoiceStyle;
  private readonly apiStyle: ApiStyle;
  private readonly onUsage: ((usage: OpenAIUsageTelemetry) => void) | undefined;

  constructor(options: OpenAIProviderOptions) {
    this.model = options.model ?? OPENAI_DEFAULT_MODEL;
    this.apiStyle = options.apiStyle ?? 'auto';
    // Phase 2: derive tokenizer_family from the resolved model unless the
    // caller provides explicit capabilities (e.g. tests with a mock window).
    const baseCapabilities = options.capabilities ?? OPENAI_CAPABILITIES;
    this.capabilities = {
      ...baseCapabilities,
      tokenizer_family:
        options.capabilities?.tokenizer_family ?? resolveOpenAITokenizerFamily(this.model),
      // Capability honesty (ADR-005 § Rationale, contributing.md § "Declare
      // capabilities honestly"): `seed` exists on `/chat/completions` and does
      // not exist on `/responses`, so `deterministic_seed` is a property of the
      // resolved endpoint, not of the vendor. Derived from the deployment model
      // + apiStyle here; an explicit `capabilities.deterministic_seed` from the
      // caller still wins, mirroring the tokenizer_family precedent above.
      //
      // A per-request `request_shaping.model` can route a single call
      // differently from the deployment default; `toResponsesArgs` emits a note
      // in that case rather than silently dropping the seed.
      deterministic_seed:
        options.capabilities?.deterministic_seed ??
        resolveApiStyle(this.model, this.apiStyle) === 'chat',
    };
    this.maxTokensPerCall = options.maxTokensPerCall;
    this.tokenParamStyle = options.tokenParamStyle ?? 'auto';
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.toolChoiceStyle = options.toolChoiceStyle ?? 'auto';
    this.onUsage = options.onUsage;
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      const clientOptions: Parameters<typeof createOpenAIClient>[0] = {
        apiKey: options.apiKey,
      };
      if (options.baseUrl !== undefined) {
        clientOptions.baseUrl = options.baseUrl;
      }
      if (options.timeoutMs !== undefined) {
        clientOptions.timeoutMs = options.timeoutMs;
      }
      this.client = createOpenAIClient(clientOptions) as OpenAIClientLike;
    }
  }

  async review(input: ProviderReviewInput): Promise<ProviderReviewOutput> {
    if (this.maxTokensPerCall !== undefined) {
      // Phase 2: unified estimator — counts the SAME serialized prompt the
      // batcher counts, eliminating the HOTSPOT-2/HOTSPOT-6 divergence.
      // Phase 4: throws `over_budget` (not `capability/cost_ceiling`) so the
      // orchestrator's discriminator is a single `kind === 'over_budget'` check
      // and the batch degrades (split/skip) instead of aborting the PR.
      const estimate = estimatePromptTokens(
        serializeForEstimate(input),
        this.capabilities.tokenizer_family,
      );
      if (estimate > this.maxTokensPerCall) {
        throw new ProviderErrorThrowable({
          kind: 'over_budget',
          estimated_tokens: estimate,
          hard_cap_in: this.maxTokensPerCall,
          message: `request exceeds per-call token budget: estimated ${estimate} tokens, cap ${this.maxTokensPerCall}`,
        });
      }
    }

    const prompt = buildPrompt(input);

    // D3: resolve per-request model and seed from request_shaping (conditional-assign)
    const model = input.request_shaping?.model ?? this.model;

    // D1: select the correct token-limit parameter for the resolved model.
    // `resolveTokenParam` applies the `tokenParamStyle` override (operator escape
    // hatch via `OPENAI_TOKEN_PARAM`) or falls back to the heuristic (via
    // `isReasoningModel`) that distinguishes gpt-5*/o-series
    // (`max_completion_tokens`) from classic models (`max_tokens`).
    // Never send both; JSON.stringify elides undefined keys so only the set
    // field reaches the wire.
    const tokenParam = resolveTokenParam(model, this.tokenParamStyle);

    // D2: resolve tool_choice for the resolved model.
    // Reasoning models (gpt-5*/o-series) need `tool_choice: 'required'` to
    // allow interleaved thinking before the tool call. Forcing a specific
    // function on these models short-circuits reasoning and yields an empty
    // findings array. Classic models continue to use the forced-specific object.
    // The `OPENAI_TOOL_CHOICE` env var (→ `this.toolChoiceStyle`) lets
    // operators override the heuristic for proxy gateways or misclassifications.
    const toolChoice = resolveToolChoice(model, prompt.tool.function.name, this.toolChoiceStyle);

    // D2b: conservative prompt nudge for reasoning models only.
    // Appending a short instruction to the system message directly counters the
    // empty-array pattern: the model is explicitly told to reason thoroughly
    // before calling the tool and only submit an empty array when there are
    // genuinely no issues. Classic-model messages are NOT modified — this
    // ensures byte-identical requests for gpt-4o/gpt-4.1 (no regression).
    const REASONING_NUDGE =
      '\n\nAnalyze the diff thoroughly, then call submit_review_findings exactly once with every real finding; use an empty findings array only if there are genuinely no issues.';

    const effectiveMessages: OpenAIChatCompletionsArgs['messages'] = isReasoningModel(model)
      ? [
          {
            ...prompt.messages[0],
            // Append the nudge to the system message (index 0).
            content: (prompt.messages[0]?.content ?? '') + REASONING_NUDGE,
          } as { role: 'system' | 'user' | 'assistant'; content: string },
          ...prompt.messages.slice(1),
        ]
      : prompt.messages;

    // Step 1: base args — model, prompt structure, and the deployment-level
    // output token budget (`this.maxOutputTokens`, from OPENAI_MAX_OUTPUT_TOKENS
    // or the 4096 default).
    let args: OpenAIChatCompletionsArgs = {
      model,
      messages: effectiveMessages,
      tools: [prompt.tool],
      tool_choice: toolChoice,
    };
    args[tokenParam] = this.maxOutputTokens;

    const seed = input.request_shaping?.deterministic_seed;
    if (typeof seed === 'number') {
      args.seed = seed;
    }

    // Step 2: apply normalized generation settings from request_shaping.generation.
    // Spec § 5.3 (AS-5, AS-7): generation fields override the deployment default.
    // Order is defaults → generation → provider_options (last wins, P5).
    // NOTE: `generation.seed` is NOT re-read here — the orchestrator maps it into
    // `request_shaping.deterministic_seed` (single seed source, spec § 5.3/5.4).
    const generation = input.request_shaping?.generation;
    if (generation !== undefined) {
      if (typeof generation.max_output_tokens === 'number') {
        // Overwrite the default token budget with the repo-config value (AS-5).
        // The token-param KEY is still chosen by resolveTokenParam so the right
        // field name is used for the resolved model family.
        args[tokenParam] = generation.max_output_tokens;
      }
      if (typeof generation.temperature === 'number') {
        args.temperature = generation.temperature;
      }
      if (typeof generation.top_p === 'number') {
        args.top_p = generation.top_p;
      }
      // generation.seed is intentionally skipped here; it arrives via
      // deterministic_seed above (spec § 5.4 "single seed source").
    }

    // Step 3: apply raw provider_options passthrough (escape hatch, P5 — wins last).
    // The orchestrator places only the active-provider's sub-bag here (AS-10, G9).
    // Denylisted keys are dropped and a note is returned (spec § 3.7, G8).
    // G7: we do NOT log any key or value from providerOptionsBag.
    const providerOptionsBag = input.request_shaping?.provider_options;
    if (providerOptionsBag !== undefined && typeof providerOptionsBag === 'object') {
      const { args: merged } = applyProviderOptions(
        args,
        providerOptionsBag as Record<string, unknown>,
      );
      args = merged;
    }

    // D4: select the endpoint for the resolved model. `/responses` is used for
    // the families that reject function tools on `/chat/completions`; the
    // `OPENAI_API_STYLE` env var (→ `this.apiStyle`) overrides the heuristic.
    // An injected client without a `responses` method keeps the chat path.
    const responsesCall = this.client.responses?.bind(this.client);
    const useResponses =
      resolveApiStyle(model, this.apiStyle) === 'responses' && responsesCall !== undefined;

    let response: unknown;
    try {
      if (responsesCall !== undefined && useResponses) {
        // The endpoint-aware translation (reasoning spelling, seed, state
        // linking, output cap) happens here, once, immediately before the
        // call. `notes` are key-only by construction (G7).
        const { args: responsesArgs } = toResponsesArgs(args);
        response = await responsesCall(responsesArgs);
      } else {
        response = await this.client.chatCompletions(args);
      }
    } catch (err) {
      if (err instanceof ProviderErrorThrowable) {
        throw err;
      }
      throw new ProviderErrorThrowable(mapOpenAIError(err));
    }

    // Token telemetry. Emitted before truncation detection so a call that hit
    // the output cap still reports whether reasoning or findings consumed it
    // (issue #40 § "token usage is recorded from the Responses usage object").
    // Never allowed to fail a review.
    if (this.onUsage !== undefined) {
      try {
        this.onUsage(extractUsage(response, useResponses ? 'responses' : 'chat', model));
      } catch {
        // telemetry is best-effort
      }
    }

    // Detect response truncation: the model hit the output token cap and the
    // output may be a partial/invalid findings array. Throw output_truncated so
    // the orchestrator can split-and-retry instead of dropping the batch's
    // findings (chunking-stability-spec.md § Phase 1). The message is param-
    // and value-agnostic so it accurately reflects whatever token field was in
    // play (max_tokens, max_completion_tokens or max_output_tokens).
    if (isOutputTruncated(response)) {
      throw new ProviderErrorThrowable({
        kind: 'output_truncated',
        message: `openai response truncated: the model hit the output token cap (${this.maxOutputTokens})`,
        requested_max_tokens: this.maxOutputTokens,
      });
    }

    const toolArgs = useResponses
      ? extractResponsesToolCallArguments(response, prompt.tool.function.name)
      : extractToolCallArguments(response, prompt.tool.function.name);
    const parsed = ProviderReviewOutputSchema.safeParse(toolArgs);
    if (!parsed.success) {
      throw new ProviderErrorThrowable({
        kind: 'schema_validation',
        message: 'openai tool_call arguments failed ProviderReviewOutput schema',
        zod_issues: parsed.error.issues.map((issue) => issue.message),
      });
    }
    return parsed.data;
  }

  /**
   * `respond()` — reviewer-interaction entry point (`@bot ask <message>`).
   * No tool/JSON-schema is involved: a plain-text completion is requested
   * (`textCompletion`, no `tools`/`tool_choice`) and the assistant's message
   * content is returned as `reply_markdown`. Token-param selection
   * (`max_tokens` vs `max_completion_tokens`) and error mapping mirror
   * `review()`.
   */
  async respond(input: ProviderRespondInput): Promise<ProviderRespondOutput> {
    if (this.maxTokensPerCall !== undefined) {
      // Simple chars/4 estimate (the cost-ceiling-proxy heuristic `review()`
      // used before the unified estimator existed) — `estimatePromptTokens`/
      // `serializeForEstimate` are typed specifically for `ProviderReviewInput`'s
      // diff-hunk shape. Safe here because `ProviderRespondInput` is already
      // hard-capped by the caller (MAX_RESPOND_* in shared/schemas/provider.ts).
      const estimate = Math.ceil(JSON.stringify(input).length / 4);
      if (estimate > this.maxTokensPerCall) {
        throw new ProviderErrorThrowable({
          kind: 'over_budget',
          estimated_tokens: estimate,
          hard_cap_in: this.maxTokensPerCall,
          message: `request exceeds per-call token budget: estimated ${estimate} tokens, cap ${this.maxTokensPerCall}`,
        });
      }
    }

    const prompt = buildRespondPrompt(input);
    const model = this.model;
    const tokenParam = resolveTokenParam(model, this.tokenParamStyle);

    const args: OpenAITextCompletionArgs = { model, messages: prompt.messages };
    args[tokenParam] = this.maxOutputTokens;

    const generation = input.generation;
    if (generation !== undefined) {
      if (typeof generation.max_output_tokens === 'number') {
        args[tokenParam] = generation.max_output_tokens;
      }
      if (typeof generation.temperature === 'number') {
        args.temperature = generation.temperature;
      }
      if (typeof generation.top_p === 'number') {
        args.top_p = generation.top_p;
      }
      if (typeof generation.seed === 'number') {
        args.seed = generation.seed;
      }
    }

    let response: unknown;
    try {
      response = await this.client.textCompletion(args);
    } catch (err) {
      if (err instanceof ProviderErrorThrowable) {
        throw err;
      }
      throw new ProviderErrorThrowable(mapOpenAIError(err));
    }

    if (
      typeof response === 'object' &&
      response !== null &&
      Array.isArray((response as Record<string, unknown>).choices) &&
      ((response as Record<string, unknown>).choices as unknown[])[0] !== undefined
    ) {
      const firstChoice = (
        (response as Record<string, unknown>).choices as Record<string, unknown>[]
      )[0];
      if (
        typeof firstChoice === 'object' &&
        firstChoice !== null &&
        (firstChoice as Record<string, unknown>).finish_reason === 'length'
      ) {
        throw new ProviderErrorThrowable({
          kind: 'output_truncated',
          message: `openai respond output truncated: finish_reason is 'length' (output token cap: ${this.maxOutputTokens})`,
          requested_max_tokens: this.maxOutputTokens,
        });
      }
    }

    const text = extractMessageContent(response);
    const parsed = ProviderRespondOutputSchema.safeParse({ reply_markdown: text });
    if (!parsed.success) {
      throw new ProviderErrorThrowable({
        kind: 'schema_validation',
        message: 'openai respond output failed ProviderRespondOutput schema',
        zod_issues: parsed.error.issues.map((issue) => issue.message),
      });
    }
    return parsed.data;
  }
}

export { buildPrompt } from './prompt.js';
export type { PromptShape } from './prompt.js';
export { mapOpenAIError } from './error-mapping.js';
export { createOpenAIClient } from './client.js';
export type { CreateOpenAIClientOptions, OpenAIClient } from './client.js';
