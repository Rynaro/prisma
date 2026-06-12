import { z } from 'zod';
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
  })
  .strict();
export type ProviderRequestShaping = z.infer<typeof ProviderRequestShapingSchema>;

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

export const ProviderReviewOutputSchema = z
  .object({
    findings: z.array(ProviderReviewOutputFindingSchema),
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
]);
export type ProviderError = z.infer<typeof ProviderErrorSchema>;

/**
 * `ProviderCapabilities` per ADR-002 § Interface contract: a typed bag describing
 * per-adapter capability presence (structured-output mode, function calling,
 * deterministic seed, max context).
 */
export const ProviderCapabilitiesSchema = z
  .object({
    structured_output: z.boolean(),
    function_calling: z.boolean(),
    deterministic_seed: z.boolean(),
    max_context_tokens: z.number().int().positive(),
  })
  .strict();
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

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
