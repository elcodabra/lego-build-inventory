// Disassembly of known models: pure invariants, the MCP tool over stdio, and its analytics events.
//   node test/disassembly.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const core = require('../lib/core.cjs');
const dis = require('../lib/disassembly.cjs');
const ok = (m) => console.log('  ok  ' + m);
const key = (b) => b.map((x) => `${x.id}|${x.color}|${x.qty}`).sort();

console.log('unit');
for (const name of ['cat', 'microduck', 'cottage']) {
  const m = core.loadModel(name);
  const before = JSON.stringify(m);
  const inv = dis.assertReverseInvariant(m);
  const N = m.steps.length;
  assert.deepEqual(dis.reverseSteps({ steps: dis.reverseSteps(m) }), m.steps, 'involution');
  assert.deepEqual(dis.reverseSteps(m)[0], m.steps[N - 1], 'reverse step 1 removes the last build step');
  assert.equal(dis.modelAtReverseStep(m, 0).steps.flat().length, inv.parts);
  assert.equal(dis.modelAtReverseStep(m, N).steps.flat().length, 0);
  for (let k = 1; k <= N; k++) assert.ok(dis.modelAtReverseStep(m, k).steps.flat().length <= dis.modelAtReverseStep(m, k - 1).steps.flat().length);
  assert.deepEqual(key(dis.disassemblyBOM(m)), key(core.bom(m)), 'BOM = build BOM');
  const ex = dis.explodedScene(m);
  assert.equal(ex.visualOnly, true);
  assert.equal(ex.steps.flat().length, inv.parts);
  assert.equal(JSON.stringify(m), before, 'source model not mutated');
  assert.deepEqual(m.steps.flat().map((p) => p.at), core.loadModel(name).steps.flat().map((p) => p.at), 'physical coordinates untouched');
  assert.ok(ex.steps.flat().some((p, i) => p.at[2] !== m.steps.flat()[i].at[2]), 'exploded copy is actually offset');
  assert.throws(() => dis.modelAtReverseStep(m, N + 1));
  assert.throws(() => dis.modelAtReverseStep(m, -1));
  ok(`${name}: ${inv.parts} parts, ${N} steps; involution, monotone, full->empty, BOM parity, no mutation, exploded is visual only`);
}

console.log('mcp (stdio)');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-dis-'));
const client = new Client({ name: 'dis-test', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(ROOT, 'mcp/server.mjs')], env: { ...process.env, LEGO_DATA_DIR: TMP }, stderr: 'ignore' }));
const tools = (await client.listTools()).tools.map((t) => t.name);
for (const t of ['show_build', 'model_get', 'model_preview', 'model_render', 'parts_from_pile_photo', 'model_disassemble']) assert.ok(tools.includes(t), t);
ok('model_disassemble registered, existing tools still there');
await client.callTool({ name: 'inventory_import', arguments: { data: 'part,color,qty\n3001,red,3' } });
const invBefore = JSON.stringify((await client.callTool({ name: 'inventory_show', arguments: {} })).content);
for (const name of ['cat', 'microduck', 'cottage']) {
  const m = core.loadModel(name);
  const pic = await client.callTool({ name: 'model_disassemble', arguments: { name } });
  assert.ok(!pic.isError, JSON.stringify(pic.content));
  const d = pic.structuredContent;
  assert.equal(d.disassembly.source, 'exact-model-json');
  assert.equal(d.disassembly.physicallyValidated, false);
  assert.equal(d.parts, m.steps.flat().length);
  assert.deepEqual(key(d.bom), key(core.bom(m)));
  assert.equal(d.stepUrls.length, 0);
  const st = await client.callTool({ name: 'model_disassemble', arguments: { name, mode: 'steps' } });
  const s = st.structuredContent;
  assert.equal(s.mode, 'steps');
  assert.equal(s.stepUrls.length, m.steps.length);
  // local stdio server returns no public URLs; the PNGs are written to the data dir
  const files = fs.readdirSync(path.join(TMP, 'exports')).filter((f) => f.startsWith(name + '-unbuild'));
  assert.equal(files.length, m.steps.length);
  for (const f of [`${name}-model.png`, `${name}-exploded.png`, files[0]]) {
    const b = fs.readFileSync(path.join(TMP, 'exports', f));
    assert.equal(b.subarray(1, 4).toString(), 'PNG');
    assert.ok(b.length > 5000, f + ' too small');
  }
  // Build <-> Disassemble: show_build on the same name still works and has the same BOM
  const build = await client.callTool({ name: 'show_build', arguments: { name, mode: 'picture' } });
  assert.equal(build.structuredContent.disassembly, undefined);
  assert.deepEqual(key(build.structuredContent.bom), key(d.bom));
  ok(`${name}: picture + exploded + ${s.stepUrls.length} reverse steps rendered; show_build BOM identical`);
}
assert.equal(JSON.stringify((await client.callTool({ name: 'inventory_show', arguments: {} })).content), invBefore, 'inventory untouched');
const bad = await client.callTool({ name: 'model_disassemble', arguments: { name: '../../etc/passwd' } });
assert.ok(bad.isError);
ok('inventory untouched; path-like names refused');
await client.close();
fs.cpSync(path.join(TMP, 'exports'), path.join(os.tmpdir(), 'lego-dis-last'), { recursive: true });

console.log('analytics');
const an = await import('../api/_analytics.mjs');
const payload = JSON.stringify({ result: { structuredContent: { name: 'cat', parts: 106, steps: 17, mode: 'steps', stepUrls: ['https://x/a.png'], disassembly: { explodedUrl: 'https://x/e.png' } } } });
const evs = an.events({ userId: 'a0123456789abcdef01234567', msgs: [{ method: 'tools/call', params: { name: 'model_disassemble', arguments: { name: 'cat', mode: 'steps' } } }], client: 'chatgpt', status: 200, ms: 1200, payload });
const types = evs.map((e) => e.event_type);
assert.deepEqual(types, ['tool_call', 'disassembly_opened', 'exploded_view_rendered']);
const raw = JSON.stringify(evs);
assert.ok(!/https?:\/\//.test(raw), 'no media URLs in analytics');
assert.match(evs[1].user_id, /^a[0-9a-f]{24}$/);
ok('disassembly_opened + exploded_view_rendered, no URLs, user_id format kept');
console.log('all good, pictures in ' + path.join(os.tmpdir(), 'lego-dis-last'));
