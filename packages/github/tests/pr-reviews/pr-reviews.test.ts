import { describe, expect, it } from 'vitest';
import type {
  OctokitLike,
  PullsCreateReviewParams,
  PullsDismissReviewParams,
  PullsReviewData,
} from '../../src/installation-auth/index.js';
import {
  PR_REVIEWS_MODULE,
  PR_REVIEW_BODY_MAX_BYTES,
  PrReviewInputError,
  buildPrReviewsClient,
} from '../../src/pr-reviews/index.js';

interface FakeOctokit extends OctokitLike {
  createReviewCalls: PullsCreateReviewParams[];
  dismissReviewCalls: PullsDismissReviewParams[];
  setListPages: (pages: PullsReviewData[][]) => void;
  listCalls: Array<{ page?: number; per_page?: number }>;
}

const buildFake = (): FakeOctokit => {
  let listPages: PullsReviewData[][] = [];
  const fake: Partial<FakeOctokit> = {};
  fake.createReviewCalls = [];
  fake.dismissReviewCalls = [];
  fake.listCalls = [];
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
      createReview: async (params) => {
        fake.createReviewCalls?.push(params);
        return {
          data: {
            id: 9001,
            state: 'APPROVED',
            body: params.body,
            user: { login: 'prisma-bot[bot]', type: 'Bot' },
            commit_id: params.commit_id,
          },
        };
      },
      listReviews: async (params) => {
        const entry: { page?: number; per_page?: number } = {};
        if (params.page !== undefined) entry.page = params.page;
        if (params.per_page !== undefined) entry.per_page = params.per_page;
        fake.listCalls?.push(entry);
        const idx = (params.page ?? 1) - 1;
        const data = listPages[idx] ?? [];
        return { data };
      },
      dismissReview: async (params) => {
        fake.dismissReviewCalls?.push(params);
        return { data: { id: params.review_id, state: 'DISMISSED', body: null, user: null } };
      },
    },
    issues: {
      createComment: async () => ({ data: { id: 1, body: null, user: null } }),
      getComment: async () => ({ data: { id: 1, body: null, user: null } }),
      listComments: async () => ({ data: [] }),
    },
    reactions: {
      createForIssueComment: async () => ({ data: { id: 1 } }),
    },
  };
  return fake as FakeOctokit;
};

const review = (overrides: Partial<PullsReviewData> = {}): PullsReviewData => ({
  id: 1,
  state: 'APPROVED',
  body: null,
  user: { login: 'prisma-bot[bot]', type: 'Bot' },
  ...overrides,
});

describe('PR_REVIEWS_MODULE', () => {
  it('is the stable module marker', () => {
    expect(PR_REVIEWS_MODULE).toBe('pr-reviews');
  });
});

describe('buildPrReviewsClient — findOurApproval', () => {
  it('returns null when no review exists', async () => {
    const fake = buildFake();
    const client = buildPrReviewsClient(fake);
    const result = await client.findOurApproval({
      owner: 'o',
      repo: 'r',
      pull_number: 1,
      app_login: 'prisma-bot',
    });
    expect(result).toBeNull();
  });

  it('matches only a Bot user whose login is `${app_login}[bot]`', async () => {
    const fake = buildFake();
    fake.setListPages([
      [
        review({ id: 1, user: { login: 'someone-else[bot]', type: 'Bot' } }),
        review({ id: 2, user: { login: 'prisma-bot[bot]', type: 'User' } }),
        review({ id: 3, user: { login: 'prisma-bot', type: 'Bot' } }),
      ],
    ]);
    const client = buildPrReviewsClient(fake);
    const result = await client.findOurApproval({
      owner: 'o',
      repo: 'r',
      pull_number: 1,
      app_login: 'prisma-bot',
    });
    expect(result).toBeNull();
  });

  it('ignores a DISMISSED review of ours', async () => {
    const fake = buildFake();
    fake.setListPages([[review({ id: 5, state: 'DISMISSED' })]]);
    const client = buildPrReviewsClient(fake);
    const result = await client.findOurApproval({
      owner: 'o',
      repo: 'r',
      pull_number: 1,
      app_login: 'prisma-bot',
    });
    expect(result).toBeNull();
  });

  it('finds an undismissed APPROVED review of ours, carrying its commit_id', async () => {
    const fake = buildFake();
    fake.setListPages([[review({ id: 42, commit_id: 'deadbeef' })]]);
    const client = buildPrReviewsClient(fake);
    const result = await client.findOurApproval({
      owner: 'o',
      repo: 'r',
      pull_number: 1,
      app_login: 'prisma-bot',
    });
    expect(result).toEqual({ id: 42, commit_id: 'deadbeef' });
  });

  it('paginates until a short page is returned, keeping the most recent match', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => review({ id: i + 1 }));
    const fake = buildFake();
    fake.setListPages([fullPage, [review({ id: 999 })]]);
    const client = buildPrReviewsClient(fake);
    const result = await client.findOurApproval({
      owner: 'o',
      repo: 'r',
      pull_number: 1,
      app_login: 'prisma-bot',
    });
    expect(fake.listCalls).toEqual([
      { page: 1, per_page: 100 },
      { page: 2, per_page: 100 },
    ]);
    expect(result?.id).toBe(999);
  });
});

describe('buildPrReviewsClient — approve', () => {
  it('submits event: APPROVE exactly, never any other event', async () => {
    const fake = buildFake();
    const client = buildPrReviewsClient(fake);
    await client.approve({
      owner: 'o',
      repo: 'r',
      pull_number: 1,
      commit_id: 'sha123',
      body: 'nice work',
    });
    expect(fake.createReviewCalls).toHaveLength(1);
    expect(fake.createReviewCalls[0]?.event).toBe('APPROVE');
    expect(fake.createReviewCalls[0]?.commit_id).toBe('sha123');
    expect(fake.createReviewCalls[0]?.body).toBe('nice work');
  });

  it('returns the created review_id', async () => {
    const fake = buildFake();
    const client = buildPrReviewsClient(fake);
    const result = await client.approve({
      owner: 'o',
      repo: 'r',
      pull_number: 1,
      commit_id: 'sha123',
      body: 'nice work',
    });
    expect(result).toEqual({ review_id: 9001 });
  });

  it('throws PrReviewInputError on an oversize body and does not call the API', async () => {
    const fake = buildFake();
    const client = buildPrReviewsClient(fake);
    const oversized = 'x'.repeat(PR_REVIEW_BODY_MAX_BYTES + 1);
    await expect(
      client.approve({
        owner: 'o',
        repo: 'r',
        pull_number: 1,
        commit_id: 'sha123',
        body: oversized,
      }),
    ).rejects.toBeInstanceOf(PrReviewInputError);
    expect(fake.createReviewCalls).toHaveLength(0);
  });
});

describe('buildPrReviewsClient — dismiss', () => {
  it('dismisses the given review id with the supplied message', async () => {
    const fake = buildFake();
    const client = buildPrReviewsClient(fake);
    await client.dismiss({
      owner: 'o',
      repo: 'r',
      pull_number: 1,
      review_id: 42,
      message: 'stale',
    });
    expect(fake.dismissReviewCalls).toEqual([
      { owner: 'o', repo: 'r', pull_number: 1, review_id: 42, message: 'stale' },
    ]);
  });
});
