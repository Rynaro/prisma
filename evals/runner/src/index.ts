/**
 * Public surface of `@prisma-bot/eval-runner`. Re-exports the symbols the
 * harness's tests (and any future programmatic caller) consume; nothing in
 * the CLI entry point (`cli.ts`) is exported because callers should drive the
 * runner via `pnpm --filter @prisma-bot/eval-runner run eval` or `make eval`.
 */

export type {
  AssertionFailure,
  AssertionReport,
} from './assertions.js';
export { evaluateExpectations } from './assertions.js';

export type { LoadedScenario } from './loader.js';
export { loadScenarioFixture, loadScenarioIndex } from './loader.js';

export type {
  PrefilterMirror,
  RunOutcome,
  RunOutcomeError,
  RunPipelineForFixtureArgs,
} from './pipeline-runner.js';
export { runPipelineForFixture } from './pipeline-runner.js';

export type {
  ScenarioOutcomeRecord,
  ScenarioReport,
} from './reporter.js';
export {
  buildReport,
  fromAssertionReport,
  renderJson,
  renderMarkdown,
  summarise,
} from './reporter.js';

export type {
  ChangedFileEntry,
  MetricId,
  ProviderScriptStep,
  PullsGetData,
  ScenarioExpectations,
  ScenarioFixture,
  ScenarioIndex,
  ScenarioIndexEntry,
  ScenarioOctokitResponses,
  ScenarioPullRequestPayload,
} from './schema.js';
export {
  MetricIdSchema,
  ScenarioExpectationsSchema,
  ScenarioFixtureSchema,
  ScenarioIndexSchema,
  ScenarioOctokitResponsesSchema,
  ScenarioPullRequestPayloadSchema,
  mergeConfig,
} from './schema.js';
