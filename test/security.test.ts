import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, timingSafeStringEqual, verifySignature } from '../src/security.js';

const SECRET = 'unit-test-secret';

describe('verifySignature', () => {
  it('accepts a correct sha256= signature over the raw body', () => {
    const body = Buffer.from('{"hello":"world"}');
    const sig = `sha256=${hmacSha256Hex(SECRET, body)}`;
    expect(verifySignature(SECRET, body, sig)).toBe(true);
  });

  it('rejects when the body has been tampered with', () => {
    const body = Buffer.from('{"hello":"world"}');
    const sig = `sha256=${hmacSha256Hex(SECRET, body)}`;
    expect(verifySignature(SECRET, Buffer.from('{"hello":"mars"}'), sig)).toBe(false);
  });

  it('rejects a non-string header (missing signature)', () => {
    expect(verifySignature(SECRET, Buffer.from('x'), undefined)).toBe(false);
    expect(verifySignature(SECRET, Buffer.from('x'), 123)).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    const body = Buffer.from('x');
    expect(verifySignature(SECRET, body, hmacSha256Hex(SECRET, body))).toBe(false);
  });

  it('rejects an empty or non-hex digest', () => {
    expect(verifySignature(SECRET, Buffer.from('x'), 'sha256=')).toBe(false);
    expect(verifySignature(SECRET, Buffer.from('x'), 'sha256=zzzz')).toBe(false);
  });

  it('rejects a hex digest of the wrong length', () => {
    expect(verifySignature(SECRET, Buffer.from('x'), 'sha256=abcd')).toBe(false);
  });

  it('accepts an upper-case hex digest (case-insensitive)', () => {
    const body = Buffer.from('payload');
    const sig = `sha256=${hmacSha256Hex(SECRET, body).toUpperCase()}`;
    expect(verifySignature(SECRET, body, sig)).toBe(true);
  });
});

describe('timingSafeStringEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeStringEqual('Bearer abc', 'Bearer abc')).toBe(true);
  });

  it('returns false for different strings of equal length', () => {
    expect(timingSafeStringEqual('Bearer abc', 'Bearer xyz')).toBe(false);
  });

  it('returns false for strings of different length', () => {
    expect(timingSafeStringEqual('short', 'a-much-longer-token')).toBe(false);
  });
});
