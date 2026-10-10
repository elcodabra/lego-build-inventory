// End-to-end smoke test: CLI inventory + check, then the MCP server over stdio and HTTP.
//   node test/smoke.mjs [--render]   (--render also renders an mp4 through MCP)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-smoke-'));
const RENDER = process.argv.includes('--render');
const ok = (m) => console.log('  ok  ' + m);
const node = (...a) => execFileSync('node', a, { cwd: TMP, encoding: 'utf8', env: { ...process.env, LEGO_DATA_DIR: path.join(TMP, 'data-cli'), LEGO_INVENTORY: '' } });

// A tiny red-and-white mushroom from a small pile of parts.
const MUSHROOM = {
  title: 'Грибок', theta: 40, phi: 30,
  steps: [
    [{ id: '3003', color: 'white', at: [1, 1, 0] }],
    [{ id: '3003', color: 'white', at: [1, 1, 3] }],
    [{ id: '3031', color: 'red', at: [0, 0, 6] }],
    [{ id: '3001', color: 'red', at: [0, 1, 7], rot: 0 }, { id: '3004', color: 'red', at: [0, 0, 7] }, { id: '3004', color: 'red', at: [2, 3, 7] }],
    [{ id: '3068', color: 'white', at: [1, 1, 10] }],
  ],
};
const PILE = 'part,color,qty\n3003,White,2\n3031,Red,1\n3001,Red,1\n3004,Red,1\n3068,White,1\n3024,Black,6\n';

console.log('CLI');
fs.writeFileSync(path.join(TMP, 'pile.csv'), PILE);
fs.mkdirSync(path.join(TMP, 'models'));
fs.writeFileSync(path.join(TMP, 'models/mushroom.json'), JSON.stringify(MUSHROOM));
node(path.join(ROOT, 'tools/inventory.cjs'), 'import', 'pile.csv');
let out = '';
try { node(path.join(ROOT, 'tools/check-model.cjs'), 'mushroom'); } catch (e) { out = e.stdout; }
assert.match(out, /MISSING\s+3004 red .*не хватает 1/);
ok('check-model reports the missing 1x2 brick');
node(path.join(ROOT, 'tools/inventory.cjs'), 'add', '3004', 'Red', '1');
out = node(path.join(ROOT, 'tools/check-model.cjs'), 'mushroom');
assert.match(out, /no overlaps, everything is held, all parts are in the inventory/);
ok('check-model green after adding the part');
assert.match(node(path.join(ROOT, 'tools/inventory.cjs'), 'bom', 'mushroom', '--csv'), /3004,Red,2/);
ok('bom csv');

