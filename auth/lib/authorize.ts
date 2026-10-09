// Pending authorization requests. /authorize validates the client request, stores it under a random
// id and sends the browser to the login/consent page with only that id. The consent POST then
// issues the code for exactly what was validated, never for parameters coming from the form.
import { ISSUER, RESOURCES, SCOPES, TTL, isLoopback } from './config';
import { kv } from './kv';
import { randomId, validChallenge } from './crypto';
import { getClient, ClientError, type Client } from './clients';

export type AuthRequest = {
  id: string;
  clientId: string;
  clientName: string;
  clientHost: string;
  verified: boolean; // the client really is the app it names (known host), else the consent warns
  redirectUri: string;
  state?: string;
  challenge: string;
  resource: string;
  scope: string;
  created: number;
};

export class RedirectableError extends Error {
  constructor(public code: string, message: string, public redirectUri: string, public state?: string) { super(message); }
}

// Clients whose name we can trust on the consent screen: their identity is bound to a domain we know
// (CIMD document hosted there, or DCR with a redirect to it). Anyone else may call itself "ChatGPT".
const KNOWN: Record<string, string> = { 'chatgpt.com': 'ChatGPT', 'claude.ai': 'Claude', 'claude.com': 'Claude' };
function isVerifiedClient(c: Client, redirectUri: string) {
  try {
    const host = new URL(c.kind === 'cimd' ? c.client_id : redirectUri).hostname;
    const r = new URL(redirectUri);
    return !!KNOWN[host] && r.protocol === 'https:' && r.hostname === host;
  } catch { return false; }
}

// Resource identifiers are compared exactly; accept the server origin with or without "/mcp" and a
// trailing slash, mapping them to our canonical value.
export function normalizeResource(r: string | null) {
  if (!r) return null;
  const t = r.replace(/\/+$/, '');
  return RESOURCES.find((x) => x === t || x === `${t}/mcp`) || r;
}

// Exact match, except loopback redirects of native apps (RFC 8252 7.3): any port is allowed, the
// scheme, host and path must match a registered loopback URI exactly.
function redirectAllowed(registered: string[], uri: string) {
  if (registered.includes(uri)) return true;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (!isLoopback(u) || u.username || u.password || u.hash) return false;
  return registered.some((r) => {
    try {
      const x = new URL(r);
      return isLoopback(x) && x.protocol === u.protocol && x.hostname === u.hostname && x.pathname === u.pathname && x.search === u.search;
    } catch { return false; }
  });
}

// RFC 6749 4.1.2.1: errors about client_id / redirect_uri are shown to the user (never redirected);
// everything else goes back to the client with ?error=...&iss=...
export async function parseAuthorize(params: URLSearchParams): Promise<AuthRequest> {
  const clientId = params.get('client_id') || '';
  let client: Client;
  try { client = await getClient(clientId); } catch (e: any) { throw new ClientError(e.code || 'invalid_client', e.message); }
  const redirectUri = params.get('redirect_uri') || '';
  // redirect_uri is always required (and must then match at /token): no single-URI default
  if (!redirectUri || !redirectAllowed(client.redirect_uris, redirectUri)) throw new ClientError('invalid_request', 'redirect_uri is missing or not registered for this client');
  const state = params.get('state') || undefined;
  const fail = (code: string, msg: string) => new RedirectableError(code, msg, redirectUri, state);
  if (params.get('response_type') !== 'code') throw fail('unsupported_response_type', 'response_type must be code');
  const challenge = params.get('code_challenge');
  if (params.get('code_challenge_method') !== 'S256' || !validChallenge(challenge)) throw fail('invalid_request', 'PKCE with S256 is required');
  const resource = normalizeResource(params.get('resource')) || RESOURCES[0];
  if (!RESOURCES.includes(resource)) throw fail('invalid_target', 'unknown resource');
  const asked = (params.get('scope') || '').split(/\s+/).filter(Boolean);
  // unknown scopes (e.g. openid/email from generic clients) are ignored, the grant is for "lego"
  const scope = SCOPES.join(' ');
  void asked;
  let host = '';
  try { host = new URL(client.kind === 'cimd' ? client.client_id : redirectUri).host; } catch { /* empty */ }
  const req: AuthRequest = {
    id: randomId(18), clientId: client.client_id, clientName: client.client_name, clientHost: host, verified: isVerifiedClient(client, redirectUri),
    redirectUri, state, challenge: challenge!, resource, scope, created: Date.now(),
  };
  await kv.set(`authreq:${req.id}`, req, TTL.request);
  return req;
}

export const getAuthRequest = (id: string): Promise<AuthRequest | null> => (id && /^[A-Za-z0-9_-]{10,60}$/.test(id) ? kv.get(`authreq:${id}`) : Promise.resolve(null));
export const dropAuthRequest = (id: string) => kv.del(`authreq:${id}`);

export function redirectWith(redirectUri: string, params: Record<string, string | undefined>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  u.searchParams.set('iss', ISSUER); // RFC 9207: on every authorization response, success or error
  return u.toString();
}
