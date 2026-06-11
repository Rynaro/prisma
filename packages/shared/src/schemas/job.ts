import { z } from 'zod';
import { PublicationResultSchema } from './publication.js';
import { RejectionLogEntrySchema } from './rejection.js';

/**
 * `JobPayload` per docs/api-contracts.md § Async job contract, with the Phase 3
 * additive `traceparent` optional field documented in docs/system-design.md
 * § Cross-cutting concerns / Trace propagation across the queue. The extension is
 * forward-compatible (optional, trace-only) and does not modify Phase 2 contracts.
 */

export const JobEventTypeSchema = z.enum([
  'pull_request.opened',
  'pull_request.synchronize',
  'pull_request.reopened',
]);
export type JobEventType = z.infer<typeof JobEventTypeSchema>;

export const JobPayloadSchema = z
  .object({
    idempotency_key: z.string().min(1),
    installation_id: z.number().int().positive(),
    repository_id: z.number().int().positive(),
    pull_request_number: z.number().int().positive(),
    head_sha: z.string().min(1),
    event_type: JobEventTypeSchema,
    received_at: z.string().datetime({ offset: true }),
    // Phase 3 additive extension — does not modify Phase 2 contracts.
    traceparent: z.string().min(1).optional(),
    // Repository identity carried from the webhook payload so the worker can
    // resolve owner/repo without an extra API call. Optional for backwards
    // compatibility: jobs enqueued by an older app version will not have these
    // fields; the worker falls back to env-var overrides and then throws a
    // descriptive error if neither source is available.
    owner: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
  })
  .strict();
export type JobPayload = z.infer<typeof JobPayloadSchema>;

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
