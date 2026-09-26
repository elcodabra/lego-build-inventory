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
