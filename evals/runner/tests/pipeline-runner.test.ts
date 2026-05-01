import { makeFindingFixture } from '@prisma-bot/provider-fake';
import { describe, expect, it } from 'vitest';
import { runPipelineForFixture } from '../src/pipeline-runner.js';
import {
  type ChangedFileEntry,
  type ScenarioFixture,
  ScenarioFixtureSchema,
} from '../src/schema.js';

/**
 * Two hand-built scenarios exercise the pipeline-runner end-to-end without
 * depending on the on-disk YAML fixtures. Both feed real Phase 5 modules
 * (snapshotter, prefilter, validator, ranker, publisher) through the
 * orchestrator, with the `FakeProvider` and a fixture-derived `OctokitLike`.
 */

const buildFixture = (overrides: Partial<ScenarioFixture> = {}): ScenarioFixture => {
  const base: Record<string, unknown> = {
    id: 'security-bug',
    name: 'Security bug',
    description: 'Test fixture for the runner.',
    config_overrides: {
      mode: 'summary-plus-inline',
      thresholds: {
        severity_floor: { inline: 'medium' },
        confidence_floor: { inline: 0.7 },
      },
      comment_cap: { per_pr: 5, per_file: 1 },
    },
    pr_payload: {
      action: 'opened',
      installation: { id: 1000 },
      repository: { id: 2000, full_name: 'octocat/repo' },
      pull_request: {
        number: 42,
        head: { sha: 'a'.repeat(40) },
      },
    },
    octokit_responses: {
      pulls_get: {
        number: 42,
        head: { sha: 'a'.repeat(40), ref: 'feature' },
        base: { sha: 'b'.repeat(40), ref: 'main' },
      },
      pulls_list_files: [
        {
          filename: 'src/example.ts',
          status: 'modified',
          additions: 2,
          deletions: 0,
          patch: '@@ -1,3 +1,5 @@\n line\n+added1\n+added2\n',
        },
      ],
    },
    provider_script: [
      {
        kind: 'output',
        output: {
          findings: [
            makeFindingFixture({
              path: 'src/example.ts',
              line: 2,
              severity: 'high',
              category: 'security',
              message: 'security finding in this hunk',
              rationale: 'reason',
              confidence: 0.9,
            }),
          ],
        },
      },
    ],
    expectations: {
      prefilter: {
        outcome: 'accepted',
        skipped_paths: [],
        skipped_reasons: [],
        files_sent_to_provider: 1,
      },
      provider: { calls: 1 },
      validator: { findings: 1, rejection_reasons: [] },
      ranker: { output_size_eq_input: true },
      publisher: {
        inline_count: 1,
        summary_count: 0,
        dropped_count: 0,
        publication_state: 'succeeded',
        summary_contains: [],
        expected_categories: ['security'],
        rejection_reasons: [],
      },
    },
    metrics: ['comment_usefulness'],
    ...overrides,
  };
  return ScenarioFixtureSchema.parse(base);
};

const filesPayloadFromFixture = (fixture: ScenarioFixture): ChangedFileEntry[] => {
  const value = fixture.octokit_responses.pulls_list_files;
  if (!Array.isArray(value)) {
    throw new Error('test fixture pulls_list_files must be an inline array');
  }
  return value;
};

describe('runPipelineForFixture', () => {
  it('happy path: 1 finding emitted inline; provider called once; prefilter accepted', async () => {
    const fixture = buildFixture();
    const filesPayload = filesPayloadFromFixture(fixture);
    const outcome = await runPipelineForFixture({ fixture, filesPayload });
    expect(outcome.prefilter.outcome).toBe('accepted');
    expect(outcome.prefilter.files_sent_to_provider).toBe(1);
    expect(outcome.provider.calls).toBe(1);
    expect(outcome.publisher.inline_count).toBe(1);
    expect(outcome.publisher.summary_count).toBe(0);
    expect(outcome.publisher.dropped_count).toBe(0);
    expect(outcome.publisher.publication_state).toBe('succeeded');
    expect(outcome.publication?.summary_artifact).toContain('security');
  });

  it('schema-validation provider error: validator rejection, summary-only fallback, succeeded state', async () => {
    const fixture = buildFixture({
      provider_script: [
        {
          kind: 'error',
          error: {
            kind: 'schema_validation',
            message: 'output failed schema validation',
          },
        },
      ],
      expectations: {
        prefilter: {
          outcome: 'accepted',
          skipped_paths: [],
          skipped_reasons: [],
          files_sent_to_provider: 1,
        },
        provider: { calls: 1 },
        validator: { findings: 0, rejection_reasons: ['provider_output_zod_failed'] },
        ranker: { output_size_eq_input: true },
        publisher: {
          inline_count: 0,
          summary_count: 0,
          dropped_count: 0,
          publication_state: 'succeeded',
          summary_contains: [],
          expected_categories: [],
          rejection_reasons: [],
        },
      },
    });
    const filesPayload = filesPayloadFromFixture(fixture);
    const outcome = await runPipelineForFixture({ fixture, filesPayload });
    expect(outcome.provider.calls).toBe(1);
    expect(outcome.publisher.inline_count).toBe(0);
    expect(outcome.publisher.publication_state).toBe('succeeded');
    expect(outcome.validator.rejection_reasons).toContain('provider_output_zod_failed');
  });
});
