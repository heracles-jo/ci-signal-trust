import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compute the hex HMAC-SHA256 of `body` keyed by `secret`. Exposed so the docs/
 * curl example and tests can produce a matching signature.
 */
export function hmacSha256Hex(secret: string, body: Buffer | string): string {
  return createHmac('sha256', secret)
    .update(typeof body === 'string' ? Buffer.from(body) : body)
    .digest('hex');
}

/**
 * Verify an `x-signature-256: sha256=<hexdigest>` header against the raw request
 * body using a timing-safe comparison. Returns false for any malformed input
 * rather than throwing, so callers map cleanly to a 401.
 */
export function verifySignature(secret: string, rawBody: Buffer, header: unknown): boolean {
  if (typeof header !== 'string') {
    return false;
  }
  const prefix = 'sha256=';
  if (!header.startsWith(prefix)) {
    return false;
  }
  const provided = header.slice(prefix.length).trim();
  if (provided.length === 0 || !/^[0-9a-fA-F]+$/.test(provided)) {
    return false;
  }
  const expected = hmacSha256Hex(secret, rawBody);
  const providedBuf = Buffer.from(provided.toLowerCase(), 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  // timingSafeEqual throws if lengths differ; guard first (still constant-time
  // within equal-length comparisons, which is what matters for the digest).
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Timing-safe string comparison for bearer tokens. Length mismatch returns false
 * without leaking timing about the secret's content beyond its length.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
