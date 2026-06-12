import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RepoConfigSchema } from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import { loadRepoConfig } from '../src/index.js';

/**
 * Phase 7 — validate that `.github/review-bot.yml.example` (composed by
 * IDG) parses cleanly through `loadRepoConfig` and exposes the OQ-2
 * defaults verbatim. This test is the AC-EXAMPLE-1, AC-EXAMPLE-2, and
 * AC-EXAMPLE-5 enforcement surface from `docs/_planning/phase-7-spec.md`.
 *
 * The repo root is two levels up from this file
 * (`packages/config/tests/example-config.test.ts` -> repo root).
 */
const TEST_FILE_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(TEST_FILE_DIR, '..', '..', '..');
const EXAMPLE_PATH = resolve(REPO_ROOT, '.github', 'review-bot.yml.example');

const readExample = (): string => readFileSync(EXAMPLE_PATH, 'utf8');

describe('.github/review-bot.yml.example', () => {
  it('parses through loadRepoConfig without throwing', () => {
    const yamlContents = readExample();
    expect(() => loadRepoConfig({ yamlContents })).not.toThrow();
  });

  it('contains every top-level key declared in RepoConfigSchema', () => {
    const yamlContents = readExample();
    const cfg = loadRepoConfig({ yamlContents }) as Record<string, unknown>;
    const expectedKeys = Object.keys(RepoConfigSchema.shape);
    // `model` and `nickname` are intentionally optional and commented-out in
    // the example; the schema exposes them as optional without defaults, so
    // their absence from a parsed config object is expected.
    const requiredKeys = expectedKeys.filter((key) => key !== 'model' && key !== 'nickname');
    for (const key of requiredKeys) {
      expect(cfg, `expected top-level key '${key}' to be present`).toHaveProperty(key);
    }
  });

  it('reflects the OQ-2 defaults verbatim', () => {
    const yamlContents = readExample();
    const cfg = loadRepoConfig({ yamlContents });
    expect(cfg.mode).toBe('dry-run');
    expect(cfg.comment_cap.per_pr).toBe(5);
    expect(cfg.comment_cap.per_file).toBe(1);
    expect(cfg.thresholds.severity_floor.inline).toBe('medium');
    expect(cfg.thresholds.confidence_floor.inline).toBe(0.7);
    expect(cfg.provider).toBe('anthropic');
  });

  it('does not contain forbidden author tokens (TODO / FIXME / TBD / XXX)', () => {
    const yamlContents = readExample();
    const forbidden = ['TODO', 'FIXME', 'TBD', 'XXX'];
    for (const token of forbidden) {
      expect(
        yamlContents.includes(token),
        `found forbidden token '${token}' in .github/review-bot.yml.example`,
      ).toBe(false);
    }
  });
});
