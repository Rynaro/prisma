import { z } from 'zod';

/**
 * Hard caps for user-customizable review guidance.
 * Single source of truth — imported by config schema, augmentation resolver,
 * and prompt renderer. Per spec § Hard caps.
 */

/** Maximum number of path-scoped instruction entries. */
export const MAX_PATH_INSTRUCTIONS = 20;

/** Maximum bytes for a single instructions text block (global or per-path). */
export const MAX_INSTRUCTION_BLOCK_BYTES = 2048;

/** Maximum number of context_files entries. */
export const MAX_CONTEXT_FILES = 5;

/** Maximum bytes for a single fetched context file (truncate on UTF-8 boundary). */
export const MAX_CONTEXT_FILE_BYTES = 65536;

/**
 * Total token budget for all rendered guidance.
 * Uses the same Math.ceil(len/4) heuristic as the adapters.
 * 7500 << MAX_TOKENS_PER_PR/2 (30 000) so guidance can never evict the diff.
 */
export const MAX_AUGMENTATION_TOKENS = 7500;

// ---------------------------------------------------------------------------
// Sub-schemas used by RepoConfigSchema (config.ts) and ProviderReviewInput
// (provider.ts).
// ---------------------------------------------------------------------------

export const PathInstructionSchema = z
  .object({
    path: z.string().min(1),
    instructions: z.string().min(1).max(MAX_INSTRUCTION_BLOCK_BYTES),
  })
  .strict();
export type PathInstruction = z.infer<typeof PathInstructionSchema>;

export const ContextFileRefSchema = z
  .object({
    /** Repo-relative path; must not start with '/' or contain '..'. Validated in fetcher. */
    path: z.string().min(1),
  })
  .strict();
export type ContextFileRef = z.infer<typeof ContextFileRefSchema>;

export const ReviewGuidanceSchema = z
  .object({
    /** Optional global free-text review instructions. */
    instructions: z.string().min(1).max(MAX_INSTRUCTION_BLOCK_BYTES).optional(),
    /** Path-scoped instruction entries, matched via picomatch globs. */
    path_instructions: z.array(PathInstructionSchema).max(MAX_PATH_INSTRUCTIONS).default([]),
    /** Repo-relative paths to fetch and inject as reference material. */
    context_files: z.array(ContextFileRefSchema).max(MAX_CONTEXT_FILES).default([]),
  })
  .strict()
  .default({ path_instructions: [], context_files: [] });
export type ReviewGuidance = z.infer<typeof ReviewGuidanceSchema>;

// ---------------------------------------------------------------------------
// CustomGuidanceSchema — the resolved, pre-flattened form sent to providers.
// Providers never see globs or raw config; they receive ready-to-render text.
// ---------------------------------------------------------------------------

export const CustomGuidanceSchema = z
  .object({
    /** Global instructions (already capped/merged upstream). */
    instructions: z.string().min(1).optional(),
    /** path_instructions already matched against changed paths + flattened. */
    matched_path_instructions: z
      .array(z.object({ path: z.string().min(1), instructions: z.string().min(1) }).strict())
      .default([]),
    /** Context files already fetched, truncated, and labeled. */
    context_files: z
      .array(z.object({ path: z.string().min(1), content: z.string() }).strict())
      .default([]),
  })
  .strict();
export type CustomGuidance = z.infer<typeof CustomGuidanceSchema>;
