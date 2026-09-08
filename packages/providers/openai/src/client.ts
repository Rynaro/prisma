/**
 * `client.ts` — the **only** file in this package permitted to call the network
 * primitive (`fetch`) for the OpenAI inference endpoint.
 *
 * Per ADR-002 § Decision and api-contracts.md § Invariants and error semantics
 * (item 1): no vendor-specific transport detail leaks outside this file. The
 * exported `OpenAIClientLike` shape (declared in `index.ts`, mirrored here
 * via the return type of `createOpenAIClient`) is the only surface the rest
 * of the package consumes — tests inject mocks against the same shape.
 *
 * Wire shape: OpenAI-compatible `/chat/completions`, plus `/responses` for the
 * model families that reject function tools on `/chat/completions`. On non-2xx
 * responses we throw a plain object carrying `status`, `headers`, `message`,
 * and (when available) `error.type` / `error.code`, which `error-mapping.ts`
 * reads vendor-neutrally.
 */

export interface CreateOpenAIClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * `OpenAIChatCompletionsArgs` — the wire shape sent to `/chat/completions`.
 *
 * The token-limit parameter changed across OpenAI model families:
 *   - Classic models (`gpt-4o`, `gpt-4`, `gpt-3.5-turbo`, …): `max_tokens`.
 *   - Newer families (gpt-5*, o1, o3, o4, …): `max_completion_tokens`.
 *
 * Exactly one of the two optional token fields must be set per request;
 * `resolveTokenParam` (index.ts) selects the correct key. Both are typed as
 * optional here so the TS type can carry either without carrying both. The
 * `createOpenAIClient` implementation serialises the body via `JSON.stringify`,
 * which elides undefined keys, ensuring only the populated field is sent.
 *
 * Per ADR-002: no vendor types leak past `client.ts`. The caller (index.ts) is
 * responsible for populating exactly one token field.
 *
 * The index signature `[k: string]: unknown` carries raw `provider_options`
 * passthrough keys (spec § 5.3, AS-8/AS-9).  `JSON.stringify` elides
 * `undefined` values so absent optional fields never reach the wire.
 * The denylist (index.ts `OPENAI_PASSTHROUGH_DENYLIST`) prevents passthrough
 * from overriding Prisma-critical fields (spec § 3.7, G8).
 */
export interface OpenAIChatCompletionsArgs {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  tools: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: object };
  }>;
  /**
   * tool_choice: either 'required' (reasoning models: gpt-5+/o-series, allows
   * interleaved thinking) or a forced-specific function object (classic models:
   * gpt-4o, gpt-4.1). See resolveToolChoice in index.ts.
   */
  tool_choice: 'required' | { type: 'function'; function: { name: string } };
  /**
   * Output token cap for classic model families (`gpt-4o`, `gpt-4`, `gpt-3.5-turbo`, …).
   * Mutually exclusive with `max_completion_tokens` — set exactly one per request.
   */
  max_tokens?: number;
  /**
   * Output token cap for newer model families (`gpt-5*`, `o1`, `o3`, `o4`, …).
   * Mutually exclusive with `max_tokens` — set exactly one per request.
   */
  max_completion_tokens?: number;
  seed?: number;
  /** Normalized temperature from `generation.temperature`. */
  temperature?: number;
  /** Nucleus sampling from `generation.top_p`. */
  top_p?: number;
  /**
   * Open index signature for raw `provider_options.openai` passthrough keys.
   * The denylist in `index.ts` prevents Prisma-critical fields from being set
   * here. `JSON.stringify` elides `undefined`, so absent optional fields from
   * the fixed properties above never appear as explicit `undefined` on the wire
   * either — only truly set values are serialised.
   */
  [k: string]: unknown;
}

/**
 * `OpenAIResponsesArgs`, the wire shape sent to `/responses`.
 *
 * The Responses API spells the same request differently from
 * `/chat/completions`:
 *   - the system message is `instructions`, the remaining turns are `input`;
 *   - a tool is flat (`{ type, name, description, parameters }`) rather than
 *     nested under a `function` key;
 *   - the output cap is `max_output_tokens` (neither `max_tokens` nor
 *     `max_completion_tokens` is accepted);
 *   - reasoning effort is a `reasoning: { effort }` object, not the flat
 *     `reasoning_effort` field the chat endpoint takes;
 *   - there is no `seed`;
 *   - `store` controls server-side retention; Prisma sends `false`.
 *
 * The endpoint rejects unknown top-level parameters with HTTP 400, so a chat
 * field cannot simply ride along.
 *
 * `tool_choice: 'required'` keeps its meaning and its wire value. The mapping
 * from `OpenAIChatCompletionsArgs` lives in `toResponsesArgs` (index.ts) so
 * this file stays transport-only.
 *
 * The index signature carries raw `provider_options` passthrough keys exactly
 * as `OpenAIChatCompletionsArgs` does.
 */
