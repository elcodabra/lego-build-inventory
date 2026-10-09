// OAuth clients. Two ways a client (ChatGPT, Claude, an MCP CLI...) identifies itself:
//  - CIMD: client_id is an HTTPS URL of a JSON metadata document (fetched, validated, cached);
//  - DCR (RFC 7591): the client registers once at /register and gets an opaque client_id.
// Only public clients (token_endpoint_auth_method "none" + PKCE) are supported.
import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as ufetch } from 'undici';
import { DCR_REDIRECT_ALLOW, TTL, isChatGptCallback, isLoopback } from './config';
import { kv } from './kv';
import { randomId } from './crypto';

export type Client = {
  client_id: string;
  client_name: string;
  client_uri?: string;
  logo_uri?: string;
  redirect_uris: string[];
  kind: 'cimd' | 'dcr';
  created: number;
};

export class ClientError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const str = (v: unknown, max = 200) => (typeof v === 'string' && v.length <= max ? v : undefined);

// ---------------------------------------------------------------- redirect URI policy

function validRedirect(u: string, kind: 'cimd' | 'dcr', docHost?: string) {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  if (isLoopback(url)) return true; // native clients (RFC 8252); port may vary, path must match
  if (url.protocol !== 'https:') return false;
  // DCR: only exact, known callback URLs (anyone can register, so no open-ended prefixes)
  if (kind === 'dcr') return DCR_REDIRECT_ALLOW.includes(u) || isChatGptCallback(u);
  // CIMD: the redirect must be on the same site as the metadata document
  return !!docHost && (url.hostname === docHost || url.hostname.endsWith('.' + docHost));
}

// ---------------------------------------------------------------- CIMD fetch (SSRF-safe)

// Private / special address ranges (no BlockList: mixing IPv4 rules with ::ffff:0:0/96 makes it
// report ordinary public IPv4 addresses as blocked).
function v4ToInt(ip: string) { return ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0; }
const V4_PRIVATE: [string, number][] = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]];
function privateV4(ip: string) {
  const n = v4ToInt(ip);
  return V4_PRIVATE.some(([base, bits]) => ((n ^ v4ToInt(base)) >>> (32 - bits)) === 0);
}
function privateV6(ip: string) {
  const s = ip.toLowerCase();
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || s.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  if (s.startsWith('::ffff:') || s.startsWith('64:ff9b:')) return true; // hex-form mapped: refuse
  if (s === '::' || s === '::1') return true;
  const first = parseInt(s.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00; // ULA, link-local, multicast
}
export const isPrivateAddress = (ip: string, family: number) => (family === 6 ? privateV6(ip) : privateV4(ip));
const TEST_HOSTS = (process.env.AUTH_CIMD_TEST_HOSTS || '').split(',').filter(Boolean); // tests only: e.g. "localhost:18898"

function publicOnlyLookup(hostname: string, opts: any, cb: any) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address, a.family))) return cb(new Error('client metadata host resolves to a private address'));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}
const agent = new Agent({ connect: { lookup: publicOnlyLookup as any, timeout: 4000 }, headersTimeout: 4000, bodyTimeout: 4000 });
let testAgentInstance: Agent | null = null;
const testAgent = () => (testAgentInstance ||= new Agent({ connect: { ca: process.env.AUTH_CIMD_TEST_CA, timeout: 4000 } }));

