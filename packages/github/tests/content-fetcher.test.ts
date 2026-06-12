import { describe, expect, it } from 'vitest';
import type { OctokitLike, ReposGetContentData } from '../src/index.js';
import { buildContentFetcher } from '../src/index.js';

/**
 * Tests for `buildContentFetcher` per spec § S2 acceptance criteria.
 * Uses a hand-rolled stub that never touches the network.
 */

type GetContentParams = { owner: string; repo: string; path: string; ref?: string };

/**
 * Build a minimal `OctokitLike` stub whose `repos.getContent` is fully
 * controllable per test.
 */
const buildStubOctokit = (
  handler: (params: GetContentParams) => Promise<{ data: ReposGetContentData }>,
): OctokitLike => {
  // We only need repos.getContent for these tests; cast other namespaces.
  return {
    rest: {
      pulls: {} as OctokitLike['rest']['pulls'],
      repos: {
        getContent: handler,
      },
      checks: {} as OctokitLike['rest']['checks'],
      pulls_reviews: {} as OctokitLike['rest']['pulls_reviews'],
      issues: {} as OctokitLike['rest']['issues'],
      reactions: {} as OctokitLike['rest']['reactions'],
    },
  };
};

const toBase64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

describe('buildContentFetcher', () => {
  it('returns ok:true with decoded text for a valid file', async () => {
    const content = 'Hello, world!';
    const octokit = buildStubOctokit(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: toBase64(content),
      },
    }));
    const fetcher = buildContentFetcher(octokit, 'owner', 'repo');
    const result = await fetcher.fetchText({ path: 'README.md', ref: 'main', maxBytes: 1024 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe(content);
      expect(result.truncated).toBe(false);
    }
  });

  it('returns reason:missing for a 404 error', async () => {
    const octokit = buildStubOctokit(async () => {
      const err = Object.assign(new Error('Not Found'), { status: 404 });
      throw err;
    });
    const fetcher = buildContentFetcher(octokit, 'owner', 'repo');
    const result = await fetcher.fetchText({ path: 'missing.md', ref: 'main', maxBytes: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing');
    }
  });

  it('returns reason:error for non-404 API errors — never throws', async () => {
    const octokit = buildStubOctokit(async () => {
      throw new Error('Internal Server Error');
    });
    const fetcher = buildContentFetcher(octokit, 'owner', 'repo');
    const result = await fetcher.fetchText({ path: 'file.md', ref: 'main', maxBytes: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('error');
    }
  });

  it('returns reason:not_a_file when type is dir', async () => {
    const octokit = buildStubOctokit(async () => ({
      data: { type: 'dir' },
    }));
    const fetcher = buildContentFetcher(octokit, 'owner', 'repo');
    const result = await fetcher.fetchText({ path: 'src/', ref: 'main', maxBytes: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_a_file');
    }
  });

  it('returns reason:binary when decoded content contains NUL bytes', async () => {
    const binaryContent = 'some\x00binary\x00data';
    const octokit = buildStubOctokit(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: toBase64(binaryContent),
      },
    }));
    const fetcher = buildContentFetcher(octokit, 'owner', 'repo');
    const result = await fetcher.fetchText({ path: 'image.png', ref: 'main', maxBytes: 65536 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('binary');
    }
  });

  it('truncates oversize content on a UTF-8 boundary and sets truncated:true', async () => {
    // Build a string that exceeds maxBytes when encoded.
    const longContent = 'a'.repeat(200);
    const maxBytes = 100;
    const octokit = buildStubOctokit(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: toBase64(longContent),
      },
    }));
    const fetcher = buildContentFetcher(octokit, 'owner', 'repo');
    const result = await fetcher.fetchText({ path: 'big.md', ref: 'main', maxBytes });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(maxBytes);
    }
  });

  it('returns reason:error for path containing ".."', async () => {
    const octokit = buildStubOctokit(async () => {
      throw new Error('should not be called');
    });
    const fetcher = buildContentFetcher(octokit, 'owner', 'repo');
    const result = await fetcher.fetchText({
      path: '../../../etc/passwd',
      ref: 'main',
      maxBytes: 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('error');
    }
  });

  it('returns reason:error for absolute paths', async () => {
    const octokit = buildStubOctokit(async () => {
      throw new Error('should not be called');
    });
    const fetcher = buildContentFetcher(octokit, 'owner', 'repo');
    const result = await fetcher.fetchText({
      path: '/etc/passwd',
      ref: 'main',
      maxBytes: 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('error');
    }
  });

  it('never throws even when called concurrently with bad paths', async () => {
    const octokit = buildStubOctokit(async () => {
      throw Object.assign(new Error('Net error'), { status: 503 });
    });
    const fetcher = buildContentFetcher(octokit, 'owner', 'repo');
    const results = await Promise.all([
      fetcher.fetchText({ path: 'a.md', ref: 'main', maxBytes: 1024 }),
      fetcher.fetchText({ path: '../b.md', ref: 'main', maxBytes: 1024 }),
    ]);
    for (const r of results) {
      expect(r.ok).toBe(false);
    }
  });
});
