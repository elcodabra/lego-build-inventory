// YouTube copy of build videos, against a mock Google API (token endpoint + resumable upload):
// the film is uploaded once after the reply, with the right metadata and privacy, the card links
// to it next time, the daily cap holds, a failure is retried later, and analytics gets the event.
//   node test/youtube.mjs
import http from 'node:http';
import assert from 'node:assert/strict';

const calls = { token: 0, init: 0, put: 0 };
let uploads = [];
let failNext = false;
const g = http.createServer((q, s) => {
  let b = []; q.on('data', (d) => b.push(d)); q.on('end', () => {
    const body = Buffer.concat(b);
    if (q.url === '/token') { calls.token++; const f = new URLSearchParams(body.toString()); assert.equal(f.get('grant_type'), 'refresh_token'); assert.equal(f.get('refresh_token'), 'rt-test'); s.setHeader('content-type', 'application/json'); return s.end(JSON.stringify({ access_token: 'at-test', expires_in: 3600 })); }
    if (q.url.startsWith('/upload?')) {
      calls.init++;
      assert.equal(q.headers.authorization, 'Bearer at-test');
      assert.match(q.url, /uploadType=resumable/); assert.match(q.url, /notifySubscribers=false/);
      if (failNext) { failNext = false; s.statusCode = 403; return s.end('{"error":{"message":"quotaExceeded"}}'); }
      const meta = JSON.parse(body.toString());
      s.setHeader('location', `http://127.0.0.1:18896/session/${uploads.length}`);
      uploads.push({ meta, size: Number(q.headers['x-upload-content-length']) });
      return s.end();
    }
    if (q.url.startsWith('/session/')) {
      calls.put++;
      const i = Number(q.url.split('/').pop());
      assert.equal(body.length, uploads[i].size); assert.equal(q.headers['content-type'], 'video/mp4');
      s.setHeader('content-type', 'application/json');
      return s.end(JSON.stringify({ id: 'vid' + i, status: { privacyStatus: uploads[i].meta.status.privacyStatus } }));
    }
    s.statusCode = 404; s.end();
  });
}).listen(18896);
const amp = [];
const ampSrv = http.createServer((q, s) => { let b = ''; q.on('data', (d) => { b += d; }); q.on('end', () => { amp.push(...JSON.parse(b).events); s.end('{}'); }); }).listen(18895);

Object.assign(process.env, {
  VERCEL: '1', LEGO_MCP_TOKEN: 'owner-key-123',
  YOUTUBE_CLIENT_ID: 'cid', YOUTUBE_CLIENT_SECRET: 'csecret', YOUTUBE_REFRESH_TOKEN: 'rt-test', YOUTUBE_DAILY_MAX: '2',
  YOUTUBE_TOKEN_URL: 'http://127.0.0.1:18896/token', YOUTUBE_UPLOAD_URL: 'http://127.0.0.1:18896/upload',
  AMPLITUDE_API_KEY: 'k', AMPLITUDE_ENDPOINT: 'http://127.0.0.1:18895/2/httpapi',
});
for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'STATE_BLOB_TOKEN', 'MEDIA_BLOB_TOKEN', 'AUTH_ISSUER', 'LEGO_OPEN']) delete process.env[k];
const { default: handler } = await import(process.cwd() + '/api/mcp.mjs');
const srv = http.createServer((q, s) => { s.status = (c) => { s.statusCode = c; return s; }; s.json = (o) => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify(o)); }; handler(q, s); }).listen(18894);
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const c = new Client({ name: 'yt', version: '1' });
await c.connect(new StreamableHTTPClientTransport(new URL('http://localhost:18894/mcp?key=owner-key-123')));
const ok = (m) => console.log('  ok ', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f) => { for (let i = 0; i < 100 && !f(); i++) await sleep(100); };

await c.callTool({ name: 'inventory_import', arguments: { data: 'part,color,qty\n3001,red,10\n3003,white,12\n3039,red,8\n3004,white,10\n3022,white,4', replace: true } });
const s = JSON.parse((await c.callTool({ name: 'ideas_suggest', arguments: {} })).content[0].text);
const [a, b2, c3] = s.buildable.map((x) => x.idea);
for (const idea of [a, b2, c3]) await c.callTool({ name: 'idea_build', arguments: { idea } });

// 1. first video: rendered, card answers at once, upload happens after the reply
const v1 = await c.callTool({ name: 'show_build', arguments: { name: a, mode: 'video' } });
assert.equal(v1.structuredContent.youtubeUrl, null); ok('first render: card does not wait for YouTube');
await until(() => calls.put >= 1);
assert.equal(calls.put, 1);
const m = uploads[0].meta;
assert.equal(m.status.privacyStatus, 'unlisted'); assert.equal(m.snippet.categoryId, '26');
assert.match(m.snippet.title, /сборка LEGO/); assert.match(m.snippet.description, /trademark of the LEGO Group/);
ok(`uploaded after the reply: "${m.snippet.title}", ${uploads[0].size} bytes, unlisted, no subscriber ping`);

// 2. same film again: no second upload, the card now links to YouTube
const v1b = await c.callTool({ name: 'show_build', arguments: { name: a, mode: 'video' } });
assert.equal(v1b.structuredContent.youtubeUrl, 'https://youtu.be/vid0');
assert.match(v1b.content.map((x) => x.text || '').join(' '), /youtu\.be\/vid0/);
await sleep(500); assert.equal(calls.put, 1); ok('same film: no re-upload, card links to https://youtu.be/vid0');

// 3. a failed upload is not remembered (retried next time) and does not break the tool
failNext = true;
const v2 = await c.callTool({ name: 'show_build', arguments: { name: b2, mode: 'video' } });
assert.ok(!v2.isError && v2.structuredContent.videoUrl === null || !v2.isError); // tool fine (no media store in this test)
await until(() => calls.init >= 2); await sleep(300);
assert.equal(calls.put, 1); ok('YouTube error: tool still answers, nothing recorded');
await c.callTool({ name: 'show_build', arguments: { name: b2, mode: 'video' } });
await until(() => calls.put >= 2);
assert.equal(calls.put, 2); ok('retried on the next render and uploaded');

// 4. daily cap (2): the third distinct film is not uploaded today
await c.callTool({ name: 'show_build', arguments: { name: c3, mode: 'video' } });
await sleep(1500);
assert.equal(calls.put, 2); ok('daily cap respected (YOUTUBE_DAILY_MAX=2)');

// 5. analytics
await sleep(300);
const ev = amp.filter((e) => e.event_type === 'video_published');
assert.equal(ev.length, 2); assert.equal(ev[0].event_properties.target, 'youtube');
assert.ok(!JSON.stringify(amp).includes('vid0') && !JSON.stringify(amp).includes('rt-test')); ok('analytics: video_published x2, no video ids or tokens');
assert.equal(calls.token, 1); ok('one access-token refresh reused for all uploads');

await c.close(); srv.close(); g.close(); ampSrv.close();
console.log('youtube checks passed');
process.exit(0);
