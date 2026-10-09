// Grants, authorization codes and refresh tokens.
//
// A grant = one user's consent for one client (and resource). Codes and refresh tokens belong to a
// grant; revoking the grant (from the account page) kills every refresh token of that connection,
// and the MCP server refuses access tokens of revoked grants on its next check.
// Refresh tokens are rotated on every use; re-using an already used refresh token revokes the
// whole grant (RFC 9700 refresh token replay detection).
import { TTL } from './config';
import { kv } from './kv';
import { randomId, sha256 } from './crypto';

export type Grant = { id: string; userId: string; clientId: string; clientName: string; resource: string; scope: string; created: number; lastUsed: number };
type Code = { grantId: string; userId: string; clientId: string; redirectUri: string; resource: string; scope: string; challenge: string };
type Refresh = { grantId: string; family: string; used?: boolean };

export async function findOrCreateGrant(userId: string, clientId: string, clientName: string, resource: string, scope: string): Promise<Grant> {
  const ids = await kv.smembers(`grants:${userId}`);
  for (const id of ids) {
    const g: Grant | null = await kv.get(`grant:${id}`);
    if (g && g.clientId === clientId && g.resource === resource) {
      g.scope = scope; g.lastUsed = Date.now(); g.clientName = clientName;
      await kv.set(`grant:${id}`, g);
      return g;
    }
  }
  const g: Grant = { id: 'g_' + randomId(12), userId, clientId, clientName, resource, scope, created: Date.now(), lastUsed: Date.now() };
  await kv.set(`grant:${g.id}`, g);
  await kv.sadd(`grants:${userId}`, g.id);
  return g;
}

export async function listGrants(userId: string): Promise<Grant[]> {
  const out: Grant[] = [];
  for (const id of await kv.smembers(`grants:${userId}`)) {
    const g = await kv.get(`grant:${id}`);
    if (g) out.push(g); else await kv.srem(`grants:${userId}`, id);
  }
  return out.sort((a, b) => b.lastUsed - a.lastUsed);
}

export async function revokeGrant(userId: string, grantId: string) {
  const g: Grant | null = await kv.get(`grant:${grantId}`);
  if (!g || g.userId !== userId) return false;
  await kv.del(`grant:${grantId}`);
  await kv.srem(`grants:${userId}`, grantId);
  await kv.set(`revoked:${grantId}`, 1, TTL.access + 60); // access tokens of this grant die at the MCP server
  return true;
}
export const isRevoked = async (grantId: string) => !!(await kv.get(`revoked:${grantId}`)) || !(await kv.get(`grant:${grantId}`));

// ---------------------------------------------------------------- codes

export async function issueCode(c: Code) {
  const code = randomId(32);
  await kv.set(`code:${sha256(code)}`, c, TTL.code);
  return code;
}
// Single use. A redeemed code leaves a marker pointing at its grant, so a second redemption attempt
// (leaked code) can revoke the connection it created.
export async function takeCode(code: string): Promise<Code | null> {
  const h = sha256(String(code));
  const c: Code | null = await kv.take(`code:${h}`);
  if (c) await kv.set(`code-used:${h}`, c.grantId, TTL.refresh);
  return c;
}
export async function revokeByUsedCode(code: string) {
  if (!code) return;
  const grantId = await kv.take(`code-used:${sha256(String(code))}`);
  if (!grantId) return;
  const g: Grant | null = await kv.get(`grant:${grantId}`);
  if (g) await revokeGrant(g.userId, g.id);
}

// ---------------------------------------------------------------- refresh tokens

export async function issueRefresh(grantId: string, family = randomId(12)) {
  const token = 'rt_' + randomId(32);
  await kv.set(`refresh:${sha256(token)}`, { grantId, family } as Refresh, TTL.refresh);
  return token;
}

// Returns the grant id for a valid refresh token and marks it used. The same token presented again
// within a short grace window (a client retrying after a lost response, or two parallel refreshes)
// gets the SAME new token pair instead of an error; later reuse is treated as theft and revokes
// the grant (RFC 9700 4.14.2).
const GRACE_SECONDS = Number(process.env.AUTH_REFRESH_GRACE_SECONDS ?? 30);
export async function useRefresh(token: string): Promise<{ grantId: string; family: string; replayResponse?: any } | null> {
  const h = sha256(String(token));
  const r: Refresh | null = await kv.get(`refresh:${h}`);
  if (!r) return null;
  const first = await kv.setnx(`refresh-used:${h}`, { at: Date.now() }, TTL.refresh);
  if (first) return { grantId: r.grantId, family: r.family };
  const used = await kv.get(`refresh-used:${h}`);
  if (used && Date.now() - used.at < GRACE_SECONDS * 1000) {
    for (let i = 0; i < 20; i++) { // wait for the winner to store its response
      const resp = await kv.get(`refresh-resp:${h}`);
      if (resp) return { grantId: r.grantId, family: r.family, replayResponse: resp };
      await new Promise((ok) => setTimeout(ok, 100));
    }
    return null;
  }
  const g: Grant | null = await kv.get(`grant:${r.grantId}`);
  if (g) await revokeGrant(g.userId, g.id);
  return null;
}
// Remember the response to a refresh for the grace window (encrypted at rest is not needed: the
// key is a hash of the old refresh token, which only the client has).
export const rememberRefreshResponse = (token: string, resp: unknown) => kv.set(`refresh-resp:${sha256(String(token))}`, resp, GRACE_SECONDS + 5);
