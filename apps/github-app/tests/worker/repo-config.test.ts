/**
 * Unit tests for `fetchRepoConfig` (`src/repo-config.ts`) — the worker's
 * config-load helper. Extracted to its own module so these tests exercise the
 * REAL implementation (worker.ts boots Redis + BullMQ on import and cannot be
 * imported here).
 *
 * Covers the guidance-only salvage carve-out (docs/config-spec.md § Failure
 * modes): when every Zod issue on `.github/review-bot.yml` is confined to
 * `review_guidance`, the rest of the config is honored and only guidance is
 * reset to its empty default. Any issue outside `review_guidance` still
 * triggers the full-default fallback.
 */

import type { OctokitLike } from '@prisma-bot/github';
import { DEFAULT_REPO_CONFIG } from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import { fetchRepoConfig } from '../../src/repo-config.js';

const toBase64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/**
 * Build a minimal `OctokitLike` stub whose `repos.getContent` always returns
 * the given YAML text as a base64-encoded file (mirrors
 * packages/github/tests/content-fetcher.test.ts's `buildStubOctokit`).
 */
const buildStubOctokit = (yamlText: string): OctokitLike => ({
  rest: {
    pulls: {} as OctokitLike['rest']['pulls'],
    repos: {
      getContent: async () => ({
        data: { type: 'file', encoding: 'base64', content: toBase64(yamlText) },
      }),
    },
    checks: {} as OctokitLike['rest']['checks'],
    pulls_reviews: {} as OctokitLike['rest']['pulls_reviews'],
    issues: {} as OctokitLike['rest']['issues'],
    reactions: {} as OctokitLike['rest']['reactions'],
  },
});

/** Collects every `log(event, payload)` call made during a test. */
const makeLogSpy = (): {
  log: (event: string, payload?: Record<string, unknown>) => void;
  calls: Array<{ event: string; payload?: Record<string, unknown> }>;
} => {
  const calls: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  return {
    log: (event, payload) => {
      calls.push(payload !== undefined ? { event, payload } : { event });
    },
    calls,
  };
};

describe('fetchRepoConfig', () => {
  it('guidance-only-bad YAML: keeps custom scalars, resets guidance, one note naming review_guidance', async () => {
    const oversizedInstructions = 'x'.repeat(3000);
    const yaml = [
      'mode: summary-only',
      'comment_cap:',
      '  per_pr: 3',
      '  per_file: 1',
      'nickname: custom-bot',
      'review_guidance:',
      `  instructions: "${oversizedInstructions}"`,
      '',
    ].join('\n');
    const octokit = buildStubOctokit(yaml);
    const { log, calls } = makeLogSpy();

    const { config, notes } = await fetchRepoConfig(octokit, 'owner', 'repo', 'main', log);

    expect(config.mode).toBe('summary-only');
    expect(config.comment_cap).toEqual({ per_pr: 3, per_file: 1 });
    expect(config.nickname).toBe('custom-bot');
    expect(config.review_guidance).toEqual({
      instructions: undefined,
      path_instructions: [],
      context_files: [],
    });

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('review_guidance');
    expect(notes[0]).toContain('rest of config honored');

    const parseErrorLog = calls.find((c) => c.event === 'worker.config.parse_error');
    expect(parseErrorLog).toBeDefined();
    expect(parseErrorLog?.payload?.salvaged).toBe(true);
    expect(parseErrorLog?.payload?.code).toBe('schema_violation');
  });

  it('non-guidance-bad YAML: falls back to DEFAULT_REPO_CONFIG with a "using defaults" note', async () => {
    const yaml = 'comment_cap:\n  per_pr: "five"\n  per_file: 1\n';
    const octokit = buildStubOctokit(yaml);
    const { log, calls } = makeLogSpy();

    const { config, notes } = await fetchRepoConfig(octokit, 'owner', 'repo', 'main', log);

    expect(config).toEqual(DEFAULT_REPO_CONFIG);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('using defaults');

    const parseErrorLog = calls.find((c) => c.event === 'worker.config.parse_error');
    expect(parseErrorLog).toBeDefined();
    expect(parseErrorLog?.payload?.salvaged).toBe(false);
  });

  it('mixed-bad YAML (guidance AND non-guidance violations): falls back to full defaults', async () => {
    const oversizedInstructions = 'z'.repeat(3000);
    const yaml = [
      'mode: invalid-mode',
      'review_guidance:',
      `  instructions: "${oversizedInstructions}"`,
      '',
    ].join('\n');
    const octokit = buildStubOctokit(yaml);
    const { log, calls } = makeLogSpy();

    const { config, notes } = await fetchRepoConfig(octokit, 'owner', 'repo', 'main', log);

    expect(config).toEqual(DEFAULT_REPO_CONFIG);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('using defaults');

    const parseErrorLog = calls.find((c) => c.event === 'worker.config.parse_error');
    expect(parseErrorLog).toBeDefined();
    expect(parseErrorLog?.payload?.salvaged).toBe(false);
  });
});