async function fetchMetadata(clientId: string) {
  const url = new URL(clientId);
  const testHost = TEST_HOSTS.includes(url.host); // tests only: a local HTTPS host with a test CA
  if (url.protocol !== 'https:') throw new ClientError('invalid_client', 'client_id must be an https URL');
  if (url.pathname === '/' || url.hash || url.username || url.password || url.port && url.port !== '443' && !testHost) throw new ClientError('invalid_client', 'bad client_id URL');
  // IP literals never go through DNS lookup, so check them here (SSRF)
  const h = url.hostname.replace(/^\[|\]$/g, '');
  if (!testHost && (net.isIP(h) || /^\d+$/.test(h) || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal'))) {
    throw new ClientError('invalid_client', 'client_id host must be a public domain name');
  }
  const res = await ufetch(clientId, { redirect: 'error', headers: { accept: 'application/json' }, dispatcher: testHost ? testAgent() : agent, signal: AbortSignal.timeout(5000) })
    .catch((e) => { console.error(JSON.stringify({ ev: 'cimd_fetch_failed', url: clientId, err: e.message, cause: e.cause?.message, code: e.cause?.code })); throw new ClientError('invalid_client', 'cannot fetch client metadata: ' + (e.cause?.message || e.message)); });
  if (!res.ok) throw new ClientError('invalid_client', `client metadata HTTP ${res.status}`);
  // read at most 8 KB, whatever Content-Length says (chunked responses have none)
  const MAX = 8192;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as any) {
    size += chunk.length;
    if (size > MAX) { try { await (res.body as any).cancel(); } catch { /* ignore */ } throw new ClientError('invalid_client', 'client metadata too large'); }
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let doc: any;
  try { doc = JSON.parse(text); } catch { throw new ClientError('invalid_client', 'client metadata is not JSON'); }
  if (doc.client_id !== clientId) throw new ClientError('invalid_client', 'client_id in metadata does not match its URL');
  const name = str(doc.client_name, 100);
  if (!name) throw new ClientError('invalid_client', 'client_name is required');
  if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length || doc.redirect_uris.length > 10) throw new ClientError('invalid_client', 'redirect_uris is required');
  for (const r of doc.redirect_uris) if (typeof r !== 'string' || !validRedirect(r, 'cimd', url.hostname)) throw new ClientError('invalid_client', 'bad redirect_uri in client metadata: ' + String(r).slice(0, 100));
  const methods: string[] = Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : [doc.token_endpoint_auth_method || 'none'];
  if (!methods.includes('none')) throw new ClientError('invalid_client', 'only public clients (token_endpoint_auth_method "none") are supported');
  const c: Client = {
    client_id: clientId, client_name: name, client_uri: str(doc.client_uri, 300), logo_uri: str(doc.logo_uri, 500),
    redirect_uris: doc.redirect_uris, kind: 'cimd', created: Date.now(),
  };
  return c;
}

// ---------------------------------------------------------------- lookup / register

export async function getClient(clientId: string): Promise<Client> {
  if (typeof clientId !== 'string' || !clientId || clientId.length > 500) throw new ClientError('invalid_client', 'client_id is required');
  if (/^https?:\/\//.test(clientId)) {
    const cached = await kv.get(`cimd:${clientId}`);
    if (cached) return cached;
    const c = await fetchMetadata(clientId);
    await kv.set(`cimd:${clientId}`, c, TTL.cimd);
    return c;
  }
  const c = await kv.get(`client:${clientId}`);
  if (!c) throw new ClientError('invalid_client', 'unknown client_id');
  return c;
}

export async function registerClient(body: any): Promise<Client & Record<string, unknown>> {
  if (!body || typeof body !== 'object') throw new ClientError('invalid_client_metadata', 'JSON body required');
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10) throw new ClientError('invalid_redirect_uri', 'redirect_uris is required');
  for (const r of uris) if (typeof r !== 'string' || r.length > 500 || !validRedirect(r, 'dcr')) throw new ClientError('invalid_redirect_uri', 'redirect_uri not allowed: ' + String(r).slice(0, 100));
  // We only support public clients. A client asking for client_secret_* is registered as a public
  // client and told so in the response (RFC 7591 3.2.1 lets the server replace requested values).
  const grants = body.grant_types || ['authorization_code', 'refresh_token'];
  if (!Array.isArray(grants) || grants.some((g: string) => !['authorization_code', 'refresh_token'].includes(g))) throw new ClientError('invalid_client_metadata', 'unsupported grant_types');
  const c: Client = {
    client_id: 'c_' + randomId(18),
    client_name: str(body.client_name, 100) || 'MCP client',
    client_uri: str(body.client_uri, 300),
    logo_uri: str(body.logo_uri, 500),
    redirect_uris: uris,
    kind: 'dcr',
    created: Date.now(),
  };
  await kv.set(`client:${c.client_id}`, c);
  return {
    ...c,
    client_id_issued_at: Math.floor(c.created / 1000),
    grant_types: grants,
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}