export interface OpenAIResponsesArgs {
  model: string;
  /** The system message, which the Responses API takes as a top-level field. */
  instructions: string;
  input: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: Array<{
    type: 'function';
    name: string;
    description: string;
    parameters: object;
  }>;
  /** Same values as the chat endpoint, minus the `function` nesting. */
  tool_choice: 'required' | { type: 'function'; name: string };
  /** Output token cap. The Responses API accepts only this spelling. */
  max_output_tokens?: number;
  /**
   * Reasoning configuration. `toResponsesArgs` builds this from a native
   * `provider_options.openai.reasoning` object and/or the legacy
   * `reasoning_effort` chat spelling. Typed as `unknown` because the object's
   * own fields (`effort`, `summary`, …) are the vendor's contract, not this
   * adapter's — the adapter only guarantees the key.
   */
  reasoning?: unknown;
  /** Server-side retention of the response. Prisma sends `false`. */
  store?: boolean;
  temperature?: number;
  top_p?: number;
  [k: string]: unknown;
}

/**
 * `OpenAITextCompletionArgs` — the wire shape for a plain-text (no tools)
 * `/chat/completions` request, used by `respond()` (reviewer-interaction,
 * `@bot ask <message>`). Mirrors `OpenAIChatCompletionsArgs` minus the
 * `tools`/`tool_choice` fields — `respond()` has no JSON-schema contract, the
 * model simply replies with markdown text.
 */
export interface OpenAITextCompletionArgs {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  max_tokens?: number;
  max_completion_tokens?: number;
  seed?: number;
  temperature?: number;
  top_p?: number;
  [k: string]: unknown;
}

export interface OpenAIClient {
  chatCompletions(args: OpenAIChatCompletionsArgs): Promise<unknown>;
  responses(args: OpenAIResponsesArgs): Promise<unknown>;
  textCompletion(args: OpenAITextCompletionArgs): Promise<unknown>;
}

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

interface OpenAIHttpError {
  status: number;
  headers: Record<string, string>;
  message: string;
  error?: { type?: string; code?: string };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Shared POST-and-error-mapping logic for `chatCompletions`, `responses` and
 * `textCompletion`. The only difference between the wire calls is the URL and
 * the request body shape; the HTTP/error handling is identical, so it is
 * factored here once (DRY) rather than duplicated.
 */
async function postChatCompletion(
  url: string,
  apiKey: string,
  timeoutMs: number | undefined,
  body: unknown,
): Promise<unknown> {
  const controller = timeoutMs !== undefined ? new AbortController() : undefined;
  const timeoutHandle =
    controller !== undefined && timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;

  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  };
  if (controller !== undefined) {
    init.signal = controller.signal;
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }

  if (!response.ok) {
    let errorPayload: unknown;
    try {
      errorPayload = await response.json();
    } catch {
      try {
        errorPayload = { message: await response.text() };
      } catch {
        errorPayload = { message: `HTTP ${response.status}` };
      }
    }
    const payload =
      typeof errorPayload === 'object' && errorPayload !== null
        ? (errorPayload as Record<string, unknown>)
        : {};
    const innerError =
      typeof payload.error === 'object' && payload.error !== null
        ? (payload.error as { type?: string; code?: string; message?: string })
        : undefined;
    const messageRaw =
      (innerError?.message ?? (typeof payload.message === 'string' ? payload.message : '')) ||
      `openai HTTP ${response.status}`;
    const httpError: OpenAIHttpError = {
      status: response.status,
      headers: headersToRecord(response.headers),
      message: messageRaw,
    };
    if (innerError !== undefined) {
      const e: { type?: string; code?: string } = {};
      if (innerError.type !== undefined) e.type = innerError.type;
      if (innerError.code !== undefined) e.code = innerError.code;
      httpError.error = e;
    }
    throw httpError;
  }

  return response.json();
}

export function createOpenAIClient(opts: CreateOpenAIClientOptions): OpenAIClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const responsesUrl = `${baseUrl}/responses`;
  const timeoutMs = opts.timeoutMs;

  return {
    chatCompletions(args: OpenAIChatCompletionsArgs): Promise<unknown> {
      return postChatCompletion(url, opts.apiKey, timeoutMs, args);
    },
    responses(args: OpenAIResponsesArgs): Promise<unknown> {
      return postChatCompletion(responsesUrl, opts.apiKey, timeoutMs, args);
    },
    textCompletion(args: OpenAITextCompletionArgs): Promise<unknown> {
      return postChatCompletion(url, opts.apiKey, timeoutMs, args);
    },
  };
}
