// Verifies an access token the way the MCP server does: signature (our JWKS), issuer, audience =
// one of our resources, type, expiry, and that the grant was not revoked.
import { createLocalJWKSet, jwtVerify } from 'jose';
import { ISSUER, RESOURCES } from './config';
import { isRevoked } from './grants';
import { keys } from './jwt';

export async function verifyAccessToken(token: string) {
  if (!token) return null;
  const { publicJwk } = await keys();
  try {
    const { payload } = await jwtVerify(token, createLocalJWKSet({ keys: [publicJwk] }), { issuer: ISSUER, audience: RESOURCES, algorithms: ['ES256'], typ: 'at+jwt' });
    if (await isRevoked(String(payload.gid))) return null;
    return payload;
  } catch {
    return null;
  }
}
export const bearer = (req: Request) => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
