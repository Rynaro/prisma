import { describe, expect, it } from 'vitest';
import type {
  IssuesCreateCommentParams,
  OctokitLike,
  ReactionsCreateForIssueCommentParams,
} from '../../src/installation-auth/index.js';
import {
  ISSUE_COMMENTS_MODULE,
  IssueCommentInputError,
  buildIssueCommentsClient,
} from '../../src/issue-comments/index.js';

interface FakeOctokit extends OctokitLike {
  createCommentCalls: IssuesCreateCommentParams[];
  getCommentCalls: Array<{ owner: string; repo: string; comment_id: number }>;
  reactionCalls: ReactionsCreateForIssueCommentParams[];
  setGetCommentUser: (login: string, type: string) => void;
}

const buildFake = (): FakeOctokit => {
  let getCommentUser: { login: string; type: string } = { login: 'alice', type: 'User' };
  const fake: Partial<FakeOctokit> = {};
  fake.createCommentCalls = [];
  fake.getCommentCalls = [];
  fake.reactionCalls = [];
  fake.setGetCommentUser = (login, type) => {
    getCommentUser = { login, type };
  };
  fake.rest = {
    pulls: {
      get: async () => ({
        data: { number: 1, head: { sha: 'a', ref: 'm' }, base: { sha: 'b', ref: 'm' } },
      }),
      listFiles: async () => ({ data: [] }),
    },
    repos: {
      getContent: async () => ({ data: {} }),
    },
    checks: {
      create: async () => ({ data: { id: 1 } }),
      update: async () => ({ data: { id: 1 } }),
      listForRef: async () => ({ data: { check_runs: [] } }),
    },
    pulls_reviews: {
      createReviewComment: async () => ({
        data: { id: 1, body: '', path: '', line: null, user: null },
      }),
      listReviewComments: async () => ({ data: [] }),
    },
    issues: {
      createComment: async (params) => {
        fake.createCommentCalls?.push(params);
        return {
          data: { id: 9001, body: params.body, user: { login: 'prisma-bot[bot]', type: 'Bot' } },
        };
      },
      getComment: async (params) => {
        fake.getCommentCalls?.push(params);
        return { data: { id: params.comment_id, body: 'hello', user: getCommentUser } };
      },
    },
    reactions: {
      createForIssueComment: async (params) => {
        fake.reactionCalls?.push(params);
        return { data: { id: 42 } };
      },
    },
  };
  return fake as FakeOctokit;
};

describe('IssueCommentsClient', () => {
  it('module marker is defined', () => {
    expect(ISSUE_COMMENTS_MODULE).toBe('issue-comments');
  });

  describe('createReply', () => {
    it('posts the comment and returns the id', async () => {
      const fake = buildFake();
      const client = buildIssueCommentsClient(fake);
      const result = await client.createReply({
        owner: 'o',
        repo: 'r',
        issue_number: 42,
        body: 'Hello!',
      });
      expect(result.id).toBe(9001);
      expect(fake.createCommentCalls).toHaveLength(1);
      expect(fake.createCommentCalls[0]).toMatchObject({
        owner: 'o',
        repo: 'r',
        issue_number: 42,
        body: 'Hello!',
      });
    });

    it('throws IssueCommentInputError when body exceeds 64 KiB', async () => {
      const fake = buildFake();
      const client = buildIssueCommentsClient(fake);
      const oversized = 'a'.repeat(64 * 1024 + 1);
      await expect(
        client.createReply({ owner: 'o', repo: 'r', issue_number: 1, body: oversized }),
      ).rejects.toBeInstanceOf(IssueCommentInputError);
      expect(fake.createCommentCalls).toHaveLength(0);
    });

    it('accepts body of exactly 64 KiB', async () => {
      const fake = buildFake();
      const client = buildIssueCommentsClient(fake);
      const maxBody = 'a'.repeat(64 * 1024);
      const result = await client.createReply({
        owner: 'o',
        repo: 'r',
        issue_number: 1,
        body: maxBody,
      });
      expect(result.id).toBe(9001);
    });
  });

  describe('getAuthor', () => {
    it('returns the login when user is present', async () => {
      const fake = buildFake();
      fake.setGetCommentUser('alice', 'User');
      const client = buildIssueCommentsClient(fake);
      const login = await client.getAuthor({ owner: 'o', repo: 'r', comment_id: 777 });
      expect(login).toBe('alice');
      expect(fake.getCommentCalls).toHaveLength(1);
      expect(fake.getCommentCalls[0]).toMatchObject({ owner: 'o', repo: 'r', comment_id: 777 });
    });

    it('returns null when user is null', async () => {
      const fake = buildFake();
      const client = buildIssueCommentsClient(fake);
      // Override getComment to return null user
      fake.rest.issues.getComment = async (params) => {
        fake.getCommentCalls?.push(params);
        return { data: { id: params.comment_id, body: null, user: null } };
      };
      const login = await client.getAuthor({ owner: 'o', repo: 'r', comment_id: 1 });
      expect(login).toBeNull();
    });
  });

  describe('addReaction', () => {
    it('posts the eyes reaction', async () => {
      const fake = buildFake();
      const client = buildIssueCommentsClient(fake);
      await client.addReaction({ owner: 'o', repo: 'r', comment_id: 123, content: 'eyes' });
      expect(fake.reactionCalls).toHaveLength(1);
      expect(fake.reactionCalls[0]).toMatchObject({
        owner: 'o',
        repo: 'r',
        comment_id: 123,
        content: 'eyes',
      });
    });

    it('posts the +1 reaction', async () => {
      const fake = buildFake();
      const client = buildIssueCommentsClient(fake);
      await client.addReaction({ owner: 'o', repo: 'r', comment_id: 456, content: '+1' });
      expect(fake.reactionCalls).toHaveLength(1);
      expect(fake.reactionCalls[0]?.content).toBe('+1');
    });
  });
});
