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

// ---------------------------------------------------------------------------
// respond() — reviewer interaction (`@bot ask <message>`)
// Per docs/_planning/reviewer-interaction/spec.md § 6.
// ---------------------------------------------------------------------------

/**
 * Hard caps for the `respond()` provider entry. Single source of truth
 * (mirrors the `guidance.ts` cap convention) — imported by the GitHub
 * harvest helpers (`packages/github/src/interactions`) and the worker's
 * `ask` dispatch (`apps/github-app`) so every caller enforces the same
 * bounds. Per spec § 6 / § 7 step 6.
 */
export const MAX_RESPOND_FINDINGS = 20;
export const MAX_RESPOND_FINDING_BODY_BYTES = 500;
export const MAX_RESPOND_SUMMARY_BYTES = 4096;
export const MAX_RESPOND_THREAD_EXCHANGES = 10;
export const MAX_RESPOND_THREAD_BYTES = 8192;

/**
 * `RespondPrMeta` — the PR metadata carried on `ProviderRespondInput.pr`.
 * No pre-existing shared schema carries exactly this field set (title +
 * description together): `PrSnapshot` (snapshot.ts) has no title/description,
 * and the GitHub `PullsGetData` client shape (packages/github) is
 * vendor-adjacent, not a shared/provider-facing type. Declared fresh here per
 * spec § 6 (deviation noted: spec says "reuse existing PR meta shape" but no
 * such shape existed; this is the new canonical one going forward).
 */
export const RespondPrMetaSchema = z
  .object({
    title: z.string().min(1),
    /** PR body/description; empty string when the PR has no description. */
    description: z.string(),
    base_ref: z.string().min(1),
    head_ref: z.string().min(1),
    head_sha: z.string().min(1),
  })
  .strict();
export type RespondPrMeta = z.infer<typeof RespondPrMetaSchema>;

/**
 * A single harvested finding rendered into the `respond()` review context.
 * Field names per spec § 6 (`file`, not `path` — distinct from
 * `ProviderReviewOutputFinding` because it is sourced from an already-posted
 * inline comment, not a fresh provider output).
 */
export const RespondFindingSchema = z
  .object({
    file: z.string().min(1),
    line: z.number().int().positive(),
    severity: SeveritySchema,
    category: CategorySchema,
    title: z.string().min(1),
    body: z.string().min(1),
  })
  .strict();
export type RespondFinding = z.infer<typeof RespondFindingSchema>;

/**
 * A prior exchange within the current review round's interaction thread.
 * `question` is the developer's original `ask` message; `reply_markdown` is
 * the reviewer's previously-posted reply. Oldest→newest ordering is a
 * contract of the array position, not a field on this schema.
 */
export const RespondExchangeSchema = z
  .object({
    author_login: z.string().min(1),
    question: z.string().min(1),
    reply_markdown: z.string().min(1),
  })
  .strict();
export type RespondExchange = z.infer<typeof RespondExchangeSchema>;

/**
 * `ProviderRespondInput` — vendor-neutral input to `Provider.respond()`.
 * Per spec § 6:
 *   - `review_context` carries the latest published round's findings +
 *     check-run summary (both byte-capped by the caller before this schema
 *     is constructed — see `MAX_RESPOND_*` above).
 *   - `thread` carries prior exchanges THIS round, oldest→newest; empty on
 *     the first interaction of a round, or whenever `max_per_review <= 1`
 *     (spec § 7 step 6 — thread context is only assembled when more than one
 *     message is allowed per round).
 *   - `guidance` mirrors `config.review_guidance.instructions` when set.
 */
export const ProviderRespondInputSchema = z
  .object({
    pr: RespondPrMetaSchema,
    review_context: z
      .object({
        round: z.number().int().positive(),
        summary_markdown: z.string(),
        findings: z.array(RespondFindingSchema).max(MAX_RESPOND_FINDINGS),
      })
      .strict(),
    thread: z.array(RespondExchangeSchema).max(MAX_RESPOND_THREAD_EXCHANGES),
    message: z
      .object({
        author_login: z.string().min(1),
        text: z.string().min(1),
      })
      .strict(),
    guidance: z.string().min(1).optional(),
    generation: GenerationSchema.optional(),
  })
  .strict();
export type ProviderRespondInput = z.infer<typeof ProviderRespondInputSchema>;

/**
 * `ProviderRespondOutput` — non-empty markdown reply. The worker truncates
 * to the 64 KiB issue-comment ceiling before posting (spec § 7 step 7).
 */
export const ProviderRespondOutputSchema = z
  .object({
    reply_markdown: z.string().min(1),
  })
  .strict();
export type ProviderRespondOutput = z.infer<typeof ProviderRespondOutputSchema>;

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
