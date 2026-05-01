import Anthropic from '@anthropic-ai/sdk';

/**
 * `AnthropicClientLike` — the minimal shape this package consumes from the
 * Anthropic SDK. Declared in `index.ts` so other modules in this package can
 * inject mock clients without importing the SDK.
 *
 * This file is the ONLY file in the repo permitted to import the
 * `@anthropic-ai/sdk` runtime types per ADR-002 § Decision and
 * api-contracts.md § Invariants and error semantics (item 1).
 */
export interface CreateAnthropicClientOptions {
  apiKey: string;
  baseURL?: string;
  timeoutMs?: number;
  httpAgent?: unknown;
}

export function createAnthropicClient(opts: CreateAnthropicClientOptions): Anthropic {
  const config: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: opts.apiKey,
  };
  if (opts.baseURL !== undefined) {
    config.baseURL = opts.baseURL;
  }
  if (opts.timeoutMs !== undefined) {
    config.timeout = opts.timeoutMs;
  }
  if (opts.httpAgent !== undefined) {
    (config as Record<string, unknown>).httpAgent = opts.httpAgent;
  }
  return new Anthropic(config);
}
