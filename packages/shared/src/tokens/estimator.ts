// estimator.ts - The single token estimator for the diff-chunking subsystem.
//
// Contract (chunking-stability-spec.md § 3):
//   - estimatePromptTokens(prompt, family) is THE single estimator. Both the
//     batcher (hot path) and the per-call adapter guard (boundary) call this
//     function over the EXACT serialized prompt. No other token math exists
//     after Phase 2.
//   - For cl100k / o200k: exact local count via js-tiktoken.
//   - For anthropic-approx: fast local heuristic (chars/4 x SAFETY_MARGIN)
//     that NEVER under-counts.
//   - serializeForEstimate(input) builds a SerializedPrompt by reusing the
//     SAME renderers the adapters use, guaranteeing estimator <-> wire agreement.
//
// Vendor isolation: this module lives in @prisma-bot/shared and imports ONLY
// js-tiktoken (a standalone tokenizer - no vendor SDK) and the shared prompt
// renderers. scripts/check-vendor-isolation.sh stays green.
//
// Performance: the tiktoken encoder is lazy-initialised once per process via a
// module-level cache map. Subsequent calls to estimatePromptTokens with the
// same family reuse the cached encoder at zero allocation cost.

import { getEncoding } from 'js-tiktoken';
import {
  FINDING_JSON_SCHEMA,
  IMMUTABLE_SYSTEM_PROMPT,
  TOOL_DESCRIPTION,
  renderCustomGuidance,
  renderUserMessage,
} from '../prompt/review-prompt.js';
import type { ProviderReviewInput } from '../schemas/provider.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Tokenizer family selector. Maps to the model's real tokenizer.
 * - cl100k: GPT-4 and earlier (gpt-4, gpt-3.5-turbo, copilot default).
 * - o200k: GPT-4o family / gpt-4.1 / o-series reasoning models (o1, o3, o4, gpt-5*).
 * - anthropic-approx: Anthropic Claude family (no local BPE; uses a
 *   conservative chars/4 x SAFETY_MARGIN heuristic).
 */
export type TokenizerFamily = 'cl100k' | 'o200k' | 'anthropic-approx';

/**
 * The exact serialized form of the prompt the adapter will send on the wire.
 * serializeForEstimate populates this from a ProviderReviewInput using the
 * SAME renderers the adapter uses, so the estimator and wire payload agree.
 */
export interface SerializedPrompt {
  /** The exact system prompt string the adapter will send. */
  system: string;
  /** The exact user-message string (line-numbered diff + rendered guidance). */
  user: string;
  /** The tool/JSON-schema payload the adapter will send, serialized. */
  tool: string;
}

// ---------------------------------------------------------------------------
// Shared tool schema (mirrors what adapters construct in their prompt.ts)
// ---------------------------------------------------------------------------

// The tool-input JSON schema sent on the wire (same shape for all adapters).
// We serialize it to a string once, then cache it — it never changes at
// runtime. This mirrors the per-adapter TOOL_INPUT_SCHEMA / TOOL_PARAMETERS_SCHEMA
// constants in packages/providers/*/src/prompt.ts.
const SHARED_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: FINDING_JSON_SCHEMA,
    },
  },
};

const SERIALIZED_TOOL_SCHEMA: string = JSON.stringify({
  name: 'submit_review_findings',
  description: TOOL_DESCRIPTION,
  schema: SHARED_TOOL_SCHEMA,
});

// ---------------------------------------------------------------------------
// Tiktoken lazy-init cache
// ---------------------------------------------------------------------------

// Safety margin for the anthropic-approx heuristic.
// 1.15 = 15% over the chars/4 baseline, matching the empirically observed
// "~15-25% larger than content-only" band from worker lines 60-63.
// Using 1.15 as the floor keeps the batcher conservative (never under-count).
export const SAFETY_MARGIN = 1.15;

type EncoderFamily = 'cl100k_base' | 'o200k_base';

const encoderCache = new Map<EncoderFamily, ReturnType<typeof getEncoding>>();

function getEncoder(family: EncoderFamily): ReturnType<typeof getEncoding> {
  const cached = encoderCache.get(family);
  if (cached !== undefined) return cached;
  const enc = getEncoding(family);
  encoderCache.set(family, enc);
  return enc;
}

// ---------------------------------------------------------------------------
// Core estimator
// ---------------------------------------------------------------------------

/**
 * THE single token estimator.
 *
 * Batcher (hot path) and per-call adapter guard BOTH call this function over
 * the EXACT serialized prompt. No other token math exists in Phase 2+.
 *
 * - For cl100k / o200k: exact local BPE count via js-tiktoken over the
 *   concatenated system+user+tool string.
 * - For anthropic-approx: ceil(chars/4 x SAFETY_MARGIN), rounded up. Never under-counts.
 *
 * @param prompt  - The serialized prompt built by serializeForEstimate.
 * @param family  - The tokenizer family for the active provider/model.
 * @returns       Number of tokens (always a positive integer).
 */
export function estimatePromptTokens(prompt: SerializedPrompt, family: TokenizerFamily): number {
  const text = `${prompt.system}\n${prompt.user}\n${prompt.tool}`;

  if (family === 'anthropic-approx') {
    // Fast local heuristic: chars / 4 x SAFETY_MARGIN, rounded up.
    return Math.ceil((text.length / 4) * SAFETY_MARGIN);
  }

  // Exact BPE count via js-tiktoken (cl100k_base for cl100k, o200k_base for o200k).
  const encoderName: EncoderFamily = family === 'o200k' ? 'o200k_base' : 'cl100k_base';
  const encoder = getEncoder(encoderName);
  return encoder.encode(text).length;
}

// ---------------------------------------------------------------------------
// Serialize helper
// ---------------------------------------------------------------------------

/**
 * Build a SerializedPrompt from a ProviderReviewInput using the SAME
 * renderers the adapters use. This is the single point where the estimator
 * and the wire payload are guaranteed to agree.
 *
 * Reuses:
 * - IMMUTABLE_SYSTEM_PROMPT (the exact shared system prompt)
 * - renderUserMessage(input) (byte-identical to all adapter prompt builders)
 * - renderCustomGuidance(input.custom_guidance) (guidance rendered as adapters do)
 * - SERIALIZED_TOOL_SCHEMA (the tool definition, serialized)
 *
 * Anchors: review-prompt.ts lines 36-51, 115-146, 166-207;
 *          anthropic/prompt.ts lines 46-63, openai/prompt.ts lines 50-68.
 *
 * @param input  - The ProviderReviewInput as it will be sent to the adapter.
 * @returns      A SerializedPrompt ready for estimatePromptTokens.
 */
export function serializeForEstimate(input: ProviderReviewInput): SerializedPrompt {
  const userMessage =
    renderUserMessage(input) + (renderCustomGuidance(input.custom_guidance) ?? '');
  return {
    system: IMMUTABLE_SYSTEM_PROMPT,
    user: userMessage,
    tool: SERIALIZED_TOOL_SCHEMA,
  };
}
