import type { OctokitLike } from '../installation-auth/client.js';

/**
 * `review-comments` module — preserves the Phase 4 marker
 * `REVIEW_COMMENTS_MODULE` for the smoke test, plus the Phase 5.5 typed
 * client for the GitHub Pull Request Review Comments API.
 *
 * Per `docs/system-design.md` § packages/github/review-comments: only invoked
 * for findings whose `render_target = 'inline'` after caps and thresholds.
 * The publisher does not edit or delete prior inline comments in MVP (per
 * `publication-policy.md` § Re-run behavior on synchronize).
 */

export const REVIEW_COMMENTS_MODULE = 'review-comments';

/**
 * Cap on body length we are willing to send. GitHub documents a 65,536 byte
 * cap on issue and review comment bodies; we use 64 KiB (UTF-8 byte length)
 * as our internal ceiling. Larger bodies are rejected — the publisher is
 * expected to render summaries that fit in this budget.
 */
export const REVIEW_COMMENT_BODY_MAX_BYTES = 64 * 1024;

export class ReviewCommentInputError extends Error {
  override readonly name = 'ReviewCommentInputError' as const;
  readonly code: 'body_too_large';
  constructor(code: 'body_too_large', message: string) {
    super(message);
    this.code = code;
  }
}

export interface ReviewCommentsClient {
  postInline(args: {
    owner: string;
    repo: string;
    pull_number: number;
    commit_sha: string;
    path: string;
    line: number;
    body: string;
  }): Promise<{ id: number }>;
  listOurs(args: {
    owner: string;
    repo: string;
    pull_number: number;
    app_login: string;
  }): Promise<Array<{ id: number; path: string; line: number | null; body: string }>>;
}

const DEFAULT_PER_PAGE = 100;

const utf8ByteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

export const buildReviewCommentsClient = (octokit: OctokitLike): ReviewCommentsClient => ({
  async postInline(args): Promise<{ id: number }> {
    if (utf8ByteLength(args.body) > REVIEW_COMMENT_BODY_MAX_BYTES) {
      throw new ReviewCommentInputError(
        'body_too_large',
        `review-comment body exceeds ${REVIEW_COMMENT_BODY_MAX_BYTES} bytes`,
      );
    }
    const response = await octokit.rest.pulls_reviews.createReviewComment({
      owner: args.owner,
      repo: args.repo,
      pull_number: args.pull_number,
      body: args.body,
      commit_id: args.commit_sha,
      path: args.path,
      line: args.line,
    });
    return { id: response.data.id };
  },

  async listOurs(
    args,
  ): Promise<Array<{ id: number; path: string; line: number | null; body: string }>> {
    const accumulated: Array<{
      id: number;
      path: string;
      line: number | null;
      body: string;
    }> = [];
    let page = 1;
    const expectedLogin = `${args.app_login}[bot]`;
    // Octokit pagination: fetch until a short page is returned.
    while (true) {
      const response = await octokit.rest.pulls_reviews.listReviewComments({
        owner: args.owner,
        repo: args.repo,
        pull_number: args.pull_number,
        per_page: DEFAULT_PER_PAGE,
        page,
      });
      const batch = response.data;
      for (const comment of batch) {
        if (comment.user === null) continue;
        if (comment.user.type !== 'Bot') continue;
        if (comment.user.login !== expectedLogin) continue;
        accumulated.push({
          id: comment.id,
          path: comment.path,
          line: comment.line,
          body: comment.body,
        });
      }
      if (batch.length < DEFAULT_PER_PAGE) break;
      page += 1;
    }
    return accumulated;
  },
});
