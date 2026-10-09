// Access tokens are JWTs signed with an ES256 key. The private key comes from AUTH_SIGNING_KEY
// (a JWK); its public part is published at /jwks.json for the MCP server to verify tokens.
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import { ISSUER, TTL } from './config';
import { randomId } from './crypto';

type Keys = { privateKey: CryptoKey; publicJwk: JWK; kid: string };
let cached: Promise<Keys> | null = null;

async function load(): Promise<Keys> {
  const raw = process.env.AUTH_SIGNING_KEY;
  if (raw) {
    const jwk = JSON.parse(raw) as JWK;
    const kid = jwk.kid || 'k1';
    const privateKey = (await importJWK({ ...jwk, alg: 'ES256' }, 'ES256')) as CryptoKey;
    const { d, ...pub } = jwk;
    return { privateKey, publicJwk: { ...pub, kid, alg: 'ES256', use: 'sig' }, kid };
  }
  if (process.env.NODE_ENV === 'production' && process.env.VERCEL) throw new Error('AUTH_SIGNING_KEY is not set');
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const kid = 'dev-' + randomId(6);
  return { privateKey: privateKey as CryptoKey, publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' }, kid };
}
export const keys = () => (cached ||= load());

export async function issueAccessToken(p: { sub: string; clientId: string; resource: string; scope: string; grantId: string }) {
  const { privateKey, kid } = await keys();
  return new SignJWT({ scope: p.scope, client_id: p.clientId, gid: p.grantId })
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'at+jwt' })
    .setIssuer(ISSUER)
    .setSubject(p.sub)
    .setAudience(p.resource)
    .setIssuedAt()
    .setExpirationTime(`${TTL.access}s`)
    .setJti(randomId(16))
    .sign(privateKey);
}
