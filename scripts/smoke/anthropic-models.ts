/**
 * `scripts/smoke/anthropic-models.ts` — live Anthropic model smoke check
 * (ADR-009 § 3.17). USER-RUN, PRE-RELEASE ONLY.
 *
 * Runs one real `AnthropicProvider.review()` per model on a fixed, tiny,
 * deliberately non-security diff (an off-by-one bug) and prints one verdict
 * line per model. It is never run by `pnpm test`, `make`, CI, or vitest, and it
 * makes no network call unless `ANTHROPIC_API_KEY` is set.
 *
 * Usage:
 *   ./node_modules/.bin/tsx scripts/smoke/anthropic-models.ts [options] [model ...]
 *
 * Models:  positional args, else ANTHROPIC_SMOKE_MODELS (comma-separated), else
 *          claude-opus-5-5 claude-sonnet-5-5 claude-haiku-5-5.
 *          claude-fable-5-1 is opt-in: name it explicitly (needs 30-day
 *          retention; ZDR orgs get a 400).
 * Options: --effort <level>  send provider_options.anthropic.effort
 *                            (mapped to output_config.effort)
 *          --allow-empty     a zero-finding review does not fail the run
 *          -h, --help        print usage, exit 0
 * Env:     ANTHROPIC_API_KEY (required, never printed)
 *          ANTHROPIC_TOOL_CHOICE, ANTHROPIC_MAX_OUTPUT_TOKENS (parsed exactly
 *          as the worker parses them)
 * Exit:    0 every model PASS · 1 any FAIL or EMPTY · 2 usage error or missing key
 *
 * Boundaries:
 *   - Imports are confined to `node:` built-ins and the adapter's public
 *     entry (relative path: workspace packages are linked per consumer, so a
 *     bare package specifier does not resolve from `scripts/`). The vendor SDK
 *     is reached only through the adapter's own client factory (ADR-002).
 *   - Never prints the key, the system prompt, messages, tool input, finding
 *     text, response content or any refusal explanation (ADR-009 G-1). Every
 *     output line passes through a key-redaction backstop.
 */

import {
  type AnthropicClientLike,
  AnthropicProvider,
  type AnthropicToolChoiceStyle,
  type AnthropicUsageTelemetry,
  createAnthropicClient,
} from '../../packages/providers/anthropic/src/index.js';

type ReviewInput = Parameters<AnthropicProvider['review']>[0];

const USAGE = `Usage: ./node_modules/.bin/tsx scripts/smoke/anthropic-models.ts [options] [model ...]
Models:  positional args, else ANTHROPIC_SMOKE_MODELS (comma-separated), else
         claude-opus-5-5 claude-sonnet-5-5 claude-haiku-5-5.
         claude-fable-5-1 is opt-in: name it explicitly (needs 30-day retention; ZDR orgs get a 400).
Options: --effort <level>  send provider_options.anthropic.effort (-> output_config.effort)
         --allow-empty     a zero-finding review does not fail the run
         -h, --help        print usage, exit 0
Env:     ANTHROPIC_API_KEY (required, never printed)
         ANTHROPIC_TOOL_CHOICE, ANTHROPIC_MAX_OUTPUT_TOKENS (parsed exactly as the worker parses them)
Exit:    0 every model PASS · 1 any FAIL or EMPTY · 2 usage error or missing key
`;

const DEFAULT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const MODEL_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const EFFORT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MESSAGE_CAP = 200;
const REQUEST_TIMEOUT_MS = 180_000;

// A correctness bug (off-by-one loop bound), deliberately not security code, so
// the `cyber` safety classifier is not triggered.
const SMOKE_INPUT: ReviewInput = {
  files: [
    {
      path: 'src/smoke/sum.ts',
      language: 'ts',
      hunks: [
        {
          id: 'H1',
          line_start: 1,
          line_end: 7,
          content: [
            '+export function sum(xs: number[]): number {',
            '+  let total = 0;',
            '+  for (let i = 0; i <= xs.length; i++) {',
            '+    total += xs[i];',
            '+  }',
            '+  return total;',
            '+}',
          ].join('\n'),
        },
      ],
    },
  ],
} as ReviewInput;

// ---------------------------------------------------------------------------
// Output (all lines pass through the redaction backstop)
// ---------------------------------------------------------------------------

let redactKey = '';

