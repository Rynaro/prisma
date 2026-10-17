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
  isClaudeAdaptiveThinkingModel,
  parseClaudeModelId,
  serializeForEstimate,
} from '@prisma-bot/shared';
import { createAnthropicClient } from './client.js';
import { mapAnthropicError } from './error-mapping.js';
import { buildPrompt, toAnthropicStrictSchema } from './prompt.js';

/**
 * `ANTHROPIC_PROVIDER_NAME` is kept as a top-level constant for backward
 * compatibility with phase-4 references. The instance's `name` field is the
 * canonical source of truth.
 */
export const ANTHROPIC_PROVIDER_NAME = 'anthropic';

// ---------------------------------------------------------------------------
// Module-level constants. DECLARATION ORDER MATTERS: `DEFAULT_CAPABILITIES`
// below calls the resolvers at module load, so everything they read must be
// declared above it (a later `const` would hit the temporal dead zone).
// ---------------------------------------------------------------------------

/** Claude 4.5 and older, and unknown IDs (ADR-009 D6). */
export const ANTHROPIC_CONTEXT_WINDOW_DEFAULT = 200_000;
/** Claude 4.6+ and every 5.x (ADR-009 D6). */
export const ANTHROPIC_CONTEXT_WINDOW_LONG = 1_000_000;

/** Default output cap for Claude 4.x and older / aliases (the historical value). */
export const ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS = 4096;
/** Default output cap when adaptive thinking is on (thinking counts toward `max_tokens`; ADR-009 D5). */
export const ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS_THINKING = 16_384;

/** Tokenizer VOCABULARY rule only (version-first Claude IDs); never decides routing (ADR-009 G-2). */
const CLAUDE_VERSION_FIRST_RE = /claude-\d/i;

const REFUSAL_CATEGORY_RE = /^[a-z0-9_]{1,64}$/;

/** Appended to `system` on the unforced path only (ADR-009 D1). */
export const ANTHROPIC_TOOL_NUDGE =
  '\n\nAnalyze the diff thoroughly, then call submit_review_findings exactly once with every real finding; use an empty findings array only if there are genuinely no issues. Your answer is read only from that tool call; plain text is discarded.';

/** Keys the `provider_options.anthropic` bag can never set (ADR-009 D4). */
export const ANTHROPIC_PASSTHROUGH_DENYLIST: ReadonlySet<string> = new Set([
  'model',
  'messages',
  'system',
  'tools',
  'tool_choice',
  'stream', // Prisma-managed
  'betas',
  'mcp_servers',
  'container', // data boundary / header smuggling
  'fallbacks', // spend routing (D9)
]);
/** Nested `output_config` keys the bag can never set. */
export const ANTHROPIC_OUTPUT_CONFIG_DENYLIST: ReadonlySet<string> = new Set(['format']);

/**
 * Default model identifier. Centralized so it can be swapped in one place.
 * Model selection is treated as configuration, not as a vendor type.
 */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-3-5-sonnet-latest';

/** `ANTHROPIC_TOOL_CHOICE` values. `auto` = use the per-model rule (ADR-009 R1). */
export type AnthropicToolChoiceStyle = 'auto' | 'forced' | 'unforced';
export type AnthropicToolChoiceMode = 'forced' | 'unforced';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `true` when the repo bag turns thinking on (`thinking.type` adaptive | enabled). */
export function providerOptionsEnableThinking(bag: Record<string, unknown> | undefined): boolean {
  if (bag === undefined) return false;
  const thinking = bag.thinking;
  if (!isPlainObject(thinking)) return false;
  return thinking.type === 'adaptive' || thinking.type === 'enabled';
}

/**
 * Resolve forced vs unforced tool choice (ADR-009 D1). Explicit env style wins;
 * otherwise Claude 5.x IDs (via the shared parser) or a bag that enables
 * thinking get `unforced`; everything else keeps today's forced bytes.
 */
export function resolveAnthropicToolChoiceMode(
  model: string,
  bag: Record<string, unknown> | undefined,
  style: AnthropicToolChoiceStyle = 'auto',
): AnthropicToolChoiceMode {
  if (style === 'forced') return 'forced';
  if (style === 'unforced') return 'unforced';
  return isClaudeAdaptiveThinkingModel(model) || providerOptionsEnableThinking(bag)
    ? 'unforced'
    : 'forced';
}

/** Default `max_tokens` for a model + repo bag (ADR-009 D5; single source for adapter and worker, G-8). */
export function resolveAnthropicDefaultMaxOutputTokens(
  model: string,
  bag?: Record<string, unknown>,
): number {
  return isClaudeAdaptiveThinkingModel(model) || providerOptionsEnableThinking(bag)
    ? ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS_THINKING
    : ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS;
}

