import type {
  ProviderCapabilities,
  ProviderError,
  ProviderReviewInput,
  ProviderReviewOutput,
} from './provider.js';

/**
 * `Provider` — the single interface every model adapter implements.
 *
 * Per ADR-002 § Decision and api-contracts.md § Provider adapter contract:
 *   - `review(input)` is the only entry point used by the pipeline.
 *   - `capabilities` is a typed bag the pipeline reads (it does not
 *     rediscover capabilities at call time).
 *   - On failure, adapters throw `ProviderErrorThrowable` (instance of `Error`)
 *     whose `.value` is one of the five `ProviderError` variants
 *     (`transport | auth | rate_limit | capability | schema_validation`).
 *
 * Invariants (api-contracts.md § Invariants and error semantics, items 1, 4, 8):
 *   - No vendor SDK type ever appears in this signature or in any
 *     downstream type imported from this package.
 *   - Adapters never throw a vendor SDK exception; they map to
 *     `ProviderError` and rethrow as `ProviderErrorThrowable`.
 *   - Adapters never log the input or output bodies (observability.md
 *     § Event taxonomy: `provider.called` / `provider.error`).
 */
export interface Provider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  review(input: ProviderReviewInput): Promise<ProviderReviewOutput>;
}

export type { ProviderError };
