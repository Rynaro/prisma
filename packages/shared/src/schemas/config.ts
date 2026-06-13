import { z } from 'zod';
import { CategorySchema, ModeSchema, SeveritySchema } from './finding.js';
import { ReviewGuidanceSchema } from './guidance.js';

/**
 * `.github/review-bot.yml` schema per docs/config-spec.md § Key reference.
 * Defaults match the OQ-2 resolutions verbatim:
 *   - mode = 'dry-run'
 *   - comment_cap.per_pr = 5
 *   - comment_cap.per_file = 1
 *   - severity_floor.inline = 'medium'
 *   - confidence_floor.inline = 0.7
 *   - provider = 'anthropic' (per OQ-1)
 *
 * Per docs/config-spec.md § Failure modes:
 *   - Unknown top-level keys are warn-and-ignore — schema uses non-strict outer
 *     object to honour the policy. See ConfigParseError handling in
 *     `packages/config/src/config-loader/parse.ts` for the warn surface.
 *   - Type mismatches on known keys reject the entire file.
 */

const ThresholdsSchema = z
  .object({
    severity_floor: z
      .object({
        inline: SeveritySchema.default('medium'),
      })
      .default({ inline: 'medium' }),
    confidence_floor: z
      .object({
        inline: z.number().min(0).max(1).default(0.7),
      })
      .default({ inline: 0.7 }),
  })
  .default({
    severity_floor: { inline: 'medium' },
    confidence_floor: { inline: 0.7 },
  });

const CommentCapSchema = z
  .object({
    per_pr: z.number().int().nonnegative().default(5),
    per_file: z.number().int().nonnegative().default(1),
  })
  .default({ per_pr: 5, per_file: 1 });

const PathRulesSchema = z
  .object({
    include: z.array(z.string().min(1)).default([]),
    exclude: z.array(z.string().min(1)).default([]),
  })
  .default({ include: [], exclude: [] });

const RepoHeuristicsSchema = z
  .object({
    security: z.boolean().default(true),
    tests: z.boolean().default(true),
    migrations: z.boolean().default(true),
    layering: z.boolean().default(true),
  })
  .default({ security: true, tests: true, migrations: true, layering: true });

// Per-category severity overrides. Keys must be members of the category vocabulary
// (config-spec.md § severity); values must be members of the severity vocabulary.
const SeverityOverridesSchema = z.record(CategorySchema, SeveritySchema).default({});

// `categories_enabled` defaults to the full category vocabulary
// (config-spec.md § categories_enabled).
const CategoriesEnabledSchema = z
  .array(CategorySchema)
  .default(['security', 'correctness', 'performance', 'tests', 'style', 'migration', 'dependency']);

/**
 * `chunking` configures the diff-chunking subsystem introduced in v0.7.0.
 *
 * When a PR is too large for a single provider call but within the chunkable
 * ceiling, the pipeline batches prefiltered files across multiple provider
 * calls, merges the findings, and runs the existing validator→ranker→publisher
 * chain once. Per docs/config-spec.md § chunking.
 *
 * Defaults:
 *   enabled                   true
 *   max_files                 200   (chunkable ceiling; above → oversized skip)
 *   max_changed_lines        12000  (chunkable ceiling; above → oversized skip)
 *   max_provider_calls_per_pr    6  (cost guard; exceeding → oversized skip)
 *   call_token_budget        60000  (per-call input token budget; greedy bin-pack)
 *
 * The existing top-level `max_files` (default 50) / `max_changed_lines`
 * (default 2000) remain the SINGLE-CALL threshold. Between the two sets of
 * limits → chunked review. Above `chunking.max_*` → oversized skip.
 */
export const ChunkingSchema = z
  .object({
    enabled: z.boolean().default(true),
    max_files: z.number().int().positive().default(200),
    max_changed_lines: z.number().int().positive().default(12000),
    max_provider_calls_per_pr: z.number().int().positive().default(6),
    call_token_budget: z.number().int().positive().default(60000),
  })
  .strict()
  .default({
    enabled: true,
    max_files: 200,
    max_changed_lines: 12000,
    max_provider_calls_per_pr: 6,
    call_token_budget: 60000,
  });

