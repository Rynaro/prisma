import {
  buildCheckRunsClient,
  buildIssueCommentsClient,
  buildReviewCommentsClient,
} from '@prisma-bot/github';
import { type AskResult, runAsk } from '@prisma-bot/github-app';
import { FakeProvider } from '@prisma-bot/provider-fake';
import type { RespondPrMeta } from '@prisma-bot/shared';
import { buildFakeOctokit } from './octokit-fake.js';
import { type ChangedFileEntry, type ScenarioFixture, mergeConfig } from './schema.js';

/**
 * Wires a reviewer-interaction (`ask_request` present) `ScenarioFixture`
 * through `runAsk` (`@prisma-bot/github-app`) using the same hand-rolled
 * `OctokitLike` (`buildFakeOctokit`) as the review-pipeline runner, plus a
 * key-less `FakeProvider` (deterministic `respond()` per spec § 6).
 *
 * Kept as a separate runner from `pipeline-runner.ts` — `runAsk` is not part
 * of `runPipeline`; the two entry points share only the fake octokit and the
 * config-merge helper.
 */

const REPO_IDENTITY = {
  owner: 'octocat',
  repo: 'hello-world',
  app_id: 999,
  app_login: 'prisma-bot',
};

export interface AskRunOutcome {
  result: AskResult;
  /** Count of `provider.respond()` calls observed this run. */
  provider_calls: number;
}

export interface RunAskForFixtureArgs {
  fixture: ScenarioFixture;
  filesPayload: ChangedFileEntry[];
}

export const runAskForFixture = async (args: RunAskForFixtureArgs): Promise<AskRunOutcome> => {
  const { fixture } = args;
  if (fixture.ask_request === undefined) {
    throw new Error(`fixture ${fixture.id} has no ask_request (not an interaction scenario)`);
  }

  const config = mergeConfig(fixture.config_overrides);
  const octokitHandle = buildFakeOctokit({
    responses: fixture.octokit_responses,
    filesPayload: args.filesPayload,
  });
  const provider = new FakeProvider({ script: [] });

  const checkRuns = buildCheckRunsClient(octokitHandle.octokit);
  const reviewComments = buildReviewCommentsClient(octokitHandle.octokit);
  const issueComments = buildIssueCommentsClient(octokitHandle.octokit);

  const pull_request_number = fixture.pr_payload.pull_request.number;
  const prResp = await octokitHandle.octokit.rest.pulls.get({
    owner: REPO_IDENTITY.owner,
    repo: REPO_IDENTITY.repo,
    pull_number: pull_request_number,
  });
  const pr: RespondPrMeta = {
    title: prResp.data.title,
    description: prResp.data.body ?? '',
    base_ref: prResp.data.base.ref,
    head_ref: prResp.data.head.ref,
    head_sha: prResp.data.head.sha,
  };

  const result = await runAsk(
    { checkRuns, reviewComments, issueComments, provider },
    {
      owner: REPO_IDENTITY.owner,
      repo: REPO_IDENTITY.repo,
      pull_request_number,
      head_sha: prResp.data.head.sha,
      app_id: REPO_IDENTITY.app_id,
      app_login: REPO_IDENTITY.app_login,
    },
    {
      author_login: fixture.ask_request.commenter_login,
      message: fixture.ask_request.message,
      interactions: config.interactions,
      pr,
      ...(config.review_guidance.instructions !== undefined
        ? { guidance: config.review_guidance.instructions }
        : {}),
    },
  );

  return { result, provider_calls: provider.respondCalls.length };
};