function redact(line: string): string {
  return redactKey.length > 0 ? line.split(redactKey).join('[redacted]') : line;
}

function out(line: string): void {
  process.stdout.write(`${redact(line)}\n`);
}

function err(line: string): void {
  process.stderr.write(`${redact(line)}\n`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface Parsed {
  help: boolean;
  allowEmpty: boolean;
  effort: string | undefined;
  models: string[];
  error: string | undefined;
}

function parseArgs(argv: readonly string[]): Parsed {
  const parsed: Parsed = {
    help: false,
    allowEmpty: false,
    effort: undefined,
    models: [],
    error: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
    } else if (arg === '--allow-empty') {
      parsed.allowEmpty = true;
    } else if (arg === '--effort' || arg.startsWith('--effort=')) {
      const value = arg === '--effort' ? argv[++i] : arg.slice('--effort='.length);
      if (value === undefined || !EFFORT_RE.test(value)) {
        parsed.error = '--effort needs a level such as low, medium, high, xhigh or max';
      } else {
        parsed.effort = value;
      }
    } else if (arg.startsWith('-')) {
      parsed.error = `unknown option: ${arg.slice(0, 40)}`;
    } else {
      parsed.models.push(arg);
    }
  }
  return parsed;
}

function resolveModels(positional: readonly string[]): string[] {
  if (positional.length > 0) return [...positional];
  const fromEnv = (process.env.ANTHROPIC_SMOKE_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  return fromEnv.length > 0 ? fromEnv : [...DEFAULT_MODELS];
}

/** Parsed exactly as the worker's `readPositiveIntEnv`. */
function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

/** Parsed exactly as the worker parses `ANTHROPIC_TOOL_CHOICE` (invalid values are ignored). */
function readToolChoiceStyle(): AnthropicToolChoiceStyle | undefined {
  const raw = process.env.ANTHROPIC_TOOL_CHOICE;
  return raw === 'auto' || raw === 'forced' || raw === 'unforced' ? raw : undefined;
}

// ---------------------------------------------------------------------------
// Per-model run
// ---------------------------------------------------------------------------

type Verdict = 'PASS' | 'EMPTY' | 'FAIL';

interface Recorded {
  calls: number;
  toolChoice: string | undefined;
  strict: boolean;
  maxTokens: number | undefined;
  effort: string | undefined;
  stopReasons: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeToken(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(value) ? value : undefined;
}

/** Wraps the real client. Records ONLY the four request fields and `stop_reason`. */
function recordingClient(real: AnthropicClientLike, rec: Recorded): AnthropicClientLike {
  return {
    messages: {
      async create(args: unknown): Promise<unknown> {
        rec.calls += 1;
        const a = asRecord(args);
        rec.toolChoice = safeToken(asRecord(a?.tool_choice)?.type);
        const tools = a?.tools;
        rec.strict = Array.isArray(tools) && asRecord(tools[0])?.strict === true;
        rec.maxTokens = typeof a?.max_tokens === 'number' ? a.max_tokens : undefined;
        rec.effort = safeToken(asRecord(a?.output_config)?.effort);
        const response = await real.messages.create(args);
        const stop = safeToken(asRecord(response)?.stop_reason);
        if (stop !== undefined) rec.stopReasons.push(stop);
        return response;
      },
    },
  };
}

function describeFailure(thrown: unknown): string {
  const value = asRecord(asRecord(thrown)?.value);
  const kind = safeToken(value?.kind);
  if (kind === undefined) {
    const name = safeToken(asRecord(thrown)?.name) ?? 'unknown';
    return `kind=unexpected name=${name}`;
  }
  const parts = [`kind=${kind}`];
  const code = safeToken(value?.code);
  if (code !== undefined) parts.push(`code=${code}`);
  if (typeof value?.message === 'string') {
    const message = value.message.replace(/\s+/g, ' ').replace(/"/g, "'").slice(0, MESSAGE_CAP);
    parts.push(`message="${message}"`);
  }
  return parts.join(' ');
}

interface ModelResult {
  verdict: Verdict;
}

async function runModel(
  apiKey: string,
  model: string,
  effort: string | undefined,
): Promise<ModelResult> {
  const rec: Recorded = {
    calls: 0,
    toolChoice: undefined,
    strict: false,
    maxTokens: undefined,
    effort: undefined,
    stopReasons: [],
  };
  const sums: Partial<Record<'input' | 'output' | 'cached' | 'cache_write', number>> = {};
  const add = (key: keyof typeof sums, value: number | undefined): void => {
    if (value !== undefined) sums[key] = (sums[key] ?? 0) + value;
  };
  const onUsage = (u: AnthropicUsageTelemetry): void => {
    add('input', u.input_tokens);
    add('output', u.output_tokens);
    add('cached', u.cached_input_tokens);
    add('cache_write', u.cache_write_tokens);
  };

  const started = Date.now();
  let verdict: Verdict;
  let findings = 0;
  let failure: string | undefined;
  try {
    const real = createAnthropicClient({
      apiKey,
      timeoutMs: REQUEST_TIMEOUT_MS,
    }) as unknown as AnthropicClientLike;
    const style = readToolChoiceStyle();
    const maxOutputTokens = readPositiveIntEnv('ANTHROPIC_MAX_OUTPUT_TOKENS');
    const provider = new AnthropicProvider({
      apiKey,
      model,
      client: recordingClient(real, rec),
      onUsage,
      ...(style !== undefined ? { toolChoiceStyle: style } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    });
    const input: ReviewInput =
      effort !== undefined
        ? ({
            ...SMOKE_INPUT,
            request_shaping: { provider_options: { effort } },
          } as ReviewInput)
        : SMOKE_INPUT;
    const result = await provider.review(input);
    findings = result.findings.length;
    verdict = findings >= 1 ? 'PASS' : 'EMPTY';
  } catch (thrown) {
    verdict = 'FAIL';
    failure = describeFailure(thrown);
  }
  const elapsed = Date.now() - started;

  const fields: string[] = [`[anthropic-smoke] ${model} ${verdict} findings=${findings}`];
  if (failure !== undefined) fields.push(failure);
  fields.push(`calls=${rec.calls}`);
  if (rec.toolChoice !== undefined) fields.push(`tool_choice=${rec.toolChoice}`);
  fields.push(`strict=${rec.strict}`);
  if (rec.maxTokens !== undefined) fields.push(`max_tokens=${rec.maxTokens}`);
  fields.push(`effort=${rec.effort ?? 'default'}`);
  if (rec.stopReasons.length > 0) fields.push(`stop_reasons=${rec.stopReasons.join(',')}`);
  if (sums.input !== undefined) fields.push(`input_tokens=${sums.input}`);
  if (sums.output !== undefined) fields.push(`output_tokens=${sums.output}`);
  if (sums.cached !== undefined) fields.push(`cached_input_tokens=${sums.cached}`);
  if (sums.cache_write !== undefined) fields.push(`cache_write_tokens=${sums.cache_write}`);
  fields.push(`elapsed_ms=${elapsed}`);
  out(fields.join(' '));
  return { verdict };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.error !== undefined) {
    err(`[anthropic-smoke] ${parsed.error}`);
    process.stderr.write(USAGE);
    return 2;
  }
  const models = resolveModels(parsed.models);
  const badModel = models.find((m) => !MODEL_ID_RE.test(m));
  if (badModel !== undefined) {
    err('[anthropic-smoke] invalid model id (allowed: letters, digits, . _ : -; max 100 chars)');
    return 2;
  }

  // The key check happens before any client exists: no key, no calls.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    err('[anthropic-smoke] ANTHROPIC_API_KEY is not set; no calls were made.');
    return 2;
  }
  redactKey = apiKey;

  const style = readToolChoiceStyle();
  const maxOutputTokens = readPositiveIntEnv('ANTHROPIC_MAX_OUTPUT_TOKENS');
  out(
    `[anthropic-smoke] models=${models.join(',')} tool_choice_style=${style ?? 'auto'} max_output_tokens=${maxOutputTokens ?? 'default'} effort=${parsed.effort ?? 'default'}`,
  );

  let passed = 0;
  let failed = false;
  for (const model of models) {
    const { verdict } = await runModel(apiKey, model, parsed.effort);
    if (verdict === 'PASS') passed += 1;
    else if (verdict === 'FAIL' || !parsed.allowEmpty) failed = true;
  }
  out(`[anthropic-smoke] result: ${passed}/${models.length} PASS`);
  return failed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (thrown: unknown) => {
    err(`[anthropic-smoke] ${describeFailure(thrown)}`);
    process.exitCode = 1;
  },
);
