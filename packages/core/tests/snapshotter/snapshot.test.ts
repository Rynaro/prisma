import { PrSnapshotSchema } from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import { type SnapshotterOctokitLike, fetchPrSnapshot } from '../../src/snapshotter/index.js';

interface FakeFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'changed' | 'copied' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

interface FakeOptions {
  prData?: {
    number: number;
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
  };
  // Pages of files; each page is what `listFiles` returns for that page index.
  pages: FakeFile[][];
}

interface FakeOctokit extends SnapshotterOctokitLike {
  getCalls: number;
  listFilesCalls: Array<{ page: number; per_page: number }>;
}

const buildFake = (opts: FakeOptions): FakeOctokit => {
  const prData = opts.prData ?? {
    number: 7,
    head: { sha: 'head1', ref: 'feature' },
    base: { sha: 'base1', ref: 'main' },
  };
  const fake = {
    getCalls: 0,
    listFilesCalls: [] as Array<{ page: number; per_page: number }>,
    rest: {
      pulls: {
        get: async (_p: { owner: string; repo: string; pull_number: number }) => {
          fake.getCalls += 1;
          return { data: prData };
        },
        listFiles: async (p: {
          owner: string;
          repo: string;
          pull_number: number;
          per_page?: number;
          page?: number;
        }) => {
          const page = p.page ?? 1;
          const per_page = p.per_page ?? 100;
          fake.listFilesCalls.push({ page, per_page });
          const data = opts.pages[page - 1] ?? [];
          return { data };
        },
      },
    },
  } as FakeOctokit;
  return fake;
};

const baseOpts = (octokit: SnapshotterOctokitLike) => ({
  octokit,
  installation_id: 100,
  repository_id: 200,
  owner: 'octocat',
  repo: 'hello-world',
  pull_request_number: 7,
});

