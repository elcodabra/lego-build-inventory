// Meta API integration without spending money: a local mock of POST /v1/responses.
//   node test/meta-mock.mjs
// Covers: request shape (model, image, json_schema, effort), DTO validation (foreign names, paths,
// extra fields), errors (429, 401, 5xx retry, timeout, non-JSON, cut-off output), model fallback,
// the budget cap, and the MCP flow photo -> candidates -> confirm -> exact disassembly.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-meta-'));
const ok = (m) => console.log('  ok  ' + m);
const PORT = 18795;
Object.assign(process.env, {
  MODEL_API_KEY: 'test-key-not-real', META_API_BASE: `http://127.0.0.1:${PORT}/v1`, META_TIMEOUT_MS: '1500',
  META_MODELS: 'muse-spark-1.3,muse-spark-1.2', META_BUDGET_FILE: path.join(TMP, 'budget.json'), LEGO_DATA_DIR: path.join(TMP, 'data'),
});
const require = createRequire(import.meta.url);
const meta = require('../lib/meta.cjs');
const an = require('../lib/analyze.cjs');
const { budget, fileStore } = require('../lib/budget.cjs');

// ---- mock server: behaviour picked per test via `mode`
let mode = 'ok';
let seen = [];
const GOOD = { is_lego_model: true, object_summary: 'small orange cat', visible_colours: ['orange', 'white'], visible_parts: [{ category: 'brick', count_estimate: 20, confidence: 'medium' }], possible_model_names: ['cat'], match_confidence: 'high', uncertainties: ['back side hidden'], suggested_views: ['side'] };
const reply = (res, code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const okBody = (model, json, extra) => ({ id: 'resp_mock', model, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(json) }] }], usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1000 }, ...extra });
const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    const body = JSON.parse(b);
    seen.push({ auth: req.headers.authorization, path: req.url, body });
    const n = seen.length;
    if (mode === 'ok') return reply(res, 200, okBody(body.model, GOOD));
    if (mode === 'nomatch') return reply(res, 200, okBody(body.model, { ...GOOD, possible_model_names: [], match_confidence: 'none' }));
    if (mode === 'foreign') return reply(res, 200, okBody(body.model, { ...GOOD, possible_model_names: ['../../etc/passwd'] }));
    if (mode === 'extra') return reply(res, 200, okBody(body.model, { ...GOOD, exec: 'rm -rf /' }));
    if (mode === 'paths') return reply(res, 200, okBody(body.model, { ...GOOD, object_summary: 'see /etc/passwd and https://evil.example/x', uncertainties: ['\u0000ctrl'] }));
    if (mode === 'many') return reply(res, 200, okBody(body.model, { ...GOOD, visible_colours: Array.from({ length: 40 }, (_, i) => 'c' + i), uncertainties: Array(20).fill('x') }));
    if (mode === '429') return reply(res, 429, { error: { message: 'rate limit' } });
    if (mode === '401') return reply(res, 401, { error: { message: 'bad key' } });
    if (mode === '500-then-ok') return n === 1 ? reply(res, 500, { error: 'boom' }) : reply(res, 200, okBody(body.model, GOOD));
    if (mode === '500') return reply(res, 503, { error: 'down' });
    if (mode === 'slow') return setTimeout(() => reply(res, 200, okBody(body.model, GOOD)), 2500);
    if (mode === 'notjson') return reply(res, 200, { id: 'r', status: 'completed', output: [{ content: [{ type: 'output_text', text: 'I think it is a cat!' }] }], usage: { input_tokens: 10, output_tokens: 10 } });
    if (mode === 'cutoff') return reply(res, 200, { id: 'r', status: 'incomplete', output: [{ content: [{ type: 'output_text', text: '{"is_lego' }] }], usage: { input_tokens: 10, output_tokens: 4000 } });
    if (mode === 'first-model-missing') return body.model === 'muse-spark-1.3' ? reply(res, 404, { error: { message: 'model not found' } }) : reply(res, 200, okBody(body.model, GOOD));
    return reply(res, 500, {});
  });
}).listen(PORT);

const photoUrl = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'test/fixtures/3001-red.png')).toString('base64');
const run = async (m, extra) => { mode = m; seen = []; return an.analyze({ src: photoUrl, budget: budget(fileStore()), ...extra }); };
const fails = async (m, code) => { await assert.rejects(run(m), (e) => { assert.equal(e.code, code, `${m}: ${e.code} ${e.message}`); return true; }); };

