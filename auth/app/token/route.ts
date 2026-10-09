// POST /token: authorization_code (PKCE S256, exact redirect_uri, resource) and refresh_token
// (rotation with replay detection). Public clients: client_id in the body, no secret.
import { clientKind, track } from '@/lib/analytics';
import { getClient } from '@/lib/clients';
import { RESOURCES, TTL } from '@/lib/config';
import { equal, pkceS256, validVerifier } from '@/lib/crypto';
import { findOrCreateGrant, isRevoked, issueRefresh, rememberRefreshResponse, revokeByUsedCode, takeCode, useRefresh } from '@/lib/grants';
import { normalizeResource } from '@/lib/authorize';
import { issueAccessToken } from '@/lib/jwt';
import { kv } from '@/lib/kv';
import { corsPreflight, json, oauthError } from '@/lib/metadata';
import { rateLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

async function readForm(req: Request) {
  const type = req.headers.get('content-type') || '';
  if (type.includes('application/x-www-form-urlencoded')) return new URLSearchParams(await req.text());
  if (type.includes('application/json')) { const j = await req.json().catch(() => ({})); return new URLSearchParams(Object.entries(j).map(([k, v]) => [k, String(v)])); }
  return null;
}

async function tokenBody(grantId: string, sub: string, clientId: string, resource: string, scope: string, family?: string) {
  const access_token = await issueAccessToken({ sub, clientId, resource, scope, grantId });
  const refresh_token = await issueRefresh(grantId, family);
  return { access_token, token_type: 'Bearer', expires_in: TTL.access, refresh_token, scope };
}
const tokens = async (...a: Parameters<typeof tokenBody>) => json(await tokenBody(...a));

export async function POST(req: Request) {
  if (!(await rateLimit('token', 120, 60))) return oauthError('slow_down', 'too many requests', 429);
  const f = await readForm(req);
  if (!f) return oauthError('invalid_request', 'use application/x-www-form-urlencoded');
  if (req.headers.get('authorization')) return oauthError('invalid_client', 'public clients only: send client_id in the body, no client authentication', 401);
  const clientId = f.get('client_id') || '';
  try { await getClient(clientId); } catch { return oauthError('invalid_client', 'unknown client', 401); }
  const grantType = f.get('grant_type');

  if (grantType === 'authorization_code') {
    const codeValue = f.get('code') || '';
    const code = await takeCode(codeValue);
    if (!code) {
      // RFC 6749 4.1.2 / RFC 9700: a reused code means it leaked; revoke what it produced
      await revokeByUsedCode(codeValue);
      track('token_error', { error: 'invalid_grant', grant: 'authorization_code' });
      return oauthError('invalid_grant', 'code is invalid, expired or already used');
    }
    if (code.clientId !== clientId) return oauthError('invalid_grant', 'code was issued to another client');
    if (code.redirectUri !== f.get('redirect_uri')) return oauthError('invalid_grant', 'redirect_uri does not match');
    const verifier = f.get('code_verifier');
    if (!validVerifier(verifier) || !equal(pkceS256(verifier), code.challenge)) return oauthError('invalid_grant', 'PKCE verification failed');
    const resource = normalizeResource(f.get('resource')) || code.resource;
    if (resource !== code.resource) return oauthError('invalid_target', 'resource does not match the authorization request');
    if (await isRevoked(code.grantId)) return oauthError('invalid_grant', 'access was revoked');
    track('token_issued', { grant: 'authorization_code', client: clientKind(clientId) }, code.userId);
    return tokens(code.grantId, code.userId, clientId, code.resource, code.scope);
  }

  if (grantType === 'refresh_token') {
    const rtoken = f.get('refresh_token') || '';
    const r = await useRefresh(rtoken);
    if (!r) { track('token_error', { error: 'invalid_grant', grant: 'refresh_token' }); return oauthError('invalid_grant', 'refresh token is invalid, expired or already used'); }
    const g = await kv.get(`grant:${r.grantId}`);
    if (!g || (await isRevoked(r.grantId))) return oauthError('invalid_grant', 'access was revoked');
    if (g.clientId !== clientId) return oauthError('invalid_grant', 'refresh token was issued to another client');
    const resource = normalizeResource(f.get('resource')) || g.resource;
    if (resource !== g.resource || !RESOURCES.includes(resource)) return oauthError('invalid_target', 'resource does not match the grant');
    if (r.replayResponse) return json(r.replayResponse); // retry within the grace window: same tokens
    await findOrCreateGrant(g.userId, g.clientId, g.clientName, g.resource, g.scope); // touch lastUsed
    const body = await tokenBody(g.id, g.userId, clientId, g.resource, g.scope, r.family);
    track('token_refreshed', { client: clientKind(clientId) }, g.userId);
    await rememberRefreshResponse(rtoken, body);
    return json(body);
  }

  return oauthError('unsupported_grant_type', 'use authorization_code or refresh_token');
}
export const OPTIONS = corsPreflight;
