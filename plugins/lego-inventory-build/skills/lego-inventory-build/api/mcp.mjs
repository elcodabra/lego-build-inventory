// Vercel entry: MCP over Streamable HTTP (stateless) at /mcp.
//
// Serverless has no persistent disk, so each request works in /tmp/lego/<user> and syncs that
// user's state (inventory.json, models/*.json) with a PRIVATE Vercel Blob store (STATE_BLOB_TOKEN):
// pulled before the tool call, pushed after it if anything changed. Rendered PNG/mp4 go to a
// PUBLIC store (MEDIA_BLOB_TOKEN) under unguessable names, so ChatGPT can show/link them.
//
// Auth / users: the connector URL is https://<app>/mcp?key=<key>. With LEGO_MCP_TOKEN set only that
// key is accepted (one user). With LEGO_OPEN=1 any key of 16+ chars is accepted and becomes its own
// separate inventory, so several people can test with their own keys. The key is never stored:
// data is filed under sha256(key).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const ROOT_TMP = '/tmp/lego';
const STATE = process.env.STATE_BLOB_TOKEN;
const MEDIA = process.env.MEDIA_BLOB_TOKEN;
let blob = null;
const B = async () => (blob ||= await import('@vercel/blob'));

function userOf(req) {
  const url = new URL(req.url, 'http://x');
  const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('key') || '';
  const token = process.env.LEGO_MCP_TOKEN;
  if (token) return key === token ? 'owner' : null;
  if (process.env.LEGO_OPEN === '1' && key.length >= 16) return 'u' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
  return null;
}

// Blob layout: state/<user>/inventory.json, state/<user>/models/<name>.json, media/<random>.<ext>
async function pull(user, dir) {
  // without a state store (local test) /tmp is the store: keep it
  if (STATE) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'exports'), { recursive: true });
  if (!STATE) return new Map();
  const { list, get } = await B();
  const seen = new Map();
  let cursor;
  do {
    const r = await list({ prefix: `state/${user}/`, cursor, limit: 1000, token: STATE });
    await Promise.all(r.blobs.map(async (b) => {
      const rel = b.pathname.slice(`state/${user}/`.length);
      const g = await get(b.pathname, { access: 'private', useCache: false, token: STATE });
      if (!g || g.statusCode !== 200) return;
      const buf = Buffer.from(await new Response(g.stream).arrayBuffer());
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), buf);
      seen.set(rel, hash(buf));
    }));
    cursor = r.cursor;
  } while (cursor);
  return seen;
}

const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

async function push(user, dir, before) {
  if (!STATE) return;
  const { put } = await B();
  const files = [];
  if (fs.existsSync(path.join(dir, 'inventory.json'))) files.push('inventory.json');
  for (const f of fs.readdirSync(path.join(dir, 'models'))) if (f.endsWith('.json')) files.push('models/' + f);
  await Promise.all(files.map(async (rel) => {
    const buf = fs.readFileSync(path.join(dir, rel));
    if (before.get(rel) === hash(buf)) return;
    await put(`state/${user}/${rel}`, buf, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', token: STATE });
  }));
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
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
}

let queue = Promise.resolve(); // one request at a time per instance: env vars below are process-wide

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    return res.status(200).json({ name: 'lego-inventory-build', mcp: '/mcp?key=<your key>', state: !!STATE, media: !!MEDIA, open: process.env.LEGO_OPEN === '1' });
  }
  if (req.method !== 'POST') return res.status(405).end();
  const user = userOf(req);
  if (!user) return res.status(401).json({ error: 'unauthorized: add ?key=<key> to the connector URL' });

  let body;
  try { body = await readBody(req); } catch { return res.status(400).json({ error: 'bad json' }); }

  const run = async () => {
    const dir = path.join(ROOT_TMP, user);
    const before = await pull(user, dir);
    // core.cjs reads these at call time (inventory) or at load (data dir): set both, load after.
    process.env.LEGO_DATA_DIR = dir;
    process.env.LEGO_INVENTORY = path.join(dir, 'inventory.json');
    process.env.LEGO_RENDERER = 'node';
    const { buildServer } = await import('../mcp/tools.mjs');
    const srv = buildServer({ publish, dataDir: dir });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await srv.connect(transport);
    await transport.handleRequest(req, res, body);
    await push(user, dir, before);
    await srv.close();
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  try {
    await p;
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
}
