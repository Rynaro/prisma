import {
  type Provider,
  type ProviderCapabilities,
  ProviderErrorThrowable,
  type ProviderReviewInput,
  type ProviderReviewOutput,
  ProviderReviewOutputSchema,
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
 * Regex that matches OpenAI model identifiers which require
 * `max_completion_tokens` instead of the classic `max_tokens` parameter.
 *
 * Pattern rationale:
 *   - `o[1-9]`        — o-series reasoning models: o1, o3, o4, …
 *   - `gpt-[5-9]`     — gpt-5, gpt-6, … (gpt-5.4-nano matches on the `5`)
 *   - `gpt-\d{2,}`    — gpt-10, gpt-11, … (future two-digit major versions)
 *
 * Classic models (`gpt-4o`, `gpt-4`, `gpt-4.1`, `gpt-3.5-turbo`) do NOT
 * match: `gpt-4` has a single-digit major ≤ 4; `gpt-4o` has a letter suffix.
 *
 * The regex is anchored at the start to avoid false positives in suffixes
 * (e.g., a hypothetical `ft:gpt-4-my-o1-finetune` should NOT match).
 * The `i` flag is defensive for any mixed-case API identifiers.
 */
const NEWER_MODEL_RE = /^(o[1-9]|gpt-(?:[5-9]|\d{2,}))/i;

/**
 * `resolveTokenParam` — pure helper that maps a model identifier + an optional
 * operator override to the correct token-limit field name.
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
  // auto: apply the heuristic regex.
  return NEWER_MODEL_RE.test(model) ? 'max_completion_tokens' : 'max_tokens';
}

/**
 * `OPENAI_PROVIDER_NAME` — canonical `Provider.name` value for the OpenAI
 * adapter. The instance's `name` field is the source of truth; this
 * top-level constant exists so call sites (selector logs, log enrichers,
 * test assertions) do not need to instantiate a provider to compare strings.
 */
export const OPENAI_PROVIDER_NAME = 'openai';

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
    tool_choice: { type: 'function'; function: { name: string } };
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

  constructor(options: OpenAIProviderOptions) {
    this.capabilities = options.capabilities ?? OPENAI_CAPABILITIES;
    this.model = options.model ?? OPENAI_DEFAULT_MODEL;
    this.maxTokensPerCall = options.maxTokensPerCall;
    this.tokenParamStyle = options.tokenParamStyle ?? 'auto';
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
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
    // hatch via `OPENAI_TOKEN_PARAM`) or falls back to the heuristic regex that
    // distinguishes gpt-5*/o-series (`max_completion_tokens`) from classic models
    // (`max_tokens`). Never send both; JSON.stringify elides undefined keys so
    // only the set field reaches the wire.
    const tokenParam = resolveTokenParam(model, this.tokenParamStyle);
    const args: OpenAIChatCompletionsArgs = {
      model,
      messages: prompt.messages,
      tools: [prompt.tool],
      tool_choice: prompt.tool_choice,
    };
    args[tokenParam] = this.maxOutputTokens;

    const seed = input.request_shaping?.deterministic_seed;
    if (typeof seed === 'number') {
      args.seed = seed;
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
