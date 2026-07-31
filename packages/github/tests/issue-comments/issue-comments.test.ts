import { describe, expect, it } from 'vitest';
import type {
  IssueCommentData,
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
  setListPages: (pages: IssueCommentData[][]) => void;
  listCalls: Array<{ page?: number; per_page?: number }>;
}

const buildFake = (): FakeOctokit => {
  let getCommentUser: { login: string; type: string } = { login: 'alice', type: 'User' };
  let listPages: IssueCommentData[][] = [];
  const fake: Partial<FakeOctokit> = {};
  fake.createCommentCalls = [];
  fake.getCommentCalls = [];
  fake.reactionCalls = [];
  fake.listCalls = [];
  fake.setGetCommentUser = (login, type) => {
    getCommentUser = { login, type };
  };
  fake.setListPages = (pages) => {
    listPages = pages;
  };
  fake.rest = {
    pulls: {
      get: async () => ({
        data: {
          number: 1,
          head: { sha: 'a', ref: 'm' },
          base: { sha: 'b', ref: 'm' },
          title: 'test PR',
          body: null,
        },
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
      createReview: async () => ({
        data: { id: 1, state: 'APPROVED', body: '', user: null },
      }),
      listReviews: async () => ({ data: [] }),
      dismissReview: async () => ({
        data: { id: 1, state: 'DISMISSED', body: '', user: null },
      }),
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
      listComments: async (params) => {
        const entry: { page?: number; per_page?: number } = {};
        if (params.page !== undefined) entry.page = params.page;
        if (params.per_page !== undefined) entry.per_page = params.per_page;
        fake.listCalls?.push(entry);
        const idx = (params.page ?? 1) - 1;
        const data = listPages[idx] ?? [];
        return { data };
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

  describe('listOurs', () => {
    it('filters out non-bot and other-login comments', async () => {
      const fake = buildFake();
      fake.setListPages([
        [
          { id: 1, body: 'mine', user: { login: 'prisma-bot[bot]', type: 'Bot' } },
          { id: 2, body: 'human', user: { login: 'alice', type: 'User' } },
          { id: 3, body: 'other-bot', user: { login: 'other[bot]', type: 'Bot' } },
        ],
      ]);
      const client = buildIssueCommentsClient(fake);
      const out = await client.listOurs({
        owner: 'o',
        repo: 'r',
        issue_number: 42,
        app_login: 'prisma-bot',
      });
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({ id: 1, body: 'mine' });
    });

    it('paginates if needed', async () => {
      const fake = buildFake();
      const fullPage: IssueCommentData[] = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        body: `b${i}`,
        user: { login: 'prisma-bot[bot]', type: 'Bot' },
      }));
      fake.setListPages([
        fullPage,
        [{ id: 999, body: 'last', user: { login: 'prisma-bot[bot]', type: 'Bot' } }],
      ]);
      const client = buildIssueCommentsClient(fake);
      const out = await client.listOurs({
        owner: 'o',
        repo: 'r',
        issue_number: 42,
        app_login: 'prisma-bot',
      });
      expect(out).toHaveLength(101);
      expect(fake.listCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('returns an empty array on the fail-open path (no bot comments)', async () => {
      const fake = buildFake();
      fake.setListPages([[]]);
      const client = buildIssueCommentsClient(fake);
      const out = await client.listOurs({
        owner: 'o',
        repo: 'r',
        issue_number: 42,
        app_login: 'prisma-bot',
      });
      expect(out).toEqual([]);
    });
  });
});
