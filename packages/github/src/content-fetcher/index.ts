import type { OctokitLike } from '../installation-auth/client.js';

/**
 * `ContentFetcher` — graceful-degradation-first interface for fetching text
 * files from a GitHub repository at a given ref.
 *
 * Contract: `fetchText` NEVER throws. On any error or skip condition it
 * returns a typed `{ ok: false, reason }` value so the caller can surface a
 * human-readable note without failing the review pipeline.
 *
 * Per spec § S2 / §5.2 (content-fetcher module).
 */

export type FetchTextOk = { ok: true; text: string; truncated: boolean };
export type FetchTextSkip = {
  ok: false;
  reason: 'missing' | 'oversize' | 'binary' | 'not_a_file' | 'error';
};
export type FetchTextResult = FetchTextOk | FetchTextSkip;

export interface ContentFetcher {
  /**
   * Fetch a single file from the repo at the given ref, decoded to UTF-8 text.
   *
   * @param args.path     Repo-relative path (e.g. '.github/review-bot.yml').
   *                      Paths containing '..' or starting with '/' are
   *                      rejected immediately as `{ ok:false, reason:'error' }`.
   * @param args.ref      Git ref (SHA or branch name).
   * @param args.maxBytes If decoded bytes exceed this value the content is
   *                      truncated to the last valid UTF-8 boundary and
   *                      `truncated: true` is returned.
   */
  fetchText(args: {
    path: string;
    ref: string;
    maxBytes: number;
  }): Promise<FetchTextResult>;
}

/**
 * Truncate a UTF-8 string to at most `maxBytes` encoded bytes, preserving
 * valid UTF-8 character boundaries (mirrors the snapshotter's `truncatePatch`
 * algorithm at `packages/core/src/snapshotter/index.ts:200-215`).
 */
const truncateToUtf8Boundary = (text: string, maxBytes: number): string => {
  const byteLen = Buffer.byteLength(text, 'utf8');
  if (byteLen <= maxBytes) return text;
  // Binary-search for the largest prefix that fits.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo);
};

/** Return true when a string contains NUL bytes (binary heuristic). */
const hasBinaryBytes = (text: string): boolean => text.includes('\x00');

/**
 * Build a `ContentFetcher` bound to the given `octokit` client, `owner`, and
 * `repo`. The returned fetcher issues `repos.getContent` calls on the already-
 * authenticated client — no additional auth is needed.
 */
export const buildContentFetcher = (
  octokit: OctokitLike,
  owner: string,
  repo: string,
): ContentFetcher => ({
  async fetchText({ path, ref, maxBytes }): Promise<FetchTextResult> {
    // Path-traversal guard: reject absolute paths and any containing '..'.
    if (path.startsWith('/') || path.includes('..')) {
      return { ok: false, reason: 'error' };
    }

    let data: {
      type?: string;
      encoding?: string;
      content?: string;
      size?: number;
    };

    try {
      const response = await octokit.rest.repos.getContent({ owner, repo, path, ref });
      data = response.data;
    } catch (err: unknown) {
      // GitHub returns HTTP 404 for missing files; treat any fetch error as
      // a typed skip rather than letting it propagate.
      const status =
        err !== null &&
        typeof err === 'object' &&
        'status' in err &&
        typeof (err as { status: unknown }).status === 'number'
          ? (err as { status: number }).status
          : undefined;
      if (status === 404) {
        return { ok: false, reason: 'missing' };
      }
      return { ok: false, reason: 'error' };
    }

    // Only the single-file form is useful; directories / symlinks → skip.
    if (data.type !== 'file') {
      return { ok: false, reason: 'not_a_file' };
    }

    // GitHub encodes file content as base64.
    if (data.encoding !== 'base64' || data.content === undefined) {
      return { ok: false, reason: 'error' };
    }

    // Decode base64 → Buffer → UTF-8 string.
    // GitHub inserts newlines into the base64 string; strip them first.
    const b64 = data.content.replace(/\n/g, '');
    let decoded: string;
    try {
      decoded = Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      return { ok: false, reason: 'binary' };
    }

    // Binary heuristic: NUL bytes indicate a non-text file.
    if (hasBinaryBytes(decoded)) {
      return { ok: false, reason: 'binary' };
    }

    // Apply byte cap.
    const truncated = Buffer.byteLength(decoded, 'utf8') > maxBytes;
    const text = truncated ? truncateToUtf8Boundary(decoded, maxBytes) : decoded;

    return { ok: true, text, truncated };
  },
});
