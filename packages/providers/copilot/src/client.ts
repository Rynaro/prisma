/**
 * `client.ts` — the **only** file in this package permitted to call the network
 * primitive (`fetch`) for the GitHub Models inference endpoint.
 *
 * Per ADR-002 § Decision and api-contracts.md § Invariants and error semantics
 * (item 1): no vendor-specific transport detail leaks outside this file. The
 * exported `CopilotClientLike` shape (declared in `index.ts`, mirrored here
 * via the return type of `createCopilotClient`) is the only surface the rest
 * of the package consumes — tests inject mocks against the same shape.
 *
 * Wire shape: OpenAI-compatible `/chat/completions` (GitHub Models). On non-2xx
 * responses we throw a plain object carrying `status`, `headers`, `message`,
 * and (when available) `error.type`, which `error-mapping.ts` reads
 * vendor-neutrally.
 */

export interface CreateCopilotClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface CopilotChatCompletionsArgs {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  tools: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: object };
  }>;
  tool_choice: { type: 'function'; function: { name: string } };
  max_tokens: number;
}

export interface CopilotClient {
  chatCompletions(args: CopilotChatCompletionsArgs): Promise<unknown>;
}

const DEFAULT_BASE_URL = 'https://models.github.ai/inference';

interface CopilotHttpError {
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

export function createCopilotClient(opts: CreateCopilotClientOptions): CopilotClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const timeoutMs = opts.timeoutMs;

  return {
    async chatCompletions(args: CopilotChatCompletionsArgs): Promise<unknown> {
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
          `copilot HTTP ${response.status}`;
        const httpError: CopilotHttpError = {
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
