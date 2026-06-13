import {
  type ChangedFile,
  type PrSnapshot,
  type RepoConfig,
  RepoConfigSchema,
} from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import { runPrefilter } from '../../src/prefilter/index.js';

const baseConfig: RepoConfig = RepoConfigSchema.parse({});

const baseSnapshot = (files: ChangedFile[]): PrSnapshot => ({
  installation_id: 1,
  repository_id: 2,
  pull_request_number: 42,
  head_sha: 'a'.repeat(40),
  base_sha: 'b'.repeat(40),
  default_branch: 'main',
  total_changed_lines: files.reduce((s, f) => s + f.additions + f.deletions, 0),
  files,
});

const file = (overrides: Partial<ChangedFile> = {}): ChangedFile => ({
  path: 'src/example.ts',
  status: 'modified',
  additions: 5,
  deletions: 1,
  hunks: [{ new_start: 10, new_lines: 5, old_start: 10, old_lines: 4 }],
  is_binary: false,
  ...overrides,
});

const withConfig = (overrides: Partial<RepoConfig>): RepoConfig =>
  RepoConfigSchema.parse({ ...baseConfig, ...overrides });

describe('runPrefilter', () => {
  it('returns accepted with no files for an empty snapshot', () => {
    const result = runPrefilter({
      snapshot: baseSnapshot([]),
      config: baseConfig,
    });
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.files).toEqual([]);
      expect(result.skipped).toEqual([]);
    }
  });

  it('passes a single source file through with hunk built from the snapshot', () => {
    const snapshot = baseSnapshot([file({ path: 'src/a.ts', language: 'typescript' })]);
    const result = runPrefilter({ snapshot, config: baseConfig });
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.files).toHaveLength(1);
      const [first] = result.files;
      if (first === undefined) throw new Error('expected one prefiltered file');
      expect(first.path).toBe('src/a.ts');
      expect(first.language).toBe('typescript');
      expect(first.hunks).toHaveLength(1);
      const [hunk] = first.hunks;
      if (hunk === undefined) throw new Error('expected one hunk');
      expect(hunk.id).toBe('src/a.ts#10-15');
      expect(hunk.line_start).toBe(10);
      expect(hunk.line_end).toBe(14);
      expect(hunk.content).toBe('');
    }
  });

  it('skips removed files with reason removed_file', () => {
    const snapshot = baseSnapshot([file({ path: 'src/old.ts', status: 'removed', hunks: [] })]);
    const result = runPrefilter({ snapshot, config: baseConfig });
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.files).toHaveLength(0);
      expect(result.skipped).toEqual([{ path: 'src/old.ts', reason: 'removed_file' }]);
    }
  });

  it('skips binary files with reason binary', () => {
    const snapshot = baseSnapshot([file({ path: 'assets/logo.png', is_binary: true, hunks: [] })]);
    const result = runPrefilter({ snapshot, config: baseConfig });
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.files).toHaveLength(0);
      expect(result.skipped).toEqual([{ path: 'assets/logo.png', reason: 'binary' }]);
    }
  });

  it('skips lockfiles by basename with reason lockfile', () => {
    const snapshot = baseSnapshot([file({ path: 'package-lock.json' })]);
    const result = runPrefilter({ snapshot, config: baseConfig });
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.files).toHaveLength(0);
      expect(result.skipped).toEqual([{ path: 'package-lock.json', reason: 'lockfile' }]);
    }
  });

  it('skips vendored paths when exclude_vendored is true', () => {
    const snapshot = baseSnapshot([file({ path: 'vendor/foo.go' })]);
    const config = withConfig({ exclude_vendored: true });
    const result = runPrefilter({ snapshot, config });
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.files).toHaveLength(0);
      expect(result.skipped).toEqual([{ path: 'vendor/foo.go', reason: 'vendored' }]);
    }
  });

  it('does not skip vendored paths when exclude_vendored is false', () => {
    const snapshot = baseSnapshot([file({ path: 'vendor/foo.go' })]);
    const config = withConfig({ exclude_vendored: false });
    const result = runPrefilter({ snapshot, config });
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.files).toHaveLength(1);
      expect(result.skipped).toEqual([]);
    }
  });

  it('skips generated paths when exclude_generated is true', () => {
    const snapshot = baseSnapshot([file({ path: 'dist/foo.js' })]);
    const config = withConfig({ exclude_generated: true });
    const result = runPrefilter({ snapshot, config });
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.files).toHaveLength(0);
      expect(result.skipped).toEqual([{ path: 'dist/foo.js', reason: 'generated' }]);
    }
  });

  it('skips with path_rule_not_included when include is set and path is outside it', () => {
    const snapshot = baseSnapshot([file({ path: 'lib/util.ts' })]);
    const config = withConfig({ path_rules: { include: ['src/**'], exclude: [] } });
    const result = runPrefilter({ snapshot, config });
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.files).toHaveLength(0);
      expect(result.skipped).toEqual([{ path: 'lib/util.ts', reason: 'path_rule_not_included' }]);
    }
  });

  it('exclude overrides include and yields path_rule_excluded', () => {
    const snapshot = baseSnapshot([file({ path: 'src/foo.test.ts' })]);
    const config = withConfig({
      path_rules: { include: ['src/**'], exclude: ['**/*.test.ts'] },
    });
    const result = runPrefilter({ snapshot, config });
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.files).toHaveLength(0);
      expect(result.skipped).toEqual([{ path: 'src/foo.test.ts', reason: 'path_rule_excluded' }]);
    }
  });

  it('reports chunkable (not oversized) when kept files exceed max_files but fit chunking ceiling', () => {
    // With default chunking.max_files=200, 5 files that exceed max_files=2 are chunkable.
    const files = Array.from({ length: 5 }, (_, i) => file({ path: `src/f${i}.ts` }));
    const snapshot = baseSnapshot(files);
    const config = withConfig({ max_files: 2 });
    const result = runPrefilter({ snapshot, config });
    expect(result.kind).toBe('chunkable');
    if (result.kind === 'chunkable') {
      expect(result.files_considered).toBe(5);
      expect(result.files).toHaveLength(5);
    }
  });

  it('reports oversized too_many_files when kept files exceed BOTH max_files and chunking.max_files', () => {
    const files = Array.from({ length: 5 }, (_, i) => file({ path: `src/f${i}.ts` }));
    const snapshot = baseSnapshot(files);
    // Set chunking ceiling below the kept count
    const config = withConfig({
      max_files: 2,
      chunking: {
        enabled: true,
        max_files: 3,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 60000,
      },
    });
    const result = runPrefilter({ snapshot, config });
    expect(result.kind).toBe('oversized');
    if (result.kind === 'oversized') {
      expect(result.reason).toBe('too_many_files');
      expect(result.files_considered).toBe(5);
    }
  });

  it('reports chunkable (not oversized) when lines exceed max_changed_lines but fit chunking ceiling', () => {
    // 1500 + 600 = 2100 lines > 1000 (max_changed_lines) but < 12000 (chunking.max_changed_lines)
    const snapshot = baseSnapshot([file({ path: 'src/big.ts', additions: 1500, deletions: 600 })]);
    const config = withConfig({ max_files: 50, max_changed_lines: 1000 });
    const result = runPrefilter({ snapshot, config });
    expect(result.kind).toBe('chunkable');
    if (result.kind === 'chunkable') {
      expect(result.lines_considered).toBe(2100);
      expect(result.files).toHaveLength(1);
    }
  });

  it('reports oversized too_many_changed_lines when lines exceed BOTH limits', () => {
    // 15000 lines > 1000 (max_changed_lines) and > 12000 (chunking.max_changed_lines)
    const snapshot = baseSnapshot([file({ path: 'src/big.ts', additions: 9000, deletions: 6000 })]);
    const config = withConfig({ max_files: 50, max_changed_lines: 1000 });
    const result = runPrefilter({ snapshot, config });
    expect(result.kind).toBe('oversized');
    if (result.kind === 'oversized') {
      expect(result.reason).toBe('too_many_changed_lines');
      expect(result.lines_considered).toBe(15000);
    }
  });

  it('reports oversized when chunking is disabled even if within chunking ceiling', () => {
    const files = Array.from({ length: 5 }, (_, i) => file({ path: `src/f${i}.ts` }));
    const snapshot = baseSnapshot(files);
    const config = withConfig({
      max_files: 2,
      chunking: {
        enabled: false,
        max_files: 200,
        max_changed_lines: 12000,
        max_provider_calls_per_pr: 6,
        call_token_budget: 60000,
      },
    });
    const result = runPrefilter({ snapshot, config });
    expect(result.kind).toBe('oversized');
  });

  it('invokes hunkContent resolver and lands its return value into Hunk.content', () => {
    const snapshot = baseSnapshot([
      file({
        path: 'src/a.ts',
        hunks: [
          { new_start: 1, new_lines: 3, old_start: 1, old_lines: 0 },
          { new_start: 20, new_lines: 2, old_start: 18, old_lines: 1 },
        ],
      }),
    ]);
    const calls: Array<{ path: string; new_start: number }> = [];
    const result = runPrefilter({
      snapshot,
      config: baseConfig,
      hunkContent: (path, hunk) => {
        calls.push({ path, new_start: hunk.new_start });
        return `content@${path}#${hunk.new_start}`;
      },
    });
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      const [f] = result.files;
      if (f === undefined) throw new Error('expected one file');
      expect(f.hunks.map((h) => h.content)).toEqual(['content@src/a.ts#1', 'content@src/a.ts#20']);
    }
    expect(calls).toEqual([
      { path: 'src/a.ts', new_start: 1 },
      { path: 'src/a.ts', new_start: 20 },
    ]);
  });

  it('skips files with no hunks once they reach the no_hunks check', () => {
    const snapshot = baseSnapshot([file({ path: 'src/empty.ts', hunks: [] })]);
    const result = runPrefilter({ snapshot, config: baseConfig });
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.files).toHaveLength(0);
      expect(result.skipped).toEqual([{ path: 'src/empty.ts', reason: 'no_hunks' }]);
    }
  });
});
