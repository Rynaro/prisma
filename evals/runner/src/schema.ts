import { CategorySchema, RepoConfigSchema, SeveritySchema } from '@prisma-bot/shared';
import { z } from 'zod';

/**
 * Zod schemas for Phase 6 evaluation fixtures.
 *
 * The scenario index `evals/scenarios.yaml` is described by `ScenarioIndexSchema`
 * and a per-scenario fixture `evals/fixtures/<id>.yaml` is described by
 * `ScenarioFixtureSchema`. Both schemas are `.strict()` at the outermost level
 * per `docs/_planning/phase-6-spec.md` § Scenario YAML schema:
 *   "Unknown top-level keys are rejected (zod `.strict()`)".
 *
 * `config_overrides` is a partial object that the harness deep-merges over
 * `DEFAULT_REPO_CONFIG` by feeding it back through `RepoConfigSchema.parse(...)`.
 * Because every leaf in the underlying config schema has a `.default(...)`, an
 * arbitrary subset of keys parses to a fully-populated `RepoConfig`. We declare
 * the override surface as `z.record(...)` rather than redeclaring the whole
 * config tree here; the actual validation happens when the runner constructs
 * the merged `RepoConfig`.
 */

export const ScenarioConfigOverridesSchema = z.record(z.string(), z.unknown());

