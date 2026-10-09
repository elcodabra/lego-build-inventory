// Small crypto helpers: random ids, hashing, PKCE, signed (HMAC) cookie values.
import crypto from 'node:crypto';

export const randomId = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('base64url');

export function equal(a: string, b: string) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// RFC 7636 S256
export const pkceS256 = (verifier: string) => sha256(verifier);
export const validVerifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
export const validChallenge = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);

let secret: Buffer | null = null;
function key() {
  if (secret) return secret;
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= 32) secret = Buffer.from(s);
  else if (process.env.NODE_ENV === 'production' && process.env.VERCEL) throw new Error('AUTH_SECRET is not set');
  else secret = crypto.randomBytes(32); // dev / tests: per process
  return secret;
}
export const hmac = (data: string) => crypto.createHmac('sha256', key()).update(data).digest('base64url');
export const sign = (value: string) => `${value}.${hmac(value)}`;
export function unsign(signed: string | undefined | null): string | null {
  if (!signed) return null;
  const i = signed.lastIndexOf('.');
  if (i < 1) return null;
  const v = signed.slice(0, i);
  return equal(hmac(v), signed.slice(i + 1)) ? v : null;
}
