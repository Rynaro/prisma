import { z } from 'zod';
import type { TokenizerFamily } from '../tokens/estimator.js';
import { GenerationSchema } from './config.js';
import { CategorySchema, SeveritySchema } from './finding.js';
import { CustomGuidanceSchema } from './guidance.js';

/**
 * Per ADR-002 § Interface contract (sketch) and api-contracts.md § Provider adapter
 * contract: `ProviderReviewInput` carries normalized diff context plus a request-shaping
 * section (model selection, capability hints, deterministic seed where supported).
 *
 * Phase 4 declared the field-by-field shape as future work; for Phase 5.1 we keep the
 * surface narrow and forward-compatible (closed at the outer level via .strict()).
 */

export const HunkSchema = z
  .object({
    id: z.string().min(1),
    line_start: z.number().int().positive(),
    line_end: z.number().int().positive(),
    content: z.string(),
  })
  .strict();
export type Hunk = z.infer<typeof HunkSchema>;

export const PrefilteredFileSchema = z
  .object({
    path: z.string().min(1),
    language: z.string().min(1).optional(),
    hunks: z.array(HunkSchema),
  })
  .strict();
export type PrefilteredFile = z.infer<typeof PrefilteredFileSchema>;

export const ProviderRequestShapingSchema = z
  .object({
    model: z.string().min(1).optional(),
    deterministic_seed: z.number().int().optional(),
    capability_hints: z.array(z.string().min(1)).optional(),
    /**
     * Normalized generation settings forwarded from `config.generation`.
     * The orchestrator maps `config.generation.seed` → `deterministic_seed`
     * (single seed source) before building this bag, so `generation.seed`
     * is NOT re-read by the adapter.
     *
     * Spec: docs/_planning/config-dx/spec.md § 5.2, § 5.4.
     */
    generation: GenerationSchema.optional(),
    /**
     * Already-narrowed raw passthrough bag for the ACTIVE provider only.
     * The orchestrator selects `config.provider_options[activeProvider]`
     * and places it here so the adapter never needs to know its own slug
     * or key into the full provider-options map (prevents cross-vendor
     * leakage at the boundary).
     *
     * Values are arbitrary (`unknown`); the denylist is enforced in the
     * adapter before the keys reach the wire.
     *
     * G7: NEVER log any value from this bag.
     * Spec: docs/_planning/config-dx/spec.md § 5.2, § 3.7.
     */
    provider_options: z.record(z.string().min(1), z.unknown()).optional(),
  })
  .strict();
export type ProviderRequestShaping = z.infer<typeof ProviderRequestShapingSchema>;

/**
 * Presence == enabled. Absence => zero prompt bytes, zero tool-schema bytes.
 * Per spec § A.3 (positive feedback / highlights).
 */
export const PositiveFeedbackRequestSchema = z
  .object({ max_items: z.number().int().min(1).max(5) })
  .strict();
export type PositiveFeedbackRequest = z.infer<typeof PositiveFeedbackRequestSchema>;

export const ProviderReviewInputSchema = z
  .object({
    files: z.array(PrefilteredFileSchema),
    repo_heuristics: z.record(z.string(), z.boolean()).optional(),
    request_shaping: ProviderRequestShapingSchema.optional(),
    /**
     * Resolved, pre-flattened custom guidance from `.github/review-bot.yml`.
     * Absent when no guidance is configured → zero-config behavior is
     * byte-identical to today. Injected by the orchestrator after augmentation
     * resolution; never constructed by providers themselves (they render it).
     */
    custom_guidance: CustomGuidanceSchema.optional(),
    /**
     * Present only when the repo enabled `positive_feedback`. Absent when the
     * feature is not configured → zero-config behavior is byte-identical to
     * today (prompt bytes and tool schema unchanged).
     */
    positive_feedback: PositiveFeedbackRequestSchema.optional(),
  })
  .strict();
export type ProviderReviewInput = z.infer<typeof ProviderReviewInputSchema>;

/**
 * `ProviderReviewOutput` finding fields per ADR-002 § Output schema:
 * `path`, `line`, `severity`, `category`, `message`, `rationale`, `confidence`.
 * Optional `suggested_fix` is mapped through to `NormalizedFinding.suggested_fix`
 * (review-findings-schema.md § Mapping table).
 */
export const ProviderReviewOutputFindingSchema = z
  .object({
    path: z.string().min(1),
    line: z.number().int().positive(),
    severity: SeveritySchema,
    category: CategorySchema,
    message: z.string().min(1),
    rationale: z.string().min(1),
    confidence: z.number().min(0).max(1),
    suggested_fix: z.string().min(1).optional(),
  })
  .strict();
export type ProviderReviewOutputFinding = z.infer<typeof ProviderReviewOutputFindingSchema>;

/**
 * A provider-reported "good decision" in the diff. Deliberately NOT a finding:
 * no line anchor, no severity, no category. `path`, when present, MUST be one
 * of the input files (enforced by the validator, not by this schema).
 */
export const ProviderReviewOutputHighlightSchema = z
  .object({
    path: z.string().min(1).optional(),
    message: z.string().min(1),
    rationale: z.string().min(1),
  })
  .strict();
