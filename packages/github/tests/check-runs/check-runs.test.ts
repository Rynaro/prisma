import { describe, expect, it } from 'vitest';
import { CheckRunInputError, buildCheckRunsClient } from '../../src/check-runs/index.js';
import type {
  ChecksCreateParams,
  ChecksListItemData,
  ChecksUpdateParams,
  OctokitLike,
} from '../../src/installation-auth/index.js';

interface FakeOctokit extends OctokitLike {
  createCalls: ChecksCreateParams[];
  updateCalls: ChecksUpdateParams[];
  listForRefCalls: Array<{ owner: string; repo: string; ref: string; app_id?: number }>;
  setListForRefData: (data: ChecksListItemData[]) => void;
  setNextCreateError: (err: unknown) => void;
}

const buildFake = (): FakeOctokit => {
  let listForRefData: ChecksListItemData[] = [];
  let nextCreateError: unknown;
  const fake: Partial<FakeOctokit> = {};
  fake.createCalls = [];
  fake.updateCalls = [];
  fake.listForRefCalls = [];
  fake.setListForRefData = (data) => {
    listForRefData = data;
  };
  fake.setNextCreateError = (err) => {
    nextCreateError = err;
  };
  fake.rest = {
    pulls: {
      get: async () => ({
        data: { number: 1, head: { sha: 'a', ref: 'm' }, base: { sha: 'b', ref: 'm' } },
      }),
      listFiles: async () => ({ data: [] }),
    },
    checks: {
      create: async (params) => {
        if (nextCreateError !== undefined) {
          const err = nextCreateError;
          nextCreateError = undefined;
          throw err;
        }
        fake.createCalls?.push(params);
        return { data: { id: 999 } };
      },
      update: async (params) => {
        fake.updateCalls?.push(params);
        return { data: { id: params.check_run_id } };
      },
      listForRef: async (params) => {
        fake.listForRefCalls?.push(params);
        return { data: { check_runs: listForRefData } };
      },
    },
    pulls_reviews: {
      createReviewComment: async () => ({
        data: { id: 1, body: '', path: '', line: null, user: null },
      }),
      listReviewComments: async () => ({ data: [] }),
    },
  };
  return fake as FakeOctokit;
};

describe('CheckRunsClient', () => {
  it('startInProgress issues the right Octokit call and returns the id', async () => {
    const fake = buildFake();
    const client = buildCheckRunsClient(fake);
    const result = await client.startInProgress({
      owner: 'o',
      repo: 'r',
      head_sha: 'h',
      name: 'AI Code Review',
      details_url: 'https://example.com',
    });
    expect(result.check_run_id).toBe(999);
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.createCalls[0]).toMatchObject({
      owner: 'o',
      repo: 'r',
      head_sha: 'h',
      name: 'AI Code Review',
      status: 'in_progress',
      details_url: 'https://example.com',
    });
  });

  it("finalize with conclusion 'success' issues the right update call", async () => {
    const fake = buildFake();
    const client = buildCheckRunsClient(fake);
    await client.finalize({
      owner: 'o',
      repo: 'r',
      check_run_id: 12,
      conclusion: 'success',
      title: 'AI Code Review — done',
      summary: 'all good',
    });
    expect(fake.updateCalls).toHaveLength(1);
    expect(fake.updateCalls[0]).toMatchObject({
      owner: 'o',
      repo: 'r',
      check_run_id: 12,
      status: 'completed',
      conclusion: 'success',
      output: { title: 'AI Code Review — done', summary: 'all good' },
    });
  });

  it('finalize rejects when title.length > 60', async () => {
    const fake = buildFake();
    const client = buildCheckRunsClient(fake);
    await expect(
      client.finalize({
        owner: 'o',
        repo: 'r',
        check_run_id: 1,
        conclusion: 'neutral',
        title: 'x'.repeat(61),
        summary: 'body',
      }),
    ).rejects.toBeInstanceOf(CheckRunInputError);
    expect(fake.updateCalls).toHaveLength(0);
  });

  it('listOurs filters to app_id and returns the trimmed shape', async () => {
    const fake = buildFake();
    fake.setListForRefData([
      {
        id: 1,
        name: 'AI Code Review',
        head_sha: 'h',
        status: 'completed',
        conclusion: 'success',
        output: { title: 't', summary: 's', text: null },
        app: { id: 42 },
      },
      {
        id: 2,
        name: 'OtherCheck',
        head_sha: 'h',
        status: 'completed',
        conclusion: 'failure',
        output: { title: 'x', summary: 'y', text: null },
        app: { id: 7 },
      },
    ]);
    const client = buildCheckRunsClient(fake);
    const out = await client.listOurs({ owner: 'o', repo: 'r', ref: 'h', app_id: 42 });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: 1, conclusion: 'success', output_summary: 's' });
    expect(fake.listForRefCalls[0]).toMatchObject({ app_id: 42 });
  });

  it('Octokit error is propagated and not swallowed', async () => {
    const fake = buildFake();
    fake.setNextCreateError(new Error('boom'));
    const client = buildCheckRunsClient(fake);
    await expect(
      client.startInProgress({ owner: 'o', repo: 'r', head_sha: 'h', name: 'n' }),
    ).rejects.toThrow('boom');
  });
});
