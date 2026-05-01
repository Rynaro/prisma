import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA-256 webhook signature verification per
 * docs/api-contracts.md § Webhook ingress contract and
 * docs/threat-model.md § Webhook replay or signature failures.
 *
 * Comparison is constant-time:
 *   - When the header is present and length-matched, the digests are
 *     compared with `crypto.timingSafeEqual` over equal-length Buffers.
 *   - When the header length differs from the expected hex digest length,
 *     a same-length zero buffer is compared instead so that the elapsed
 *     time of the comparison does not leak the length-mismatch path.
 *
 * The function never logs the signature header value or the secret; it only
 * reports a discriminated reason code.
 */

const SIGNATURE_PREFIX = 'sha256=';
const HEX_DIGEST_LENGTH = 64; // sha256 hex digest is 64 chars

export type SignatureVerificationResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'missing_header' | 'malformed_header' | 'mismatch';
    };

export interface VerifySignatureOptions {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  secret: string;
}

const isHexString = (value: string): boolean => /^[0-9a-f]+$/i.test(value);

export const verifySignature = (opts: VerifySignatureOptions): SignatureVerificationResult => {
  const { rawBody, signatureHeader, secret } = opts;

  if (signatureHeader === undefined) {
    return { ok: false, reason: 'missing_header' };
  }

  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, reason: 'malformed_header' };
  }

  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);

  if (providedHex.length !== HEX_DIGEST_LENGTH || !isHexString(providedHex)) {
    return { ok: false, reason: 'malformed_header' };
  }

  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expectedHex, 'hex');
  const providedBuffer = Buffer.from(providedHex, 'hex');

  // Both buffers are guaranteed equal-length here (HEX_DIGEST_LENGTH bytes when decoded).
  // We still defend against any future divergence by comparing against a zero-buffer of
  // the expected length when lengths somehow diverge — keeping wall-clock time flat on
  // the length-mismatch path. See module docstring.
  if (providedBuffer.length !== expectedBuffer.length) {
    const padded = Buffer.alloc(expectedBuffer.length);
    timingSafeEqual(expectedBuffer, padded);
    return { ok: false, reason: 'mismatch' };
  }

  if (!timingSafeEqual(expectedBuffer, providedBuffer)) {
    return { ok: false, reason: 'mismatch' };
  }

  return { ok: true };
};
