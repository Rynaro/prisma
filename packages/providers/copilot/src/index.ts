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
  buildRespondPrompt,
  estimatePromptTokens,
  serializeForEstimate,
} from '@prisma-bot/shared';
import { type CopilotTextCompletionArgs, createCopilotClient } from './client.js';
import { mapCopilotError } from './error-mapping.js';
import { buildPrompt } from './prompt.js';

/**
 * `COPILOT_PROVIDER_NAME` — canonical `Provider.name` value for the GitHub
 * Copilot adapter. The instance's `name` field is the source of truth; this
 * top-level constant exists so call sites (selector logs, log enrichers,
 * test assertions) do not need to instantiate a provider to compare strings.
 */
export const COPILOT_PROVIDER_NAME = 'copilot';

/**
 * Default model identifier. Centralized so it can be swapped in one place.
 * Model selection is treated as configuration, not as a vendor type.
 *
 * Per `.spectra/plans/copilot-vendor/spec.yaml` (OQ-Copilot-2): GPT-4o-class
 * model on the GitHub Models endpoint. Operators override via `COPILOT_MODEL`.
 */
export const COPILOT_DEFAULT_MODEL = 'gpt-4o';

/**
 * Default base URL for the GitHub Models inference endpoint. Operators may
 * override via `COPILOT_BASE_URL` (e.g., when GitHub stabilizes the endpoint
 * behind a different host or to point at a private gateway).
 */
export const COPILOT_DEFAULT_BASE_URL = 'https://models.github.ai/inference';

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  structured_output: true,
  function_calling: true,
  deterministic_seed: false,
  max_context_tokens: 128000,
  /**
   * Copilot uses GPT-4o-class models via the GitHub Models endpoint.
   * The endpoint is OpenAI-compatible; default tokenizer is `cl100k` (GPT-4
   * family). Operators targeting gpt-4o or newer models should note that those
   * use `o200k_base`, but `cl100k` over-counts for those (safe direction).
   *
   * Per chunking-stability-spec.md § Phase 2 "Provider capabilities".
   */
  tokenizer_family: 'cl100k',
};

/**
 * `CopilotClientLike` — the minimal interface this package consumes from a
 * client. In production, `createCopilotClient` returns an instance that
 * satisfies this shape; tests inject mock clients.
 *
 * Per ADR-002 § Decision and api-contracts.md § Invariants and error semantics
 * (item 1): no OpenAI / fetch / Response type appears in this signature.
 */
export interface CopilotClientLike {
  chatCompletions(args: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    tools: Array<{
      type: 'function';
      function: { name: string; description: string; parameters: object };
    }>;
    tool_choice: { type: 'function'; function: { name: string } };
    max_tokens: number;
  }): Promise<unknown>;
  /**
   * Plain-text (no tools) completion — used by `respond()`
   * (reviewer-interaction, `@bot ask <message>`). See `CopilotTextCompletionArgs`.
   */
  textCompletion(args: CopilotTextCompletionArgs): Promise<unknown>;
}

/**
 * Default output token budget. Matches the historical hardcoded value so that
 * deployments that do not set `COPILOT_MAX_OUTPUT_TOKENS` are byte-identical
 * in behavior. Raise via `CopilotProviderOptions.maxOutputTokens` (or the
 * env var) for finding-dense repos where the output truncates.
 *
 * Per chunking-stability-spec.md § Phase 1 "New/changed config knobs".
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface CopilotProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /**
   * Cost-ceiling proxy: characters in stringified input divided by 4 ≈ tokens
   * (rough but bounded). Pre-flight rejection raises a `capability` error with
   * `missing_capability: 'cost_ceiling'` for parity with the Anthropic adapter.
   */
  maxTokensPerCall?: number;
  /**
   * Output token budget sent per request as `max_tokens`. Defaults to 4096.
   * Raise via `COPILOT_MAX_OUTPUT_TOKENS` env var or
   * `chunking.reserved_output_tokens` config for finding-dense repos.
   *
   * Per chunking-stability-spec.md § Phase 1 "New/changed config knobs".
   */
  maxOutputTokens?: number;
  timeoutMs?: number;
  capabilities?: ProviderCapabilities;
  client?: CopilotClientLike;
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
      message: 'copilot response was not an object',
    });
  }
  const record = response as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'copilot response missing choices array',
    });
  }
  const firstChoice = choices[0];
  if (typeof firstChoice !== 'object' || firstChoice === null) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'copilot first choice was not an object',
    });
  }
  const message = (firstChoice as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'copilot choice missing message',
    });
  }
  const toolCalls = (message as Record<string, unknown>).tool_calls;
  if (!Array.isArray(toolCalls)) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: `copilot response missing tool_calls for tool '${toolName}'`,
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
            message: 'copilot tool_call arguments was not valid JSON',
          });
        }
      }
      return rawArgs;
    }
  }
  throw new ProviderErrorThrowable({
    kind: 'schema_validation',
    message: `copilot response missing tool_call for tool '${toolName}'`,
  });
}

