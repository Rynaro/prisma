/**
 * `scripts/replay-webhook.ts` — developer-only signed webhook replay CLI.
 *
 * Reads an evaluation fixture (`evals/fixtures/<id>.yaml`), reconstructs a
 * `pull_request` webhook delivery from the fixture's `pr_payload` block,
 * computes the `X-Hub-Signature-256` header per
 * `docs/api-contracts.md` § Webhook ingress contract, and POSTs the body
 * to a configurable URL. Intended to be invoked through the `tools`
 * container via `make replay-webhook FIXTURE=<id>`.
 *
 * Developer tool — not for production use. The signed delivery here is
 * webhook-authentication only; the GitHub App private key (`.pem`) is
 * never used by this script.
 *
 * CLI shape (matches README "Local webhook development"):
 *
 *   tsx scripts/replay-webhook.ts \
 *     --fixture <fixture-id> \
 *     [--url http://localhost:3030/webhooks/github] \
 *     [--secret-env GITHUB_APP_WEBHOOK_SECRET] \
 *     [--delivery-id <uuid>]
 *
 * Exit codes:
 *   0 — receiver returned 2xx
 *   1 — receiver returned non-2xx
 *   2 — argument / parse error (bad flag, missing fixture field)
 *   3 — fixture file not found on disk
 *
 * Imports are confined to the Node standard library plus the `yaml`
 * package already pinned by `@prisma-bot/config`. No imports from the
 * `@prisma-bot/*` workspace packages so the script stays standalone.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';

const DEFAULT_URL = 'http://localhost:3030/webhooks/github';
const DEFAULT_SECRET_ENV = 'GITHUB_APP_WEBHOOK_SECRET';
// Mirrors the literal in apps/github-app/src/main.ts (DEV_FALLBACK_SECRET).
// Keep these two constants byte-equivalent.
const DEV_FALLBACK_SECRET = 'dev-only-not-secure';
const RESPONSE_BODY_TRUNCATION_BYTES = 4 * 1024;

const USAGE = `Usage: tsx scripts/replay-webhook.ts \\
  --fixture <fixture-id> \\
  [--url http://localhost:3030/webhooks/github] \\
  [--secret-env GITHUB_APP_WEBHOOK_SECRET] \\
  [--delivery-id <uuid>]

Replays a Phase 6 evaluation fixture as a signed pull_request webhook
delivery against a running app instance. Developer tool only.

Flags:
  --fixture       Required. Fixture id under evals/fixtures/<id>.yaml.
  --url           Override target URL. Default: ${DEFAULT_URL}
  --secret-env    Env var name holding the webhook secret.
                  Default: ${DEFAULT_SECRET_ENV}
                  Falls back to the dev-only constant when unset.
  --delivery-id   X-GitHub-Delivery override (UUID). Default: random UUID.
  -h, --help      Print this help and exit 0.

Exit codes: 0 = 2xx response, 1 = non-2xx, 2 = arg/parse error,
3 = fixture not found.
`;

interface ParsedArgs {
  fixture: string;
  url: string;
  secretEnv: string;
  deliveryId: string | undefined;
}

const parseCliArgs = (argv: string[]): ParsedArgs | { help: true } => {
  const result = parseArgs({
    args: argv,
    options: {
      fixture: { type: 'string' },
      url: { type: 'string' },
      'secret-env': { type: 'string' },
      'delivery-id': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (result.values.help === true) {
    return { help: true };
  }
  const fixture = result.values.fixture;
  if (typeof fixture !== 'string' || fixture.length === 0) {
    throw new Error('--fixture is required');
  }
  const url = typeof result.values.url === 'string' ? result.values.url : DEFAULT_URL;
  const secretEnv =
    typeof result.values['secret-env'] === 'string'
      ? result.values['secret-env']
      : DEFAULT_SECRET_ENV;
  const deliveryId =
    typeof result.values['delivery-id'] === 'string' ? result.values['delivery-id'] : undefined;
  return { fixture, url, secretEnv, deliveryId };
};

interface FixtureShape {
  pr_payload?: unknown;
}

const readFixture = async (
  fixtureId: string,
): Promise<{ rawBody: string; fixturePath: string }> => {
  const fixturePath = resolve(process.cwd(), 'evals', 'fixtures', `${fixtureId}.yaml`);
  let contents: string;
  try {
    contents = await readFile(fixturePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new FixtureNotFoundError(fixtureId, fixturePath);
    }
    throw new Error(
      `failed to read fixture ${fixtureId} at ${fixturePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(contents);
  } catch (err) {
    throw new Error(
      `fixture ${fixtureId} (${fixturePath}) is not valid YAML: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `fixture ${fixtureId} (${fixturePath}) must be a YAML mapping at the top level`,
    );
  }
  const fixture = parsed as FixtureShape;
  if (fixture.pr_payload === undefined) {
    throw new Error(
      `fixture ${fixtureId} (${fixturePath}) has no \`pr_payload\` field; expected a pull_request payload mapping`,
    );
  }
  const rawBody = JSON.stringify(fixture.pr_payload);
  return { rawBody, fixturePath };
};

class FixtureNotFoundError extends Error {
  public readonly fixtureId: string;
  public readonly fixturePath: string;
  public constructor(fixtureId: string, fixturePath: string) {
    super(`fixture not found: ${fixtureId} (expected at ${fixturePath})`);
    this.name = 'FixtureNotFoundError';
    this.fixtureId = fixtureId;
    this.fixturePath = fixturePath;
  }
}

const computeSignature = (rawBody: string, secret: string): string => {
  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return `sha256=${digest}`;
};

const resolveSecret = (secretEnvName: string): { secret: string; usingFallback: boolean } => {
  const fromEnv = process.env[secretEnvName];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return { secret: fromEnv, usingFallback: false };
  }
  return { secret: DEV_FALLBACK_SECRET, usingFallback: true };
};

const truncateBody = (body: string): string => {
  if (Buffer.byteLength(body, 'utf8') <= RESPONSE_BODY_TRUNCATION_BYTES) {
    return body;
  }
  // Truncate at a UTF-8 byte boundary by slicing characters until the byte
  // budget is exhausted; appending an ellipsis marker.
  let bytes = 0;
  let cut = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] ?? '';
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > RESPONSE_BODY_TRUNCATION_BYTES) break;
    bytes += chBytes;
    cut = i + 1;
  }
  return `${body.slice(0, cut)}\n... [truncated]`;
};

const writeStderrLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const writeStdoutLine = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const main = async (): Promise<number> => {
  let parsed: ParsedArgs | { help: true };
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    writeStderrLine(`error: ${err instanceof Error ? err.message : String(err)}`);
    writeStderrLine('');
    process.stderr.write(USAGE);
    return 2;
  }
  if ('help' in parsed) {
    process.stdout.write(USAGE);
    return 0;
  }

  let fixtureLoad: Awaited<ReturnType<typeof readFixture>>;
  try {
    fixtureLoad = await readFixture(parsed.fixture);
  } catch (err) {
    if (err instanceof FixtureNotFoundError) {
      writeStderrLine(`error: ${err.message}`);
      return 3;
    }
    writeStderrLine(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const { rawBody } = fixtureLoad;

  const { secret, usingFallback } = resolveSecret(parsed.secretEnv);
  if (usingFallback) {
    writeStderrLine(
      `warn: ${parsed.secretEnv} is unset; using dev-only fallback secret (${DEV_FALLBACK_SECRET}). Production deliveries MUST set the env var.`,
    );
  }

  const signature = computeSignature(rawBody, secret);
  const deliveryId = parsed.deliveryId ?? randomUUID();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Event': 'pull_request',
    'X-GitHub-Delivery': deliveryId,
    'X-Hub-Signature-256': signature,
  };

  let response: Response;
  try {
    response = await fetch(parsed.url, {
      method: 'POST',
      headers,
      body: rawBody,
    });
  } catch (err) {
    writeStderrLine(
      `error: POST ${parsed.url} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const status = response.status;
  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch (err) {
    bodyText = `<failed to read response body: ${err instanceof Error ? err.message : String(err)}>`;
  }
  const truncated = truncateBody(bodyText);

  // stdout: status code on its own line, then the (possibly truncated) body.
  // smoke.sh consumes the first stdout line and asserts on the status code.
  writeStdoutLine(String(status));
  if (truncated.length > 0) {
    process.stdout.write(truncated);
    if (!truncated.endsWith('\n')) process.stdout.write('\n');
  }

  // stderr: a single structured JSON line summarising the request, plus
  // the Delivery header for human-readable diagnostics. Signature value
  // is logged on stderr at a separate line so it is not confused with
  // the response body on stdout. Secret is never logged.
  const summary = {
    ts: new Date().toISOString(),
    fixture: parsed.fixture,
    url: parsed.url,
    status,
    delivery_id: deliveryId,
  };
  writeStderrLine(JSON.stringify(summary));
  writeStderrLine(`X-GitHub-Delivery: ${deliveryId}`);
  writeStderrLine(`X-Hub-Signature-256: ${signature}`);

  if (status >= 200 && status < 300) return 0;
  return 1;
};

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    writeStderrLine(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
