// Vercel entry: MCP over Streamable HTTP (stateless) at /mcp.
//
// Serverless has no persistent disk, so each request works in its own /tmp directory and syncs the
// user's state (inventory.json, models/*.json) with a PRIVATE Vercel Blob store (STATE_BLOB_TOKEN):
// pulled before the tool call, pushed BEFORE the response is sent (so a reported success is saved),
// with ETag checks so two instances cannot silently overwrite each other. Rendered PNG/mp4 go to a
// PUBLIC store (MEDIA_BLOB_TOKEN) under unguessable names, so ChatGPT can show/link them.
//
// Per-request context (data dir, safe mode, renderer) goes through AsyncLocalStorage (core.ctx),
// never through process.env, so requests of different users run concurrently; requests of the same
// user are serialised by a per-user lock on this instance.
//
// Auth: key in the Authorization: Bearer header or ?key= (ChatGPT connectors only allow a URL).
// LEGO_MCP_TOKEN = the single owner key. LEGO_OPEN=1 = any random key of 24+ chars is its own user
// (data filed under sha256(key), the key itself is never stored).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

const require = createRequire(import.meta.url);
const core = require('../lib/core.cjs');

const ROOT_TMP = '/tmp/lego';
const STATE = process.env.STATE_BLOB_TOKEN;
const MEDIA = process.env.MEDIA_BLOB_TOKEN;
// Public store host, allowed in the player's CSP. From MEDIA_ORIGIN, or the store id in the token
// (vercel_blob_rw_<storeId>_<secret> -> https://<storeid lowercase>.public.blob.vercel-storage.com).
const MEDIA_ORIGIN = process.env.MEDIA_ORIGIN || (MEDIA && /^vercel_blob_rw_([A-Za-z0-9]+)_/.test(MEDIA) ? `https://${MEDIA.match(/^vercel_blob_rw_([A-Za-z0-9]+)_/)[1].toLowerCase()}.public.blob.vercel-storage.com` : null);
const MAX_BODY = 20 * 1024 * 1024;
let blob = null;
const B = async () => (blob ||= await import('@vercel/blob'));

const sha = (s) => crypto.createHash('sha256').update(s).digest();
function userOf(req) {
  const url = new URL(req.url, 'http://x');
  const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('key') || '';
  const token = process.env.LEGO_MCP_TOKEN;
  if (token) return crypto.timingSafeEqual(sha(key), sha(token)) ? 'owner' : null;
  if (process.env.LEGO_OPEN === '1' && key.length >= 24 && new Set(key).size >= 10) return 'u' + sha(key).toString('hex').slice(0, 24);
  return null;
}

// Blob layout: state/<user>/inventory.json, state/<user>/models/<name>.json, media/<random>.<ext>
// Without STATE_BLOB_TOKEN (local runs, tests) a directory stands in for the store.
const LOCAL_STORE = path.join(ROOT_TMP, '_store');
const STATE_FILE = /^(inventory\.json|models\/[a-z0-9_-]{1,64}\.json)$/;
function localFiles(user) {
  const base = path.join(LOCAL_STORE, user);
  const out = [];
  if (fs.existsSync(path.join(base, 'inventory.json'))) out.push('inventory.json');
  if (fs.existsSync(path.join(base, 'models'))) for (const f of fs.readdirSync(path.join(base, 'models'))) out.push('models/' + f);
  return out.filter((rel) => STATE_FILE.test(rel));
}
async function pull(user, dir) {
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'exports'), { recursive: true });
  const seen = new Map();
  if (!STATE) {
    for (const rel of localFiles(user)) {
      const buf = fs.readFileSync(path.join(LOCAL_STORE, user, rel));
      fs.writeFileSync(path.join(dir, rel), buf);
      seen.set(rel, { hash: hash(buf) });
    }
    return seen;
  }
  const { list, get } = await B();
  let cursor;
  do {
    const r = await list({ prefix: `state/${user}/`, cursor, limit: 1000, token: STATE });
    await Promise.all(r.blobs.map(async (b) => {
      const rel = b.pathname.slice(`state/${user}/`.length);
      if (!STATE_FILE.test(rel)) return;
      const g = await get(b.pathname, { access: 'private', useCache: false, token: STATE });
      // a failed read must not look like "no inventory": that would overwrite it on push
      if (!g || g.statusCode !== 200) throw new Error(`state read failed for ${rel}`);
      const buf = Buffer.from(await new Response(g.stream).arrayBuffer());
      fs.writeFileSync(path.join(dir, rel), buf);
      // get() may report a weak W/"..." ETag (compressed transfer) that ifMatch rejects; list() has
      // the store's strong ETag. If the blob changed between list and get, the write fails safely.
      seen.set(rel, { hash: hash(buf), etag: b.etag || String(g.blob.etag).replace(/^W\//, '') });
    }));
    cursor = r.cursor;
  } while (cursor);
  return seen;
}

const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// Writes changed files; a changed file must still have the ETag we read (or not exist yet), so a
// concurrent write from another instance makes this request fail instead of being lost.
async function push(user, dir, before) {
  const files = [];
  if (fs.existsSync(path.join(dir, 'inventory.json'))) files.push('inventory.json');
  for (const f of fs.readdirSync(path.join(dir, 'models'))) if (/^[a-z0-9_-]{1,64}\.json$/.test(f)) files.push('models/' + f);
  const changed = files.filter((rel) => !before.has(rel) || before.get(rel).hash !== hash(fs.readFileSync(path.join(dir, rel))));
  if (!STATE) {
    for (const rel of changed) {
      fs.mkdirSync(path.dirname(path.join(LOCAL_STORE, user, rel)), { recursive: true });
      fs.copyFileSync(path.join(dir, rel), path.join(LOCAL_STORE, user, rel));
    }
    return changed;
  }
  const { put } = await B();
  const results = await Promise.allSettled(changed.map((rel) => put(`state/${user}/${rel}`, fs.readFileSync(path.join(dir, rel)), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', token: STATE,
    ...(before.has(rel) ? { ifMatch: before.get(rel).etag } : {}),
  })));
  const failed = results.map((r, i) => (r.status === 'rejected' ? `${changed[i]}: ${r.reason && r.reason.message}` : null)).filter(Boolean);
  if (failed.length) {
    const e = new Error('saving failed (changed concurrently? try again): ' + failed.join('; '));
    e.conflict = failed.some((f) => /Precondition failed|ETag/i.test(f));
    throw e;
  }
  return changed;
}

async function publish(file) {
  if (!MEDIA) return null;
  const { put } = await B();
  const ext = path.extname(file);
  const r = await put(`media/${crypto.randomBytes(12).toString('hex')}-${path.basename(file, ext)}${ext}`, fs.readFileSync(file), {
    access: 'public', addRandomSuffix: false, contentType: ext === '.mp4' ? 'video/mp4' : 'image/png', token: MEDIA,
  });
  return r.url;
}

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || 'null') : req.body;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('request too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
}

