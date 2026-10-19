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
      // the real API answers 400 INVALID to defaultAudioLanguage 'zxx' (seen in production)
      if (meta.snippet && meta.snippet.defaultAudioLanguage === 'zxx') { s.statusCode = 400; return s.end('{"error":{"message":"Request contains an invalid argument."}}'); }
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
for (const k of ['STATE_BLOB_TOKEN', 'MEDIA_BLOB_TOKEN', 'AUTH_ISSUER', 'LEGO_OPEN']) delete process.env[k];
// with KV_REST_API_URL set, runs against real Upstash Redis under a throwaway prefix (cleaned up below)
const prefix = 'legoyt' + Date.now().toString(36);
if (process.env.KV_REST_API_URL) process.env.LEGO_REDIS_PREFIX = prefix; else { delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; }
console.log('  store:', process.env.KV_REST_API_URL ? 'Upstash Redis, prefix ' + prefix : 'in memory');
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
assert.match(m.snippet.title, /^How to build a LEGO .+ from \d+ bricks/); assert.match(m.snippet.description, /trademark of the LEGO Group/);
assert.ok(!/[а-яё]/i.test(m.snippet.title + m.snippet.description + m.snippet.tags.join(' ')), 'YouTube metadata is English only: ' + m.snippet.title);
assert.equal(m.snippet.defaultLanguage, 'en');
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

// 6. film served from the render cache (no mp4 to hash): the card still links to YouTube,
// found by the film key (regression: production renders hit the cache on the second press)
{
  const yt = await import(process.cwd() + '/api/_youtube.mjs');
  const core = (await import('node:module')).createRequire(import.meta.url)('../lib/core.cjs');
  const os = await import('node:os'); const fsm = await import('node:fs'); const pth = await import('node:path');
  const dir = fsm.mkdtempSync(pth.join(os.tmpdir(), 'ytc-'));
  fsm.mkdirSync(pth.join(dir, 'models')); fsm.mkdirSync(pth.join(dir, 'exports'));
  const films = new Map();
  let lastKey = null;
  const { buildServer } = await import(process.cwd() + '/mcp/tools.mjs');
  await core.ctx.run({ dataDir: dir, safe: true, renderer: 'node' }, async () => {
    const opts = {
      publish: async (f) => 'https://media.test/' + pth.basename(f),
      videoCache: { get: async (k) => films.get(k) || null, set: async (k, u) => { films.set(k, u); } },
      onVideo: async (file, meta) => { lastKey = meta.key; await yt.linkFilm(meta.key, { id: 'vidC', url: 'https://youtu.be/vidC' }); return null; },
      youtubeForFilm: async (k) => { const v = await yt.knownFilm(k); return v ? v.url : null; },
    };
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const srv2 = buildServer(opts);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await srv2.connect(st);
    const c2 = new Client({ name: 'ytc', version: '1' }); await c2.connect(ct);
    await c2.callTool({ name: 'inventory_import', arguments: { data: 'part,color,qty\n3001,red,10\n3003,white,12\n3039,red,8\n3004,white,10\n3022,white,4', replace: true } });
    await c2.callTool({ name: 'idea_build', arguments: { idea: a } });
    const r1 = await c2.callTool({ name: 'show_build', arguments: { name: a, mode: 'video' } });
    assert.ok(lastKey, 'onVideo got the film key');
    assert.equal(r1.structuredContent.youtubeUrl, null);
    const r2 = await c2.callTool({ name: 'show_build', arguments: { name: a, mode: 'video' } });
    assert.equal(films.size, 1, 'second call served from the film cache');
    assert.equal(r2.structuredContent.youtubeUrl, 'https://youtu.be/vidC');
    await c2.close();
  });
  fsm.rmSync(dir, { recursive: true, force: true });
  ok('cached film (no re-render): card links to YouTube via the film key');
}

