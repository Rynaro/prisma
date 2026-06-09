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
    max_tokens: number;
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
export class OpenAIProvider implements Provider {
  readonly name = OPENAI_PROVIDER_NAME;
  readonly capabilities: ProviderCapabilities;

  private readonly client: OpenAIClientLike;
  private readonly model: string;
  private readonly maxTokensPerCall: number | undefined;

  constructor(options: OpenAIProviderOptions) {
    this.capabilities = options.capabilities ?? OPENAI_CAPABILITIES;
    this.model = options.model ?? OPENAI_DEFAULT_MODEL;
    this.maxTokensPerCall = options.maxTokensPerCall;
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
    const args: OpenAIChatCompletionsArgs = {
      model,
      messages: prompt.messages,
      tools: [prompt.tool],
      tool_choice: prompt.tool_choice,
      max_tokens: 4096,
    };
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
