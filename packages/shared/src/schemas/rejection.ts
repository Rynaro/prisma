import { z } from 'zod';

/**
 * `RejectionLogEntry` per docs/review-findings-schema.md § Rejection log entry shape.
 * Emitted by validator, ranker, and publisher when a finding is dropped.
 */

export const RejectionStageSchema = z.enum(['validator', 'ranker', 'publisher']);
export type RejectionStage = z.infer<typeof RejectionStageSchema>;

export const RejectionLogEntrySchema = z
  .object({
    finding_id: z.string().min(1).nullable(),
    stage: RejectionStageSchema,
    reason_code: z.string().min(1),
    reason_message: z.string().min(1),
    provider_output_excerpt: z.string(),
    timestamp: z.string().datetime({ offset: true }),
  })
  .strict();
export type RejectionLogEntry = z.infer<typeof RejectionLogEntrySchema>;
