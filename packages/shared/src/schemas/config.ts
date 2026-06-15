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
 * `GenerationSchema` — vendor-neutral normalized generation settings.
 *
 * These are the ~5 settings that every major LLM API supports under different
 * names. The adapter translates each key to the vendor's dialect so operators
 * never need to know which vendor calls it `max_tokens` vs.
 * `max_completion_tokens` (design.md P2/P6).
 *
 * Defaults: all absent → today's behavior preserved byte-for-byte (AS-11).
 *
 * Validation ranges (spec OQ-6):
 *   temperature  [0, 2]  — cross-vendor range; users wanting exotic values use
 *                          provider_options (the escape hatch).
 *   top_p        [0, 1]
 *   seed         integer (no range cap — each vendor limits differently)
 *   max_output_tokens  positive integer
 *
 * Non-strict: uses the default Zod `.strip` behavior (consistent with the
 * outer RepoConfigSchema warn-and-ignore policy; generation is a
 * forward-compat surface).  The "warn" half is implemented by the config-
 * loader's keyset-diff.  This diverges from ChunkingSchema (.strict()) because
 * chunking has a fully-known, closed key set whereas generation is intended to
 * grow as new normalized settings are added.
 *
 * Spec: docs/_planning/config-dx/spec.md § 5.1 (GenerationSchema).
 */
export const GenerationSchema = z
  .object({
    /**
     * Output token budget. Adapter translates to `max_tokens` (classic models)
     * or `max_completion_tokens` (gpt-5*, o-series) via `resolveTokenParam`.
     * Overrides `OPENAI_MAX_OUTPUT_TOKENS` env default when set.
     */
    max_output_tokens: z.number().int().positive().optional(),
    /**
     * Sampling temperature. Cross-vendor range [0, 2]. Values outside this
     * range reject the file (schema_violation). For vendor-specific exotic
     * ranges use provider_options.
     */
    temperature: z.number().min(0).max(2).optional(),
    /**
     * Nucleus sampling probability. Range [0, 1].
     */
    top_p: z.number().min(0).max(1).optional(),
    /**
     * Reproducibility seed (integer). Threaded into
     * `request_shaping.deterministic_seed` by the orchestrator (single seed
     * source — the adapter does not read `generation.seed` directly).
     */
    seed: z.number().int().optional(),
  })
  .default({});

export type GenerationConfig = z.infer<typeof GenerationSchema>;

/**
 * `ProviderOptionsSchema` — raw vendor passthrough map keyed by provider slug.
 *
 * Each inner bag is forwarded untouched to the active provider's request body,
 * minus a denylist of Prisma-critical fields (spec § 3.7).  Keys and values
 * are arbitrary — this is the forward-compat escape hatch for brand-new model
 * knobs (design.md P3/P5).
 *
 * Only the sub-bag keyed by the active provider's slug is applied; other
 * slugs' bags are silently ignored at apply time (AS-10, G9).  Unknown slug
 * keys are simply never read — forward-compat by construction.
 *
 * G7: `provider_options` values are forwarded into the request body only and
 * are NEVER logged.  The `configuration` reply echoes keys only (OQ-7).
 *
 * Spec: docs/_planning/config-dx/spec.md § 5.1 (ProviderOptionsSchema), § 3.7.
 */
export const ProviderOptionsSchema = z
  .record(z.string().min(1), z.record(z.string().min(1), z.unknown()))
  .default({});

export type ProviderOptions = z.infer<typeof ProviderOptionsSchema>;

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
 *   call_token_budget        1_000_000  (sentinel; hard_cap_in derived from window)
 *
 * The existing top-level `max_files` (default 50) / `max_changed_lines`
 * (default 2000) remain the SINGLE-CALL threshold. Between the two sets of
 * limits → chunked review. Above `chunking.max_*` → oversized skip.
 *
 * Phase 2 budget derivation (chunking-stability-spec.md § Phase 2):
 *   hard_cap_in = window − reserved_output_tokens − prompt_overhead_tokens − safety
 *   safety      = ceil(safety_fraction × window)
 * The `call_token_budget` default is raised to a high sentinel (1_000_000) so
 * the derived `hard_cap_in` always dominates. Operators who set a lower value
 * still get that value as an effective ceiling: effective = min(call_token_budget, hard_cap_in).
 */
