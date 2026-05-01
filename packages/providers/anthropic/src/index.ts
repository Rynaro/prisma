import {
  type Provider,
  type ProviderCapabilities,
  ProviderErrorThrowable,
  type ProviderReviewInput,
  type ProviderReviewOutput,
  ProviderReviewOutputSchema,
} from '@prisma-bot/shared';
import { createAnthropicClient } from './client.js';
import { mapAnthropicError } from './error-mapping.js';
import { buildPrompt } from './prompt.js';

/**
 * `ANTHROPIC_PROVIDER_NAME` is kept as a top-level constant for backward
 * compatibility with phase-4 references. The instance's `name` field is the
 * canonical source of truth.
 */
export const ANTHROPIC_PROVIDER_NAME = 'anthropic';

/**
 * Default model identifier. Centralized so it can be swapped in one place.
 * Model selection is treated as configuration, not as a vendor type.
 */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-3-5-sonnet-latest';

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  structured_output: true,
  function_calling: true,
  deterministic_seed: false,
  max_context_tokens: 200000,
};

/**
 * `AnthropicClientLike` — the minimal interface this package consumes from a
 * client. In production, `createAnthropicClient` returns an instance that
 * satisfies this shape; tests inject mock clients.
 *
 * Per ADR-002 § Decision and api-contracts.md § Invariants and error semantics
 * (item 1): no Anthropic SDK type appears in this signature.
 */
export interface AnthropicClientLike {
  messages: {
    create(args: unknown): Promise<unknown>;
  };
}

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  /**
   * Cost-ceiling proxy: characters in stringified input divided by 4 ≈ tokens
   * (rough but bounded). Pre-flight rejection raises a `capability` error with
   * `missing_capability: 'cost_ceiling'` per the Phase 5.3 spec.
   */
  maxTokensPerCall?: number;
  timeoutMs?: number;
  capabilities?: ProviderCapabilities;
  client?: AnthropicClientLike;
}

interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  input: unknown;
}

function isToolUseBlock(block: unknown): block is ToolUseBlock {
  if (typeof block !== 'object' || block === null) {
    return false;
  }
  const record = block as Record<string, unknown>;
  return record.type === 'tool_use' && typeof record.name === 'string';
}

function extractToolUseInput(response: unknown, toolName: string): unknown {
  if (typeof response !== 'object' || response === null) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'anthropic response was not an object',
    });
  }
  const record = response as Record<string, unknown>;
  const content = record.content;
  if (!Array.isArray(content)) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'anthropic response missing content array',
    });
  }
  for (const block of content) {
    if (isToolUseBlock(block) && block.name === toolName) {
      return block.input;
    }
  }
  throw new ProviderErrorThrowable({
    kind: 'schema_validation',
    message: `anthropic response missing tool_use block for tool '${toolName}'`,
  });
}

/**
 * `AnthropicProvider` — the reference adapter implementing the `Provider`
 * interface for Anthropic Claude.
 *
 * Invariants (ADR-002, api-contracts.md § Invariants and error semantics):
 *   - The `@anthropic-ai/sdk` import is confined to `client.ts`.
 *   - All thrown errors are `ProviderErrorThrowable` instances; vendor SDK
 *     errors are mapped through `mapAnthropicError`.
 *   - Adapter validates the tool-use input via `ProviderReviewOutputSchema`;
 *     on failure throws `schema_validation` (item 8).
 *   - Adapter never logs request or response bodies (observability.md §
 *     Event taxonomy: `provider.called` / `provider.error`).
 */
export class AnthropicProvider implements Provider {
  readonly name = ANTHROPIC_PROVIDER_NAME;
  readonly capabilities: ProviderCapabilities;

  private readonly client: AnthropicClientLike;
  private readonly model: string;
  private readonly maxTokensPerCall: number | undefined;

  constructor(options: AnthropicProviderOptions) {
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
    this.model = options.model ?? ANTHROPIC_DEFAULT_MODEL;
    this.maxTokensPerCall = options.maxTokensPerCall;
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      const clientOptions: Parameters<typeof createAnthropicClient>[0] = {
        apiKey: options.apiKey,
      };
      if (options.timeoutMs !== undefined) {
        clientOptions.timeoutMs = options.timeoutMs;
      }
      this.client = createAnthropicClient(clientOptions) as unknown as AnthropicClientLike;
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

    let response: unknown;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: prompt.system,
        messages: prompt.messages,
        tools: [
          {
            name: prompt.tool.name,
            description: prompt.tool.description,
            input_schema: prompt.tool.input_schema,
          },
        ],
        tool_choice: { type: 'tool', name: prompt.tool.name },
      });
    } catch (err) {
      if (err instanceof ProviderErrorThrowable) {
        throw err;
      }
      throw new ProviderErrorThrowable(mapAnthropicError(err));
    }

    const toolInput = extractToolUseInput(response, prompt.tool.name);
    const parsed = ProviderReviewOutputSchema.safeParse(toolInput);
    if (!parsed.success) {
      throw new ProviderErrorThrowable({
        kind: 'schema_validation',
        message: 'anthropic tool_use input failed ProviderReviewOutput schema',
        zod_issues: parsed.error.issues.map((issue) => issue.message),
      });
    }
    return parsed.data;
  }
}

export { buildPrompt } from './prompt.js';
export type { PromptShape } from './prompt.js';
export { mapAnthropicError } from './error-mapping.js';
export { createAnthropicClient } from './client.js';
export type { CreateAnthropicClientOptions } from './client.js';
