// OAuth 2.1 resource-server side of the MCP endpoint (MCP authorization spec):
//  - /.well-known/oauth-protected-resource[/mcp] (RFC 9728) names our authorization server;
//  - 401 + WWW-Authenticate: Bearer resource_metadata=... sends clients to it;
//  - access tokens are ES256 JWTs from that server: signature (its JWKS), iss, aud = this resource,
//    typ at+jwt, exp; plus an optional revocation check (introspection) cached for a minute.
// Configured by AUTH_ISSUER (enables OAuth) and MCP_RESOURCE (default https://<host>/mcp).
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const ISSUER = (process.env.AUTH_ISSUER || '').replace(/\/+$/, '');
export const enabled = !!ISSUER;
const JWKS_URL = process.env.AUTH_JWKS_URL || (ISSUER ? `${ISSUER}/jwks.json` : '');
const INTROSPECT_SECRET = process.env.AUTH_INTROSPECT_SECRET || '';
let jwks = null;

// Canonical resource of this server. In production MCP_RESOURCE must be set: deriving it from the
// Host header would let any alias of the deployment accept tokens minted for another name.
export function resourceFor(req) {
  if (process.env.MCP_RESOURCE) return process.env.MCP_RESOURCE;
  if (process.env.VERCEL_ENV === 'production') throw new Error('MCP_RESOURCE is not set');
  const host = req.headers.host;
  const proto = /^(localhost|127\.)/.test(host) ? 'http' : 'https';
  return `${proto}://${host}/mcp`;
}
const origin = (resource) => new URL(resource).origin;
export const metadataUrl = (resource) => `${origin(resource)}/.well-known/oauth-protected-resource/mcp`;

export function protectedResourceMetadata(resource) {
  return {
    resource,
    authorization_servers: [ISSUER],
    scopes_supported: ['lego'],
    bearer_methods_supported: ['header'],
    resource_name: 'LEGO из моих деталей',
    resource_documentation: 'https://github.com/elcodabra/lego-build-inventory',
  };
}

export function challenge(resource, error) {
  return `Bearer resource_metadata="${metadataUrl(resource)}", scope="lego"${error ? `, error="${error}"` : ''}`;
}

const revokedCache = new Map(); // gid -> { active, until }
const ACTIVE_TTL = Number(process.env.AUTH_ACTIVE_CACHE_MS ?? 15_000); // a revoked connection stops working within this time
async function stillActive(token, gid) {
  if (!INTROSPECT_SECRET) return true;
  const c = revokedCache.get(gid);
  if (c && c.until > Date.now()) return c.active;
  let active = true;
  try {
    const r = await fetch(`${ISSUER}/introspect`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-introspect-secret': INTROSPECT_SECRET }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error('introspect HTTP ' + r.status);
    active = !!(await r.json()).active;
  } catch (e) {
    // The JWT itself is valid (signature, aud, exp). If the revocation check is unreachable, keep
    // working only with a previously confirmed status for this connection; never trust a new one.
    console.log(JSON.stringify({ ev: 'introspect_error', err: e.message }));
    if (c) return c.active;
    return false;
  }
  // "revoked" is final, keep it longer; "active" only briefly so revocation takes effect fast
  revokedCache.set(gid, { active, until: Date.now() + (active ? ACTIVE_TTL : 3_600_000) });
  if (revokedCache.size > 5000) revokedCache.clear();
  return active;
}

// Returns { sub, clientId, scope } for a valid token, or null.
export async function verify(token, resource) {
  if (!enabled || !token || token.split('.').length !== 3) return null;
  jwks ||= createRemoteJWKSet(new URL(JWKS_URL), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: resource, algorithms: ['ES256'], typ: 'at+jwt' });
    if (!String(payload.scope || '').split(' ').includes('lego')) return null;
    if (!(await stillActive(token, String(payload.gid)))) return null;
    return { sub: String(payload.sub), clientId: String(payload.client_id || ''), scope: String(payload.scope) };
  } catch {
    return null;
  }
}
