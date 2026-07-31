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

/** Note appended whenever `approval.approve_on_clean` is forced off by re-resolution. */
const APPROVE_ON_CLEAN_PRIVILEGE_NOTE =
  "`approval.approve_on_clean` is only honored from the repository's default branch; it was ignored for this run.";

/**
 * Re-resolve the single privileged key `approval.approve_on_clean` against the
 * repository default branch. Zero extra API calls on the default path (the
 * flag is off in the head-ref config, or the head config already came from
 * the default branch). Fails CLOSED: any doubt forces `false`.
 *
 * Verified vulnerability this closes: `worker.ts` resolves `.github/review-bot.yml`
 * at the PR's `head_sha` (`configRef`), which a PR author fully controls. For
 * every other key that is harmless (worst case: the author widens their own
 * review); for `approve_on_clean` it is a privilege-escalation vector — ship
 * `approval: { approve_on_clean: true }` in the PR under review and collect a
 * bot approval. This function re-checks the flag against `ref: 'HEAD'` (the
 * default branch, per A1) before it is ever honored.
 *
 * `celebrate_clean`, `clean_conclusion`, and `positive_feedback` are NOT
 * privileged (they change only rendered text and a passing-vs-passing
 * conclusion) and are not re-resolved here.
 */
export const resolvePrivilegedApproval = async (
  octokit: OctokitLike,
  owner: string,
  repo: string,
  headConfig: RepoConfig,
  headRef: string,
  log: Logger,
): Promise<{ config: RepoConfig; notes: string[] }> => {
  if (headConfig.approval.approve_on_clean !== true) {
    return { config: headConfig, notes: [] };
  }
  if (headRef === 'HEAD') {
    // The config already came from the default branch ref — nothing to
    // re-resolve.
    return { config: headConfig, notes: [] };
  }

  const forceDisabled = (): { config: RepoConfig; notes: string[] } => ({
    config: {
      ...headConfig,
      approval: { ...headConfig.approval, approve_on_clean: false },
    },
    notes: [APPROVE_ON_CLEAN_PRIVILEGE_NOTE],
  });

  try {
    const { config: defaultBranchConfig } = await fetchRepoConfig(
      octokit,
      owner,
      repo,
      'HEAD',
      log,
    );
    if (defaultBranchConfig.approval.approve_on_clean === true) {
      return { config: headConfig, notes: [] };
    }
    return forceDisabled();
  } catch {
    // Fail closed on any unexpected fetch/parse failure.
    return forceDisabled();
  }
};
