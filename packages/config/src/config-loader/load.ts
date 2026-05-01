import { DEFAULT_REPO_CONFIG, type RepoConfig } from '@prisma-bot/shared';
import { parseRepoConfigYaml } from './parse.js';

/**
 * `loadRepoConfig` resolves the effective `RepoConfig` per
 * docs/config-spec.md § Resolution order:
 *
 *   1. Built-in defaults (DEFAULT_REPO_CONFIG)
 *   2. Repo-local `.github/review-bot.yml`
 *   3. Per-PR overrides — RESERVED for Phase 5.5 (config-spec.md § Resolution order
 *      lists this as a Phase-deferred slot). Phase 5.1 implements layers 1 + 2 only;
 *      this comment is the explicit reference to the spec section.
 *
 * Merge semantics per the spec: deep-merge for objects, replacement for scalars
 * and arrays.
 *
 * Returns a fully-populated `RepoConfig` (no `undefined` at the top level).
 */
export const loadRepoConfig = (opts: { yamlContents: string | null }): RepoConfig => {
  if (opts.yamlContents === null) {
    return DEFAULT_REPO_CONFIG;
  }
  // The schema's defaults already populate every required key when an absent key
  // is encountered during parse. Validating the YAML through the schema (with
  // defaults applied at every level) is the canonical implementation of
  // "deep-merge for objects, replacement for scalars and arrays" because Zod's
  // .default() is applied per-key and arrays/scalars are replaced wholesale by
  // the parsed value when present.
  return parseRepoConfigYaml(opts.yamlContents);
};
