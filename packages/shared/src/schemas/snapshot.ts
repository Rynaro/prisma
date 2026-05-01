import { z } from 'zod';

/**
 * `PrSnapshot` and friends — the snapshotter's output and the prefilter's input.
 *
 * The snapshotter (Phase 5.5) is the only component that constructs a
 * `PrSnapshot`; the schema lands in this slice (Phase 5.4) so that the
 * prefilter and validator can reference the shape without depending on the
 * snapshotter implementation. Per `docs/system-design.md` § packages/core/snapshotter,
 * the snapshot is bounded by `max_files` and `max_changed_lines` (the prefilter
 * enforces those caps; the snapshotter populates the structure).
 *
 * Field names mirror the GitHub Pull Requests API "files" payload shape (per
 * `docs/api-contracts.md` § GitHub interactions) but the schema is vendor-neutral:
 * no GitHub type leaks into downstream code.
 */

export const ChangedFileStatusSchema = z.enum(['added', 'modified', 'removed', 'renamed']);
export type ChangedFileStatus = z.infer<typeof ChangedFileStatusSchema>;

export const ChangedHunkSchema = z
  .object({
    /** start line in the new file */
    new_start: z.number().int().positive(),
    /** number of lines in the new file covered by this hunk */
    new_lines: z.number().int().nonnegative(),
    /** start line in the old file (0 for pure additions) */
    old_start: z.number().int().nonnegative(),
    /** number of lines in the old file covered by this hunk */
    old_lines: z.number().int().nonnegative(),
  })
  .strict();
export type ChangedHunk = z.infer<typeof ChangedHunkSchema>;

export const ChangedFileSchema = z
  .object({
    path: z.string().min(1),
    status: ChangedFileStatusSchema,
    /** previous path for renames; undefined otherwise */
    previous_path: z.string().min(1).optional(),
    /** total additions across hunks */
    additions: z.number().int().nonnegative(),
    /** total deletions across hunks */
    deletions: z.number().int().nonnegative(),
    /** unified diff hunks; empty array allowed for binary or oversize-skipped files */
    hunks: z.array(ChangedHunkSchema),
    /** byte size of the new content (for max-file-size policies in later slices) */
    size_bytes: z.number().int().nonnegative().optional(),
    /** is this a binary file per the source forge? */
    is_binary: z.boolean(),
    /** detected programming language tag (best-effort, may be undefined) */
    language: z.string().min(1).optional(),
  })
  .strict();
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const PrSnapshotSchema = z
  .object({
    installation_id: z.number().int().positive(),
    repository_id: z.number().int().positive(),
    pull_request_number: z.number().int().positive(),
    head_sha: z.string().min(1),
    base_sha: z.string().min(1),
    default_branch: z.string().min(1),
    /** total non-binary changed lines across all included files */
    total_changed_lines: z.number().int().nonnegative(),
    files: z.array(ChangedFileSchema),
  })
  .strict();
export type PrSnapshot = z.infer<typeof PrSnapshotSchema>;
