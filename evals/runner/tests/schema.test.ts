import { describe, expect, it } from 'vitest';
import { ScenarioFixtureSchema, ScenarioIndexSchema } from '../src/schema.js';

const validFixture = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'security-bug',
  name: 'Security bug — SQL injection',
  description: 'Provider emits a SQL-injection finding on a TypeScript file.',
  config_overrides: { mode: 'summary-plus-inline' },
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
        filename: 'src/db/query.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@\n existing\n+added\n',
      },
    ],
  },
  provider_script: [
    {
      kind: 'output',
      output: {
        findings: [
          {
            path: 'src/db/query.ts',
            line: 2,
            severity: 'high',
            category: 'security',
            message: 'security finding',
            rationale: 'why',
            confidence: 0.9,
          },
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
      summary_contains: ['security'],
      expected_categories: ['security'],
      rejection_reasons: [],
    },
  },
  metrics: ['comment_usefulness'],
  ...overrides,
});

describe('ScenarioFixtureSchema', () => {
  it('accepts a fully-populated valid fixture', () => {
    const parsed = ScenarioFixtureSchema.parse(validFixture());
    expect(parsed.id).toBe('security-bug');
    expect(parsed.provider_script).toHaveLength(1);
    expect(parsed.expectations.publisher.inline_count).toBe(1);
  });

  it('rejects a fixture missing a required top-level field', () => {
    const { id: _omitted, ...rest } = validFixture();
    expect(() => ScenarioFixtureSchema.parse(rest)).toThrow();
  });

  it('rejects a fixture whose mode override is not a closed-vocabulary value', () => {
    // Mode is part of `config_overrides` (a passthrough record); the merged
    // RepoConfig parse rejects unknown modes. We exercise the merge layer
    // through `mergeConfig` rather than the fixture schema, but the fixture
    // schema's expectations.publisher.publication_state IS strictly enforced.
    const fixture = validFixture({
      expectations: {
        ...(validFixture().expectations as Record<string, unknown>),
        publisher: {
          ...(validFixture().expectations as { publisher: Record<string, unknown> }).publisher,
          publication_state: 'definitely-not-a-state',
        },
      },
    });
    expect(() => ScenarioFixtureSchema.parse(fixture)).toThrow();
  });

  it('accepts an empty provider_script (used by oversized-pr and generated-files)', () => {
    const fixture = validFixture({ provider_script: [] });
    const parsed = ScenarioFixtureSchema.parse(fixture);
    expect(parsed.provider_script).toEqual([]);
  });

  it('rejects an invalid metric identifier', () => {
    const fixture = validFixture({ metrics: ['not_a_real_metric'] });
    expect(() => ScenarioFixtureSchema.parse(fixture)).toThrow();
  });

  it('rejects unknown top-level keys (strict)', () => {
    const fixture = validFixture({ unexpected_top_level_key: true });
    expect(() => ScenarioFixtureSchema.parse(fixture)).toThrow();
  });
});

describe('ScenarioIndexSchema', () => {
  it('accepts the canonical 9-scenario shape', () => {
    const index = {
      scenarios: [
        {
          id: 'security-bug',
          name: 'Security bug',
          fixture: 'fixtures/security-bug.yaml',
          tags: ['security'],
        },
      ],
    };
    const parsed = ScenarioIndexSchema.parse(index);
    expect(parsed.scenarios).toHaveLength(1);
  });

  it('rejects an entry missing `tags`', () => {
    const index = {
      scenarios: [
        {
          id: 'x',
          name: 'X',
          fixture: 'fixtures/x.yaml',
        },
      ],
    };
    expect(() => ScenarioIndexSchema.parse(index)).toThrow();
  });
});
