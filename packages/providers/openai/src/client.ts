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
 * Wire shape: OpenAI-compatible `/chat/completions`. On non-2xx
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
 */
export interface OpenAIChatCompletionsArgs {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  tools: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: object };
  }>;
  tool_choice: { type: 'function'; function: { name: string } };
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
}

export interface OpenAIClient {
  chatCompletions(args: OpenAIChatCompletionsArgs): Promise<unknown>;
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

export function createOpenAIClient(opts: CreateOpenAIClientOptions): OpenAIClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const timeoutMs = opts.timeoutMs;

  return {
    async chatCompletions(args: OpenAIChatCompletionsArgs): Promise<unknown> {
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
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(args),
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
    },
  };
}
