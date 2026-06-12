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
 *
 * Optional discriminators `comment_id` and `check_run_id` are included in the
 * canonical JSON only when defined, preserving existing pull_request-event keys
 * byte-for-byte (backward-compatible extension per spec D4).
 *
 * For `issue_comment` jobs where head_sha is not available at ingress, pass
 * `head_sha: ''` (empty-string sentinel); the canonical JSON will include the
 * empty string, which differentiates it from a real sha.
 */

export interface DeriveIdempotencyKeyOptions {
  installation_id: number;
  repository_id: number;
  pull_request_number: number;
  head_sha: string;
  delivery_id: string;
  /** Optional: present for issue_comment.command jobs. */
  comment_id?: number;
  /** Optional: present for check_run.rerequested jobs. */
  check_run_id?: number;
}

const KEY_PREFIX = 'prisma_';

export const deriveIdempotencyKey = (opts: DeriveIdempotencyKeyOptions): string => {
  const base: Record<string, unknown> = {
    delivery_id: opts.delivery_id,
    installation_id: opts.installation_id,
    repository_id: opts.repository_id,
    pull_request_number: opts.pull_request_number,
    head_sha: opts.head_sha,
  };
  // Include optional discriminators only when defined so that existing
  // pull_request-event keys remain byte-for-byte unchanged.
  if (opts.comment_id !== undefined) {
    base.comment_id = opts.comment_id;
  }
  if (opts.check_run_id !== undefined) {
    base.check_run_id = opts.check_run_id;
  }
  const canonical = JSON.stringify(base);
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `${KEY_PREFIX}${digest}`;
};