console.log('client + DTO');
const r = await run('ok');
const req0 = seen[0];
assert.equal(req0.path, '/v1/responses');
assert.equal(req0.auth, 'Bearer test-key-not-real');
assert.equal(req0.body.model, 'muse-spark-1.3');
assert.equal(req0.body.reasoning.effort, 'low');
assert.equal(req0.body.text.format.type, 'json_schema');
assert.deepEqual(req0.body.text.format.schema.properties.possible_model_names.items.enum.sort(), ['cat', 'cottage', 'microduck']);
const img = req0.body.input[0].content.find((c) => c.type === 'input_image');
assert.match(img.image_url, /^data:image\/jpeg;base64,/);
assert.deepEqual(r.candidates.map((c) => c.name), ['cat']);
assert.equal(r.candidates[0].label, 'possible match');
assert.equal(r.analysis.source, 'meta-muse-spark-1.3');
assert.equal(r.provider.costUsd, (900 * 1.25 + 1000 * 4.25) / 1e6);
ok('request: Responses API, Bearer key, model, low effort, json_schema with server allowlist, JPEG data URL; cost from usage');
const nm = await run('nomatch');
assert.equal(nm.candidates.length, 0);
ok('no match -> no candidates (nothing picked at random)');
await fails('foreign', 'INVALID_MODEL_OUTPUT');
await fails('extra', 'INVALID_MODEL_OUTPUT');
const p = await run('paths');
assert.ok(!/\/etc\/passwd|https?:\/\//.test(JSON.stringify(p.analysis)), JSON.stringify(p.analysis));
assert.ok(!/\u0000/.test(p.analysis.uncertainties[0]));
ok('foreign model name and extra fields rejected; paths, links and control chars stripped from text');
const many = await run('many');
assert.equal(many.analysis.visible_colours.length, 16);
assert.equal(many.analysis.uncertainties.length, 6);
ok('long lists (a colourful pile) are truncated, not rejected');
const md = path.join(process.env.LEGO_DATA_DIR, 'models');
fs.mkdirSync(md, { recursive: true });
for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(md, `user${i}.json`), JSON.stringify({ title: 'U' + i, steps: [[{ id: '3001', color: 'red', at: [0, 0, 0] }]] }));
const names = an.candidates().map((c) => c.name);
assert.ok(['cat', 'microduck', 'cottage'].every((n) => names.includes(n)), 'built-ins dropped: ' + names.join(','));
assert.equal(names.length, 12);
for (let i = 0; i < 20; i++) fs.rmSync(path.join(md, `user${i}.json`));
ok('with 20 saved models the built-in cat/microduck stay in the candidate list (cap 12)');
// a PNG labelled image/jpeg (as iPhone HEIC uploads arrive mislabelled): the bytes decide
const mislabeled = await an.preparePhoto(photoUrl.replace('data:image/png', 'data:image/jpeg'));
assert.ok(mislabeled.width > 0);
ok('image type comes from the bytes, not the data: URL label');

console.log('errors');
await fails('429', 'QUOTA_EXCEEDED');
assert.equal(seen.length, 1, '429 is not retried');
await fails('401', 'META_UNAVAILABLE');
const retry = await run('500-then-ok');
assert.equal(retry.provider.attempts, 2);
await fails('500', 'META_UNAVAILABLE');
assert.equal(seen.length, 2, 'exactly one retry');
await fails('slow', 'META_UNAVAILABLE');
await fails('notjson', 'INVALID_MODEL_OUTPUT');
await fails('cutoff', 'INVALID_MODEL_OUTPUT');
await assert.rejects(an.analyze({ src: 'data:image/png;base64,AAAA' }), (e) => e.code === 'INVALID_IMAGE');
await assert.rejects(an.analyze({ src: 'http://127.0.0.1:22/x.png' }), (e) => e.code === 'INVALID_IMAGE' || e.code === 'META_UNAVAILABLE');
ok('429 no retry; 401; 5xx one retry; timeout; non-JSON and cut-off output; broken image');
const fb = await run('first-model-missing');
assert.equal(fb.provider.model, 'muse-spark-1.2');
assert.deepEqual(fb.provider.tried, ['muse-spark-1.3', 'muse-spark-1.2']);
await assert.rejects(run('ok', { model: 'gpt-x' }), (e) => e.code === 'MODEL_NOT_AVAILABLE');
ok('model switch: unavailable model falls through to the next in META_MODELS; unknown models refused');