export const ChunkingSchema = z
  .object({
    enabled: z.boolean().default(true),
    max_files: z.number().int().positive().default(200),
    max_changed_lines: z.number().int().positive().default(12000),
    max_provider_calls_per_pr: z.number().int().positive().default(6),
    /**
     * Optional per-call input token ceiling (back-compat knob).
     * Phase 2 semantics: effective budget = min(call_token_budget, hard_cap_in).
     * Default raised to 1_000_000 so the derived `hard_cap_in` dominates.
     * Existing configs that set a lower value still cap correctly.
     *
     * Per chunking-stability-spec.md § 7 backward-compat.
     */
    call_token_budget: z.number().int().positive().default(1_000_000),
    /**
     * Output token budget reserved per provider call.
     * Adapters use this as `max_tokens` / `max_completion_tokens` on the wire.
     * Also used in the `hard_cap_in` reservation formula.
     * Default 4096 keeps happy-path PRs byte-identical to pre-Phase-1 behavior.
     * Operators raise this for finding-dense repos where responses truncate.
     *
     * Per chunking-stability-spec.md § Phase 1 "New/changed config knobs".
     */
    reserved_output_tokens: z.number().int().positive().default(4096),
    /**
     * Maximum number of split-and-retry attempts when a batch is truncated.
     * Each truncated batch is split in half (by estimated tokens) and retried.
     * At exhaustion, the files are recorded as "not fully reviewed" in the
     * check-run notice; the PR is never aborted.
     *
     * Default 2 means an initial truncation plus 2 retry generations (the
     * initial batch and up to 2 halving rounds).
     *
     * Per chunking-stability-spec.md § Phase 1 "Data-flow change" retry cap.
     */
    max_truncation_retries: z.number().int().nonnegative().default(2),
    /**
     * Token reserve for the prompt's fixed overhead: IMMUTABLE_SYSTEM_PROMPT
     * (~250 tokens) + tool/JSON-schema (~500) + guidance ceiling
     * (MAX_AUGMENTATION_TOKENS=7500) + render scaffolding (~750) = ~9000.
     * Operators should keep prompt_overhead_tokens ≥ 1000 + MAX_AUGMENTATION_TOKENS.
     *
     * Used in the `hard_cap_in` reservation formula:
     *   hard_cap_in = window − reserved_output_tokens − prompt_overhead_tokens − safety
     *
     * Per chunking-stability-spec.md § Phase 2 reservation formula.
     */
    prompt_overhead_tokens: z.number().int().positive().default(9000),
    /**
     * Fraction of the provider context window reserved as a safety margin.
     * Default 0.07 = 7% (within the documented 5–10% band).
     * safety = ceil(safety_fraction × window)
     *
     * Per chunking-stability-spec.md § Phase 2 reservation formula.
     */
    safety_fraction: z.number().min(0).max(1).default(0.07),
    /**
     * Context lines surrounding a hunk boundary.
     * Phase 3 FORWARD-COMPAT KNOB ONLY — the splitter operates on existing hunk
     * boundaries produced by the prefilter and does NOT re-diff or re-trim hunk
     * content (core lacks the raw patch; re-diffing belongs to a future prefilter
     * change). This value is recorded and documented so a future prefilter change
     * can use it without a breaking schema bump.
     * Default 10 matches the Qodo-style "~10 lines surrounding context" guidance.
     *
     * Per chunking-stability-spec.md § Phase 3 step 3.
     */
    hunk_context_lines: z.number().int().nonnegative().default(10),
    /**
     * Minimum serialized token estimate for a file to be split by hunks.
     * A file whose estimate is BELOW this threshold is never split — the splitter
     * only fires when the file's estimate exceeds `hard_cap_in`. The effective
     * default is therefore `hard_cap_in` (only split when over budget). This knob
     * allows operators to suppress pathological 1-line sub-file splits for files
     * that are only marginally over budget.
     *
     * Default 0: always split when over budget (conservative — any over-budget
     * file is a candidate; the batcher's skip/own-batch branches handle the rest).
     *
     * Per chunking-stability-spec.md § Phase 3 config.
     */
    min_hunk_split_tokens: z.number().int().nonnegative().default(0),
  })
  .strict()
  .default({
    enabled: true,
    max_files: 200,
    max_changed_lines: 12000,
    max_provider_calls_per_pr: 6,
    call_token_budget: 1_000_000,
    reserved_output_tokens: 4096,
    max_truncation_retries: 2,
    prompt_overhead_tokens: 9000,
    safety_fraction: 0.07,
    hunk_context_lines: 10,
    min_hunk_split_tokens: 0,
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
    /**
     * Per-language model override — schema-only; not applied per-language
     * in this release (OQ-4). Accepted for forward-compat.
     */
    model: z.string().min(1).optional(),
    /**
     * Per-language generation settings — schema-only; not applied per-language
     * in this release (OQ-4). Accepted for forward-compat.
     */
    generation: GenerationSchema.optional(),
    /**
     * Per-language provider_options — schema-only; not applied per-language
     * in this release (OQ-4). Accepted for forward-compat.
     */
    provider_options: ProviderOptionsSchema.optional(),
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
    /**
     * Vendor-neutral normalized generation settings. The adapter translates
     * each key to the vendor's dialect (e.g. `max_output_tokens` →
     * `max_tokens` or `max_completion_tokens` via `resolveTokenParam`).
     * All fields optional; absent → deployment-level env defaults apply.
     *
     * Spec: docs/_planning/config-dx/spec.md § 5.1, § 2 Group B.
     * Design: docs/_planning/config-dx/design.md § generation block.
     */
    generation: GenerationSchema,
    /**
     * Raw vendor passthrough map keyed by provider slug. Each inner bag is
     * forwarded untouched to the active provider's request, minus the
     * denylist (spec § 3.7). Only the active provider's sub-bag is applied;
     * other slugs' bags are silently ignored (AS-10).
     *
     * Precedence: provider_options > generation > Prisma defaults (P5).
     * G7: values are NEVER logged; `configuration` reply echoes keys only.
     *
     * Spec: docs/_planning/config-dx/spec.md § 5.1, § 3.7, § 2 Group C.
     */
    provider_options: ProviderOptionsSchema,
  })
  .describe('Repo-local .github/review-bot.yml configuration');

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

/**
 * `DEFAULT_REPO_CONFIG` is produced by parsing an empty object through the schema
 * so defaults are derived from a single source of truth: the schema itself.
 * Regression-tested in `packages/shared/tests/schemas.test.ts`.
 */
export const DEFAULT_REPO_CONFIG: RepoConfig = RepoConfigSchema.parse({});
