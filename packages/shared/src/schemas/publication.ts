import { z } from 'zod';
import { type NormalizedFinding, NormalizedFindingSchema } from './finding.js';
import { RejectionLogEntrySchema } from './rejection.js';

/**
 * `RankedFindings` per docs/api-contracts.md § Ranker contract — an ordered list
 * of `NormalizedFinding`. The list is treated as immutable by the ranker's
 * downstream consumers; the inferred type is exposed as a `readonly` alias.
 */
export const RankedFindingsSchema = z.array(NormalizedFindingSchema);
export type RankedFindings = readonly NormalizedFinding[];

/**
 * `PublicationResult` per docs/api-contracts.md § Publisher contract.
 */
export const PublicationResultSchema = z
  .object({
    published_inline: z.array(NormalizedFindingSchema),
    published_summary: z.array(NormalizedFindingSchema),
    dropped: z.array(NormalizedFindingSchema),
    rejections: z.array(RejectionLogEntrySchema),
    checks_run_id: z.string(),
    summary_artifact: z.string(),
  })
  .strict();
export type PublicationResult = z.infer<typeof PublicationResultSchema>;