describe('fetchPrSnapshot', () => {
  it('returns one file with one hunk for a single-file PR', async () => {
    const fake = buildFake({
      pages: [
        [
          {
            filename: 'src/example.ts',
            status: 'modified',
            additions: 3,
            deletions: 1,
            changes: 4,
            patch: '@@ -10,4 +10,5 @@ context\n line\n+added\n+added\n',
          },
        ],
      ],
    });
    const snap = await fetchPrSnapshot(baseOpts(fake));
    expect(snap.files).toHaveLength(1);
    const [file] = snap.files;
    if (file === undefined) throw new Error('expected one file');
    expect(file.path).toBe('src/example.ts');
    expect(file.hunks).toHaveLength(1);
    expect(file.is_binary).toBe(false);
    expect(file.language).toBe('typescript');
    expect(snap.total_changed_lines).toBe(file.additions + file.deletions);
  });

  it('paginates correctly across multiple pages', async () => {
    const fake = buildFake({
      pages: [
        [
          {
            filename: 'a.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -1,1 +1,2 @@\n a\n+b\n',
          },
        ],
        [
          {
            filename: 'b.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -1,1 +1,2 @@\n a\n+b\n',
          },
        ],
      ],
    });
    // Force per_page=1 so the snapshotter must paginate.
    const snap = await fetchPrSnapshot({ ...baseOpts(fake), perPage: 1 });
    expect(snap.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(fake.listFilesCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('handles a binary file (patch === undefined) with is_binary: true and no hunks', async () => {
    const fake = buildFake({
      pages: [
        [
          {
            filename: 'assets/logo.png',
            status: 'added',
            additions: 0,
            deletions: 0,
            changes: 0,
          },
        ],
      ],
    });
    const snap = await fetchPrSnapshot(baseOpts(fake));
    const [file] = snap.files;
    if (file === undefined) throw new Error('expected one file');
    expect(file.is_binary).toBe(true);
    expect(file.hunks).toEqual([]);
  });

  it('populates previous_path on a renamed file', async () => {
    const fake = buildFake({
      pages: [
        [
          {
            filename: 'src/new.ts',
            previous_filename: 'src/old.ts',
            status: 'renamed',
            additions: 0,
            deletions: 0,
            changes: 0,
            patch: '',
          },
        ],
      ],
    });
    const snap = await fetchPrSnapshot(baseOpts(fake));
    const [file] = snap.files;
    if (file === undefined) throw new Error('expected one file');
    expect(file.status).toBe('renamed');
    expect(file.previous_path).toBe('src/old.ts');
  });

  it('emits status: "removed" for a removed file', async () => {
    const fake = buildFake({
      pages: [
        [
          {
            filename: 'src/gone.ts',
            status: 'removed',
            additions: 0,
            deletions: 5,
            changes: 5,
            patch: '@@ -1,5 +0,0 @@\n-a\n-b\n-c\n-d\n-e\n',
          },
        ],
      ],
    });
    const snap = await fetchPrSnapshot(baseOpts(fake));
    const [file] = snap.files;
    if (file === undefined) throw new Error('expected one file');
    expect(file.status).toBe('removed');
  });

  it('parses a hunk header missing the comma value (e.g. `@@ -10 +12,5 @@`)', async () => {
    const fake = buildFake({
      pages: [
        [
          {
            filename: 'src/ex.ts',
            status: 'modified',
            additions: 5,
            deletions: 1,
            changes: 6,
            // First hunk: `@@ -10 +12,5 @@` — old_lines defaults to 1.
            // Second hunk: `@@ -20,3 +22 @@`  — new_lines defaults to 1.
            patch:
              '@@ -10 +12,5 @@\n line\n+a\n+b\n+c\n+d\n+e\n@@ -20,3 +22 @@\n-x\n-y\n-z\n+single\n',
          },
        ],
      ],
    });
    const snap = await fetchPrSnapshot(baseOpts(fake));
    const [file] = snap.files;
    if (file === undefined) throw new Error('expected one file');
    expect(file.hunks).toEqual([
      { old_start: 10, old_lines: 1, new_start: 12, new_lines: 5 },
      { old_start: 20, old_lines: 3, new_start: 22, new_lines: 1 },
    ]);
  });

  it('truncates a patch larger than maxPatchBytesPerFile and the snapshot still parses', async () => {
    // Build a giant patch with valid hunk headers at the very top + lots of
    // junk after the budget cuts in. The truncation should still preserve a
    // schema-conformant snapshot.
    const giantBody = 'line\n'.repeat(10_000);
    const fake = buildFake({
      pages: [
        [
          {
            filename: 'src/big.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: `@@ -1,1 +1,2 @@\n a\n+b\n${giantBody}`,
          },
        ],
      ],
    });
    const snap = await fetchPrSnapshot({ ...baseOpts(fake), maxPatchBytesPerFile: 256 });
    expect(() => PrSnapshotSchema.parse(snap)).not.toThrow();
    const [file] = snap.files;
    if (file === undefined) throw new Error('expected one file');
    // The first hunk header (which is at byte offset 0 and within 256 bytes)
    // should still parse out.
    expect(file.hunks.length).toBeGreaterThanOrEqual(1);
  });

  it('populates installation_id, repository_id, pull_request_number, head_sha, base_sha, default_branch from the fake', async () => {
    const fake = buildFake({
      prData: {
        number: 42,
        head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ref: 'feature' },
        base: { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', ref: 'main' },
      },
      pages: [[]],
    });
    const snap = await fetchPrSnapshot({
      octokit: fake,
      installation_id: 100,
      repository_id: 200,
      owner: 'octocat',
      repo: 'hello-world',
      pull_request_number: 42,
    });
    expect(snap.installation_id).toBe(100);
    expect(snap.repository_id).toBe(200);
    expect(snap.pull_request_number).toBe(42);
    expect(snap.head_sha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(snap.base_sha).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(snap.default_branch).toBe('main');
  });
});
