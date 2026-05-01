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
 */
export type ConfigParseErrorCode = 'invalid_yaml' | 'schema_violation';

export class ConfigParseError extends Error {
  public override readonly name = 'ConfigParseError';
  public readonly code: ConfigParseErrorCode;

  public constructor(code: ConfigParseErrorCode, message: string) {
    super(message);
    this.code = code;
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
      throw new ConfigParseError('schema_violation', formatZodError(error));
    }
    throw error;
  }
};