/** Extract the plain-text assistant reply from a chat-completions response (no tools). */
function extractMessageContent(response: unknown): string {
  if (typeof response !== 'object' || response === null) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'copilot response was not an object',
    });
  }
  const record = response as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'copilot response missing choices array',
    });
  }
  const firstChoice = choices[0];
  if (typeof firstChoice !== 'object' || firstChoice === null) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'copilot first choice was not an object',
    });
  }
  const message = (firstChoice as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'copilot choice missing message',
    });
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'copilot message missing text content',
    });
  }
  return content.trim();
}

/**
 * `CopilotProvider` — the GitHub Copilot adapter implementing the `Provider`
 * interface. The vendor surface is the GitHub Models inference endpoint
 * (`https://models.github.ai/inference/chat/completions`), accessed over an
 * OpenAI-compatible REST shape.
 *
 * Invariants (ADR-002, api-contracts.md § Invariants and error semantics):
 *   - Network primitive (`fetch`) is confined to `client.ts`.
 *   - All thrown errors are `ProviderErrorThrowable` instances; raw HTTP
 *     errors are mapped through `mapCopilotError`.
 *   - Adapter validates the tool-call arguments via `ProviderReviewOutputSchema`;
 *     on failure throws `schema_validation` (item 8).
 *   - Adapter never logs request or response bodies (observability.md §
 *     Event taxonomy: `provider.called` / `provider.error`).
 */
export class CopilotProvider implements Provider {
  readonly name = COPILOT_PROVIDER_NAME;
  readonly capabilities: ProviderCapabilities;

  private readonly client: CopilotClientLike;
  private readonly model: string;
  private readonly maxTokensPerCall: number | undefined;
  private readonly maxOutputTokens: number;

  constructor(options: CopilotProviderOptions) {
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
    this.model = options.model ?? COPILOT_DEFAULT_MODEL;
    this.maxTokensPerCall = options.maxTokensPerCall;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      const clientOptions: Parameters<typeof createCopilotClient>[0] = {
        apiKey: options.apiKey,
      };
      if (options.baseUrl !== undefined) {
        clientOptions.baseUrl = options.baseUrl;
      }
      if (options.timeoutMs !== undefined) {
        clientOptions.timeoutMs = options.timeoutMs;
      }
      this.client = createCopilotClient(clientOptions) as CopilotClientLike;
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

    let response: unknown;
    try {
      response = await this.client.chatCompletions({
        model: this.model,
        messages: prompt.messages,
        tools: [prompt.tool],
        tool_choice: prompt.tool_choice,
        max_tokens: this.maxOutputTokens,
      });
    } catch (err) {
      if (err instanceof ProviderErrorThrowable) {
        throw err;
      }
      throw new ProviderErrorThrowable(mapCopilotError(err));
    }

    // Detect response truncation: finish_reason==='length' means the model hit
    // the output token cap and the output may be a partial/invalid findings array.
    // Throw output_truncated so the orchestrator can split-and-retry instead of
    // dropping the batch's findings (chunking-stability-spec.md § Phase 1).
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
          message: `copilot response truncated: finish_reason is 'length' (max_tokens: ${this.maxOutputTokens})`,
          requested_max_tokens: this.maxOutputTokens,
        });
      }
    }

    const toolArgs = extractToolCallArguments(response, prompt.tool.function.name);
    const parsed = ProviderReviewOutputSchema.safeParse(toolArgs);
    if (!parsed.success) {
      throw new ProviderErrorThrowable({
        kind: 'schema_validation',
        message: 'copilot tool_call arguments failed ProviderReviewOutput schema',
        zod_issues: parsed.error.issues.map((issue) => issue.message),
      });
    }
    return parsed.data;
  }

  /**
   * `respond()` — reviewer-interaction entry point (`@bot ask <message>`).
   * No tool/JSON-schema is involved: a plain-text completion is requested
   * (`textCompletion`, no `tools`/`tool_choice`) and the assistant's message
   * content is returned as `reply_markdown`. Error mapping mirrors `review()`.
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

    const args: CopilotTextCompletionArgs = {
      model: this.model,
      messages: prompt.messages,
      max_tokens: this.maxOutputTokens,
    };
    const generation = input.generation;
    if (generation !== undefined) {
      if (typeof generation.max_output_tokens === 'number') {
        args.max_tokens = generation.max_output_tokens;
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
      throw new ProviderErrorThrowable(mapCopilotError(err));
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
          message: `copilot respond output truncated: finish_reason is 'length' (max_tokens: ${this.maxOutputTokens})`,
          requested_max_tokens: this.maxOutputTokens,
        });
      }
    }

    const text = extractMessageContent(response);
    const parsed = ProviderRespondOutputSchema.safeParse({ reply_markdown: text });
    if (!parsed.success) {
      throw new ProviderErrorThrowable({
        kind: 'schema_validation',
        message: 'copilot respond output failed ProviderRespondOutput schema',
        zod_issues: parsed.error.issues.map((issue) => issue.message),
      });
    }
    return parsed.data;
  }
}

export { buildPrompt } from './prompt.js';
export type { PromptShape } from './prompt.js';
export { mapCopilotError } from './error-mapping.js';
export { createCopilotClient } from './client.js';
export type { CreateCopilotClientOptions, CopilotClient } from './client.js';
