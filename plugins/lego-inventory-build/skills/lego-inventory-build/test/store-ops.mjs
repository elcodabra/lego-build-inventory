// How many storage operations one full ChatGPT session costs, against real Upstash Redis (test key
// prefix, cleaned up after) with Vercel Blob replaced by a counting stub. Also: concurrent writes
// to one user are not lost, quotas are atomic, identical pictures are uploaded once.
//   KV_REST_API_URL=... KV_REST_API_TOKEN=... node test/store-ops.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

if (!process.env.KV_REST_API_URL) { console.log('skip: no KV_REST_API_URL'); process.exit(0); }
const prefix = 'legotest' + Date.now().toString(36);
Object.assign(process.env, { VERCEL: '1', LEGO_MCP_TOKEN: 'owner-key-123', LEGO_OPEN: '1', LEGO_REDIS_PREFIX: prefix, MEDIA_BLOB_TOKEN: 'vercel_blob_rw_TESTSTORE_x' });
delete process.env.STATE_BLOB_TOKEN;
delete process.env.AMPLITUDE_API_KEY;

// count Blob calls: stub @vercel/blob put()
const require = createRequire(import.meta.url);
const blobPath = require.resolve('@vercel/blob');
const ops = { put: 0, list: 0, get: 0 };
const blob = await import('@vercel/blob');
const fakeBlob = { ...blob, put: async (p) => { ops.put++; return { url: 'https://teststore.public.blob.vercel-storage.com/' + p }; }, list: async () => { ops.list++; return { blobs: [] }; }, get: async () => { ops.get++; return null; } };
const { syncBuiltinESMExports } = await import('node:module');
// the handler imports @vercel/blob lazily via import(): intercept with a loader hook
const { register } = await import('node:module');
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(s, c, n) { if (s === '@vercel/blob') return { url: 'stub:blob', shortCircuit: true }; return n(s, c); }
export async function load(u, c, n) { if (u === 'stub:blob') return { format: 'module', shortCircuit: true, source: 'export const put = (...a) => globalThis.__blob.put(...a); export const list = (...a) => globalThis.__blob.list(...a); export const get = (...a) => globalThis.__blob.get(...a); export const del = async () => {};' }; return n(u, c); }`));
globalThis.__blob = fakeBlob;

const { default: handler, mediaStats } = await import(process.cwd() + '/api/mcp.mjs');
const store = await import(process.cwd() + '/api/_store.mjs');
assert.equal(store.backend, 'redis');
const srv = http.createServer((req, res) => {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  handler(req, res);
}).listen(18790);
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const connect = async (key) => { const c = new Client({ name: 'openai-mcp', version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:18790/mcp?key=${key}`))); return c; };
const ok = (m) => console.log('  ok ', m);
const key = 'Tst-' + Math.random().toString(36).slice(2) + 'ABCDEFGHJKLMNP';

// ---- one realistic session
const r0 = store.redisStats.commands;
const c = await connect(key);
await c.listTools();
await c.callTool({ name: 'lego_guide', arguments: {} });
await c.callTool({ name: 'inventory_import', arguments: { data: 'part,color,qty\n3001,red,10\n3003,white,12\n3004,white,10\n3039,red,8\n3022,white,4\n3020,green,2', replace: true } });
await c.callTool({ name: 'inventory_show', arguments: {} });
const s = JSON.parse((await c.callTool({ name: 'ideas_suggest', arguments: {} })).content[0].text);
const idea = s.buildable[0].idea;
await c.callTool({ name: 'idea_build', arguments: { idea } });
await c.callTool({ name: 'show_build', arguments: { name: idea } });
await c.callTool({ name: 'show_build', arguments: { name: idea } }); // same picture again
await c.callTool({ name: 'show_build', arguments: { name: idea, mode: 'steps' } });
const redisCmds = store.redisStats.commands - r0;
console.log(`  session: ${idea}; Blob put=${ops.put} list=${ops.list} get=${ops.get} (advanced ops = ${ops.put + ops.list}); Redis commands=${redisCmds}; media uploaded ${mediaStats.uploads}, reused ${mediaStats.reused}`);
assert.equal(ops.list + ops.get, 0, 'no Blob reads for state'); ok('no Blob operations for state');
assert.ok(mediaStats.reused >= 2, 'repeated pictures reused'); ok('identical pictures uploaded once');

// ---- state really persisted (fresh client, same key)
const c2 = await connect(key);
const inv = JSON.parse((await c2.callTool({ name: 'inventory_show', arguments: {} })).content[0].text);
assert.ok(inv.totalParts >= 40); ok(`state persisted in Redis: ${inv.totalParts} parts`);
const ml = (await c2.callTool({ name: 'model_list', arguments: {} })).content[0].text;
assert.ok(ml.includes(idea)); ok('saved model listed');

// ---- concurrency: 8 parallel +1 updates, none lost (different instances = no shared lock: call the store directly too)
const before = (JSON.parse((await c2.callTool({ name: 'inventory_show', arguments: {} })).content[0].text).drawable || []).find((x) => x.id === '3024' && x.color === 'lime')?.qty || 0;
const clients = await Promise.all(Array.from({ length: 8 }, () => connect(key)));
const res = await Promise.allSettled(clients.map((x) => x.callTool({ name: 'inventory_update', arguments: { items: [{ id: '3024', color: 'lime', qty: 1 }] } })));
const okN = res.filter((r) => r.status === 'fulfilled' && !r.value.isError).length;
const after = (JSON.parse((await c2.callTool({ name: 'inventory_show', arguments: {} })).content[0].text).drawable || []).find((x) => x.id === '3024' && x.color === 'lime')?.qty || 0;
assert.equal(after - before, okN); ok(`parallel updates: ${okN}/8 succeeded, ${after - before} applied, none lost`);

// cross-instance: two loads of the same version, second save must conflict
const fs = await import('node:fs');
const d1 = '/tmp/lego/t1-' + Date.now(); const d2 = '/tmp/lego/t2-' + Date.now();
const v1 = await store.load('u' + key.slice(0, 5), d1); const v2 = await store.load('u' + key.slice(0, 5), d2);
fs.writeFileSync(d1 + '/inventory.json', '{"items":[],"sources":["a"]}');
fs.writeFileSync(d2 + '/inventory.json', '{"items":[],"sources":["b"]}');
await store.save('u' + key.slice(0, 5), d1, v1);
await assert.rejects(store.save('u' + key.slice(0, 5), d2, v2), (e) => e.conflict === true); ok('stale write from another instance is refused (conflict)');

// ---- quota is atomic under parallel load
const qk = 'q' + Date.now();
const qs = await Promise.all(Array.from({ length: 20 }, () => store.chargeQuota(qk, { calls: 1, video: 0, photo: 0 }, { calls: 7, video: 1, photo: 1 })));
assert.equal(qs.filter((q) => q.ok).length, 7); ok('20 parallel charges against a limit of 7: exactly 7 pass');
assert.equal(qs.filter((q) => q.first).length, 1); ok('exactly one "first call" flag');

// ---- clean up test keys
const R = (cmd) => fetch(process.env.KV_REST_API_URL, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN }, body: JSON.stringify(cmd) }).then((r) => r.json());
let cur = '0'; let n = 0;
do { const r = (await R(['SCAN', cur, 'MATCH', prefix + ':*', 'COUNT', '200'])).result; cur = r[0]; if (r[1].length) { await R(['DEL', ...r[1]]); n += r[1].length; } } while (cur !== '0');
ok(`removed ${n} test keys`);
await Promise.all([c, c2, ...clients].map((x) => x.close()));
srv.close();
console.log('store checks passed');
process.exit(0);
