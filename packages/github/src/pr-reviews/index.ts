import type { OctokitLike } from '../installation-auth/client.js';

/**
 * `pr-reviews` module — a thin typed shim over the GitHub PR-review-submission
 * surface (`pulls.createReview` / `listReviews` / `dismissReview`), mirroring
 * `review-comments` (module marker, body byte cap, bot-login match,
 * page-until-short pagination). No business logic lives here: "is this run
 * clean, should we approve" is decided by the planner (`publisher/planner.ts`);
 * this module only knows how to submit, find, and dismiss a review.
 *
 * Per spec § D.2: this App submits approvals only. `event: 'APPROVE'` is the
 * only value the seam's `createReview` type admits — `REQUEST_CHANGES` is
 * unrepresentable.
 */

export const PR_REVIEWS_MODULE = 'pr-reviews';

/** GitHub caps review bodies at 65,536 bytes; we stop at 64 KiB like review comments. */
export const PR_REVIEW_BODY_MAX_BYTES = 64 * 1024;

export class PrReviewInputError extends Error {
  override readonly name = 'PrReviewInputError' as const;
  readonly code: 'body_too_large';
  constructor(code: 'body_too_large', message: string) {
    super(message);
    this.code = code;
  }
}

export interface OurApproval {
  id: number;
  commit_id?: string | null;
}

export interface PrReviewsClient {
  /**
   * This App's most recent review on the PR whose `state === 'APPROVED'`, or
   * null. Login match is identical to `ReviewCommentsClient.listOurs`:
   * `user.type === 'Bot'` and `user.login === `${app_login}[bot]``. A
   * dismissed approval reports `state === 'DISMISSED'` and therefore does not
   * match.
   */
  findOurApproval(args: {
    owner: string;
    repo: string;
    pull_number: number;
    app_login: string;
  }): Promise<OurApproval | null>;

  /** Submit an approving review. Throws `PrReviewInputError` on an oversize body. */
  approve(args: {
    owner: string;
    repo: string;
    pull_number: number;
    commit_id: string;
    body: string;
  }): Promise<{ review_id: number }>;

  /** Dismiss one of our own approvals. */
  dismiss(args: {
    owner: string;
    repo: string;
    pull_number: number;
    review_id: number;
    message: string;
  }): Promise<void>;
}

const DEFAULT_PER_PAGE = 100;

const utf8ByteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

export const buildPrReviewsClient = (octokit: OctokitLike): PrReviewsClient => ({
  async findOurApproval(args): Promise<OurApproval | null> {
    const expectedLogin = `${args.app_login}[bot]`;
    let match: OurApproval | null = null;
    let page = 1;
    // Octokit pagination: fetch until a short page is returned. Reviews are
    // returned in submission order; when we hold more than one matching
    // APPROVED entry (which should not normally happen — a stale approval is
    // dismissed, not superseded), the last one wins so we track the most
    // recent state.
    while (true) {
      const response = await octokit.rest.pulls_reviews.listReviews({
        owner: args.owner,
        repo: args.repo,
        pull_number: args.pull_number,
        per_page: DEFAULT_PER_PAGE,
        page,
      });
      const batch = response.data;
      for (const review of batch) {
        if (review.user === null) continue;
        if (review.user.type !== 'Bot') continue;
        if (review.user.login !== expectedLogin) continue;
        if (review.state !== 'APPROVED') continue;
        match = { id: review.id, commit_id: review.commit_id ?? null };
      }
      if (batch.length < DEFAULT_PER_PAGE) break;
      page += 1;
    }
    return match;
  },

  async approve(args): Promise<{ review_id: number }> {
    if (utf8ByteLength(args.body) > PR_REVIEW_BODY_MAX_BYTES) {
      throw new PrReviewInputError(
        'body_too_large',
        `pr-review body exceeds ${PR_REVIEW_BODY_MAX_BYTES} bytes`,
      );
    }
    const response = await octokit.rest.pulls_reviews.createReview({
      owner: args.owner,
      repo: args.repo,
      pull_number: args.pull_number,
      event: 'APPROVE',
      body: args.body,
      commit_id: args.commit_id,
    });
    return { review_id: response.data.id };
  },

  async dismiss(args): Promise<void> {
    await octokit.rest.pulls_reviews.dismissReview({
      owner: args.owner,
      repo: args.repo,
      pull_number: args.pull_number,
      review_id: args.review_id,
      message: args.message,
    });
  },
});
