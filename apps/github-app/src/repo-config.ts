/**
 * Fetch-and-parse logic for the per-repo `.github/review-bot.yml` config.
 * Extracted from `worker.ts` so the guidance-only-salvage branch (and the
 * existing fetch-failure / full-fallback branches) are unit-testable without
 * booting the worker (`worker.ts` starts Redis + BullMQ on import).
 *
 * Per spec § S4 / §6.1: config is per-job (each PR's repo has its own config).
 */
import { ConfigParseError, REPO_LOCAL_CONFIG_PATH, loadRepoConfig } from '@prisma-bot/config';
import { type OctokitLike, buildContentFetcher } from '@prisma-bot/github';
import type { RepoConfig } from '@prisma-bot/shared';

/** Structured-log sink shape; matches `worker.ts`'s local `log` helper. */
export type Logger = (event: string, payload?: Record<string, unknown>) => void;

/**
 * Fetch and parse the per-repo config from `.github/review-bot.yml` at the
 * given ref. Returns `{ config, notes }` where `notes` carries any parse
 * error description (config error → default config or guidance-only salvage,
 * review succeeds either way).
 *
 * Failure handling per docs/config-spec.md § Failure modes:
 *   - Fetch failure (missing / oversize / error) → full defaults; a note is
 *     added unless the file is simply absent.
 *   - `ConfigParseError` with `salvagedConfig` defined (every Zod issue was
 *     confined to `review_guidance`) → the salvaged config is used: every
 *     non-guidance key from the offending file is honored, guidance itself is
 *     reset to its empty default. A note names the dropped field.
 *   - `ConfigParseError` with `salvagedConfig` undefined (any issue outside
 *     `review_guidance`, or invalid YAML) → full defaults, as before.
 * `worker.config.parse_error` is always logged on a `ConfigParseError`,
 * regardless of whether salvage applied, so degradation is never silent.
 */
export const fetchRepoConfig = async (
  octokit: OctokitLike,
  owner: string,
  repo: string,
  ref: string,
  log: Logger,
): Promise<{ config: RepoConfig; notes: string[] }> => {
  const fetcher = buildContentFetcher(octokit, owner, repo);
  const result = await fetcher.fetchText({
    path: REPO_LOCAL_CONFIG_PATH,
    ref,
    maxBytes: 65536,
  });

  if (!result.ok) {
    if (result.reason === 'missing') {
      // No config file → pure defaults, no note needed.
      return { config: loadRepoConfig({ yamlContents: null }), notes: [] };
    }
    // Other fetch error → defaults + note.
    return {
      config: loadRepoConfig({ yamlContents: null }),
      notes: [`config fetch failed (${result.reason}): using defaults`],
    };
  }

  try {
    const config = loadRepoConfig({ yamlContents: result.text });
    return { config, notes: [] };
  } catch (err) {
    if (err instanceof ConfigParseError) {
      log('worker.config.parse_error', {
        code: err.code,
        message: err.message,
        salvaged: err.salvagedConfig !== undefined,
      });
      if (err.salvagedConfig !== undefined) {
        return {
          config: err.salvagedConfig,
          notes: [
            `config error (${err.code}) in review_guidance: ${err.message} — custom review guidance disabled for this run; rest of config honored`,
          ],
        };
      }
      return {
        config: loadRepoConfig({ yamlContents: null }),
        notes: [`config error (${err.code}): ${err.message} — using defaults`],
      };
    }
    return {
      config: loadRepoConfig({ yamlContents: null }),
      notes: ['config parse error: unknown error — using defaults'],
    };
  }
};
