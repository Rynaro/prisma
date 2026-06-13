import { type SnapshotterOctokitLike, fetchPrSnapshot, runPrefilter } from '@prisma-bot/core';
import { type InstallationAuth, buildContentFetcher } from '@prisma-bot/github';
import { type RepoIdentity, runPipeline } from '@prisma-bot/github-app';
import { FakeProvider, type FakeStep } from '@prisma-bot/provider-fake';
import {
  type CustomGuidance,
  type JobPayload,
  type ProviderError,
  type ProviderReviewOutput,
  type PublicationResult,
  type RejectionLogEntry,
  type RepoConfig,
} from '@prisma-bot/shared';
import { type FakeOctokitHandle, buildFakeOctokit } from './octokit-fake.js';
import {
  type ChangedFileEntry,
  type ProviderScriptStep,
  type ScenarioFixture,
  mergeConfig,
} from './schema.js';

/**
 * Wires a parsed `ScenarioFixture` through the Phase 5 orchestrator
 * (`runPipeline`) using a hand-rolled `OctokitLike` and a `FakeProvider`.
 * Returns a structured `RunOutcome` carrying every observable the assertion
 * layer compares against the fixture's `expectations` block.
 *
 * The orchestrator does not expose the prefilter outcome directly; the
 * runner re-derives it by independently snapshotting + prefiltering against
 * a second `OctokitLike` so the assertion layer can compare against the
 * spec's `outcome` enum (`accepted | oversized | all-excluded`).
 */

const REPO_IDENTITY: RepoIdentity = {
  owner: 'octocat',
  repo: 'hello-world',
  app_id: 999,
  app_login: 'prisma-bot',
};

const STUB_INSTALLATION_AUTH = {} as InstallationAuth;

export interface RunOutcomeError {
  message: string;
  /** When the throwable carried a typed `ProviderError`, capture its kind. */
  kind?: ProviderError['kind'];
}

export interface PrefilterMirror {
  outcome: 'accepted' | 'chunkable' | 'oversized' | 'all-excluded';
  skipped_paths: string[];
  skipped_reasons: string[];
  files_sent_to_provider: number;
}

export interface RunOutcome {
  prefilter: PrefilterMirror;
  provider: {
    calls: number;
    /** The custom_guidance from the first provider call, if any. */
    first_call_custom_guidance?: CustomGuidance;
  };
  validator: {
    findings: number;
    rejection_reasons: string[];
  };
  ranker: {
    output_size: number;
  };
  publisher: {
    inline_count: number;
    summary_count: number;
    dropped_count: number;
    publication_state: 'succeeded' | 'failed_terminal';
    summary_artifact: string;
    rejection_reasons: string[];
    expected_categories: string[];
  };
  /** Notes from config-fetch / augmentation surfaced by the orchestrator. */
  config_notes?: string[];
  publication?: PublicationResult;
  thrown?: RunOutcomeError;
}

const buildJobPayloadFromFixture = (fixture: ScenarioFixture): JobPayload => {
  const prAction = fixture.pr_payload.action;
  const eventType: JobPayload['event_type'] =
    prAction === 'opened'
      ? 'pull_request.opened'
      : prAction === 'synchronize'
        ? 'pull_request.synchronize'
        : 'pull_request.reopened';
  return {
    idempotency_key: `eval-${fixture.id}`,
    installation_id: fixture.pr_payload.installation.id,
    repository_id: fixture.pr_payload.repository.id,
    pull_request_number: fixture.pr_payload.pull_request.number,
    head_sha: fixture.pr_payload.pull_request.head.sha,
    event_type: eventType,
    received_at: '2026-05-01T00:00:00.000Z',
  };
};

