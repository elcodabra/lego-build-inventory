// The hosted handler (api/mcp.mjs, Vercel mode) with the new hackathon flow end to end, locally:
// a mock Meta API, a mock Amplitude, an open-mode user. Checks the real events that leave the
// server, the photo quota on model_analyze_photo, and user isolation.
//   node test/hosted-meta.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const sent = [];
const amp = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => { sent.push(JSON.parse(b)); res.end('{"code":200}'); });
}).listen(18781);
let metaCalls = 0;
const GOOD = { is_lego_model: true, object_summary: 'secret-summary orange cat', visible_colours: ['orange'], visible_parts: [{ category: 'brick', count_estimate: 20, confidence: 'medium' }], possible_model_names: ['cat'], match_confidence: 'high', uncertainties: [], suggested_views: [] };
const metaSrv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    metaCalls++;
    const body = JSON.parse(b);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'resp_secret', model: body.model, status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(GOOD) }] }], usage: { input_tokens: 800, output_tokens: 900 } }));
  });
}).listen(18782);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-hosted-'));
Object.assign(process.env, {
  VERCEL: '1', LEGO_MCP_TOKEN: 'owner-key-123', LEGO_OPEN: '1', LEGO_QUOTA_CALLS: '50', LEGO_QUOTA_PHOTO: '2',
  AMPLITUDE_API_KEY: 'test', AMPLITUDE_ENDPOINT: 'http://127.0.0.1:18781/2/httpapi',
  MODEL_API_KEY: 'meta-key-not-real', META_API_BASE: 'http://127.0.0.1:18782/v1', META_BUDGET_FILE: path.join(TMP, 'budget.json'),
});
const { default: handler } = await import(process.cwd() + '/api/mcp.mjs');
const srv = http.createServer((req, res) => {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  handler(req, res);
}).listen(18780);
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const connect = async (key, name = 'openai-mcp') => {
  const c = new Client({ name, version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:18780/mcp?key=${key}`), { requestInit: { headers: { 'user-agent': name + '/1.0.0' } } }));
  return c;
};
const ok = (m) => console.log('  ok ', m);
const photo = 'data:image/png;base64,' + fs.readFileSync('test/fixtures/3001-red.png').toString('base64');

const keyA = 'Hk7-' + 'mnbvcxzlkjhgfdsapoiuytre' + Date.now().toString(36);
const a = await connect(keyA);
const tools = (await a.listTools()).tools.map((t) => t.name);
assert.ok(tools.includes('model_analyze_photo') && tools.includes('model_disassemble')); ok('hosted server lists model_analyze_photo + model_disassemble');

const r1 = await a.callTool({ name: 'model_analyze_photo', arguments: { image: photo, hint: 'secret-hint' } });
assert.equal(r1.structuredContent.status, 'ok');
assert.deepEqual(r1.structuredContent.candidates.map((c) => c.name), ['cat']); ok('analysis on the hosted path -> candidate cat');
const d = await a.callTool({ name: 'model_disassemble', arguments: { name: 'cat', mode: 'steps', confirmed: true } });
assert.ok(!d.isError, JSON.stringify(d.content));
assert.equal(d.structuredContent.stepUrls.length, 17); ok('confirmed -> exact disassembly with 17 reverse steps');
await a.callTool({ name: 'model_analyze_photo', arguments: { image: photo } });
const over = await a.callTool({ name: 'model_analyze_photo', arguments: { image: photo } });
assert.ok(over.isError && /daily limit.*photos/.test(over.content[0].text), JSON.stringify(over.content));
assert.equal(metaCalls, 2, 'quota stops the call before Meta is reached'); ok('photo quota (2/day) blocks the 3rd analysis before any Meta request');

await new Promise((r) => setTimeout(r, 400));
const evts = sent.flatMap((p) => p.events);
const types = evts.map((e) => e.event_type);
for (const t of ['photo_model_analyzed', 'model_match_confirmed', 'disassembly_opened', 'exploded_view_rendered']) assert.ok(types.includes(t), 'missing ' + t);
assert.ok(!types.includes('meta_request_failed'), 'a quota hit is not a Meta failure');
const pa = evts.find((e) => e.event_type === 'photo_model_analyzed');
assert.equal(pa.event_properties.provider_model, 'muse-spark-1.3');
assert.equal(pa.event_properties.top_match, 'cat');
const userIds = new Set(evts.filter((e) => ['photo_model_analyzed', 'model_match_confirmed', 'disassembly_opened'].includes(e.event_type)).map((e) => e.user_id));
assert.equal(userIds.size, 1); ok('events: ' + [...new Set(types)].join(', ') + '; one user id across the funnel');
const raw = JSON.stringify(sent);
for (const bad of [keyA, 'meta-key-not-real', 'secret-hint', 'secret-summary', 'resp_secret', 'base64', 'iVBOR']) assert.ok(!raw.includes(bad), 'leaked ' + bad);
ok('no key, Meta key, hint, AI text, response id or photo bytes in analytics');

await a.close();
srv.close(); amp.close(); metaSrv.close();
console.log('hosted meta checks passed');
process.exit(0);