/** Context window per model ID (ADR-009 D6): 1M for Claude 4.6+ and 5.x, else 200K. */
export function resolveAnthropicContextWindow(model: string): number {
  const parsed = parseClaudeModelId(model);
  if (
    parsed !== undefined &&
    (parsed.major >= 5 || (parsed.major === 4 && parsed.minor !== undefined && parsed.minor >= 6))
  ) {
    return ANTHROPIC_CONTEXT_WINDOW_LONG;
  }
  return ANTHROPIC_CONTEXT_WINDOW_DEFAULT;
}

/**
 * Token-estimator family per model ID (ADR-009 D7). Claude 5.x and Opus 4.7+
 * use the newer tokenizer (`anthropic-approx-v2`); unknown aliases over-count
 * (the safe direction); version-first IDs (Claude 3.x) keep the legacy family.
 */
export function resolveAnthropicTokenizerFamily(model: string): TokenizerFamily {
  const parsed = parseClaudeModelId(model);
  if (parsed !== undefined) {
    if (parsed.major >= 5) return 'anthropic-approx-v2';
    if (parsed.family === 'opus' && parsed.major === 4 && (parsed.minor ?? 0) >= 7) {
      return 'anthropic-approx-v2';
    }
    return 'anthropic-approx';
  }
  return CLAUDE_VERSION_FIRST_RE.test(model) ? 'anthropic-approx' : 'anthropic-approx-v2';
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  structured_output: true,
  function_calling: true,
  deterministic_seed: false,
  max_context_tokens: resolveAnthropicContextWindow(ANTHROPIC_DEFAULT_MODEL),
  /**
   * Anthropic does not provide a local BPE tokenizer. The estimator uses a
   * fast chars/4 × margin heuristic (never under-counts); the family is
   * resolved per model (ADR-009 D7).
   * Per chunking-stability-spec.md § Phase 2 "Provider capabilities".
   */
  tokenizer_family: resolveAnthropicTokenizerFamily(ANTHROPIC_DEFAULT_MODEL),
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
  /**
   * `ANTHROPIC_TOOL_CHOICE`: `auto` (default; per-model rule), `forced` or
   * `unforced` (ADR-009 D1).
   */
  toolChoiceStyle?: AnthropicToolChoiceStyle;
  /**
   * Called once per `review()` API call with token counts (never content).
   * Exceptions are swallowed (ADR-009 D13).
   */
  onUsage?: (usage: AnthropicUsageTelemetry) => void;
}