const toFakeStep = (step: ProviderScriptStep): FakeStep => {
  if (step.kind === 'output') {
    const output: ProviderReviewOutput = { findings: step.output.findings };
    return { kind: 'output', output };
  }
  if (step.kind === 'output_lazy') {
    const output: ProviderReviewOutput = { findings: step.output.findings };
    return { kind: 'output', output };
  }
  // step.kind === 'error'
  const message = step.error.message;
  if (step.error.kind === 'rate_limit') {
    const value: ProviderError =
      step.error.retry_after_ms !== undefined
        ? { kind: 'rate_limit', message, retry_after_ms: step.error.retry_after_ms }
        : { kind: 'rate_limit', message };
    return { kind: 'error', error: value };
  }
  if (step.error.kind === 'capability') {
    const value: ProviderError =
      step.error.missing_capability !== undefined
        ? {
            kind: 'capability',
            message,
            missing_capability: step.error.missing_capability,
          }
        : { kind: 'capability', message };
    return { kind: 'error', error: value };
  }
  if (step.error.kind === 'schema_validation') {
    const value: ProviderError =
      step.error.zod_issues !== undefined
        ? { kind: 'schema_validation', message, zod_issues: step.error.zod_issues }
        : { kind: 'schema_validation', message };
    return { kind: 'error', error: value };
  }
  if (step.error.kind === 'auth') {
    return { kind: 'error', error: { kind: 'auth', message } };
  }
  return { kind: 'error', error: { kind: 'transport', message } };
};

const buildScript = (fixture: ScenarioFixture): FakeStep[] =>
  fixture.provider_script.map(toFakeStep);

interface DerivePrefilterArgs {
  config: RepoConfig;
  octokitHandle: FakeOctokitHandle;
  payload: JobPayload;
}

const derivePrefilterOutcome = async (args: DerivePrefilterArgs): Promise<PrefilterMirror> => {
  const snapshot = await fetchPrSnapshot({
    octokit: args.octokitHandle.octokit as unknown as SnapshotterOctokitLike,
    installation_id: args.payload.installation_id,
    repository_id: args.payload.repository_id,
    owner: REPO_IDENTITY.owner,
    repo: REPO_IDENTITY.repo,
    pull_request_number: args.payload.pull_request_number,
  });
  const prefilter = runPrefilter({ snapshot, config: args.config });
  if (prefilter.kind === 'oversized') {
    return {
      outcome: 'oversized',
      skipped_paths: prefilter.skipped.map((s) => s.path),
      skipped_reasons: Array.from(new Set(prefilter.skipped.map((s) => s.reason))),
      files_sent_to_provider: 0,
    };
  }
  const skipped_paths = prefilter.skipped.map((s) => s.path);
  const skipped_reasons = Array.from(new Set(prefilter.skipped.map((s) => s.reason)));
  if (prefilter.files.length === 0) {
    return {
      outcome: 'all-excluded',
      skipped_paths,
      skipped_reasons,
      files_sent_to_provider: 0,
    };
  }
  if (prefilter.kind === 'chunkable') {
    return {
      outcome: 'chunkable',
      skipped_paths,
      skipped_reasons,
      files_sent_to_provider: prefilter.files.length,
    };
  }
  return {
    outcome: 'accepted',
    skipped_paths,
    skipped_reasons,
    files_sent_to_provider: prefilter.files.length,
  };
};

const collectExpectedCategories = (publication: PublicationResult): string[] => {
  const set = new Set<string>();
  for (const f of publication.published_inline) set.add(f.category);
  for (const f of publication.published_summary) set.add(f.category);
  return Array.from(set);
};

const collectPublisherRejectionReasons = (publication: PublicationResult): string[] => {
  const reasons = new Set<string>();
  for (const r of publication.rejections) {
    if (r.stage !== 'publisher') continue;
    reasons.add(r.reason_code);
  }
  return Array.from(reasons);
};

export interface RunPipelineForFixtureArgs {
  fixture: ScenarioFixture;
  filesPayload: ChangedFileEntry[];
}

