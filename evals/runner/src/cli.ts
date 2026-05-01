import { writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { evaluateExpectations } from './assertions.js';
import { loadScenarioFixture, loadScenarioIndex } from './loader.js';
import { runPipelineForFixture } from './pipeline-runner.js';
import {
  type ScenarioOutcomeRecord,
  buildReport,
  fromAssertionReport,
  renderJson,
  renderMarkdown,
} from './reporter.js';

/**
 * Eval-runner CLI entry point.
 *
 * Flags:
 *   --all                — run every scenario in `evals/scenarios.yaml`
 *   --scenario <id>      — run a single scenario by id
 *   --report-md <path>   — emit a Markdown report to `<path>`
 *   --fixtures-dir <path>— override the fixtures root (default `evals/fixtures`)
 *
 * Exit codes per spec:
 *   0 — every scenario PASS
 *   1 — at least one scenario FAIL
 *   2 — harness error (config parse failure, missing fixture, etc.)
 *
 * Container-first: when invoked from `make eval` the working directory is
 * `/app`, so the default fixtures root resolves to `/app/evals/fixtures` and
 * the default index file resolves to `/app/evals/scenarios.yaml`.
 */

interface ParsedArgs {
  all: boolean;
  scenarioId?: string;
  reportMdPath?: string;
  fixturesDir: string;
  indexPath: string;
}

const DEFAULT_FIXTURES_DIR = 'evals/fixtures';
const DEFAULT_INDEX_PATH = 'evals/scenarios.yaml';

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const result: ParsedArgs = {
    all: false,
    fixturesDir: DEFAULT_FIXTURES_DIR,
    indexPath: DEFAULT_INDEX_PATH,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') {
      result.all = true;
      continue;
    }
    if (arg === '--scenario') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--scenario requires a value');
      result.scenarioId = next;
      i += 1;
      continue;
    }
    if (arg === '--report-md') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--report-md requires a value');
      result.reportMdPath = next;
      i += 1;
      continue;
    }
    if (arg === '--fixtures-dir') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--fixtures-dir requires a value');
      result.fixturesDir = next;
      i += 1;
      continue;
    }
    if (arg === '--index') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--index requires a value');
      result.indexPath = next;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  if (!result.all && result.scenarioId === undefined) {
    // Default to --all when neither flag is present.
    result.all = true;
  }
  return result;
};

const printHelp = (): void => {
  const lines = [
    'eval-runner — Phase 6 evaluation harness',
    '',
    'Usage:',
    '  pnpm --filter @prisma-bot/eval-runner run eval -- [options]',
    '',
    'Options:',
    '  --all                   Run every scenario in evals/scenarios.yaml',
    '  --scenario <id>         Run a single scenario by id',
    '  --report-md <path>      Emit a Markdown report to <path>',
    '  --fixtures-dir <path>   Override fixtures root (default evals/fixtures)',
    '  --index <path>          Override index file (default evals/scenarios.yaml)',
    '  --help, -h              Print this help',
  ];
  for (const line of lines) process.stdout.write(`${line}\n`);
};

const runOne = async (
  fixturesRoot: string,
  indexFixturePath: string,
): Promise<ScenarioOutcomeRecord> => {
  // The index stores `fixture: fixtures/<id>.yaml` (relative to `evals/`); the
  // loader operates on a fixtures root rooted at `evals/fixtures`. Strip the
  // `fixtures/` prefix when present so we always pass `<id>.yaml` to the
  // loader. Falling back to `basename` keeps the call total robust against
  // alternate path encodings (e.g., a leading `./`).
  const stripped = indexFixturePath.startsWith('fixtures/')
    ? indexFixturePath.slice('fixtures/'.length)
    : basename(indexFixturePath);
  const loaded = await loadScenarioFixture(fixturesRoot, stripped);
  const outcome = await runPipelineForFixture({
    fixture: loaded.fixture,
    filesPayload: loaded.filesPayload,
  });
  const assertion = evaluateExpectations(outcome, loaded.fixture.expectations);
  return fromAssertionReport(loaded.fixture.id, assertion, loaded.fixture.description);
};

export const main = async (argv: readonly string[]): Promise<number> => {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const cwd = process.cwd();
  const fixturesRoot = resolve(cwd, parsed.fixturesDir);
  const indexPath = resolve(cwd, parsed.indexPath);

  let index: Awaited<ReturnType<typeof loadScenarioIndex>>;
  try {
    index = await loadScenarioIndex(indexPath);
  } catch (err) {
    process.stderr.write(
      `failed to load scenario index ${indexPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const records: ScenarioOutcomeRecord[] = [];
  const targets = parsed.scenarioId
    ? index.scenarios.filter((s) => s.id === parsed.scenarioId)
    : index.scenarios;

  if (parsed.scenarioId !== undefined && targets.length === 0) {
    process.stderr.write(`scenario "${parsed.scenarioId}" not found in ${indexPath}\n`);
    return 2;
  }

  for (const entry of targets) {
    try {
      const record = await runOne(fixturesRoot, entry.fixture);
      records.push(record);
    } catch (err) {
      records.push({
        id: entry.id,
        status: 'error',
        failures: [],
        error_message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const report = buildReport(records);
  process.stdout.write(renderJson(report));

  if (parsed.reportMdPath !== undefined) {
    const out = resolve(cwd, parsed.reportMdPath);
    try {
      await writeFile(out, renderMarkdown(report), 'utf-8');
    } catch (err) {
      process.stderr.write(
        `failed to write markdown report to ${out}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }
  }

  if (report.summary.errored > 0) return 2;
  if (report.summary.failed > 0) return 1;
  return 0;
};

const argv = process.argv.slice(2);
main(argv)
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    process.stderr.write(`unhandled error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
