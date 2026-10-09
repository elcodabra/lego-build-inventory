// Vercel entry: MCP over Streamable HTTP (stateless) at /mcp.
//
// Serverless has no persistent disk, so each request works in its own /tmp directory and syncs the
// user's state (inventory.json, models/*.json) with the state store (api/_store.mjs: Upstash Redis,
// else a private Vercel Blob store): loaded before the tool call, saved BEFORE the response is sent
// (so a reported success is saved), with a version check so two instances cannot silently
// overwrite each other. Handshakes, listings and reference tools skip the store. Rendered PNG/mp4
// go to a PUBLIC Blob store (MEDIA_BLOB_TOKEN) under unguessable names, so ChatGPT can show/link
// them; identical files are uploaded once.
//
// Per-request context (data dir, safe mode, renderer) goes through AsyncLocalStorage (core.ctx),
// never through process.env, so requests of different users run concurrently; requests of the same
// user are serialised by a per-user lock on this instance.
//
// Auth: key in the Authorization: Bearer header or ?key= (ChatGPT connectors only allow a URL).
// LEGO_MCP_TOKEN = the owner key (user "owner", no quota). LEGO_OPEN=1 additionally lets anyone in
// with their own random key of 24+ chars (GET / hands one out): each key is its own user, data filed
// under sha256(key), the key itself is never stored. Open users have a daily quota per key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { waitUntil } from '@vercel/functions';
import * as analytics from './_analytics.mjs';
import * as store from './_store.mjs';
import * as oauth from './_oauth.mjs';
import * as youtube from './_youtube.mjs';

const require = createRequire(import.meta.url);
const core = require('../lib/core.cjs');

const ROOT_TMP = '/tmp/lego';
const MEDIA = process.env.MEDIA_BLOB_TOKEN;
// Public store host, allowed in the player's CSP. From MEDIA_ORIGIN, or the store id in the token
// (vercel_blob_rw_<storeId>_<secret> -> https://<storeid lowercase>.public.blob.vercel-storage.com).
const MEDIA_ORIGIN = process.env.MEDIA_ORIGIN || (MEDIA && /^vercel_blob_rw_([A-Za-z0-9]+)_/.test(MEDIA) ? `https://${MEDIA.match(/^vercel_blob_rw_([A-Za-z0-9]+)_/)[1].toLowerCase()}.public.blob.vercel-storage.com` : null);
const MAX_BODY = 20 * 1024 * 1024;
let blob = null;
const B = async () => (blob ||= await import('@vercel/blob'));

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const keyOf = (req) => {
  const url = new URL(req.url, 'http://x');
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('key') || '';
};
// Who is calling: an OAuth access token (account "a<sub>"), the owner key, or (LEGO_OPEN, legacy)
// a personal key from the old key page. Returns null when nothing valid was presented.
// OAuth tokens are accepted only in the Authorization header (never in ?key=, which leaks into logs).
export async function userOf(req) {
  const key = keyOf(req);
  const token = process.env.LEGO_MCP_TOKEN;
  if (token && crypto.timingSafeEqual(sha(key), sha(token))) return 'owner';
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (oauth.enabled && bearer.split('.').length === 3) {
    const v = await oauth.verify(bearer, oauth.resourceFor(req));
    return v ? 'a' + sha(v.sub).toString('hex').slice(0, 24) : null;
  }
  if (oauth.enabled && key.split('.').length === 3) return null;
  if (process.env.LEGO_OPEN === '1' && /^[A-Za-z0-9_-]{24,128}$/.test(key) && new Set(key).size >= 10) return 'u' + sha(key).toString('hex').slice(0, 24);
  return null;
}

// ---------------------------------------------------------------- daily quota (open users only)
// Counted per key per UTC day, atomically (Redis; a local file without it). Heavy tools have their
// own smaller caps.
const QUOTA = {
  calls: Number(process.env.LEGO_QUOTA_CALLS || 300),
  video: Number(process.env.LEGO_QUOTA_VIDEO || 10),
  photo: Number(process.env.LEGO_QUOTA_PHOTO || 40),
};
const isVideo = (m) => m.params && ((m.params.name === 'show_build' && m.params.arguments && m.params.arguments.mode === 'video') || m.params.name === 'model_render');
const isPhoto = (m) => m.params && /^parts_from_(pile_)?photo$/.test(m.params.name);
const usageOf = (msgs) => {
  const calls = msgs.filter((m) => m && m.method === 'tools/call');
  return { calls: calls.length, video: calls.filter(isVideo).length, photo: calls.filter(isPhoto).length };
};

