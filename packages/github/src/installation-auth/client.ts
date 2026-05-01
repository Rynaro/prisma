import { Octokit } from '@octokit/rest';

/**
 * `OctokitLike` — the minimal shape of the Octokit client surface this package
 * (and downstream callers) consumes. Declared here so the rest of the package
 * (and the snapshotter, publisher, etc.) never imports `@octokit/*` directly,
 * mirroring the `AnthropicClientLike` pattern from
 * `packages/providers/anthropic/src/index.ts` (Phase 5.3).
 *
 * Per `docs/api-contracts.md` § Invariants and error semantics (item 1) and
 * `docs/system-design.md` § packages/github/installation-auth: vendor SDK
 * imports are confined to `installation-auth/{client.ts, auth.ts}`. The
 * interface is the seam: every method named here corresponds 1:1 to an Octokit
 * REST endpoint we actually use; no surface beyond that is exposed.
 *
 * The naming of `pulls_reviews` mirrors that GitHub's PR review-comment endpoints
 * live on the Octokit `rest.pulls` namespace (e.g. `octokit.rest.pulls.createReviewComment`,
 * `octokit.rest.pulls.listReviewCommentsForRepo`); we group them in a separate
 * sub-namespace here so the snapshotter (which only needs `pulls.{get,listFiles}`)
 * is not coupled to the review-comment surface.
 *
 * Mapping (this package's name → Octokit method):
 *   - rest.pulls.get              → octokit.rest.pulls.get
 *   - rest.pulls.listFiles        → octokit.rest.pulls.listFiles
 *   - rest.checks.create          → octokit.rest.checks.create
 *   - rest.checks.update          → octokit.rest.checks.update
 *   - rest.checks.listForRef      → octokit.rest.checks.listForRef
 *   - rest.pulls_reviews.createReviewComment
 *                                 → octokit.rest.pulls.createReviewComment
 *   - rest.pulls_reviews.listReviewComments
 *                                 → octokit.rest.pulls.listReviewComments
 */

export interface PullsGetData {
  number: number;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  base_ref?: string | null;
}

export interface PullsListFilesData {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'changed' | 'copied' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

export interface ChecksCreateParams {
  owner: string;
  repo: string;
  name: string;
  head_sha: string;
  status?: 'queued' | 'in_progress' | 'completed';
  details_url?: string;
  external_id?: string;
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required';
  output?: { title: string; summary: string; text?: string };
}

export interface ChecksUpdateParams {
  owner: string;
  repo: string;
  check_run_id: number;
  status?: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required';
  output?: { title: string; summary: string; text?: string };
}

export interface ChecksListItemData {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  output: { title: string | null; summary: string | null; text: string | null };
  app: { id: number | null } | null;
}

export interface PullsCreateReviewCommentParams {
  owner: string;
  repo: string;
  pull_number: number;
  body: string;
  commit_id: string;
  path: string;
  line: number;
  side?: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
}

export interface PullsReviewCommentData {
  id: number;
  body: string;
  path: string;
  line: number | null;
  user: { login: string; type: string } | null;
}

export interface OctokitLike {
  rest: {
    pulls: {
      get(params: {
        owner: string;
        repo: string;
        pull_number: number;
      }): Promise<{ data: PullsGetData }>;
      listFiles(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{ data: PullsListFilesData[] }>;
    };
    checks: {
      create(params: ChecksCreateParams): Promise<{ data: { id: number } }>;
      update(params: ChecksUpdateParams): Promise<{ data: { id: number } }>;
      listForRef(params: {
        owner: string;
        repo: string;
        ref: string;
        app_id?: number;
        per_page?: number;
        page?: number;
      }): Promise<{ data: { check_runs: ChecksListItemData[] } }>;
    };
    pulls_reviews: {
      createReviewComment(
        params: PullsCreateReviewCommentParams,
      ): Promise<{ data: PullsReviewCommentData }>;
      listReviewComments(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{ data: PullsReviewCommentData[] }>;
    };
  };
}

/**
 * Build a real `OctokitLike` from a token. Used by `InstallationAuth` when no
 * `clientFactory` is injected.
 *
 * The casts at the SDK boundary are deliberate: Octokit's internal types use
 * index signatures and stricter optional-property semantics than our minimal
 * `OctokitLike` shape. Confining the cast to this single factory keeps the
 * SDK surface from leaking into downstream code.
 */
export const createDefaultOctokit = (token: string): OctokitLike => {
  const inner = new Octokit({ auth: token });
  return {
    rest: {
      pulls: {
        get: (params) => inner.rest.pulls.get(params) as unknown as Promise<{ data: PullsGetData }>,
        listFiles: (params) =>
          inner.rest.pulls.listFiles(params) as unknown as Promise<{
            data: PullsListFilesData[];
          }>,
      },
      checks: {
        create: (params) =>
          inner.rest.checks.create(
            params as unknown as Parameters<typeof inner.rest.checks.create>[0],
          ) as unknown as Promise<{ data: { id: number } }>,
        update: (params) =>
          inner.rest.checks.update(
            params as unknown as Parameters<typeof inner.rest.checks.update>[0],
          ) as unknown as Promise<{ data: { id: number } }>,
        listForRef: (params) =>
          inner.rest.checks.listForRef(params) as unknown as Promise<{
            data: { check_runs: ChecksListItemData[] };
          }>,
      },
      pulls_reviews: {
        createReviewComment: (params) =>
          inner.rest.pulls.createReviewComment(
            params as unknown as Parameters<typeof inner.rest.pulls.createReviewComment>[0],
          ) as unknown as Promise<{ data: PullsReviewCommentData }>,
        listReviewComments: (params) =>
          inner.rest.pulls.listReviewComments(params) as unknown as Promise<{
            data: PullsReviewCommentData[];
          }>,
      },
    },
  };
};
