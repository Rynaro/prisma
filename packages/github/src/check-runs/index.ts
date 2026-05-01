import type { OctokitLike } from '../installation-auth/client.js';

/**
 * `check-runs` module — preserves the Phase 4 marker `CHECK_RUNS_MODULE` for
 * the smoke test, plus the Phase 5.5 typed client for the GitHub Checks API.
 *
 * Per `docs/system-design.md` § packages/github/check-runs: the Checks run is
 * owned by the App identity; the conclusion is one of `success`, `neutral`, or
 * `failure` per `publication-policy.md`. This module is a thin typed shim
 * over `octokit.rest.checks.*` — no business logic; the publisher decides
 * what to publish, the client decides how.
 */

export const CHECK_RUNS_MODULE = 'check-runs';

/** Maximum length of the Checks run output title (per GitHub's documented limit). */
export const CHECK_RUN_TITLE_MAX_LENGTH = 60;

/**
 * Thrown when caller-supplied input would violate a GitHub-side limit. The
 * publisher truncates summaries before calling, but the title is short enough
 * that callers control it directly — we reject rather than silently truncate.
 */
export class CheckRunInputError extends Error {
  override readonly name = 'CheckRunInputError' as const;
  readonly code: 'title_too_long';
  constructor(code: 'title_too_long', message: string) {
    super(message);
    this.code = code;
  }
}

export interface CheckRunsClient {
  startInProgress(args: {
    owner: string;
    repo: string;
    head_sha: string;
    name: string;
    details_url?: string;
  }): Promise<{ check_run_id: number }>;
  finalize(args: {
    owner: string;
    repo: string;
    check_run_id: number;
    conclusion: 'success' | 'neutral' | 'failure';
    title: string;
    summary: string;
  }): Promise<void>;
  listOurs(args: {
    owner: string;
    repo: string;
    ref: string;
    app_id: number;
  }): Promise<Array<{ id: number; conclusion: string | null; output_summary: string | null }>>;
}

export const buildCheckRunsClient = (octokit: OctokitLike): CheckRunsClient => ({
  async startInProgress(args): Promise<{ check_run_id: number }> {
    const params: {
      owner: string;
      repo: string;
      name: string;
      head_sha: string;
      status: 'in_progress';
      details_url?: string;
    } = {
      owner: args.owner,
      repo: args.repo,
      name: args.name,
      head_sha: args.head_sha,
      status: 'in_progress',
    };
    if (args.details_url !== undefined) {
      params.details_url = args.details_url;
    }
    const response = await octokit.rest.checks.create(params);
    return { check_run_id: response.data.id };
  },

  async finalize(args): Promise<void> {
    if (args.title.length > CHECK_RUN_TITLE_MAX_LENGTH) {
      throw new CheckRunInputError(
        'title_too_long',
        `check-run output title exceeds ${CHECK_RUN_TITLE_MAX_LENGTH} characters (got ${args.title.length})`,
      );
    }
    await octokit.rest.checks.update({
      owner: args.owner,
      repo: args.repo,
      check_run_id: args.check_run_id,
      status: 'completed',
      conclusion: args.conclusion,
      output: { title: args.title, summary: args.summary },
    });
  },

  async listOurs(
    args,
  ): Promise<Array<{ id: number; conclusion: string | null; output_summary: string | null }>> {
    const response = await octokit.rest.checks.listForRef({
      owner: args.owner,
      repo: args.repo,
      ref: args.ref,
      app_id: args.app_id,
    });
    return response.data.check_runs
      .filter((run) => run.app !== null && run.app.id === args.app_id)
      .map((run) => ({
        id: run.id,
        conclusion: run.conclusion,
        output_summary: run.output.summary,
      }));
  },
});
