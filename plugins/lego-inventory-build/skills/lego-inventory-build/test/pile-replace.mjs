// A new pile photo REPLACES the saved parts list (the old one is kept for inventory_undo), mode
// "add" adds, mode "none" only reports. Recognition is mocked (no Brickognize calls):
//   node test/pile-replace.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-pile-replace-'));
process.env.LEGO_DATA_DIR = TMP;
process.env.LEGO_INVENTORY = '';
const photo = require('../lib/photo.cjs');
// mock: every photo shows two red 2x4 bricks and one blue 2x2
photo.identifyPile = async () => ({
  found: 3, recognised: 3, parts: [{}, {}, {}],
  items: [{ id: '3001', color: 'red', qty: 2, name: 'Brick 2 x 4', unsure: 0 }, { id: '3003', color: 'blue', qty: 1, name: 'Brick 2 x 2', unsure: 0 }],
});
const { buildServer } = await import('../mcp/tools.mjs');
const ok = (m) => console.log('  ok ', m);

const server = buildServer({ publish: () => null });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const c = new Client({ name: 'openai-mcp', version: '1.0.0' });
await c.connect(b);
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args || {} });
  assert.ok(!r.isError, `${name}: ${r.content[0].text}`);
  return r.content[0].text.trim().startsWith('{') ? JSON.parse(r.content[0].text) : r.content[0].text;
};
const total = async () => { const s = await call('inventory_show'); return typeof s === 'string' ? 0 : s.totalParts; };
const pile = (args) => call('parts_from_pile_photo', { images: ['data:image/jpeg;base64,AAAA'], ...args });

// an old list read "by eye" (the ChatGPT case) of 59 parts
await call('inventory_import', { data: 'part,color,qty\n3020,black,50\n3004,red,9', replace: true });
assert.equal(await total(), 59);

// 1. a photo replaces it
const r1 = await pile({});
assert.equal(r1.mode, 'replace');
assert.match(r1.replacedPrevious, /59 parts.*inventory_undo/);
assert.equal(await total(), 3);
ok('a new photo replaces the old list (59 -> 3) and says how to bring it back');

// 2. undo swaps back, undo again redoes
const u = await call('inventory_undo');
assert.equal(u.totalParts, 59);
assert.equal(await total(), 59);
await call('inventory_undo');
assert.equal(await total(), 3);
ok('inventory_undo brings the old list back, a second undo redoes');

// 3. mode add adds, mode none only reports
await pile({ mode: 'add' });
assert.equal(await total(), 6);
const r3 = await pile({ mode: 'none' });
assert.equal(r3.added, false);
assert.equal(await total(), 6);
ok('mode "add" adds to the list, mode "none" leaves it alone');

// 4. old clients: add=false is "none", replace=true is "replace"
await pile({ add: false });
assert.equal(await total(), 6);
await pile({ replace: true });
assert.equal(await total(), 3);
ok('old arguments still work (add=false, replace=true)');

// 5. tool texts tell the model the default
const tools = Object.fromEntries((await c.listTools()).tools.map((t) => [t.name, t]));
assert.match(tools.parts_from_pile_photo.description, /REPLACE the saved list/);
assert.ok(tools.inventory_undo);
ok('the tool description says a photo replaces the list; inventory_undo is listed');

// 6. analytics: pile mode, replaced flag and undo reach Amplitude (value-free facts only)
{
  const { events } = await import('../api/_analytics.mjs');
  const ev = (tool, payload) => events({ userId: 'u1', msgs: [{ method: 'tools/call', params: { name: tool, arguments: {} } }], ua: 'openai-mcp/1.0.0', client: 'chatgpt', status: 200, ms: 5, payload: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }) })[0].event_properties;
  const p = ev('parts_from_pile_photo', r1);
  assert.equal(p.pile_mode, 'replace'); assert.equal(p.replaced_previous, true); assert.equal(p.recognised, 3);
  const un = ev('inventory_undo', u);
  assert.equal(un.restored, true); assert.equal(un.total_parts, 59);
  ok(`amplitude facts: pile_mode=${p.pile_mode}, replaced_previous=${p.replaced_previous}, undo restored ${un.total_parts}`);
}

await c.close();

// 7. the hosted store keeps the previous list across requests (save -> fresh dir -> load)
{
  delete process.env.KV_REST_API_URL; delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.STATE_BLOB_TOKEN;
  const store = await import('../api/_store.mjs');
  if (store.backend === 'local') {
    const user = 'test-prev-' + Date.now();
    const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'st1-')); fs.mkdirSync(d1 + '/models');
    const v1 = await store.load(user, d1);
    fs.writeFileSync(d1 + '/inventory.json', '{"items":[{"id":"3001","color":"red","qty":2}],"sources":["pile photo ×1"]}');
    fs.writeFileSync(d1 + '/inventory.prev.json', '{"items":[{"id":"3020","color":"black","qty":50}],"sources":["import csv"]}');
    await store.save(user, d1, v1);
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'st2-')); fs.mkdirSync(d2 + '/models');
    await store.load(user, d2);
    assert.ok(fs.existsSync(d2 + '/inventory.prev.json'), 'inventory.prev.json saved by the store');
    assert.match(fs.readFileSync(d2 + '/inventory.prev.json', 'utf8'), /3020/);
    ok('the store saves and loads inventory.prev.json with the user state');
    fs.rmSync(path.join('/tmp/lego/_store', user), { recursive: true, force: true });
  } else console.log('  skip store roundtrip (backend ' + store.backend + ')');
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log('pile replace checks passed');
