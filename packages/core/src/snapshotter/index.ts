import {
  type ChangedFile,
  type ChangedFileStatus,
  type ChangedHunk,
  type PrSnapshot,
  PrSnapshotSchema,
} from '@prisma-bot/shared';

/**
 * `SNAPSHOTTER_MODULE` — module marker preserved for the existing smoke test
 * (see `packages/core/tests/smoke.test.ts`). The Phase 4 stub exported only
 * this constant; Phase 5.5 keeps it stable.
 */
export const SNAPSHOTTER_MODULE = 'snapshotter';

/**
 * `fetchPrSnapshot` — fetches a PR diff and metadata via a pre-authenticated
 * `OctokitLike` client and returns a schema-conformant `PrSnapshot`.
 *
 * Per `docs/system-design.md` § packages/core/snapshotter: the snapshot is
 * bounded by `max_files` (default 300; GitHub's hard cap is 3000 across all
 * pages) and by a per-file patch byte budget (default 64 KiB) before hunk
 * parsing. Truncation is silent for now: oversized PRs are caught downstream
 * by the prefilter's `max_changed_lines` cap. See OQ-9 for the spec
 * contradiction note (the snapshot schema has no `truncated` field).
 *
 * No I/O happens in this module other than via the injected `octokit` —
 * mirroring the `AnthropicClientLike` seam (Phase 5.3). Tests substitute a
 * hand-rolled fake.
 */

/** Minimal interface the snapshotter consumes from the GitHub client. */
export interface SnapshotterOctokitLike {
  rest: {
    pulls: {
      get(params: { owner: string; repo: string; pull_number: number }): Promise<{
        data: {
          number: number;
          head: { sha: string; ref: string; repo?: { full_name?: string } | null };
          base: { sha: string; ref: string; repo?: { full_name?: string } | null };
          base_ref?: string | null;
        };
      }>;
      listFiles(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: Array<{
          filename: string;
          status: 'added' | 'modified' | 'removed' | 'renamed' | 'changed' | 'copied' | 'unchanged';
          additions: number;
          deletions: number;
          changes: number;
          patch?: string;
          previous_filename?: string;
        }>;
      }>;
    };
  };
}

export interface SnapshotterOptions {
  octokit: SnapshotterOctokitLike;
  installation_id: number;
  repository_id: number;
  owner: string;
  repo: string;
  pull_request_number: number;
  /** Clamp on the number of files Octokit lists; default 300. */
  maxFiles?: number;
  /** Per-file patch byte cap; default 64 KiB. Larger patches are truncated. */
  maxPatchBytesPerFile?: number;
  /** Octokit per_page; default 100 (GitHub's max). */
  perPage?: number;
}

const DEFAULT_MAX_FILES = 300;
const DEFAULT_MAX_PATCH_BYTES_PER_FILE = 64 * 1024;
const DEFAULT_PER_PAGE = 100;

/**
 * Map a forge-side file status to the schema's `ChangedFileStatus`. The
 * schema enum is `added | modified | removed | renamed`. GitHub also returns
 * `changed`, `copied`, `unchanged` for some events; we normalise:
 *   - `changed`   → `modified`
 *   - `copied`    → `added`     (a copied file is, from a review POV, new content)
 *   - `unchanged` → `modified`  (no-op; will be filtered by the prefilter when
 *                                 there are no hunks)
 */
const normaliseStatus = (
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'changed' | 'copied' | 'unchanged',
): ChangedFileStatus => {
  switch (status) {
    case 'added':
    case 'modified':
    case 'removed':
    case 'renamed':
      return status;
    case 'changed':
      return 'modified';
    case 'copied':
      return 'added';
    case 'unchanged':
      return 'modified';
  }
};

/**
 * Detect language from path extension. The allowlist is intentionally small;
 * unknown extensions return `undefined` and the language tag is omitted from
 * the schema (per `ChangedFileSchema.language.optional()`).
 */
const detectLanguage = (path: string): string | undefined => {
  const idx = path.lastIndexOf('.');
  if (idx < 0) return undefined;
  const ext = path.slice(idx + 1).toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'go':
      return 'go';
    case 'py':
      return 'python';
    case 'rb':
      return 'ruby';
    case 'java':
      return 'java';
    case 'kt':
      return 'kotlin';
    case 'cs':
      return 'csharp';
    case 'rs':
      return 'rust';
    case 'cpp':
    case 'cc':
      return 'cpp';
    case 'c':
    case 'h':
      return 'c';
    case 'swift':
      return 'swift';
    case 'php':
      return 'php';
    case 'scala':
      return 'scala';
    default:
      return undefined;
  }
};

