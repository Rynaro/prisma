import type { OctokitLike } from '../installation-auth/client.js';

/**
 * `issue-comments` module — typed client for the GitHub Issues Comments API
 * (which also covers PR conversation comments, since PRs are issues in the
 * GitHub data model).
 *
 * Mirrors the structure of `review-comments/index.ts` and follows the same
 * ports-and-adapters pattern: the interface is the seam; callers never touch
 * `OctokitLike` directly.
 *
 * Per `docs/system-design.md` § packages/github/issue-comments: used by the
 * worker to post 👀/✅ reactions and reply comments for the ack protocol, and
 * for `help`/`configuration` command replies.
 */

export const ISSUE_COMMENTS_MODULE = 'issue-comments';

/**
 * Cap on body length we are willing to send.  GitHub documents a 65,536 byte
 * cap on issue/PR comment bodies; we use the same 64 KiB internal ceiling as
 * `review-comments`.
 */
export const ISSUE_COMMENT_BODY_MAX_BYTES = 64 * 1024;

export class IssueCommentInputError extends Error {
  override readonly name = 'IssueCommentInputError' as const;
  readonly code: 'body_too_large';
  constructor(code: 'body_too_large', message: string) {
    super(message);
    this.code = code;
  }
}

/** Reaction content accepted by this client (👀 and ✅ are the ack protocol values). */
export type ReactionContent = 'eyes' | '+1';

export interface IssueCommentsClient {
  /**
   * Post a reply comment on an issue/PR conversation.
   * Throws `IssueCommentInputError` if the body exceeds 64 KiB.
   */
  createReply(args: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }): Promise<{ id: number }>;

  /**
   * Fetch the author login of a comment by id.  Returns null when the
   * comment has no user (rare, but possible for deleted accounts).
   */
  getAuthor(args: {
    owner: string;
    repo: string;
    comment_id: number;
  }): Promise<string | null>;

  /**
   * Add a reaction to an issue/PR comment.
   * Fail-open: callers MUST catch and swallow errors (ack is non-critical).
   */
  addReaction(args: {
    owner: string;
    repo: string;
    comment_id: number;
    content: ReactionContent;
  }): Promise<void>;
}

const utf8ByteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

export const buildIssueCommentsClient = (octokit: OctokitLike): IssueCommentsClient => ({
  async createReply(args): Promise<{ id: number }> {
    if (utf8ByteLength(args.body) > ISSUE_COMMENT_BODY_MAX_BYTES) {
      throw new IssueCommentInputError(
        'body_too_large',
        `issue-comment body exceeds ${ISSUE_COMMENT_BODY_MAX_BYTES} bytes`,
      );
    }
    const response = await octokit.rest.issues.createComment({
      owner: args.owner,
      repo: args.repo,
      issue_number: args.issue_number,
      body: args.body,
    });
    return { id: response.data.id };
  },

  async getAuthor(args): Promise<string | null> {
    const response = await octokit.rest.issues.getComment({
      owner: args.owner,
      repo: args.repo,
      comment_id: args.comment_id,
    });
    return response.data.user?.login ?? null;
  },

  async addReaction(args): Promise<void> {
    await octokit.rest.reactions.createForIssueComment({
      owner: args.owner,
      repo: args.repo,
      comment_id: args.comment_id,
      content: args.content,
    });
  },
});