export const runPipelineForFixture = async (
  args: RunPipelineForFixtureArgs,
): Promise<RunOutcome> => {
  const config = mergeConfig(args.fixture.config_overrides);
  const provider = new FakeProvider({ script: buildScript(args.fixture) });
  const octokitHandle = buildFakeOctokit({
    responses: args.fixture.octokit_responses,
    filesPayload: args.filesPayload,
  });
  const payload = buildJobPayloadFromFixture(args.fixture);

  // Pre-derive the prefilter outcome by independently snapshotting +
  // prefiltering against a sibling OctokitLike. This duplicates work the
  // orchestrator performs internally, but Phase 5's `runPipeline` does not
  // surface the prefilter result; mirroring it here is the only way to satisfy
  // the fixture's `expectations.prefilter` block without modifying Phase 5
  // modules.
  const prefilterMirrorHandle = buildFakeOctokit({
    responses: args.fixture.octokit_responses,
    filesPayload: args.filesPayload,
  });
  const prefilterMirror = await derivePrefilterOutcome({
    config,
    octokitHandle: prefilterMirrorHandle,
    payload,
  });

  const validatorRejections: RejectionLogEntry[] = [];
  let publication: PublicationResult | undefined;
  let publicationState: 'succeeded' | 'failed_terminal' = 'succeeded';
  let thrown: RunOutcomeError | undefined;
  let pipelineConfigNotes: string[] | undefined;

  // Build a ContentFetcher from the fake octokit so context-file scenarios
  // exercise the full augmentation path through the real orchestrator.
  const contentFetcher = buildContentFetcher(
    octokitHandle.octokit,
    REPO_IDENTITY.owner,
    REPO_IDENTITY.repo,
  );

  try {
    const result = await runPipeline(payload, {
      installationAuth: STUB_INSTALLATION_AUTH,
      provider,
      config,
      repoLookup: async () => REPO_IDENTITY,
      octokit: octokitHandle.octokit,
      logger: { emit: () => {} },
      contentFetcher,
    });
    publicationState = result.state;
    publication = result.publication;
    pipelineConfigNotes = result.config_notes;
    for (const r of result.rejections) {
      if (r.stage === 'validator') validatorRejections.push(r);
    }
  } catch (err) {
    publicationState = 'failed_terminal';
    if (err instanceof Error) {
      thrown = { message: err.message };
    } else {
      thrown = { message: 'unknown error' };
    }
  }

  // The validator's output size equals the partition of the `PublicationResult`
  // arrays per the publisher's plan invariant (planner.ts: every input
  // finding lands in exactly one of inline / summary / dropped). The
  // orchestrator never invokes the validator in the malformed / oversized /
  // no-files paths, so the count is 0 there.
  const validatorOutputSize = publication
    ? publication.published_inline.length +
      publication.published_summary.length +
      publication.dropped.length
    : 0;

  const validatorRejectionReasonSet = new Set<string>();
  for (const r of validatorRejections) validatorRejectionReasonSet.add(r.reason_code);

  const summaryArtifact = publication?.summary_artifact ?? '';
  const inlineCount = publication?.published_inline.length ?? 0;
  const summaryCount = publication?.published_summary.length ?? 0;
  const droppedCount = publication?.dropped.length ?? 0;
  const expectedCategories = publication ? collectExpectedCategories(publication) : [];
  const publisherRejectionReasons = publication
    ? collectPublisherRejectionReasons(publication)
    : [];

  // Capture the custom_guidance from the first provider call for assertion.
  const firstCall = provider.calls[0];
  const firstCallCustomGuidance = firstCall?.custom_guidance;

  const outcome: RunOutcome = {
    prefilter: prefilterMirror,
    provider: {
      calls: provider.calls.length,
      ...(firstCallCustomGuidance !== undefined
        ? { first_call_custom_guidance: firstCallCustomGuidance }
        : {}),
    },
    validator: {
      findings: validatorOutputSize,
      rejection_reasons: Array.from(validatorRejectionReasonSet),
    },
    ranker: { output_size: validatorOutputSize },
    publisher: {
      inline_count: inlineCount,
      summary_count: summaryCount,
      dropped_count: droppedCount,
      publication_state: publicationState,
      summary_artifact: summaryArtifact,
      rejection_reasons: publisherRejectionReasons,
      expected_categories: expectedCategories,
    },
    ...(pipelineConfigNotes !== undefined && pipelineConfigNotes.length > 0
      ? { config_notes: pipelineConfigNotes }
      : {}),
  };
  if (publication !== undefined) outcome.publication = publication;
  if (thrown !== undefined) outcome.thrown = thrown;
  return outcome;
};
