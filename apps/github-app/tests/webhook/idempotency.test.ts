import { describe, expect, it } from 'vitest';
import { deriveIdempotencyKey } from '../../src/webhook/idempotency.js';

const baseInput = {
  installation_id: 1234,
  repository_id: 5678,
  pull_request_number: 42,
  head_sha: 'a'.repeat(40),
  delivery_id: '11111111-2222-3333-4444-555555555555',
};

describe('deriveIdempotencyKey', () => {
  it('is deterministic for identical inputs', () => {
    const a = deriveIdempotencyKey(baseInput);
    const b = deriveIdempotencyKey({ ...baseInput });
    expect(a).toBe(b);
  });

  it('changes when installation_id changes', () => {
    const a = deriveIdempotencyKey(baseInput);
    const b = deriveIdempotencyKey({ ...baseInput, installation_id: 9999 });
    expect(a).not.toBe(b);
  });

  it('changes when repository_id changes', () => {
    const a = deriveIdempotencyKey(baseInput);
    const b = deriveIdempotencyKey({ ...baseInput, repository_id: 99 });
    expect(a).not.toBe(b);
  });

  it('changes when pull_request_number changes', () => {
    const a = deriveIdempotencyKey(baseInput);
    const b = deriveIdempotencyKey({ ...baseInput, pull_request_number: 99 });
    expect(a).not.toBe(b);
  });

  it('changes when head_sha changes', () => {
    const a = deriveIdempotencyKey(baseInput);
    const b = deriveIdempotencyKey({ ...baseInput, head_sha: 'b'.repeat(40) });
    expect(a).not.toBe(b);
  });

  it('changes when delivery_id changes', () => {
    const a = deriveIdempotencyKey(baseInput);
    const b = deriveIdempotencyKey({
      ...baseInput,
      delivery_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(a).not.toBe(b);
  });

  it('produces a key with the prisma_ prefix', () => {
    const key = deriveIdempotencyKey(baseInput);
    expect(key.startsWith('prisma_')).toBe(true);
    // sha256 hex is 64 chars; prefix adds 7 → total 71.
    expect(key.length).toBe(7 + 64);
  });

  // --- T2: golden-value regression (PR-event key must be byte-for-byte unchanged) ---

  it('golden-value: PR-event key is byte-for-byte unchanged after discriminated union refactor', () => {
    // This value was computed from:
    //   JSON.stringify({
    //     delivery_id: '11111111-2222-3333-4444-555555555555',
    //     installation_id: 1234, repository_id: 5678,
    //     pull_request_number: 42, head_sha: 'a'.repeat(40),
    //   })
    // → sha256 → 'prisma_' prefix. MUST remain byte-for-byte stable.
    const key = deriveIdempotencyKey(baseInput);
    expect(key).toBe('prisma_2b0e78023e7e77ec59d400c08a0f522454ca51aede1336eafd3a14dd61bf9aaf');
  });

  it('two issue_comment jobs with different comment_id produce different keys', () => {
    const a = deriveIdempotencyKey({ ...baseInput, head_sha: '', comment_id: 1001 });
    const b = deriveIdempotencyKey({ ...baseInput, head_sha: '', comment_id: 1002 });
    expect(a).not.toBe(b);
  });

  it('comment job key differs from PR job key even with same delivery_id', () => {
    const prKey = deriveIdempotencyKey(baseInput);
    const commentKey = deriveIdempotencyKey({ ...baseInput, head_sha: '', comment_id: 999 });
    expect(prKey).not.toBe(commentKey);
  });

  it('two check_run jobs with different check_run_id produce different keys', () => {
    const a = deriveIdempotencyKey({ ...baseInput, check_run_id: 111 });
    const b = deriveIdempotencyKey({ ...baseInput, check_run_id: 222 });
    expect(a).not.toBe(b);
  });

  it('PR-event key is identical whether or not comment_id/check_run_id are absent', () => {
    // Neither optional discriminator is present → key matches the golden value.
    // We call with baseInput twice (spread ensures a new object) to confirm
    // that simply not providing the optional keys produces the same result.
    const withoutDiscriminators = deriveIdempotencyKey(baseInput);
    const alsoWithout = deriveIdempotencyKey({ ...baseInput });
    expect(withoutDiscriminators).toBe(alsoWithout);
  });
});