export type ChunkingConfig = z.infer<typeof ChunkingSchema>;

/**
 * `language_overrides` is a map from a language tag to an object whose shape is a
 * subset of this top-level configuration (config-spec.md § language_overrides).
 * For Phase 5.1 we accept any subset of the public top-level keys; the validator
 * for each override delegates to the same per-key rules (z.partial of the public
 * object surface). We model the override as a generic record of optional sub-keys
 * to avoid recursive schema definitions and keep the surface forward-compatible.
 */
const LanguageOverrideSchema = z
  .object({
    thresholds: ThresholdsSchema.optional(),
    comment_cap: CommentCapSchema.optional(),
    path_rules: PathRulesSchema.optional(),
    exclude_generated: z.boolean().optional(),
    exclude_vendored: z.boolean().optional(),
    max_files: z.number().int().positive().optional(),
    max_changed_lines: z.number().int().positive().optional(),
    categories_enabled: CategoriesEnabledSchema.optional(),
    severity: SeverityOverridesSchema.optional(),
    repo_heuristics: RepoHeuristicsSchema.optional(),
  })
  .strict();

const LanguageOverridesSchema = z.record(z.string().min(1), LanguageOverrideSchema).default({});

/**
 * Outer schema. Per config-spec.md § Failure modes, unknown top-level keys are
 * warn-and-ignore (NOT rejected). We therefore use the default (non-strict) Zod
 * object behaviour: unknown keys are stripped from the parsed result. The
 * "warn" half of "warn-and-ignore" is implemented by the loader, which compares
 * the raw parsed YAML keyset to the schema keyset.
 */
export const RepoConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: ModeSchema.default('dry-run'),
    provider: z.string().min(1).default('anthropic'),
    model: z.string().min(1).optional(),
    thresholds: ThresholdsSchema,
    comment_cap: CommentCapSchema,
    path_rules: PathRulesSchema,
    exclude_generated: z.boolean().default(true),
    exclude_vendored: z.boolean().default(true),
    max_files: z.number().int().positive().default(50),
    max_changed_lines: z.number().int().positive().default(2000),
    categories_enabled: CategoriesEnabledSchema,
    severity: SeverityOverridesSchema,
    language_overrides: LanguageOverridesSchema,
    repo_heuristics: RepoHeuristicsSchema,
    /**
     * User-customizable review guidance (global instructions, path-scoped
     * instructions, and context files to inject). All fields are optional;
     * absent key → empty defaults → today's behavior preserved byte-for-byte.
     * Per spec § D2: extends the existing .github/review-bot.yml schema.
     */
    review_guidance: ReviewGuidanceSchema,
    /**
     * Optional mention alias. When set, `@<nickname>` (or the configured
     * marker + nickname) in PR comments is treated as a mention of the bot in
     * addition to the real bot login. Must be login-shaped (alphanumeric +
     * hyphens, no leading hyphen, 1–39 chars).
     * Absent → today's behavior unchanged (real login only).
     * Per spec § Track 3: sibling of review_guidance.
     */
    nickname: z
      .string()
      .min(1)
      .max(39)
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/)
      .optional(),
    /**
     * Optional command marker character. Controls which prefix character the
     * bot recognises before the candidate login in PR comments.
     * Allowed values: `@` (default), `$`, `!`, `/`.
     * Using `$` is safe for unpaired leading markers; GitHub only renders
     * `$...$` pairs as math — a lone `$josie` at the start of a line is
     * rendered as plain text.
     * Per spec § configurable-command-marker.
     */
    command_marker: z.enum(['@', '$', '!', '/']).default('@'),
    /**
     * Diff-chunking configuration. Controls whether and how large PRs are
     * batched across multiple provider calls.
     * Per docs/config-spec.md § chunking.
     */
    chunking: ChunkingSchema,
  })
  .describe('Repo-local .github/review-bot.yml configuration');

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

/**
 * `DEFAULT_REPO_CONFIG` is produced by parsing an empty object through the schema
 * so defaults are derived from a single source of truth: the schema itself.
 * Regression-tested in `packages/shared/tests/schemas.test.ts`.
 */
export const DEFAULT_REPO_CONFIG: RepoConfig = RepoConfigSchema.parse({});
