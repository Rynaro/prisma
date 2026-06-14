import {
  type Provider,
  type ProviderCapabilities,
  ProviderErrorThrowable,
  type ProviderReviewInput,
  type ProviderReviewOutput,
  ProviderReviewOutputSchema,
  isReasoningModel,
} from '@prisma-bot/shared';
import { type OpenAIChatCompletionsArgs, createOpenAIClient } from './client.js';
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
 * `max_tokens` / `max_completion_tokens` / `seed` / `temperature` / `top_p`
 * are NOT denylisted — overriding them via escape hatch is the intended use
 * (AS-9, spec § 3.7 last paragraph).
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

/**
 * `OPENAI_CAPABILITIES` — declared capability set for the OpenAI adapter.
 *
 * Key differentiator vs. Copilot: `deterministic_seed: true` — OpenAI's
 * `/chat/completions` honors an integer `seed` parameter. This is a BOOL
 * (support flag); the INT seed value travels via `ProviderRequestShaping.deterministic_seed`.
 */
export const OPENAI_CAPABILITIES: ProviderCapabilities = {
  structured_output: true,
  function_calling: true,
  deterministic_seed: true,
  max_context_tokens: 128000,
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

  constructor(options: OpenAIProviderOptions) {
    this.capabilities = options.capabilities ?? OPENAI_CAPABILITIES;
    this.model = options.model ?? OPENAI_DEFAULT_MODEL;
    this.maxTokensPerCall = options.maxTokensPerCall;
    this.tokenParamStyle = options.tokenParamStyle ?? 'auto';
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.toolChoiceStyle = options.toolChoiceStyle ?? 'auto';
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
      const estimate = Math.ceil(JSON.stringify(input).length / 4);
      if (estimate > this.maxTokensPerCall) {
        throw new ProviderErrorThrowable({
          kind: 'capability',
          missing_capability: 'cost_ceiling',
          message: 'request exceeds maxTokensPerCall',
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

    let response: unknown;
    try {
      response = await this.client.chatCompletions(args);
    } catch (err) {
      if (err instanceof ProviderErrorThrowable) {
        throw err;
      }
      throw new ProviderErrorThrowable(mapOpenAIError(err));
    }

    // Detect response truncation: finish_reason==='length' means the model hit
    // the output token cap and the output may be a partial/invalid findings
    // array. Treat as schema_validation so the orchestrator publishes
    // malformed_provider_output and does not silently accept a truncated result.
    // The message is param- and value-agnostic so it accurately reflects
    // whatever token field was in play (max_tokens or max_completion_tokens).
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
          kind: 'schema_validation',
          message: `openai response truncated: finish_reason is 'length' (output token cap: ${this.maxOutputTokens})`,
        });
      }
    }

    const toolArgs = extractToolCallArguments(response, prompt.tool.function.name);
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
}

export { buildPrompt } from './prompt.js';
export type { PromptShape } from './prompt.js';
export { mapOpenAIError } from './error-mapping.js';
export { createOpenAIClient } from './client.js';
export type { CreateOpenAIClientOptions, OpenAIClient } from './client.js';
