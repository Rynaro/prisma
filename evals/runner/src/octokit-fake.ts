import type { OctokitLike, ReposGetContentData } from '@prisma-bot/github';
import type { ChangedFileEntry, PullsGetData, ScenarioOctokitResponses } from './schema.js';

/**
 * Build a deterministic `OctokitLike` from a fixture's `octokit_responses`.
 * Implements only the surface the snapshotter, check-runs client, and
 * review-comments client call:
 *
 *   - rest.pulls.get
 *   - rest.pulls.listFiles (pagination supported via per_page / page)
 *   - rest.checks.create / rest.checks.update / rest.checks.listForRef
 *   - rest.pulls_reviews.createReviewComment / listReviewComments
 *
 * Every method increments a per-method call counter so the harness can assert
 * on observed traffic without mocking individual functions.
 */

export interface FakeOctokitOptions {
  responses: ScenarioOctokitResponses;
  /**
   * The `pulls_list_files` field on the parsed fixture is a `from_file` pointer
   * resolved to an array before we get here. The constructor accepts the
   * resolved array directly to keep the type surface honest.
   */
  filesPayload: ChangedFileEntry[];
}

export interface FakeOctokitCallCounts {
  pulls_get: number;
  pulls_list_files: number;
  repos_get_content: number;
  checks_create: number;
  checks_update: number;
  checks_list_for_ref: number;
  review_comments_create: number;
  review_comments_list: number;
}

export interface FakeOctokitHandle {
  octokit: OctokitLike;
  calls: FakeOctokitCallCounts;
  /** Inline review comment bodies posted (for assertion / debugging only). */
  postedInlineComments: Array<{ path: string; line: number; body: string }>;
  /** Final check-run conclusions observed (one per `checks.update`). */
  checkRunUpdates: Array<{
    check_run_id: number;
    conclusion: string | undefined;
    summary: string | undefined;
  }>;
}

const normaliseInputStatus = (
  status: ChangedFileEntry['status'],
): 'added' | 'modified' | 'removed' | 'renamed' | 'changed' | 'copied' | 'unchanged' => status;

export const buildFakeOctokit = (options: FakeOctokitOptions): FakeOctokitHandle => {
  const calls: FakeOctokitCallCounts = {
    pulls_get: 0,
    pulls_list_files: 0,
    repos_get_content: 0,
    checks_create: 0,
    checks_update: 0,
    checks_list_for_ref: 0,
    review_comments_create: 0,
    review_comments_list: 0,
  };
  const postedInlineComments: Array<{ path: string; line: number; body: string }> = [];
  const checkRunUpdates: Array<{
    check_run_id: number;
    conclusion: string | undefined;
    summary: string | undefined;
  }> = [];

  let nextCheckRunId = 1;

  const pullsGetData: PullsGetData = options.responses.pulls_get;
  const allFiles: ChangedFileEntry[] = options.filesPayload;
  const priorReviewComments = options.responses.prior_review_comments ?? [];
  const priorCheckRuns = options.responses.prior_check_runs ?? [];
  const reposGetContentMap = options.responses.repos_get_content ?? {};

  const octokit: OctokitLike = {
    rest: {
      pulls: {
        get: async () => {
          calls.pulls_get += 1;
          return { data: pullsGetData };
        },
        listFiles: async (params) => {
          calls.pulls_list_files += 1;
          const page = params.page ?? 1;
          const perPage = params.per_page ?? 100;
          const start = (page - 1) * perPage;
          const slice = allFiles.slice(start, start + perPage).map((f) => {
            const base: {
              filename: string;
              status:
                | 'added'
                | 'modified'
                | 'removed'
                | 'renamed'
                | 'changed'
                | 'copied'
                | 'unchanged';
              additions: number;
              deletions: number;
              changes: number;
              patch?: string;
              previous_filename?: string;
            } = {
              filename: f.filename,
              status: normaliseInputStatus(f.status),
              additions: f.additions,
              deletions: f.deletions,
              changes: f.changes ?? f.additions + f.deletions,
            };
            if (f.patch !== undefined) base.patch = f.patch;
            if (f.previous_filename !== undefined) base.previous_filename = f.previous_filename;
            return base;
          });
          return { data: slice };
        },
      },
      repos: {
        getContent: async (params): Promise<{ data: ReposGetContentData }> => {
          calls.repos_get_content += 1;
          const entry = reposGetContentMap[params.path];
          if (entry === undefined) {
            // Path not in fixture → 404 (missing).
            const err = Object.assign(new Error('Not Found'), { status: 404 });
            throw err;
          }
          if ('error' in entry && entry.error === 'not_found') {
            const err = Object.assign(new Error('Not Found'), { status: 404 });
            throw err;
          }
          if ('content_base64' in entry) {
            return {
              data: {
                type: 'file',
                encoding: 'base64',
                content: entry.content_base64,
              },
            };
          }
          const err = Object.assign(new Error('Not Found'), { status: 404 });
          throw err;
        },
      },
      checks: {
        create: async (params) => {
          calls.checks_create += 1;
          const id = nextCheckRunId;
          nextCheckRunId += 1;
          // `params.head_sha` is supplied by the publisher; we accept any.
          void params.head_sha;
          return { data: { id } };
        },
        update: async (params) => {
          calls.checks_update += 1;
          checkRunUpdates.push({
            check_run_id: params.check_run_id,
            conclusion: params.conclusion,
            summary: params.output?.summary,
          });
          return { data: { id: params.check_run_id } };
        },
        listForRef: async () => {
          calls.checks_list_for_ref += 1;
          return {
            data: {
              check_runs: priorCheckRuns.map((run) => ({
                id: run.id,
                name: 'AI Code Review',
                head_sha: pullsGetData.head.sha,
                status: 'completed',
                conclusion: run.conclusion,
                output: { title: null, summary: run.output_summary, text: null },
                app: { id: null },
              })),
            },
          };
        },
      },
      pulls_reviews: {
        createReviewComment: async (params) => {
          calls.review_comments_create += 1;
          postedInlineComments.push({
            path: params.path,
            line: params.line,
            body: params.body,
          });
          return {
            data: {
              id: postedInlineComments.length,
              body: params.body,
              path: params.path,
              line: params.line,
              user: null,
            },
          };
        },
        listReviewComments: async () => {
          calls.review_comments_list += 1;
          return {
            data: priorReviewComments.map((c) => ({
              id: c.id,
              body: c.body,
              path: c.path,
              line: c.line,
              user: null,
            })),
          };
        },
      },
      issues: {
        createComment: async () => ({ data: { id: 1, body: null, user: null } }),
        getComment: async () => ({ data: { id: 1, body: null, user: null } }),
      },
      reactions: {
        createForIssueComment: async () => ({ data: { id: 1 } }),
      },
    },
  };

  return { octokit, calls, postedInlineComments, checkRunUpdates };
};