// 6b. the first upload of a film failed (e.g. a 400 from YouTube) and the film is now served from
// the cache: the cached mp4 is fetched and offered for upload again (regression, prod 2026-10-19)
{
  const http = await import('node:http');
  const os = await import('node:os'); const fsm = await import('node:fs'); const pth = await import('node:path');
  const core = (await import('node:module')).createRequire(import.meta.url)('../lib/core.cjs');
  const dir = fsm.mkdtempSync(pth.join(os.tmpdir(), 'ytr-'));
  fsm.mkdirSync(pth.join(dir, 'models')); fsm.mkdirSync(pth.join(dir, 'exports'));
  const media = new Map();
  const ms = http.createServer((q, s) => { const b = media.get(q.url.slice(1)); if (!b) { s.statusCode = 404; return s.end(); } s.end(b); });
  await new Promise((r) => ms.listen(0, '127.0.0.1', r));
  const films = new Map();
  const offered = [];
  let linked = null;
  const { buildServer } = await import(process.cwd() + '/mcp/tools.mjs');
  await core.ctx.run({ dataDir: dir, safe: true, renderer: 'node' }, async () => {
    const opts = {
      publish: async (f) => { media.set(pth.basename(f), fsm.readFileSync(f)); return `http://127.0.0.1:${ms.address().port}/${pth.basename(f)}`; },
      videoCache: { get: async (k) => films.get(k) || null, set: async (k, u) => { films.set(k, u); } },
      // first offer: the upload fails (nothing linked); second offer: it succeeds
      onVideo: async (file, meta) => { offered.push({ bytes: fsm.statSync(file).size, key: meta.key, title: meta.title }); if (offered.length > 1) linked = 'https://youtu.be/vidR'; return null; },
      youtubeForFilm: async () => linked,
    };
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const srv3 = buildServer(opts);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await srv3.connect(st);
    const c3 = new Client({ name: 'ytr', version: '1' }); await c3.connect(ct);
    await c3.callTool({ name: 'inventory_import', arguments: { data: 'part,color,qty\n3001,red,10\n3003,white,12\n3039,red,8\n3004,white,10\n3022,white,4', replace: true } });
    await c3.callTool({ name: 'idea_build', arguments: { idea: a } });
    await c3.callTool({ name: 'show_build', arguments: { name: a, mode: 'video' } });
    const r2 = await c3.callTool({ name: 'show_build', arguments: { name: a, mode: 'video' } });
    assert.equal(films.size, 1, 'second call served from the film cache');
    assert.equal(offered.length, 2, 'cached film without a YouTube copy is offered again');
    assert.equal(offered[1].bytes, offered[0].bytes, 'the re-offered file is the cached mp4');
    assert.equal(offered[1].key, offered[0].key);
    assert.equal(r2.structuredContent.youtubeUrl, null);
    const r3 = await c3.callTool({ name: 'show_build', arguments: { name: a, mode: 'video' } });
    assert.equal(offered.length, 2, 'linked film: not offered a third time');
    assert.equal(r3.structuredContent.youtubeUrl, 'https://youtu.be/vidR');
    assert.deepEqual(fsm.readdirSync(pth.join(dir, 'exports')).filter((f) => f.includes('-cached-')), [], 'temp copy removed');
    await c3.close();
  });
  ms.close();
  fsm.rmSync(dir, { recursive: true, force: true });
  ok('failed upload: the cached film is re-offered, then linked');
}

// 6c. the daily cron checks that the OAuth client still mints tokens (a disabled secret shows up as
// youtube_token_error in the logs, before users' uploads fail)
{
  const yt = await import(process.cwd() + '/api/_youtube.mjs');
  const before = calls.token;
  assert.deepEqual(await yt.checkToken(), { youtube: 'ok' });
  assert.equal(calls.token, before + 1, 'health check refreshes the token for real (no cached token)');
  process.env.CRON_SECRET = 'cron-test'; delete process.env.MEDIA_BLOB_TOKEN;
  const logs = []; const log0 = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
  const res = { code: 0, status(c) { this.code = c; return this; }, json() { return this; }, end() { return this; } };
  try { await (await import(process.cwd() + '/api/cleanup.mjs')).default({ headers: { authorization: 'Bearer cron-test' } }, res); } finally { console.log = log0; }
  assert.equal(res.code, 200);
  assert.ok(logs.some((l) => l.includes('"ev":"youtube_token"') && l.includes('"youtube":"ok"')), 'cron logs the token check');
  assert.ok(!logs.join('').includes('csecret') && !logs.join('').includes('rt-test') && !logs.join('').includes('at-test'), 'no secrets in logs');
  ok('cron: OAuth token health check logged, no secrets');
}

// 7. concurrent renders of one new film: exactly one upload (the claim is atomic)
if (process.env.KV_REST_API_URL) {
  const store = await import(process.cwd() + '/api/_store.mjs');
  const r = await Promise.all(Array.from({ length: 8 }, () => store.claimYoutubeSlot('race-sha', 1000)));
  assert.equal(r.filter(Boolean).length, 1); ok('8 parallel claims of one film in Redis: exactly 1 wins');
  // cleanup the throwaway prefix
  const kv = (cmd) => fetch(process.env.KV_REST_API_URL, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN }, body: JSON.stringify(cmd) }).then((x) => x.json()).then((x) => x.result);
  let cur = '0', n = 0;
  do { const [next, keys] = await kv(['SCAN', cur, 'MATCH', prefix + ':*', 'COUNT', '200']); cur = next; if (keys.length) { await kv(['DEL', ...keys]); n += keys.length; } } while (cur !== '0');
  ok(`cleaned ${n} test keys`);
}

await c.close(); srv.close(); g.close(); ampSrv.close();
console.log('youtube checks passed');
process.exit(0);