// The web-standard transport returns a Response (JSON mode) that we read fully, then save state,
// and only then reply: a success the client sees is a success that was saved.
function webRequest(req, body) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  headers.set('accept', 'application/json, text/event-stream');
  return new Request('https://local' + (req.url || '/mcp'), { method: 'POST', headers, body: JSON.stringify(body) });
}

const locks = new Map(); // user -> tail promise; serialises one user's requests on this instance
function withUserLock(user, fn) {
  const prev = locks.get(user) || Promise.resolve();
  const p = prev.catch(() => {}).then(fn);
  const tail = p.catch(() => {});
  locks.set(user, tail);
  tail.then(() => { if (locks.get(user) === tail) locks.delete(user); });
  return p;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    // MCP clients open an SSE stream with GET; this stateless server has none, and the spec
    // says to answer 405 then (a 200 makes clients reconnect in a loop). Browsers get a hint.
    if (/text\/event-stream/.test(req.headers.accept || '')) return res.status(405).setHeader('Allow', 'POST').end();
    return res.status(200).json({ name: 'lego-inventory-build', mcp: 'POST /mcp?key=<your key>' });
  }
  if (req.method !== 'POST') return res.status(405).end();
  const user = userOf(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 60);
  if (!user) {
    console.log(JSON.stringify({ ev: 'unauthorized', ua, hasKey: /[?&]key=/.test(req.url || ''), auth: !!req.headers.authorization }));
    return res.status(401).json({ error: 'unauthorized: add ?key=<key> to the connector URL' });
  }

  let body;
  try { body = await readBody(req); } catch (e) {
    console.log(JSON.stringify({ ev: 'bad_request', ua, err: e.message }));
    return res.status(400).json({ error: e.message === 'request too large' ? e.message : 'bad json' });
  }
  const t0 = Date.now();
  const msgs = Array.isArray(body) ? body : [body];
  const what = msgs.map((m) => (m && m.method === 'tools/call' ? `tools/call:${m.params && m.params.name}` : m && m.method)).join(',');
  const args = msgs.filter((m) => m && m.method === 'tools/call').map((m) => Object.keys((m.params && m.params.arguments) || {}).join('|'));
  const log = (extra) => console.log(JSON.stringify({ ev: 'mcp', user: user.slice(0, 8), what, args: args.length ? args : undefined, ms: Date.now() - t0, ua, ...extra }));

  try {
    // One attempt = pull, run the tool, push with ETag checks. Another instance writing the same
    // user's state in between makes push fail with a conflict: redo the whole call on fresh state.
    const attempt = async () => {
      const dir = path.join(ROOT_TMP, user + '-' + crypto.randomBytes(6).toString('hex'));
      let srv = null;
      let transport = null;
      try {
        const before = await pull(user, dir);
        return await core.ctx.run({ dataDir: dir, safe: true, renderer: 'node' }, async () => {
          const { buildServer } = await import('../mcp/tools.mjs');
          srv = buildServer({ publish, mediaOrigin: MEDIA_ORIGIN });
          transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          await srv.connect(transport);
          const r = await transport.handleRequest(webRequest(req, body), { parsedBody: body });
          const payload = Buffer.from(await r.arrayBuffer());
          const headers = {};
          r.headers.forEach((v, k) => { headers[k] = v; });
          const saved = await push(user, dir, before);
          return { status: r.status, headers, body: payload, saved };
        });
      } finally {
        if (transport) await transport.close().catch(() => {});
        if (srv) await srv.close().catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    const out = await withUserLock(user, async () => {
      for (let i = 0; ; i++) {
        try {
          return await attempt();
        } catch (e) {
          if (!e.conflict || i >= 4) throw e;
          await new Promise((r) => setTimeout(r, 150 + Math.random() * 400 * (i + 1)));
        }
      }
    });
    for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    res.status(out.status).end(out.body);
    const txt = out.body.toString('utf8', 0, 400);
    log({ status: out.status, saved: out.saved.length ? out.saved : undefined, err: /"isError":true|"error":\{/.test(txt) ? txt.replace(/\s+/g, ' ').slice(0, 300) : undefined });
  } catch (e) {
    console.error(e);
    log({ status: 500, err: e.message });
    // JSON-RPC error for the request id, so the client shows a real message
    const id = msgs.length === 1 && msgs[0] && msgs[0].id !== undefined ? msgs[0].id : null;
    if (!res.headersSent) res.status(200).json({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}
