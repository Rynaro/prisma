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
  /**
   * Anthropic does not provide a local BPE tokenizer. The estimator uses a
   * fast chars/4 × SAFETY_MARGIN heuristic (never under-counts).
   * Per chunking-stability-spec.md § Phase 2 "Provider capabilities".
   */
  tokenizer_family: 'anthropic-approx',
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

/**
 * Default output token budget. Matches the historical hardcoded value so that
 * deployments that do not set `ANTHROPIC_MAX_OUTPUT_TOKENS` are byte-identical
 * in behavior. Raise via `AnthropicProviderOptions.maxOutputTokens` (or the
 * env var) for finding-dense repos where the output truncates.
 *
 * Per chunking-stability-spec.md § Phase 1 "New/changed config knobs".
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  /**
   * Cost-ceiling proxy: characters in stringified input divided by 4 ≈ tokens
   * (rough but bounded). Pre-flight rejection raises a `capability` error with
   * `missing_capability: 'cost_ceiling'` per the Phase 5.3 spec.
   */
  maxTokensPerCall?: number;
  /**
   * Output token budget sent per request as `max_tokens`. Defaults to 4096.
   * Raise via `ANTHROPIC_MAX_OUTPUT_TOKENS` env var or
   * `chunking.reserved_output_tokens` config for finding-dense repos.
   *
   * Per chunking-stability-spec.md § Phase 1 "New/changed config knobs".
   */
  maxOutputTokens?: number;
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

interface TextBlock {
  type: 'text';
  text: string;
}

function isTextBlock(block: unknown): block is TextBlock {
  if (typeof block !== 'object' || block === null) {
    return false;
  }
  const record = block as Record<string, unknown>;
  return record.type === 'text' && typeof record.text === 'string';
}

/** Concatenate every `text` content block into a single trimmed string. */
function extractTextContent(response: unknown): string {
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
  const text = content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (text.length === 0) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'anthropic response contained no text content',
    });
  }
  return text;
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
  private readonly maxOutputTokens: number;

  constructor(options: AnthropicProviderOptions) {
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
    this.model = options.model ?? ANTHROPIC_DEFAULT_MODEL;
    this.maxTokensPerCall = options.maxTokensPerCall;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
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
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxOutputTokens,
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

    // Detect response truncation: stop_reason==='max_tokens' means the model hit
    // the output token cap and the output may be a partial/invalid findings array.
    // Throw output_truncated so the orchestrator can split-and-retry instead of
    // dropping the batch's findings (chunking-stability-spec.md § Phase 1).
    if (
      typeof response === 'object' &&
      response !== null &&
      (response as Record<string, unknown>).stop_reason === 'max_tokens'
    ) {
      throw new ProviderErrorThrowable({
        kind: 'output_truncated',
        message: `anthropic response truncated: stop_reason is 'max_tokens' (max_tokens: ${this.maxOutputTokens})`,
        requested_max_tokens: this.maxOutputTokens,
      });
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

  /**
   * `respond()` — reviewer-interaction entry point (`@bot ask <message>`).
   * Unlike `review()`, no tool/JSON-schema is involved: a plain-text
   * completion is requested and the assistant's text content is returned as
   * `reply_markdown`. Error mapping mirrors `review()`.
   *
   * The token-budget guard uses a simple chars/4 estimate (the same
   * cost-ceiling-proxy heuristic `review()` used before the unified
   * estimator existed) rather than `estimatePromptTokens`/`serializeForEstimate`,
   * which are typed specifically for `ProviderReviewInput`'s diff-hunk shape.
   * This is safe because `ProviderRespondInput` is already hard-capped
   * (`MAX_RESPOND_FINDINGS`/`MAX_RESPOND_FINDING_BODY_BYTES`/
   * `MAX_RESPOND_SUMMARY_BYTES`/`MAX_RESPOND_THREAD_BYTES`) by the caller
   * before this schema is constructed, so a rough estimate is sufficient.
   */
  async respond(input: ProviderRespondInput): Promise<ProviderRespondOutput> {
    if (this.maxTokensPerCall !== undefined) {
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

    let response: unknown;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxOutputTokens,
        system: prompt.system,
        messages: prompt.messages,
      });
    } catch (err) {
      if (err instanceof ProviderErrorThrowable) {
        throw err;
      }
      throw new ProviderErrorThrowable(mapAnthropicError(err));
    }

    if (
      typeof response === 'object' &&
      response !== null &&
      (response as Record<string, unknown>).stop_reason === 'max_tokens'
    ) {
      throw new ProviderErrorThrowable({
        kind: 'output_truncated',
        message: `anthropic respond output truncated: stop_reason is 'max_tokens' (max_tokens: ${this.maxOutputTokens})`,
        requested_max_tokens: this.maxOutputTokens,
      });
    }

    const text = extractTextContent(response);
    const parsed = ProviderRespondOutputSchema.safeParse({ reply_markdown: text });
    if (!parsed.success) {
      throw new ProviderErrorThrowable({
        kind: 'schema_validation',
        message: 'anthropic respond output failed ProviderRespondOutput schema',
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
