// Open mode, quotas and analytics of the Vercel handler, locally (no Blob, a mock Amplitude):
//   node test/open-mode.mjs
import http from 'node:http';
import assert from 'node:assert/strict';

const sent = [];
const amp = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => { sent.push(JSON.parse(b)); res.end('{"code":200}'); });
}).listen(18779);

Object.assign(process.env, {
  VERCEL: '1', LEGO_MCP_TOKEN: 'owner-key-123', LEGO_OPEN: '1', LEGO_QUOTA_CALLS: '6', LEGO_QUOTA_VIDEO: '1',
  AMPLITUDE_API_KEY: 'test', AMPLITUDE_ENDPOINT: 'http://127.0.0.1:18779/2/httpapi',
});
const { default: handler } = await import(process.cwd() + '/api/mcp.mjs');
const srv = http.createServer((req, res) => {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  handler(req, res);
}).listen(18778);
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const connect = async (key, name = 'openai-mcp') => {
  const c = new Client({ name, version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:18778/mcp?key=${key}`), { requestInit: { headers: { 'user-agent': name + '/1.0.0' } } }));
  return c;
};
const ok = (m) => console.log('  ok ', m);
const post = (key) => fetch(`http://localhost:18778/mcp?key=${key}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });

// keys
assert.equal((await post('wrong')).status, 401); ok('short/wrong key refused');
assert.equal((await post('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status, 401); ok('low-entropy key refused');
assert.equal((await post('a<script>bcdefghijklmnopqrstuvwxyz')).status, 401); ok('key with odd characters refused');

// key page
const page = await (await fetch('http://localhost:18778/', { headers: { accept: 'text/html' } })).text();
const url = page.match(/value="([^"]+)"/)[1];
const key = new URL(url).searchParams.get('key');
assert.ok(key.length >= 24 && /^[A-Za-z0-9_-]+$/.test(key)); ok('key page hands out a key: ' + key.slice(0, 6) + '…');
const page2 = await (await fetch('http://localhost:18778/', { headers: { accept: 'text/html' } })).text();
assert.notEqual(page2.match(/value="([^"]+)"/)[1], url); ok('each visit gets a new key');

// two open users are isolated
const a = await connect(key);
const b = await connect('Zz9-' + 'qwertyuiopasdfghjklzxcvb' + Date.now().toString(36)); // fresh key per run: the daily quota is per key
await a.callTool({ name: 'inventory_import', arguments: { data: 'part,color,qty\n3001,red,10\n3003,white,8', replace: true } });
const bi = (await b.callTool({ name: 'inventory_show', arguments: {} })).content[0].text;
assert.ok(/empty/i.test(bi) && !bi.includes('3001')); ok('open users do not see each other\'s parts');

// quota: 6 calls per day for user a (1 used), video 1
const s = JSON.parse((await a.callTool({ name: 'ideas_suggest', arguments: {} })).content[0].text);
const idea = (s.buildable[0] || {}).idea || 'tower';
await a.callTool({ name: 'idea_build', arguments: { idea, allowMissing: true } });
const v1 = await a.callTool({ name: 'show_build', arguments: { name: idea, mode: 'video' } });
assert.ok(!v1.isError, 'first video allowed'); ok('first video allowed');
const v2 = await a.callTool({ name: 'show_build', arguments: { name: idea, mode: 'video' } });
assert.ok(v2.isError && /daily limit.*video/.test(v2.content[0].text)); ok('second video: ' + v2.content[0].text);
await a.callTool({ name: 'inventory_show', arguments: {} }); // 5
await a.callTool({ name: 'inventory_show', arguments: {} }); // 6
const over = await a.callTool({ name: 'inventory_show', arguments: {} });
assert.ok(over.isError && /daily limit.*tool calls/.test(over.content[0].text)); ok('7th call over the daily limit');

// owner has no quota
const o = await connect('owner-key-123', 'claude-ai');
for (let i = 0; i < 8; i++) assert.ok(!(await o.callTool({ name: 'lego_catalog', arguments: {} })).isError);
ok('owner key: no quota');

// analytics
await new Promise((r) => setTimeout(r, 300));
const evts = sent.flatMap((p) => p.events);
const types = evts.reduce((m, e) => ({ ...m, [e.event_type]: (m[e.event_type] || 0) + 1 }), {});
console.log('  amplitude events', JSON.stringify(types));
assert.ok(evts.every((e) => e.user_id && e.user_id.length >= 5)); ok('every event has a user id');
assert.ok(evts.some((e) => e.event_type === 'session_start' && e.event_properties.client === 'chatgpt')); ok('session_start with client=chatgpt');
assert.ok(evts.some((e) => e.event_type === 'tool_call' && e.event_properties.client === 'claude' && e.user_id === 'owner')); ok('owner calls tagged claude');
assert.ok(evts.some((e) => e.event_type === 'user_created')); ok('user_created on a new key');
const ib = evts.find((e) => e.event_properties.tool === 'idea_build');
assert.ok(ib && ib.event_properties.idea && ib.event_properties.parts > 0); ok(`idea_build facts: ${ib.event_properties.idea}, ${ib.event_properties.parts} parts`);
const is = evts.find((e) => e.event_properties.tool === 'ideas_suggest');
assert.ok(is && is.event_properties.top_idea === idea && is.event_properties.top_uses_percent > 0 && is.event_properties.drawable_parts === 18);
ok(`ideas_suggest facts: top ${is.event_properties.top_idea} uses ${is.event_properties.top_uses_percent}% of ${is.event_properties.drawable_parts} parts`);
assert.ok(evts.some((e) => e.event_properties.tool === 'show_build' && e.event_properties.status === 429)); ok('quota hits are tracked (429)');
const all = JSON.stringify(sent);
assert.ok(!all.includes(key) && !all.includes('owner-key-123')); ok('no key in analytics');
assert.ok(!all.includes('3001') && !all.includes('blob.vercel') && !all.includes('part,color')); ok('no part lists or media URLs in analytics');

// cleanup cron needs its secret
const { default: cleanup } = await import(process.cwd() + '/api/cleanup.mjs');
const fake = () => { const r = { code: 0, status(c) { r.code = c; return r; }, end() { return r; }, json() { return r; } }; return r; };
process.env.CRON_SECRET = 'cron-secret';
assert.equal((await cleanup({ headers: {} }, fake())).code, 401);
assert.equal((await cleanup({ headers: { authorization: 'Bearer nope' } }, fake())).code, 401); ok('cleanup cron refuses without CRON_SECRET');

await Promise.all([a.close(), b.close(), o.close()]);
srv.close(); amp.close();
console.log('open mode checks passed');
process.exit(0);