console.log('budget');
fs.rmSync(process.env.META_BUDGET_FILE, { force: true });
process.env.META_BUDGET_USD = '0.03'; // worst case per call ~0.0201 (2500 in + 4000 out); real ~0.0054
await run('ok');
const st1 = await budget(fileStore()).status();
assert.equal(st1.calls, 1);
assert.ok(Math.abs(st1.spentUsd - 0.005375) < 1e-6, 'settled to the real cost: ' + st1.spentUsd);
await run('ok'); // 0.0054 + 0.0201 < 0.03 -> allowed, spent 0.0108
mode = 'ok'; seen = [];
await assert.rejects(an.analyze({ src: photoUrl, budget: budget(fileStore()) }), (e) => e.code === 'BUDGET_EXCEEDED');
assert.equal(seen.length, 0, 'no request sent once the cap would be crossed');
process.env.META_BUDGET_USD = '100';
process.env.META_DAILY_BUDGET_USD = '0.001';
await assert.rejects(run('ok'), (e) => e.code === 'BUDGET_EXCEEDED' && e.which === 'daily');
delete process.env.META_DAILY_BUDGET_USD;
ok('reserve worst case, settle to real usage; total and daily caps stop calls BEFORE sending');

console.log('mcp flow');
fs.rmSync(process.env.META_BUDGET_FILE, { force: true });
const client = new Client({ name: 'meta-test', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(ROOT, 'mcp/server.mjs')], env: { ...process.env }, stderr: 'ignore' }));
mode = 'ok';
const a1 = await client.callTool({ name: 'model_analyze_photo', arguments: { image: photoUrl, hint: 'a cat' } });
assert.equal(a1.structuredContent.kind, 'analysis');
assert.equal(a1.structuredContent.status, 'ok');
assert.deepEqual(a1.structuredContent.candidates.map((c) => c.name), ['cat']);
assert.match(a1.content[0].text, /Спроси пользователя/);
const d = await client.callTool({ name: 'model_disassemble', arguments: { name: a1.structuredContent.candidates[0].name, confirmed: true } });
assert.equal(d.structuredContent.disassembly.source, 'exact-model-json');
assert.equal(d.structuredContent.parts, 106);
ok('model_analyze_photo -> candidate "cat" (ask to confirm) -> model_disassemble on the confirmed name: exact 106 parts');
mode = '500';
const a2 = await client.callTool({ name: 'model_analyze_photo', arguments: { image: photoUrl } });
assert.equal(a2.structuredContent.status, 'unavailable');
assert.equal(a2.structuredContent.error, 'META_UNAVAILABLE');
assert.deepEqual(a2.structuredContent.known.map((k) => k.name).sort(), ['cat', 'cottage', 'microduck']);
assert.match(a2.content[0].text, /Ничего не придумывай/);
const still = await client.callTool({ name: 'model_disassemble', arguments: { name: 'microduck' } });
assert.ok(!still.isError);
ok('Meta down -> card says unavailable, offers known models; exact disassembly still works');
await client.close();

console.log('analytics');
const amp = await import('../api/_analytics.mjs');
const ev = (tool, args, sc) => amp.events({ userId: 'a0123456789abcdef01234567', msgs: [{ method: 'tools/call', params: { name: tool, arguments: args } }], client: 'claude', status: 200, ms: 900, payload: JSON.stringify({ result: { structuredContent: sc } }) });
const e1 = ev('model_analyze_photo', { image: photoUrl, hint: 'my secret cat' }, a1.structuredContent);
assert.deepEqual(e1.map((e) => e.event_type), ['tool_call', 'photo_model_analyzed']);
assert.equal(e1[1].event_properties.provider_model, 'muse-spark-1.3');
assert.equal(e1[1].event_properties.candidates, 1);
const e2 = ev('model_analyze_photo', { image: photoUrl }, a2.structuredContent);
assert.equal(e2[1].event_type, 'meta_request_failed');
assert.equal(e2[1].event_properties.error_code, 'META_UNAVAILABLE');
const e3 = ev('model_disassemble', { name: 'cat', confirmed: true }, d.structuredContent);
assert.ok(e3.some((e) => e.event_type === 'model_match_confirmed'));
const raw = JSON.stringify([...e1, ...e2, ...e3]);
for (const bad of ['base64', 'my secret cat', 'small orange cat', 'resp_mock', 'test-key-not-real', 'http']) assert.ok(!raw.includes(bad), 'leaked: ' + bad);
ok('photo_model_analyzed / meta_request_failed / model_match_confirmed; no photo, hint, AI text, response id, key or URLs');

srv.close();
console.log('all good');
