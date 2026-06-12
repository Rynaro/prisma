import { z } from 'zod';
import { PublicationResultSchema } from './publication.js';
import { RejectionLogEntrySchema } from './rejection.js';

/**
 * `JobPayload` v2 per docs/api-contracts.md § Async job contract — discriminated
 * union on `event_type`. Each variant carries only the fields relevant to its
 * trigger; all variants are `.strict()` to catch schema drift early.
 *
 * Variant summary:
 *   - `pull_request.*`          — PR open/synchronize/reopen (v1, unchanged)
 *   - `issue_comment.command`   — PR comment mention command
 *   - `check_run.rerequested`   — GitHub native re-run control
 *
 * The Phase 3 additive `traceparent` field is present on all variants.
 */

// ---------------------------------------------------------------------------
// Shared common fields (present on all variants)
// ---------------------------------------------------------------------------

const CommonJobFields = {
  idempotency_key: z.string().min(1),
  installation_id: z.number().int().positive(),
  repository_id: z.number().int().positive(),
  pull_request_number: z.number().int().nonnegative(),
  received_at: z.string().datetime({ offset: true }),
  traceparent: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
};

// ---------------------------------------------------------------------------
// Variant 1: pull_request.* (byte-identical to the original schema)
// ---------------------------------------------------------------------------

const PullRequestEventTypeSchema = z.enum([
  'pull_request.opened',
  'pull_request.synchronize',
  'pull_request.reopened',
]);

const PullRequestJobPayloadSchema = z
  .object({
    ...CommonJobFields,
    pull_request_number: z.number().int().positive(),
    head_sha: z.string().min(1),
    event_type: PullRequestEventTypeSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Variant 2: issue_comment.command
// ---------------------------------------------------------------------------

const CommenterAssociationSchema = z.enum([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
  'CONTRIBUTOR',
  'FIRST_TIME_CONTRIBUTOR',
  'FIRST_TIMER',
  'NONE',
]);

const CommentJobPayloadSchema = z
  .object({
    ...CommonJobFields,
    // head_sha is optional for comment jobs: not available at ingress
    // (issue_comment payloads carry `issue`, not `pull_request.head.sha`).
    // The worker fetches the live PR head via pulls.get before reviewing.
    head_sha: z.string().optional(),
    event_type: z.literal('issue_comment.command'),
    comment_id: z.number().int().positive(),
    commenter_login: z.string().min(1),
    commenter_association: z.string().min(1),
    mention_candidate: z.string().min(1),
    command_raw: z.string(),
    /**
     * The command marker that was used in the comment (one of `@`, `$`, `!`,
     * `/`). Optional for backward compatibility — old queued payloads without
     * this field are treated as if they used the default `@` marker.
     */
    command_marker: z.enum(['@', '$', '!', '/']).default('@'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Variant 3: check_run.rerequested
// ---------------------------------------------------------------------------

const CheckRunJobPayloadSchema = z
  .object({
    ...CommonJobFields,
    pull_request_number: z.number().int().nonnegative(),
    head_sha: z.string().min(1),
    event_type: z.literal('check_run.rerequested'),
    check_run_id: z.number().int().positive(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export const JobPayloadSchema = z.discriminatedUnion('event_type', [
  PullRequestJobPayloadSchema,
  CommentJobPayloadSchema,
  CheckRunJobPayloadSchema,
]);

export type JobPayload = z.infer<typeof JobPayloadSchema>;

/**
 * `JobEventTypeSchema` — superset of all accepted event_type values.
 */
export const JobEventTypeSchema = z.enum([
  'pull_request.opened',
  'pull_request.synchronize',
  'pull_request.reopened',
  'issue_comment.command',
  'check_run.rerequested',
]);
export type JobEventType = z.infer<typeof JobEventTypeSchema>;

/**
 * `JobResult` per docs/api-contracts.md § Async job contract. Terminal states are
 * the closed list `succeeded | failed_terminal | discarded_idempotent`.
 */

export const JobStateSchema = z.enum(['succeeded', 'failed_terminal', 'discarded_idempotent']);
export type JobState = z.infer<typeof JobStateSchema>;

export const JobResultSchema = z
  .object({
    state: JobStateSchema,
    publication_result: PublicationResultSchema.nullable(),
    rejections: z.array(RejectionLogEntrySchema),
    failure_reason_code: z.string().min(1).nullable(),
  })
  .strict();
export type JobResult = z.infer<typeof JobResultSchema>;
