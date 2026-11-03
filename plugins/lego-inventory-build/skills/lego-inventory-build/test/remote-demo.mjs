// Hackathon hero flow against a DEPLOYED server (spends one real Meta call, about $0.006):
//   node --use-system-ca test/remote-demo.mjs "https://<app>/mcp?key=<key>" [photo.jpg] [expected]
// photo -> model_analyze_photo (real Muse Spark) -> confirm top match -> model_disassemble picture +
// steps (public media URLs reachable) -> show_build (Build again). Prints timings, no secrets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const url = new URL(process.argv[2]);
let file = process.argv[3];
const expected = process.argv[4] || (file ? null : 'cat');
if (!file) {
  const nf = require('../lib/nodefilm.cjs');
  file = path.join(require('node:os').tmpdir(), 'remote-demo-cat.png');
  fs.writeFileSync(file, await nf.hero(require('../lib/core.cjs').loadModel('cat'), { size: 900 }));
}
const c = new Client({ name: 'remote-demo', version: '0' });
await c.connect(new StreamableHTTPClientTransport(url));
const t0 = Date.now();
const lap = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);
const reach = async (u) => (await fetch(u, { method: 'HEAD' })).status;

const tools = (await c.listTools()).tools.map((t) => t.name);
assert.ok(tools.includes('model_analyze_photo') && tools.includes('model_disassemble'), 'new tools missing: old deploy?');
lap('tools ok (' + tools.length + ')');
const img = `data:image/${/\.png$/i.test(file) ? 'png' : 'jpeg'};base64,` + fs.readFileSync(file).toString('base64');
const a = await c.callTool({ name: 'model_analyze_photo', arguments: { image: img } });
const sc = a.structuredContent;
assert.equal(sc.status, 'ok', 'analysis: ' + JSON.stringify(sc.error || a.content[0].text));
lap(`analysis ${sc.provider.model} ${sc.provider.ms}ms response=${sc.provider.responseId} top=${sc.candidates[0] ? sc.candidates[0].name : 'none'} conf=${sc.analysis.match_confidence}`);
if (expected) assert.equal(sc.candidates[0] ? sc.candidates[0].name : 'none', expected);
const pick = sc.candidates[0] ? sc.candidates[0].name : 'cat';
const d = (await c.callTool({ name: 'model_disassemble', arguments: { name: pick, confirmed: true } })).structuredContent;
assert.equal(d.disassembly.source, 'exact-model-json');
for (const u of [d.posterUrl, d.disassembly.explodedUrl]) assert.equal(await reach(u), 200, u);
lap(`disassemble picture: ${d.parts} parts, poster + exploded reachable`);
const s = (await c.callTool({ name: 'model_disassemble', arguments: { name: pick, mode: 'steps' } })).structuredContent;
assert.equal(s.stepUrls.length, s.steps);
assert.equal(await reach(s.stepUrls[0]), 200);
lap(`disassemble steps: ${s.stepUrls.length} reverse steps, first reachable`);
const b = (await c.callTool({ name: 'show_build', arguments: { name: pick, mode: 'steps' } })).structuredContent;
assert.equal(b.disassembly, undefined);
assert.equal(b.parts, d.parts);
lap('Build again: same part count, build steps');
await c.close();
console.log('remote demo flow passed');