export type ProviderReviewOutputHighlight = z.infer<typeof ProviderReviewOutputHighlightSchema>;

export const ProviderReviewOutputSchema = z
  .object({
    findings: z.array(ProviderReviewOutputFindingSchema),
    /** Present only when the repo enabled `positive_feedback`; ignored otherwise. */
    highlights: z.array(ProviderReviewOutputHighlightSchema).optional(),
  })
  .strict();
export type ProviderReviewOutput = z.infer<typeof ProviderReviewOutputSchema>;

/**
 * `ProviderError` discriminated union per `api-contracts.md` § Provider adapter contract
 * and `system-design.md` § Error taxonomy mapping. Variants:
 *   transport | auth | rate_limit | capability | schema_validation.
 *
 * Mapping to retry classes (system-design.md § Error taxonomy mapping):
 *   transport, rate_limit  → retried (Transient, Rate-limited)
 *   auth, capability, schema_validation  → non-transient → failed_terminal
 */
const ProviderErrorBase = {
  message: z.string().min(1),
  retryable: z.boolean().optional(),
};

export const ProviderErrorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('transport'),
      ...ProviderErrorBase,
    })
    .strict(),
  z
    .object({
      kind: z.literal('auth'),
      ...ProviderErrorBase,
    })
    .strict(),
  z
    .object({
      kind: z.literal('rate_limit'),
      retry_after_ms: z.number().int().nonnegative().optional(),
      ...ProviderErrorBase,
    })
    .strict(),
  z
    .object({
      kind: z.literal('capability'),
      missing_capability: z.string().min(1).optional(),
      ...ProviderErrorBase,
    })
    .strict(),
  z
    .object({
      kind: z.literal('schema_validation'),
      zod_issues: z.array(z.string()).optional(),
      ...ProviderErrorBase,
    })
    .strict(),
  z
    .object({
      kind: z.literal('output_truncated'),
      /**
       * The `max_tokens` value that was in effect when the output was truncated.
       * Carried from the adapter so the orchestrator can log/display it and the
       * split-and-retry path can make informed decisions.
       */
      requested_max_tokens: z.number().int().positive(),
      ...ProviderErrorBase,
    })
    .strict(),
  z
    .object({
      kind: z.literal('over_budget'),
      /**
       * The estimated prompt token count that triggered the guard.
       * Carried from the adapter so the orchestrator can log/display it and
       * make informed split decisions (Phase 4: degrade-not-abort).
       *
       * Per chunking-stability-spec.md § Phase 4 "New degradable error kind".
       */
      estimated_tokens: z.number().int().positive(),
      /**
       * The hard_cap_in value that was in effect when the guard fired.
       * Allows the orchestrator to diagnose and possibly split the batch.
       */
      hard_cap_in: z.number().int().positive(),
      ...ProviderErrorBase,
    })
    .strict(),
]);
export type ProviderError = z.infer<typeof ProviderErrorSchema>;

/**
 * `ProviderCapabilities` per ADR-002 § Interface contract: a typed bag describing
 * per-adapter capability presence (structured-output mode, function calling,
 * deterministic seed, max context).
 *
 * `tokenizer_family` (Phase 2): the tokenizer family to use when estimating
 * prompt tokens for this adapter's model. The orchestrator reads this to pick
 * the correct `TokenizerFamily` for `estimatePromptTokens` and `planBatches`.
 *   - anthropic adapters → `'anthropic-approx'`
 *   - openai adapters → `'o200k'` or `'cl100k'` per model family
 *   - copilot adapters → `'cl100k'`
 *
 * Per chunking-stability-spec.md § Phase 2 "Provider capabilities".
 */
export const ProviderCapabilitiesSchema = z
  .object({
    structured_output: z.boolean(),
    function_calling: z.boolean(),
    deterministic_seed: z.boolean(),
    max_context_tokens: z.number().int().positive(),
    /**
     * Tokenizer family for accurate prompt-token estimation (Phase 2).
     * Used by `estimatePromptTokens` in `@prisma-bot/shared/tokens/estimator`.
     */
    tokenizer_family: z.enum(['cl100k', 'o200k', 'anthropic-approx']),
  })
  .strict();
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

// Re-export TokenizerFamily so it's available via the schemas barrel.
export type { TokenizerFamily };

/**
 * `ProviderErrorThrowable` is the concrete `Error` subclass adapters throw.
 *
 * `ProviderError` is the validated shape of the failure value (a discriminated
 * union); JavaScript still requires an `Error` instance to be thrown. Adapters
 * (e.g. `packages/providers/anthropic`, `packages/providers/fake`) construct a
 * `ProviderErrorThrowable` from a validated `ProviderError` value and throw it.
 *
 * The pipeline catches `ProviderErrorThrowable` and reads `.value` to switch on
 * `kind`. No vendor SDK exception type ever escapes the adapter boundary
 * (api-contracts.md § Provider adapter contract; ADR-002 § Decision).
 */
export class ProviderErrorThrowable extends Error {
  readonly cause_kind: ProviderError['kind'];
  readonly value: ProviderError;
  constructor(value: ProviderError) {
    super(`${value.kind}: ${value.message}`);
    this.name = 'ProviderErrorThrowable';
    this.cause_kind = value.kind;
    this.value = value;
  }
}
