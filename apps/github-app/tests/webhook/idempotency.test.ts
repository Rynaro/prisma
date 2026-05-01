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
});