export const ScenarioPullRequestPayloadSchema = z
  .object({
    action: z.enum(['opened', 'synchronize', 'reopened']),
    installation: z
      .object({
        id: z.number().int().positive(),
      })
      .strict(),
    repository: z
      .object({
        id: z.number().int().positive(),
        full_name: z.string().min(1).optional(),
      })
      .passthrough(),
    pull_request: z
      .object({
        number: z.number().int().positive(),
        head: z
          .object({
            sha: z.string().min(1),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export type ScenarioPullRequestPayload = z.infer<typeof ScenarioPullRequestPayloadSchema>;

const PullsGetDataSchema = z
  .object({
    number: z.number().int().positive(),
    head: z
      .object({
        sha: z.string().min(1),
        ref: z.string().min(1),
      })
      .strict(),
    base: z
      .object({
        sha: z.string().min(1),
        ref: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type PullsGetData = z.infer<typeof PullsGetDataSchema>;

const ChangedFileEntrySchema = z
  .object({
    filename: z.string().min(1),
    status: z.enum(['added', 'modified', 'removed', 'renamed', 'changed', 'copied', 'unchanged']),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changes: z.number().int().nonnegative().optional(),
    patch: z.string().optional(),
    previous_filename: z.string().min(1).optional(),
  })
  .strict();
export type ChangedFileEntry = z.infer<typeof ChangedFileEntrySchema>;

/**
 * `pulls_list_files` may be either an inline array of file entries or a
 * `from_file` pointer to a JSON document with the same shape. The pointer is
 * resolved by the runner relative to the fixture directory before it reaches
 * the schema parser, so by the time we validate, the value is always an array.
 */
const PullsListFilesValueSchema = z.array(ChangedFileEntrySchema);

const PullsListFilesInputSchema = z.union([
  PullsListFilesValueSchema,
  z
    .object({
      from_file: z.string().min(1),
    })
    .strict(),
]);

const PriorReviewCommentSchema = z
  .object({
    id: z.number().int().nonnegative(),
    path: z.string().min(1),
    line: z.number().int().nullable(),
    body: z.string(),
  })
  .strict();

const PriorCheckRunSchema = z
  .object({
    id: z.number().int().nonnegative(),
    conclusion: z.string().nullable(),
    output_summary: z.string().nullable(),
  })
  .strict();

/**
 * A pre-existing PR review to replay from `pulls.listReviews` (S8). Used by
 * the `approve-on-clean-idempotent` scenario to simulate an already-approved
 * PR: `findOurApproval` must observe this entry and skip a redundant
 * `createReview` call.
 */
const PriorReviewSchema = z
  .object({
    id: z.number().int().nonnegative(),
    state: z.enum(['APPROVED', 'DISMISSED', 'CHANGES_REQUESTED', 'COMMENTED', 'PENDING']),
    user: z
      .object({ login: z.string().min(1), type: z.string().min(1) })
      .strict()
      .nullable(),
    body: z.string().nullable().optional(),
    commit_id: z.string().min(1).nullable().optional(),
  })
  .strict();

/**
 * Per-path fixture responses for `repos.getContent`.
 * Key: repo-relative path (e.g. 'docs/arch.md').
 * Value: `{ content_base64: string }` for a file hit,
 *        or `{ error: 'not_found' }` for a simulated 404.
 */
const ReposGetContentEntrySchema = z.union([
  z.object({ content_base64: z.string() }).strict(),
  z.object({ error: z.literal('not_found') }).strict(),
]);
export type ReposGetContentEntry = z.infer<typeof ReposGetContentEntrySchema>;

const ReposGetContentMapSchema = z.record(z.string().min(1), ReposGetContentEntrySchema);
export type ReposGetContentMap = z.infer<typeof ReposGetContentMapSchema>;

export const ScenarioOctokitResponsesSchema = z
  .object({
    pulls_get: PullsGetDataSchema,
    pulls_list_files: PullsListFilesInputSchema,
    prior_review_comments: z.array(PriorReviewCommentSchema).optional(),
    prior_check_runs: z.array(PriorCheckRunSchema).optional(),
    /** Fixture responses for `repos.getContent` keyed by repo-relative path. */
    repos_get_content: ReposGetContentMapSchema.optional(),
    /** Pre-existing PR reviews to replay from `pulls.listReviews` (S8). */
    prior_reviews: z.array(PriorReviewSchema).optional(),
  })
  .strict();

export type ScenarioOctokitResponses = z.infer<typeof ScenarioOctokitResponsesSchema>;

const ProviderFindingFixtureSchema = z
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

/**
 * A provider-reported "good decision" fixture (S8). Mirrors
 * `ProviderReviewOutputHighlightSchema` (`packages/shared/src/schemas/provider.ts`):
 * deliberately NOT a finding — no line anchor, no severity, no category.
 */
const ProviderHighlightFixtureSchema = z
  .object({
    path: z.string().min(1).optional(),
    message: z.string().min(1),
    rationale: z.string().min(1),
  })
  .strict();

const ProviderOutputFixtureSchema = z
  .object({
    findings: z.array(ProviderFindingFixtureSchema),
    /** Present only on scenarios exercising `positive_feedback` (S8). */
    highlights: z.array(ProviderHighlightFixtureSchema).optional(),
  })
  .strict();

const ProviderErrorFixtureSchema = z
  .object({
    kind: z.enum(['transport', 'auth', 'rate_limit', 'capability', 'schema_validation']),
    message: z.string().min(1),
    retry_after_ms: z.number().int().nonnegative().optional(),
    missing_capability: z.string().min(1).optional(),
    zod_issues: z.array(z.string()).optional(),
  })
  .strict();

const ProviderScriptStepSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('output'),
      output: ProviderOutputFixtureSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('error'),
      error: ProviderErrorFixtureSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('output_lazy'),
      // `output_lazy` is documented as collapsing to `output` for the YAML
      // surface (the YAML carries the literal output). The runner builds a
      // `FakeStep` of kind `output` from this entry.
      output: ProviderOutputFixtureSchema,
    })
    .strict(),
]);

export type ProviderScriptStep = z.infer<typeof ProviderScriptStepSchema>;

const PrefilterExpectationsSchema = z
  .object({
    outcome: z.enum(['accepted', 'chunkable', 'oversized', 'all-excluded']),
    skipped_paths: z.array(z.string().min(1)).default([]),
    skipped_reasons: z.array(z.string().min(1)).default([]),
    files_sent_to_provider: z.number().int().nonnegative(),
  })
  .strict();

const ProviderExpectationsSchema = z
  .object({
    calls: z.number().int().nonnegative(),
  })
  .strict();

const ValidatorExpectationsSchema = z
  .object({
    findings: z.number().int().nonnegative(),
    rejection_reasons: z.array(z.string().min(1)).default([]),
  })
  .strict();

const RankerExpectationsSchema = z
  .object({
    output_size_eq_input: z.boolean(),
  })
  .strict();

const PublisherExpectationsSchema = z
  .object({
    inline_count: z.number().int().nonnegative(),
    summary_count: z.number().int().nonnegative(),
    dropped_count: z.number().int().nonnegative(),
    publication_state: z.enum(['succeeded', 'failed_terminal']),
    summary_contains: z.array(z.string()).default([]),
    expected_categories: z.array(CategorySchema).default([]),
    /**
     * Subset assertion against the publisher-stage `RejectionLogEntry.reason_code`
     * values produced for `PublicationResult.dropped` items. Phase 6 schema
     * extension for `duplicate-issue-across-hunks` per spec § File 4.8.
     */
    rejection_reasons: z.array(z.string().min(1)).default([]),
    /**
     * The check-run conclusion actually recorded via `checks.update` (S8).
     * Optional: most scenarios don't assert it and fall through unchecked.
     */
    check_conclusion: z.enum(['success', 'neutral', 'failure']).optional(),
    /**
     * Count of `pulls.createReview` calls observed this run (S8). Defaults to
     * `0` so every pre-existing scenario becomes a regression guard for
     * "default off" (AC-034).
     */
    approvals_submitted: z.number().int().nonnegative().default(0),
    /** Count of `pulls.dismissReview` calls observed this run (S8). */
    approval_dismissals: z.number().int().nonnegative().default(0),
    /**
     * Negated-substring assertions against `summary_artifact` (S8) — the
     * complement of `summary_contains`. Used to assert that a dropped/capped
     * highlight (or a suppressed notice) does NOT appear in the rendered body.
     */
    summary_not_contains: z.array(z.string()).default([]),
  })
  .strict();

export const ScenarioExpectationsSchema = z
  .object({
    prefilter: PrefilterExpectationsSchema,
    provider: ProviderExpectationsSchema,
    validator: ValidatorExpectationsSchema,
    ranker: RankerExpectationsSchema,
    publisher: PublisherExpectationsSchema,
  })
  .strict();

export type ScenarioExpectations = z.infer<typeof ScenarioExpectationsSchema>;

const FROZEN_METRIC_IDS = [
  'false_positive_rate',
  'duplicate_suppression',
  'comment_usefulness',
  'large_diff_degradation',
  'provider_schema_failure_handling',
  'confidence_threshold_behavior',
  'publication_cap_behavior',
  'custom_guidance_threading',
  'context_file_injection',
  'malformed_config_resilience',
] as const;

export const MetricIdSchema = z.enum(FROZEN_METRIC_IDS);
export type MetricId = z.infer<typeof MetricIdSchema>;

export const ScenarioFixtureSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    config_overrides: ScenarioConfigOverridesSchema.default({}),
    pr_payload: ScenarioPullRequestPayloadSchema,
    octokit_responses: ScenarioOctokitResponsesSchema,
    provider_script: z.array(ProviderScriptStepSchema),
    expectations: ScenarioExpectationsSchema,
    metrics: z.array(MetricIdSchema).min(1),
  })
  .strict();

export type ScenarioFixture = z.infer<typeof ScenarioFixtureSchema>;

const ScenarioIndexEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    fixture: z.string().min(1),
    tags: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const ScenarioIndexSchema = z
  .object({
    scenarios: z.array(ScenarioIndexEntrySchema).min(1),
  })
  .strict();

export type ScenarioIndex = z.infer<typeof ScenarioIndexSchema>;
export type ScenarioIndexEntry = z.infer<typeof ScenarioIndexEntrySchema>;

/**
 * Merge `config_overrides` over the schema defaults. Because every leaf in
 * `RepoConfigSchema` is `.default(...)`-equipped, parsing a partial object
 * yields a fully-populated `RepoConfig` with the defaults filling the gaps.
 * This is the canonical "deep-merge of overrides over `DEFAULT_REPO_CONFIG`"
 * referenced in the spec.
 */
export const mergeConfig = (overrides: unknown): ReturnType<typeof RepoConfigSchema.parse> =>
  RepoConfigSchema.parse(overrides ?? {});