/**
 * Parse a unified-diff patch into `ChangedHunk[]`. Each hunk header matches
 *   `@@ -<oldStart>[,<oldLines>] +<newStart>[,<newLines>] @@`
 * Per the unified-diff convention, omitted comma values default to 1.
 * Lines outside hunk headers are ignored.
 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const parseHunks = (patch: string): ChangedHunk[] => {
  const hunks: ChangedHunk[] = [];
  for (const line of patch.split('\n')) {
    const match = HUNK_HEADER.exec(line);
    if (match === null) continue;
    const [, oldStartStr, oldLinesStr, newStartStr, newLinesStr] = match;
    if (oldStartStr === undefined || newStartStr === undefined) continue;
    const old_start = Number.parseInt(oldStartStr, 10);
    const old_lines = oldLinesStr === undefined ? 1 : Number.parseInt(oldLinesStr, 10);
    const new_start = Number.parseInt(newStartStr, 10);
    const new_lines = newLinesStr === undefined ? 1 : Number.parseInt(newLinesStr, 10);
    if (
      !Number.isFinite(old_start) ||
      !Number.isFinite(old_lines) ||
      !Number.isFinite(new_start) ||
      !Number.isFinite(new_lines)
    ) {
      continue;
    }
    // The schema requires `new_start` to be positive. A removed-file hunk
    // (`+0,0`) has `new_start === 0`; we drop those hunks (the file is
    // surfaced via `status === 'removed'` and the prefilter skips it before
    // any provider call).
    if (new_start <= 0) continue;
    hunks.push({ old_start, old_lines, new_start, new_lines });
  }
  return hunks;
};

const utf8ByteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Truncate a patch to fit the per-file byte budget on a UTF-8 boundary. */
const truncatePatch = (patch: string, maxBytes: number): string => {
  if (utf8ByteLength(patch) <= maxBytes) return patch;
  // Greedy truncate by characters; recheck byte length after each shrink.
  // For pathological worst-case multi-byte content this is O(n) on the slice.
  let lo = 0;
  let hi = patch.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (utf8ByteLength(patch.slice(0, mid)) <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return patch.slice(0, lo);
};

const buildChangedFile = (
  raw: {
    filename: string;
    status: 'added' | 'modified' | 'removed' | 'renamed' | 'changed' | 'copied' | 'unchanged';
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
    previous_filename?: string;
  },
  maxPatchBytes: number,
): ChangedFile => {
  const status = normaliseStatus(raw.status);
  const isBinary = raw.patch === undefined;
  const language = detectLanguage(raw.filename);
  const hunks: ChangedHunk[] = isBinary
    ? []
    : parseHunks(truncatePatch(raw.patch ?? '', maxPatchBytes));
  const base: ChangedFile = {
    path: raw.filename,
    status,
    additions: raw.additions,
    deletions: raw.deletions,
    hunks,
    is_binary: isBinary,
  };
  // exactOptionalPropertyTypes: only include optional keys when defined.
  return {
    ...base,
    ...(raw.previous_filename !== undefined ? { previous_path: raw.previous_filename } : {}),
    ...(language !== undefined ? { language } : {}),
  };
};

const listAllFiles = async (
  octokit: SnapshotterOctokitLike,
  owner: string,
  repo: string,
  pull_number: number,
  perPage: number,
  maxFiles: number,
): Promise<
  Array<{
    filename: string;
    status: 'added' | 'modified' | 'removed' | 'renamed' | 'changed' | 'copied' | 'unchanged';
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
    previous_filename?: string;
  }>
> => {
  const accumulated: Array<{
    filename: string;
    status: 'added' | 'modified' | 'removed' | 'renamed' | 'changed' | 'copied' | 'unchanged';
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
    previous_filename?: string;
  }> = [];
  let page = 1;
  while (accumulated.length < maxFiles) {
    const remaining = maxFiles - accumulated.length;
    const fetchPerPage = Math.min(perPage, remaining);
    const response = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number,
      per_page: fetchPerPage,
      page,
    });
    const batch = response.data;
    accumulated.push(...batch);
    if (batch.length < fetchPerPage) break;
    page += 1;
  }
  return accumulated.slice(0, maxFiles);
};

export const fetchPrSnapshot = async (opts: SnapshotterOptions): Promise<PrSnapshot> => {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxPatchBytes = opts.maxPatchBytesPerFile ?? DEFAULT_MAX_PATCH_BYTES_PER_FILE;
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;

  const prResponse = await opts.octokit.rest.pulls.get({
    owner: opts.owner,
    repo: opts.repo,
    pull_number: opts.pull_request_number,
  });
  const pr = prResponse.data;

  const rawFiles = await listAllFiles(
    opts.octokit,
    opts.owner,
    opts.repo,
    opts.pull_request_number,
    perPage,
    maxFiles,
  );
  const files = rawFiles.map((raw) => buildChangedFile(raw, maxPatchBytes));
  const total_changed_lines = files.reduce(
    (sum, f) => (f.is_binary ? sum : sum + f.additions + f.deletions),
    0,
  );

  // D3 fork signal: compare head.repo.full_name vs base.repo.full_name when
  // both are present. Absent → undefined (fail-closed in the orchestrator).
  const headFullName = pr.head.repo?.full_name;
  const baseFullName = pr.base.repo?.full_name;
  const isFork =
    headFullName !== undefined && baseFullName !== undefined
      ? headFullName !== baseFullName
      : undefined;

  const candidate: PrSnapshot = {
    installation_id: opts.installation_id,
    repository_id: opts.repository_id,
    pull_request_number: opts.pull_request_number,
    head_sha: pr.head.sha,
    base_sha: pr.base.sha,
    default_branch: pr.base.ref,
    ...(isFork !== undefined ? { is_fork: isFork } : {}),
    total_changed_lines,
    files,
  };
  return PrSnapshotSchema.parse(candidate);
};
