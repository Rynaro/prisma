import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignature } from '../../src/webhook/signature.js';

const SECRET = 'super-secret-test-value';

const sign = (body: Buffer, secret = SECRET): string => {
  const digest = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${digest}`;
};

describe('verifySignature', () => {
  it('returns ok for a correctly signed body', () => {
    const body = Buffer.from('{"hello":"world"}', 'utf8');
    const result = verifySignature({
      rawBody: body,
      signatureHeader: sign(body),
      secret: SECRET,
    });
    expect(result).toEqual({ ok: true });
  });

  it('returns missing_header when the header is absent', () => {
    const result = verifySignature({
      rawBody: Buffer.from('{}', 'utf8'),
      signatureHeader: undefined,
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('returns malformed_header when prefix is missing', () => {
    const body = Buffer.from('{}', 'utf8');
    const digest = createHmac('sha256', SECRET).update(body).digest('hex');
    const result = verifySignature({
      rawBody: body,
      signatureHeader: digest, // no `sha256=` prefix
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed_header' });
  });

  it('returns malformed_header when hex length is wrong', () => {
    const body = Buffer.from('{}', 'utf8');
    const result = verifySignature({
      rawBody: body,
      signatureHeader: 'sha256=deadbeef', // 8 chars, not 64
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed_header' });
  });

  it('returns malformed_header when hex is non-hex characters', () => {
    const body = Buffer.from('{}', 'utf8');
    const result = verifySignature({
      rawBody: body,
      signatureHeader: `sha256=${'z'.repeat(64)}`,
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed_header' });
  });

  it('returns mismatch when the digest does not match', () => {
    const body = Buffer.from('{"hello":"world"}', 'utf8');
    const wrong = `sha256=${'0'.repeat(64)}`;
    const result = verifySignature({
      rawBody: body,
      signatureHeader: wrong,
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('returns mismatch under timing-safe behavior on a same-length wrong digest', () => {
    // Compute a valid digest, then flip the last hex nibble. The result is
    // length-equal to the expected digest, exercising the constant-time path
    // through `crypto.timingSafeEqual`.
    const body = Buffer.from('payload', 'utf8');
    const valid = createHmac('sha256', SECRET).update(body).digest('hex');
    const flipped = `${valid.slice(0, -1)}${valid.endsWith('0') ? '1' : '0'}`;
    const result = verifySignature({
      rawBody: body,
      signatureHeader: `sha256=${flipped}`,
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('returns mismatch when the secret differs from the signing secret', () => {
    const body = Buffer.from('{"hello":"world"}', 'utf8');
    const result = verifySignature({
      rawBody: body,
      signatureHeader: sign(body, 'other-secret'),
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });
});