// Requests that never read or write the user's parts/models: protocol handshakes and listings, and
// the reference tools. They skip the state store entirely (no reads, no writes).
const STATELESS_TOOLS = new Set(['lego_guide', 'lego_catalog', 'lego_photo_guide']);
const BUILTIN_MODELS = new Set(['cat', 'microduck']);
function callNeedsState(m) {
  const name = m.params && m.params.name;
  if (STATELESS_TOOLS.has(name)) return false;
  if (name === 'model_get') return !BUILTIN_MODELS.has(String(m.params.arguments && m.params.arguments.name));
  return true;
}
const needsState = (msgs) => msgs.some((m) => m && m.method === 'tools/call' && callNeedsState(m));

const MEDIA_DAYS = Number(process.env.LEGO_MEDIA_DAYS || 30);

// Public media upload. The same bytes are uploaded once (sha1 -> URL remembered in Redis for a
// bit less than the media lifetime), so re-showing a picture costs no Blob operation.
export const mediaStats = { uploads: 0, reused: 0 };
async function publish(file) {
  if (!MEDIA) return null;
  const buf = fs.readFileSync(file);
  const sha = crypto.createHash('sha1').update(buf).digest('hex');
  const known = await store.mediaUrlFor(sha).catch(() => null);
  if (known) { mediaStats.reused++; return known; }
  const { put } = await B();
  const ext = path.extname(file);
  mediaStats.uploads++;
  const r = await put(`media/${crypto.randomBytes(12).toString('hex')}-${path.basename(file, ext)}${ext}`, buf, {
    access: 'public', addRandomSuffix: false, contentType: ext === '.mp4' ? 'video/mp4' : 'image/png', token: MEDIA,
  });
  await store.rememberMedia(sha, r.url, MEDIA_DAYS).catch(() => {});
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

// GET / in a browser: what this is and how to connect. With OAuth: just the URL (sign-in happens in
// ChatGPT/Claude). Legacy open mode without OAuth: a fresh personal key.
function keyPage(req) {
  const open = process.env.LEGO_OPEN === '1' && !oauth.enabled;
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'lego-mcp.vercel.app';
  const key = crypto.randomBytes(24).toString('base64url');
  const url = `https://${host}/mcp?key=${key}`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LEGO из моих деталей · MCP</title><meta name="robots" content="noindex">
<style>body{font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#1f2328}
code,input{font:14px ui-monospace,Menlo,monospace}input{width:100%;padding:10px;border:1px solid #d0d7de;border-radius:8px;box-sizing:border-box}
button{margin-top:8px;padding:8px 16px;border:0;border-radius:999px;background:#ffd500;font-weight:600;cursor:pointer}
ol li{margin:6px 0}.muted{color:#656d76;font-size:14px}</style></head><body>
<h1>🧱 LEGO из моих деталей</h1>
<p>MCP-сервер: сфотографируй свои детали, получи идеи, что собрать, и пошаговую инструкцию картинками или видео.</p>
${oauth.enabled ? `<h2>Как подключить</h2>
<p>Адрес приложения: <code>${esc(oauth.resourceFor(req))}</code></p>
<ol><li><b>ChatGPT</b>: Settings → Apps → Create app, вставь адрес, Authentication: OAuth.</li>
<li><b>Claude</b>: Settings → Connectors → Add custom connector, тот же адрес.</li>
<li>Откроется окно входа: войди ключом доступа (Face ID, Touch ID или PIN) и нажми «Разрешить».</li></ol>
<p class="muted">Аккаунт и подключённые приложения: <a href="${esc(oauth.ISSUER)}/account">${esc(new URL(oauth.ISSUER).host)}</a>. Лимит в сутки: ${QUOTA.calls} вызовов, ${QUOTA.video} видео, ${QUOTA.photo} фото. Мы считаем анонимную статистику использования (какие инструменты вызываются), без фото, списков деталей и личных данных. Картинки и видео хранятся ${Number(process.env.LEGO_MEDIA_DAYS || 30)} дней.</p>`
    : open ? `<h2>Твоя ссылка для подключения</h2>
<input id="u" readonly value="${esc(url)}" onclick="this.select()"><button onclick="navigator.clipboard.writeText(document.getElementById('u').value);this.textContent='Скопировано'">Скопировать</button>
<p class="muted">Ссылка личная: в ней ключ к твоим деталям и моделям. Сохрани её, мы её не храним и восстановить не сможем. Обновишь страницу — получишь новую, с пустым набором.</p>
<h2>Как подключить</h2>
<ol><li><b>ChatGPT</b>: Settings → Apps → Advanced → Developer mode → Create app, URL = ссылка выше, Authentication: No Auth.</li>
<li><b>Claude</b>: Settings → Connectors → Add custom connector, URL = ссылка выше.</li></ol>
<p class="muted">Лимит на ключ в сутки: ${QUOTA.calls} вызовов, ${QUOTA.video} видео, ${QUOTA.photo} фото. Мы считаем анонимную статистику использования (какие инструменты вызываются), без фото, списков деталей и ключей. Картинки и видео хранятся ${Number(process.env.LEGO_MEDIA_DAYS || 30)} дней.</p>`
    : '<p>Сервер работает по личному ключу владельца.</p>'}
<p class="muted"><a href="https://github.com/elcodabra/lego-build-inventory">GitHub</a> · LEGO® is a trademark of the LEGO Group, this project is not affiliated with it.</p>
</body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const u0 = new URL(req.url || '/', 'http://x');
  // Vercel keeps the original path in req.url; ?wk= is the rewrite's fallback copy of it
  const reqPath = u0.pathname.startsWith('/.well-known/') ? u0.pathname : u0.searchParams.get('wk') ? `/.well-known/${u0.searchParams.get('wk')}` : u0.pathname;
  // RFC 9728 protected resource metadata (path-specific and root forms)
  if (reqPath.startsWith('/.well-known/oauth-protected-resource')) {
    if (!oauth.enabled) return res.status(404).json({ error: 'oauth not enabled' });
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json(oauth.protectedResourceMetadata(oauth.resourceFor(req)));
  }
  // Some clients look for the authorization server metadata on the MCP origin: point them over.
  if (reqPath.startsWith('/.well-known/oauth-authorization-server') || reqPath.startsWith('/.well-known/openid-configuration')) {
    if (!oauth.enabled) return res.status(404).json({ error: 'oauth not enabled' });
    res.setHeader('Location', `${oauth.ISSUER}${reqPath.startsWith('/.well-known/openid') ? '/.well-known/openid-configuration' : '/.well-known/oauth-authorization-server'}`);
    return res.status(307).end();
  }
  if (req.method === 'GET') {
    // MCP clients open an SSE stream with GET; this stateless server has none, and the spec
    // says to answer 405 then (a 200 makes clients reconnect in a loop). Browsers get a hint.
    if (/text\/event-stream/.test(req.headers.accept || '')) return res.status(405).setHeader('Allow', 'POST').end();
    if (/text\/html/.test(req.headers.accept || '')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store'); // every visit gets its own key
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'");
      return res.status(200).end(keyPage(req));
    }
    return res.status(200).json({ name: 'lego-inventory-build', mcp: 'POST /mcp?key=<your key>', open: process.env.LEGO_OPEN === '1' });
  }
  if (req.method !== 'POST') return res.status(405).end();
  const user = await userOf(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 60);
  if (!user) {
    console.log(JSON.stringify({ ev: 'unauthorized', ua, hasKey: /[?&]key=/.test(req.url || ''), auth: !!req.headers.authorization }));
    if (oauth.enabled) {
      res.setHeader('WWW-Authenticate', oauth.challenge(oauth.resourceFor(req), req.headers.authorization ? 'invalid_token' : undefined));
      return res.status(401).json({ error: 'unauthorized', error_description: 'sign in: this server uses OAuth' });
    }
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
  const client = analytics.clientOf(ua, body);
  let newUser = false;
  // OAuth accounts ("a" + 24 hex) are sent in full: the sign-in server uses the same id, so sign-up
  // and tool calls of one person join up in Amplitude. Legacy key users stay a short hash prefix.
  const userId = user === 'owner' ? 'owner' : user.startsWith('a') ? user : user.slice(0, 13);
  const track = (status, payload, error) => {
    const p = analytics.send(analytics.events({ userId, msgs, ua, client, status, ms: Date.now() - t0, payload, error, newUser }));
    try { waitUntil(p); } catch { /* not on Vercel: the promise just runs */ }
  };
  const hasCalls = msgs.some((m) => m && m.method === 'tools/call');
  const stateful = needsState(msgs);
  // Rendered films go to the owner's YouTube channel too (when configured). The card gets a link
  // only if this exact film is already there; a new one is uploaded after the reply (the mp4 is
  // copied out of the request's temp dir first, since that dir is deleted when the call ends).
  const ytUsers = String(process.env.YOUTUBE_USERS || 'owner').split(',').map((s) => s.trim()).filter(Boolean);
  const onVideo = youtube.enabled && (ytUsers.includes('*') || ytUsers.includes(user)) ? async (file, meta) => {
    const sha = youtube.sha1File(file);
    const known = await youtube.knownVideo(sha);
    if (known) return known.url;
    const keep = path.join(ROOT_TMP, `yt-${sha}.mp4`);
    fs.copyFileSync(file, keep);
    const job = youtube.upload(keep, {
      title: `${meta.title} — сборка LEGO из ${meta.parts} деталей`,
      description: `Пошаговая сборка: ${meta.steps} шагов, ${meta.parts} деталей. Собрано из своих деталей с помощью «LEGO из моих деталей».\nhttps://github.com/elcodabra/lego-build-inventory\n\nLEGO® is a trademark of the LEGO Group, which does not sponsor or endorse this video.`,
      tags: ['LEGO', 'лего', 'инструкция', 'MOC', meta.title],
    }).then((v) => {
      if (v) analytics.send([{ user_id: userId, event_type: 'video_published', time: Date.now(), platform: 'mcp', event_properties: { target: 'youtube', format: meta.format, steps: meta.steps, parts: meta.parts } }]);
    }).finally(() => fs.rmSync(keep, { force: true }));
    try { waitUntil(job); } catch { /* not on Vercel: runs anyway */ }
    return null;
  } : null;

  try {
    // Quota first (atomic, before any work). Then one attempt = load state, run the tool, save with a
    // version check. Another instance writing the same user's state in between makes the save fail
    // with a conflict: redo the whole call on fresh state. Stateless requests skip the store.
    if (user !== 'owner' && hasCalls) {
      const q = await store.chargeQuota(user, usageOf(msgs), QUOTA);
      if (!q.ok) {
        const e = new Error(`daily limit reached: ${q.limit} ${q.over === 'calls' ? 'tool calls' : q.over === 'video' ? 'videos' : 'photos'} per day for this key, try again tomorrow`);
        e.quota = true;
        throw e;
      }
      newUser = q.first;
    }
    const attempt = async () => {
      const dir = path.join(ROOT_TMP, user + '-' + crypto.randomBytes(6).toString('hex'));
      let srv = null;
      let transport = null;
      try {
        let ver = null;
        if (stateful) ver = await store.load(user, dir);
        else { fs.mkdirSync(path.join(dir, 'models'), { recursive: true }); fs.mkdirSync(path.join(dir, 'exports'), { recursive: true }); }
        return await core.ctx.run({ dataDir: dir, safe: true, renderer: 'node' }, async () => {
          const { buildServer } = await import('../mcp/tools.mjs');
          srv = buildServer({ publish, mediaOrigin: MEDIA_ORIGIN, onVideo });
          transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          await srv.connect(transport);
          const r = await transport.handleRequest(webRequest(req, body), { parsedBody: body });
          const payload = Buffer.from(await r.arrayBuffer());
          const headers = {};
          r.headers.forEach((v, k) => { headers[k] = v; });
          const saved = stateful ? await store.save(user, dir, ver) : [];
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
    const isErr = /"isError":true|"error":\{/.test(txt);
    log({ status: out.status, saved: out.saved.length ? out.saved : undefined, err: isErr ? txt.replace(/\s+/g, ' ').slice(0, 300) : undefined });
    track(out.status, out.body.toString('utf8', 0, 20000), isErr);
  } catch (e) {
    if (!e.quota) console.error(e);
    log({ status: e.quota ? 429 : 500, err: e.message });
    track(e.quota ? 429 : 500, '', true);
    // JSON-RPC error for the request id, so the client shows a real message
    const id = msgs.length === 1 && msgs[0] && msgs[0].id !== undefined ? msgs[0].id : null;
    if (!res.headersSent) {
      // a quota hit on a tool call is a tool result the model can relay to the user
      if (e.quota && msgs.length === 1 && msgs[0].method === 'tools/call') res.status(200).json({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e.message }] } });
      else res.status(200).json({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
  }
}
