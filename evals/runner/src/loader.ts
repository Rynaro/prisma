import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  type ChangedFileEntry,
  type ScenarioFixture,
  ScenarioFixtureSchema,
  type ScenarioIndex,
  ScenarioIndexSchema,
} from './schema.js';

/**
 * Loader responsibilities:
 *
 *   1. Read `evals/scenarios.yaml` and validate it against `ScenarioIndexSchema`.
 *   2. Read each per-scenario fixture file and validate it against
 *      `ScenarioFixtureSchema`.
 *   3. Resolve `octokit_responses.pulls_list_files` when expressed as a
 *      `{ from_file: <relative-path> }` pointer; the file's parsed JSON value
 *      replaces the pointer in the in-memory fixture before zod validation.
 *   4. Assert `id === basename(file, '.yaml')` (per spec AC-FX-7).
 */

export interface LoadedScenario {
  fixture: ScenarioFixture;
  /** Resolved `pulls_list_files` payload (always an array after substitution). */
  filesPayload: ChangedFileEntry[];
  /** Absolute path to the per-scenario fixture YAML. */
  yamlPath: string;
}

const readJsonFile = async <T>(path: string): Promise<T> => {
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as T;
};

export const loadScenarioIndex = async (yamlPath: string): Promise<ScenarioIndex> => {
  const content = await readFile(yamlPath, 'utf-8');
  const raw = parseYaml(content);
  return ScenarioIndexSchema.parse(raw);
};

const resolveFromFile = async (rawValue: unknown, fixtureDir: string): Promise<unknown> => {
  if (
    rawValue !== null &&
    typeof rawValue === 'object' &&
    'from_file' in (rawValue as Record<string, unknown>) &&
    typeof (rawValue as { from_file?: unknown }).from_file === 'string'
  ) {
    const rel = (rawValue as { from_file: string }).from_file;
    const absolute = resolve(fixtureDir, rel);
    return readJsonFile<unknown>(absolute);
  }
  return rawValue;
};

export const loadScenarioFixture = async (
  fixturesRoot: string,
  fixtureRelPath: string,
): Promise<LoadedScenario> => {
  const yamlPath = resolve(fixturesRoot, fixtureRelPath);
  const content = await readFile(yamlPath, 'utf-8');
  const raw = parseYaml(content);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`fixture ${yamlPath} root is not a YAML mapping`);
  }
  // Resolve any `from_file` pointers BEFORE schema validation, per spec
  // § File 5 cross-file consistency: "@file resolution must happen before
  // zod validation, so the fully-substituted object is what is validated".
  const fixtureDir = fixturesRoot;
  const rawObj = raw as Record<string, unknown>;
  const octokitResponses = rawObj.octokit_responses as Record<string, unknown> | undefined;
  if (octokitResponses && typeof octokitResponses === 'object') {
    octokitResponses.pulls_list_files = await resolveFromFile(
      octokitResponses.pulls_list_files,
      fixtureDir,
    );
  }

  const parsed = ScenarioFixtureSchema.parse(rawObj);

  // Spec AC-FX-7: id MUST equal the basename of the fixture filename.
  const expectedId = basename(yamlPath, extname(yamlPath));
  if (parsed.id !== expectedId) {
    throw new Error(
      `fixture id "${parsed.id}" does not match filename basename "${expectedId}" (${yamlPath})`,
    );
  }

  // After resolution, `pulls_list_files` is always an array; the schema's
  // union narrows it for us, but we double-check at runtime so a bad
  // resolution surfaces a clean error rather than a downstream type error.
  const filesPayload = parsed.octokit_responses.pulls_list_files;
  if (!Array.isArray(filesPayload)) {
    throw new Error(
      `fixture ${yamlPath} octokit_responses.pulls_list_files did not resolve to an array`,
    );
  }

  return {
    fixture: parsed,
    filesPayload,
    yamlPath,
  };
};
