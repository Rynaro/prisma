import { type RepoConfig, RepoConfigSchema } from '@prisma-bot/shared';
import { YAMLParseError, parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';

/**
 * `ConfigParseError` — typed error surface for the loader.
 *
 * `code` discriminates failure category per docs/config-spec.md § Failure modes:
 *   - 'invalid_yaml'      — file does not parse as YAML, or parses to a non-object.
 *   - 'schema_violation'  — known key has an out-of-range / wrong-type value
 *                           (config-spec.md § Type mismatch on a known key).
 *
 * `salvagedConfig` — guidance-only salvage (docs/config-spec.md § Failure modes,
 * "review_guidance-only violations"). Populated ONLY when `code ===
 * 'schema_violation'` AND every offending Zod issue's path is rooted at
 * `review_guidance`: the rest of the config is honored and `salvagedConfig` is
 * the parsed `RepoConfig` with `review_guidance` reset to its empty schema
 * default. Undefined for every other failure (including 'invalid_yaml' and any
 * `schema_violation` with at least one issue outside `review_guidance`) — those
 * cases keep the full-fallback-to-defaults behavior. Callers MUST still log
 * `worker.config.parse_error` and surface a human-readable note even when a
 * salvage succeeds — silent degradation is not acceptable.
 */
export type ConfigParseErrorCode = 'invalid_yaml' | 'schema_violation';

export class ConfigParseError extends Error {
  public override readonly name = 'ConfigParseError';
  public readonly code: ConfigParseErrorCode;
  public readonly salvagedConfig?: RepoConfig;

  public constructor(
    code: ConfigParseErrorCode,
    message: string,
    options?: { salvagedConfig?: RepoConfig },
  ) {
    super(message);
    this.code = code;
    // `exactOptionalPropertyTypes` forbids assigning an explicit `undefined`
    // to an optional property — only assign when a salvaged config exists.
    if (options?.salvagedConfig !== undefined) {
      this.salvagedConfig = options.salvagedConfig;
    }
  }
}

const formatZodError = (error: ZodError): string => {
  const issues = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  return `schema violation: ${issues}`;
};

/**
 * Parse a YAML string into a validated `RepoConfig`.
 *
 * Throws `ConfigParseError` with:
 *   - code = 'invalid_yaml' for YAML syntax errors and non-object roots.
 *   - code = 'schema_violation' for Zod validation failures (known keys with the
 *     wrong type / out-of-range value). The message includes the offending key.
 *
 * Guidance-only salvage (docs/config-spec.md § Failure modes): when EVERY Zod
 * issue on a 'schema_violation' is rooted at `review_guidance` (i.e.
 * `issue.path[0] === 'review_guidance'` for every issue — an issue with an
 * empty path, such as a `.strict()` unknown-key error at the root, does NOT
 * count as guidance-scoped), the thrown `ConfigParseError` carries a
 * `salvagedConfig`: the same document re-parsed with `review_guidance` omitted,
 * so it repopulates via `ReviewGuidanceSchema`'s empty default. Every other key
 * (model, max_files, comment_cap, path_rules.exclude, nickname, command_marker,
 * floors, etc.) is honored from the offending file. If any issue exists outside
 * `review_guidance`, `salvagedConfig` is left undefined and the caller falls
 * back to full defaults, exactly as before this behavior was introduced.
 */
export const parseRepoConfigYaml = (input: string): RepoConfig => {
  let parsed: unknown;
  try {
    parsed = parseYaml(input);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      throw new ConfigParseError('invalid_yaml', `invalid YAML: ${error.message}`);
    }
    throw new ConfigParseError(
      'invalid_yaml',
      `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed === null || parsed === undefined) {
    // Empty document — equivalent to "all defaults".
    return RepoConfigSchema.parse({});
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigParseError(
      'invalid_yaml',
      'invalid YAML: configuration root must be a mapping (object)',
    );
  }

  try {
    return RepoConfigSchema.parse(parsed);
  } catch (error) {
    if (error instanceof ZodError) {
      const isGuidanceScoped = (issue: ZodError['issues'][number]): boolean =>
        issue.path.length > 0 && issue.path[0] === 'review_guidance';

      if (error.issues.length > 0 && error.issues.every(isGuidanceScoped)) {
        // `parsed` is a non-array object at this point (checked above). Blank
        // out `review_guidance` and re-parse so ReviewGuidanceSchema's
        // `.default(...)` repopulates it as empty (Zod applies `.default()` to
        // an explicit `undefined` value the same as an absent key), salvaging
        // every other key.
        const rest: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
        rest.review_guidance = undefined;
        try {
          const salvagedConfig = RepoConfigSchema.parse(rest);
          throw new ConfigParseError('schema_violation', formatZodError(error), {
            salvagedConfig,
          });
        } catch (salvageError) {
          if (salvageError instanceof ConfigParseError) {
            throw salvageError;
          }
          // Defensive: the salvage re-parse should not fail since every issue
          // was guidance-scoped. If it somehow does, fall through to the plain
          // full-fallback throw below.
        }
      }

      throw new ConfigParseError('schema_violation', formatZodError(error));
    }
    throw error;
  }
};