async function exercise(client, label) {
  console.log(label);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ['inventory_show', 'inventory_import', 'model_check', 'model_preview', 'model_render', 'lego_guide', 'lego_catalog']) assert.ok(tools.includes(t), t);
  ok(`${tools.length} tools listed`);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args || {} });
    assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`);
    return r;
  };
  const J = (r) => JSON.parse(r.content[0].text);
  await call('inventory_import', { data: PILE, replace: true });
  let c = J(await call('model_check', { model: MUSHROOM }));
  assert.equal(c.ok, false);
  assert.equal(c.missing[0].id, '3004');
  ok('model_check finds the missing part');
  await call('inventory_update', { items: [{ id: '3004', color: 'red', qty: 1 }] });
  c = J(await call('model_check', { model: MUSHROOM }));
  assert.equal(c.ok, true, JSON.stringify(c));
  ok('model_check ok');
  const bad = J(await call('model_check', { model: { title: 'x', steps: [[{ id: '9999', color: 'red', at: [0, 0, 0] }]] } }));
  assert.equal(bad.ok, false);
  ok('unknown part rejected: ' + bad.errors[0]);
  await call('model_save', { model: MUSHROOM, name: 'mushroom' });
  assert.ok(J(await call('model_list')).includes('mushroom'));
  ok('model_save + model_list');
  const p = await call('model_preview', { name: 'mushroom', times: [2, 'final'] });
  const imgs = p.content.filter((x) => x.type === 'image');
  assert.equal(imgs.length, 2);
  fs.writeFileSync(path.join(TMP, `${label}-final.png`), Buffer.from(imgs[1].data, 'base64'));
  ok('model_preview returned 2 PNGs -> ' + path.join(TMP, `${label}-final.png`));
  // ideas from a small "box" of parts
  const BOX = ['white', 'red', 'green', 'lbg', 'brown'].flatMap((c) => ['3001,' + c + ',6', '3003,' + c + ',6', '3004,' + c + ',10', '3005,' + c + ',8', '3023,' + c + ',6', '3022,' + c + ',4'])
    .concat(['3039,red,8', '3040,red,6', '3032,green,1']).join('\n');
  await call('inventory_import', { data: 'part,color,qty\n' + BOX, replace: true });
  const sug = J(await call('ideas_suggest'));
  assert.ok(sug.buildable.length >= 3, 'at least 3 ideas: ' + sug.buildable.map((b) => b.idea));
  ok('ideas_suggest: ' + sug.buildable.map((b) => `${b.idea}(${b.parts})`).join(', '));
  assert.ok(sug.recommended.startsWith(sug.buildable[0].idea) && /show_build/.test(sug.next) && /Do NOT show any other pictures/.test(sug.next));
  ok('ideas_suggest recommends the idea that uses the most parts and points to show_build: ' + sug.recommended);
  {
    const raw = await call('ideas_suggest');
    const sc = raw.structuredContent;
    assert.equal(sc.kind, 'ideas');
    assert.deepEqual(sc.ideas.map((x) => x.idea), sug.buildable.slice(0, 6).map((x) => x.idea));
    assert.ok(sc.ideas.every((x) => x.parts > 0 && x.title));
    const meta = (await client.listTools()).tools.find((t) => t.name === 'ideas_suggest')._meta;
    assert.ok(meta['openai/outputTemplate'] && meta['openai/widgetAccessible']);
    const ib = (await client.listTools()).tools.find((t) => t.name === 'idea_build')._meta;
    assert.equal(ib['openai/widgetAccessible'], true);
    assert.match(sug.next, /Do NOT show any other pictures/);
    ok(`ideas card: ${sc.ideas.length} ideas with their own pictures (${sc.ideas.filter((x) => x.thumbUrl).length} published here), «Собрать» can call idea_build`);
  }
  const eye = J(await call('inventory_import', { data: 'part,color,qty\n3001,red,1', source: 'Фото IMG_1938, примерный подсчет' }));
  assert.match(eye.warning, /parts_from_pile_photo/);
  const typed = J(await call('inventory_import', { data: 'part,color,qty\n3001,red,1' }));
  assert.equal(typed.warning, undefined);
  await call('inventory_import', { data: 'part,color,qty\n' + BOX, replace: true });
  const descs = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.description]));
  assert.match(descs.lego_photo_guide, /^FALLBACK ONLY/);
  assert.match(descs.inventory_import, /not for photos/);
  ok('a list read from a photo by eye gets a warning to use parts_from_pile_photo; tool texts steer photos to the server');
  const built = J(await call('idea_build', { idea: 'house' }));
  assert.equal(built.ok, true, JSON.stringify(built));
  const hp = await call('model_preview', { name: 'house' });
  assert.equal(hp.content.filter((x) => x.type === 'image').length, 1);
  ok(`idea_build house ${built.size}: ${built.parts} parts, checked ok, preview rendered`);
  if (!process.env.OFFLINE) {
    const fx = path.join(ROOT, 'test/fixtures');
    const dataUrl = (f) => 'data:image/png;base64,' + fs.readFileSync(path.join(fx, f)).toString('base64');
    const ph = J(await call('parts_from_photo', { images: [dataUrl('3001-red.png'), dataUrl('3039-black.png')], add: true, qty: 2 }));
    const denied = J(await call('parts_from_photo', { images: ['/etc/hosts'] }));
    assert.match(denied.results[0].error, /https URL/);
    ok('server refuses local file paths as images');
    assert.deepEqual(ph.results.map((r) => `${r.part.id} ${r.color}`), ['3001 red', '3039 black']);
    ok('parts_from_photo (Brickognize): ' + ph.results.map((r) => `${r.part.id} ${r.color} added=${r.added}`).join(', '));
  }
  if (RENDER) {
    const r = J(await call('model_render', { name: 'mushroom' }));
    assert.ok(fs.statSync(r.file).size > 10000);
    ok('model_render ' + r.file + (r.url ? ' ' + r.url : ''));
    return r;
  }
  return null;
}

const env = { ...process.env, LEGO_DATA_DIR: path.join(TMP, 'data-stdio') };
const stdio = new Client({ name: 'smoke', version: '0' });
await stdio.connect(new StdioClientTransport({ command: 'node', args: [path.join(ROOT, 'mcp/server.mjs')], env, stderr: 'ignore' }));
await exercise(stdio, 'stdio');
await stdio.close();

const PORT = 18000 + Math.floor(Math.random() * 1000);
const srv = spawn('node', [path.join(ROOT, 'mcp/server.mjs'), '--http', '--port', String(PORT)], { env: { ...process.env, LEGO_DATA_DIR: path.join(TMP, 'data-http'), LEGO_MCP_TOKEN: 'secret' }, stdio: ['ignore', 'ignore', 'pipe'] });
await new Promise((res, rej) => { srv.stderr.on('data', (d) => { if (/HTTP ready/.test(d)) res(); }); srv.on('exit', rej); });
try {
  const denied = await fetch(`http://localhost:${PORT}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401);
  ok('http: token required');
  const http = new Client({ name: 'smoke', version: '0' });
  await http.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`), { requestInit: { headers: { Authorization: 'Bearer secret' } } }));
  const r = await exercise(http, 'http');
  if (r) {
    const f = await fetch(r.url + '?key=secret');
    assert.equal(f.status, 200);
    ok('http: rendered file downloadable');
  }
  await http.close();
} finally {
  srv.kill();
}
console.log('all good, artifacts in ' + TMP);
