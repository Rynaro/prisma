import { z } from 'zod';

/**
 * Closed vocabularies per docs/review-findings-schema.md § Vocabularies.
 * These are the canonical exports; `packages/shared/src/types/index.ts` re-exports
 * the inferred TS types so call sites have one canonical import path
 * (`@prisma-bot/shared`).
 */

export const ModeSchema = z.enum(['dry-run', 'summary-only', 'summary-plus-inline']);
export type Mode = z.infer<typeof ModeSchema>;

export const SeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

export const CategorySchema = z.enum([
  'security',
  'correctness',
  'performance',
  'tests',
  'style',
  'migration',
  'dependency',
]);
export type Category = z.infer<typeof CategorySchema>;

export const RenderTargetSchema = z.enum(['inline', 'summary', 'dropped']);
export type RenderTarget = z.infer<typeof RenderTargetSchema>;

/**
 * `NormalizedFinding` — the validator's output. 15 fields per docs/review-findings-schema.md
 * § Field reference, field-by-field. Required/optional and ranges match the spec exactly.
 */
export const NormalizedFindingSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    line_start: z.number().int().positive(),
    line_end: z.number().int().positive(),
    category: CategorySchema,
    severity: SeveritySchema,
    confidence: z.number().min(0).max(1),
    title: z.string().min(1),
    explanation: z.string().min(1),
    suggested_fix: z.string().min(1).optional(),
    evidence: z.array(z.string().min(1)).min(1),
    render_target: RenderTargetSchema,
    source_artifacts_used: z.array(z.string().min(1)).min(1),
    dedupe_key: z.string().min(1),
    validator_notes: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine((value) => value.line_end >= value.line_start, {
    message: 'line_end must be >= line_start',
    path: ['line_end'],
  });
export type NormalizedFinding = z.infer<typeof NormalizedFindingSchema>;