/** Token telemetry for one `messages.create` call (ADR-009 D13). Counts only. */
export interface AnthropicUsageTelemetry {
  endpoint: 'messages';
  /** The model sent (after `request_shaping.model`). */
  model: string;
  /** `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` (total prompt). */
  input_tokens?: number;
  /** Includes thinking tokens. */
  output_tokens?: number;
  /** `cache_read_input_tokens`. */
  cached_input_tokens?: number;
  /** `cache_creation_input_tokens`. */
  cache_write_tokens?: number;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const v = record[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Tolerant usage extraction (ADR-009 D13): a field is present only when its
 * source is a number; null/absent values are omitted, never zero-filled.
 */
export function extractAnthropicUsage(response: unknown, model: string): AnthropicUsageTelemetry {
  const out: AnthropicUsageTelemetry = { endpoint: 'messages', model };
  if (!isPlainObject(response)) return out;
  const usage = response.usage;
  if (!isPlainObject(usage)) return out;
  const input = numberField(usage, 'input_tokens');
  const cacheRead = numberField(usage, 'cache_read_input_tokens');
  const cacheWrite = numberField(usage, 'cache_creation_input_tokens');
  const output = numberField(usage, 'output_tokens');
  if (input !== undefined) {
    out.input_tokens = input + (cacheRead ?? 0) + (cacheWrite ?? 0);
  }
  if (output !== undefined) out.output_tokens = output;
  if (cacheRead !== undefined) out.cached_input_tokens = cacheRead;
  if (cacheWrite !== undefined) out.cache_write_tokens = cacheWrite;
  return out;
}

/**
 * Merge the repo's `provider_options.anthropic` bag into the request (ADR-009
 * D3/D4). Works on a shallow copy; never mutates `args` or `bag`. Denylisted
 * keys are dropped with a KEY-ONLY note (G-1). A flat `effort` maps to
 * `output_config.effort` (a native `output_config.effort` wins). Everything
 * else is forwarded verbatim.
 */
export function applyAnthropicProviderOptions(
  args: Record<string, unknown>,
  bag: Record<string, unknown>,
): { args: Record<string, unknown>; droppedNotes: string[] } {
  const droppedNotes: string[] = [];
  const merged: Record<string, unknown> = { ...args };
  let held: { value: unknown } | undefined;
  for (const [k, v] of Object.entries(bag)) {
    if (ANTHROPIC_PASSTHROUGH_DENYLIST.has(k)) {
      droppedNotes.push(`provider_options.anthropic.${k} ignored (Prisma-managed field)`);
      continue;
    }
    if (k === 'effort') {
      held = { value: v };
      continue;
    }
    if (k === 'output_config' && isPlainObject(v)) {
      const copy: Record<string, unknown> = {};
      for (const [ok, ov] of Object.entries(v)) {
        if (ANTHROPIC_OUTPUT_CONFIG_DENYLIST.has(ok)) {
          droppedNotes.push(
            `provider_options.anthropic.output_config.${ok} ignored (Prisma-managed field)`,
          );
          continue;
        }
        copy[ok] = ov;
      }
      merged[k] = copy;
      continue;
    }
    merged[k] = v;
  }
  if (held !== undefined) {
    const current = merged.output_config;
    if (current === undefined) {
      merged.output_config = { effort: held.value };
    } else if (isPlainObject(current) && !('effort' in current)) {
      merged.output_config = { ...current, effort: held.value };
    } else {
      droppedNotes.push('provider_options.anthropic.effort ignored (output_config.effort is set)');
    }
  }
  return { args: merged, droppedNotes };
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

type ToolUseLookup = { found: true; input: unknown } | { found: false };

function findToolUseInput(response: unknown, toolName: string): ToolUseLookup {
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
      return { found: true, input: block.input };
    }
  }
  return { found: false };
}

function readStopReason(response: unknown): unknown {
  return isPlainObject(response) ? response.stop_reason : undefined;
}

/** Sanitized refusal category (R6); `stop_details` may be null; `explanation` is never read (G-1). */
function readRefusalCategory(response: unknown): string {
  if (!isPlainObject(response)) return 'none';
  const details = response.stop_details;
  if (!isPlainObject(details)) return 'none';
  const category = details.category;
  return typeof category === 'string' && REFUSAL_CATEGORY_RE.test(category) ? category : 'none';
}

function refusalError(response: unknown): ProviderErrorThrowable {
  return new ProviderErrorThrowable({
    kind: 'schema_validation',
    code: 'refusal',
    message: `anthropic declined the request: stop_reason refusal (category: ${readRefusalCategory(response)})`,
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
  private readonly explicitMaxOutputTokens: number | undefined;
  private readonly toolChoiceStyle: AnthropicToolChoiceStyle;
  private readonly onUsage: ((usage: AnthropicUsageTelemetry) => void) | undefined;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model ?? ANTHROPIC_DEFAULT_MODEL;
    const base = options.capabilities ?? DEFAULT_CAPABILITIES;
    this.capabilities = {
      ...base,
      max_context_tokens:
        options.capabilities?.max_context_tokens ?? resolveAnthropicContextWindow(this.model),
      tokenizer_family:
        options.capabilities?.tokenizer_family ?? resolveAnthropicTokenizerFamily(this.model),
    };
    this.maxTokensPerCall = options.maxTokensPerCall;
    this.explicitMaxOutputTokens = options.maxOutputTokens;
    this.toolChoiceStyle = options.toolChoiceStyle ?? 'auto';
    this.onUsage = options.onUsage;
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
    // 1. Resolve the request (ADR-009 § 3.18).
    const shaping = input.request_shaping;
    const model = shaping?.model ?? this.model;
    const rawBag = shaping?.provider_options;
    const bag = isPlainObject(rawBag) ? rawBag : undefined;
    const generation = shaping?.generation;
    const mode = resolveAnthropicToolChoiceMode(model, bag, this.toolChoiceStyle);
    const bagMax = bag?.max_tokens;
    const effectiveCap =
      typeof bagMax === 'number' && Number.isInteger(bagMax) && bagMax > 0
        ? bagMax
        : (generation?.max_output_tokens ??
          this.explicitMaxOutputTokens ??
          resolveAnthropicDefaultMaxOutputTokens(model, bag));

    // 2. Guard.
    if (this.maxTokensPerCall !== undefined) {
      // Phase 2: unified estimator — counts the SAME serialized prompt the
      // batcher counts, eliminating the HOTSPOT-2/HOTSPOT-6 divergence.
      // Phase 4: throws `over_budget` (not `capability/cost_ceiling`) so the
      // orchestrator's discriminator is a single `kind === 'over_budget'` check
      // and the batch degrades (split/skip) instead of aborting the PR.
      // ADR-009 D6/D7: the input cap also leaves room for the output, and the
      // window/tokenizer are those of the model this request actually uses.
      const window =
        model === this.model
          ? this.capabilities.max_context_tokens
          : resolveAnthropicContextWindow(model);
      const family =
        model === this.model
          ? this.capabilities.tokenizer_family
          : resolveAnthropicTokenizerFamily(model);
      const guardCap = Number.isFinite(this.maxTokensPerCall)
        ? this.maxTokensPerCall
        : Number.POSITIVE_INFINITY;
      const inputCap = Math.min(guardCap, window - effectiveCap);
      const estimate = estimatePromptTokens(serializeForEstimate(input), family);
      if (estimate > inputCap) {
        throw new ProviderErrorThrowable({
          kind: 'over_budget',
          estimated_tokens: estimate,
          hard_cap_in: inputCap,
          message: `request exceeds per-call token budget: estimated ${estimate} tokens, cap ${inputCap}`,
        });
      }
    }

    // 3. Build the request for the mode (key order is part of the contract).
    const prompt = buildPrompt(input);
    let args: Record<string, unknown> =
      mode === 'unforced'
        ? {
            model,
            max_tokens: effectiveCap,
            system: prompt.system + ANTHROPIC_TOOL_NUDGE,
            messages: prompt.messages,
            tools: [
              {
                name: prompt.tool.name,
                description: prompt.tool.description,
                input_schema: toAnthropicStrictSchema(prompt.tool.input_schema),
                strict: true,
              },
            ],
            tool_choice: { type: 'auto', disable_parallel_tool_use: true },
          }
        : {
            model,
            max_tokens: effectiveCap,
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
          };
    if (bag !== undefined) {
      // Dropped-key notes are key-only and stay local (G-1); nothing surfaces them yet.
      args = applyAnthropicProviderOptions(args, bag).args;
    }

    // 4. Attempt loop: one identical retry, unforced path only, only on a missing tool call (G-9).
    const maxAttempts = mode === 'unforced' ? 2 : 1;
    let toolInput: unknown;
    for (let attempt = 1; ; attempt++) {
      let response: unknown;
      try {
        response = await this.client.messages.create(args);
      } catch (err) {
        if (err instanceof ProviderErrorThrowable) {
          throw err;
        }
        throw new ProviderErrorThrowable(mapAnthropicError(err));
      }

      this.reportUsage(response, model);

      // Refusal (HTTP 200, stop_reason 'refusal'): partial content is discarded, never retried.
      if (readStopReason(response) === 'refusal') {
        throw refusalError(response);
      }

      // Detect response truncation: stop_reason==='max_tokens' means the model hit
      // the output token cap and the output may be a partial/invalid findings array.
      // Throw output_truncated so the orchestrator can split-and-retry instead of
      // dropping the batch's findings (chunking-stability-spec.md § Phase 1).
      if (readStopReason(response) === 'max_tokens') {
        throw new ProviderErrorThrowable({
          kind: 'output_truncated',
          message: `anthropic response truncated: stop_reason is 'max_tokens' (max_tokens: ${effectiveCap})`,
          requested_max_tokens: effectiveCap,
        });
      }

      const found = findToolUseInput(response, prompt.tool.name);
      if (found.found) {
        toolInput = found.input;
        break;
      }
      if (attempt < maxAttempts) {
        continue;
      }
      throw new ProviderErrorThrowable({
        kind: 'schema_validation',
        message:
          mode === 'unforced'
            ? `anthropic response did not call '${prompt.tool.name}' (tool_choice auto) after 1 retry`
            : `anthropic response missing tool_use block for tool '${prompt.tool.name}'`,
      });
    }

    // 5. Zod stays authoritative.
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

  private reportUsage(response: unknown, model: string): void {
    if (this.onUsage === undefined) return;
    try {
      this.onUsage(extractAnthropicUsage(response, model));
    } catch {
      // Telemetry must never fail a review.
    }
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
    const cap = this.explicitMaxOutputTokens ?? resolveAnthropicDefaultMaxOutputTokens(this.model);

    let response: unknown;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: cap,
        system: prompt.system,
        messages: prompt.messages,
      });
    } catch (err) {
      if (err instanceof ProviderErrorThrowable) {
        throw err;
      }
      throw new ProviderErrorThrowable(mapAnthropicError(err));
    }

    if (readStopReason(response) === 'refusal') {
      throw refusalError(response);
    }

    if (readStopReason(response) === 'max_tokens') {
      throw new ProviderErrorThrowable({
        kind: 'output_truncated',
        message: `anthropic respond output truncated: stop_reason is 'max_tokens' (max_tokens: ${cap})`,
        requested_max_tokens: cap,
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

export {
  ANTHROPIC_STRICT_SCHEMA_KEYWORDS,
  buildPrompt,
  toAnthropicStrictSchema,
} from './prompt.js';
export type { PromptShape } from './prompt.js';
export { mapAnthropicError } from './error-mapping.js';
export { createAnthropicClient } from './client.js';
export type { CreateAnthropicClientOptions } from './client.js';
