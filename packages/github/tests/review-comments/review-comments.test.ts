import { describe, expect, it } from 'vitest';
import type {
  OctokitLike,
  PullsCreateReviewCommentParams,
  PullsReviewCommentData,
} from '../../src/installation-auth/index.js';
import {
  ReviewCommentInputError,
  buildReviewCommentsClient,
} from '../../src/review-comments/index.js';

interface FakeOctokit extends OctokitLike {
  createCalls: PullsCreateReviewCommentParams[];
  setListPages: (pages: PullsReviewCommentData[][]) => void;
  listCalls: Array<{ page?: number; per_page?: number }>;
}

const buildFake = (): FakeOctokit => {
  let listPages: PullsReviewCommentData[][] = [];
  const fake: Partial<FakeOctokit> = {};
  fake.createCalls = [];
  fake.listCalls = [];
  fake.setListPages = (pages) => {
    listPages = pages;
  };
  fake.rest = {
    pulls: {
      get: async () => ({
        data: { number: 1, head: { sha: 'a', ref: 'm' }, base: { sha: 'b', ref: 'm' } },
      }),
      listFiles: async () => ({ data: [] }),
    },
    checks: {
      create: async () => ({ data: { id: 1 } }),
      update: async () => ({ data: { id: 1 } }),
      listForRef: async () => ({ data: { check_runs: [] } }),
    },
    pulls_reviews: {
      createReviewComment: async (params) => {
        fake.createCalls?.push(params);
        return {
          data: {
            id: 1234,
            body: params.body,
            path: params.path,
            line: params.line,
            user: { login: 'prisma-bot[bot]', type: 'Bot' },
          },
        };
      },
      listReviewComments: async (params) => {
        const entry: { page?: number; per_page?: number } = {};
        if (params.page !== undefined) entry.page = params.page;
        if (params.per_page !== undefined) entry.per_page = params.per_page;
        fake.listCalls?.push(entry);
        const idx = (params.page ?? 1) - 1;
        const data = listPages[idx] ?? [];
        return { data };
      },
    },
  };
  return fake as FakeOctokit;
};

describe('ReviewCommentsClient', () => {
  it('postInline issues the right Octokit call', async () => {
    const fake = buildFake();
    const client = buildReviewCommentsClient(fake);
    const result = await client.postInline({
      owner: 'o',
      repo: 'r',
      pull_number: 7,
      commit_sha: 'sha',
      path: 'src/a.ts',
      line: 12,
      body: 'hello',
    });
    expect(result.id).toBe(1234);
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.createCalls[0]).toMatchObject({
      owner: 'o',
      repo: 'r',
      pull_number: 7,
      commit_id: 'sha',
      path: 'src/a.ts',
      line: 12,
      body: 'hello',
    });
  });

  it('listOurs filters out other-user comments', async () => {
    const fake = buildFake();
    fake.setListPages([
      [
        {
          id: 1,
          body: 'mine',
          path: 'a.ts',
          line: 10,
          user: { login: 'prisma-bot[bot]', type: 'Bot' },
        },
        {
          id: 2,
          body: 'human',
          path: 'a.ts',
          line: 11,
          user: { login: 'alice', type: 'User' },
        },
        {
          id: 3,
          body: 'other-bot',
          path: 'a.ts',
          line: 12,
          user: { login: 'other-bot[bot]', type: 'Bot' },
        },
      ],
    ]);
    const client = buildReviewCommentsClient(fake);
    const out = await client.listOurs({
      owner: 'o',
      repo: 'r',
      pull_number: 7,
      app_login: 'prisma-bot',
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe(1);
  });

  it('listOurs paginates if needed', async () => {
    const fake = buildFake();
    // Build a full page (100 items) of bot comments to force a second fetch.
    const fullPage: PullsReviewCommentData[] = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: `b${i}`,
      path: 'a.ts',
      line: i + 1,
      user: { login: 'prisma-bot[bot]', type: 'Bot' },
    }));
    fake.setListPages([
      fullPage,
      [
        {
          id: 999,
          body: 'last',
          path: 'a.ts',
          line: 999,
          user: { login: 'prisma-bot[bot]', type: 'Bot' },
        },
      ],
    ]);
    const client = buildReviewCommentsClient(fake);
    const out = await client.listOurs({
      owner: 'o',
      repo: 'r',
      pull_number: 7,
      app_login: 'prisma-bot',
    });
    expect(out).toHaveLength(101);
    expect(fake.listCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects with a typed error when the body exceeds 64 KiB', async () => {
    const fake = buildFake();
    const client = buildReviewCommentsClient(fake);
    const giantBody = 'x'.repeat(64 * 1024 + 1);
    await expect(
      client.postInline({
        owner: 'o',
        repo: 'r',
        pull_number: 7,
        commit_sha: 'sha',
        path: 'src/a.ts',
        line: 12,
        body: giantBody,
      }),
    ).rejects.toBeInstanceOf(ReviewCommentInputError);
    expect(fake.createCalls).toHaveLength(0);
  });
});
