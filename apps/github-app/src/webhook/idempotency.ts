import { createHash } from 'node:crypto';

/**
 * `deriveIdempotencyKey` per docs/api-contracts.md § Webhook ingress contract
 * (Idempotency key derivation). The function is deterministic in its inputs
 * and uses a canonical field ordering so that any change to any field
 * produces a different key.
 *
 * Output shape: `prisma_<sha256-hex>` — the `prisma_` prefix reserves the key
 * namespace and disambiguates the key from raw GitHub identifiers in logs and
 * dashboards.
 */

export interface DeriveIdempotencyKeyOptions {
  installation_id: number;
  repository_id: number;
  pull_request_number: number;
  head_sha: string;
  delivery_id: string;
}

const KEY_PREFIX = 'prisma_';

export const deriveIdempotencyKey = (opts: DeriveIdempotencyKeyOptions): string => {
  const canonical = JSON.stringify({
    delivery_id: opts.delivery_id,
    installation_id: opts.installation_id,
    repository_id: opts.repository_id,
    pull_request_number: opts.pull_request_number,
    head_sha: opts.head_sha,
  });
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `${KEY_PREFIX}${digest}`;
};
