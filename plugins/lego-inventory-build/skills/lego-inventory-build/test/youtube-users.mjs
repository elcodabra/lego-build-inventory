// Whose build films go to the YouTube channel (YOUTUBE_USERS), against a mock Google API:
//   node test/youtube-users.mjs          (runs itself twice: "owner" and "*")
// With "owner" (default) another user's film is not uploaded; with "*" every user's film is,
// the analytics event carries that user's id (not the owner's), and the card links to it later.
import http from 'node:http';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const ok = (m) => console.log('  ok ', m);
if (!process.env.YT_USERS_MODE) {
  for (const mode of ['owner', '*']) {
    const out = execFileSync(process.execPath, [new URL(import.meta.url).pathname], { env: { ...process.env, YT_USERS_MODE: mode }, encoding: 'utf8' });
    const m = out.match(/RESULT (\{.*\})/);
    assert.ok(m, out.slice(-600));
    const r = JSON.parse(m[1]);
    if (mode === 'owner') {
      assert.equal(r.uploads, 0);
      ok('YOUTUBE_USERS=owner: another user\'s film is not uploaded');
    } else {
      assert.equal(r.uploads, 1);
      assert.match(r.userId, /^u[0-9a-f]{12}$/);
      assert.equal(r.eventUser, r.userId);
      assert.equal(r.linkNextTime, 'https://youtu.be/vid0');
      ok(`YOUTUBE_USERS=*: another user's film is uploaded, video_published for that user (${r.userId.slice(0, 7)}…), card links to it next time`);
    }
  }
  console.log('youtube users checks passed');
  process.exit(0);
}

// ---- child: one mode
let puts = 0;
const g = http.createServer((q, s) => {
  const b = []; q.on('data', (d) => b.push(d)); q.on('end', () => {
    if (q.url === '/token') { s.setHeader('content-type', 'application/json'); return s.end('{"access_token":"at","expires_in":3600}'); }
    if (q.url.startsWith('/upload?')) { s.setHeader('location', 'http://127.0.0.1:18886/session/0'); return s.end(); }
    if (q.url.startsWith('/session/')) { puts++; s.setHeader('content-type', 'application/json'); return s.end('{"id":"vid0","status":{"privacyStatus":"unlisted"}}'); }
    s.statusCode = 404; s.end();
  });
}).listen(18886);
const amp = [];
const ampSrv = http.createServer((q, s) => { let b = ''; q.on('data', (d) => { b += d; }); q.on('end', () => { amp.push(...JSON.parse(b).events); s.end('{}'); }); }).listen(18885);
Object.assign(process.env, {
  VERCEL: '1', LEGO_MCP_TOKEN: 'owner-key-123', LEGO_OPEN: '1', YOUTUBE_USERS: process.env.YT_USERS_MODE,
  YOUTUBE_CLIENT_ID: 'cid', YOUTUBE_CLIENT_SECRET: 'cs', YOUTUBE_REFRESH_TOKEN: 'rt', YOUTUBE_DAILY_MAX: '6',
  YOUTUBE_TOKEN_URL: 'http://127.0.0.1:18886/token', YOUTUBE_UPLOAD_URL: 'http://127.0.0.1:18886/upload',
  AMPLITUDE_API_KEY: 'k', AMPLITUDE_ENDPOINT: 'http://127.0.0.1:18885/2/httpapi',
});
for (const k of ['STATE_BLOB_TOKEN', 'MEDIA_BLOB_TOKEN', 'AUTH_ISSUER', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) delete process.env[k];
const { default: handler } = await import(process.cwd() + '/api/mcp.mjs');
const srv = http.createServer((q, s) => { s.status = (c) => { s.statusCode = c; return s; }; s.json = (o) => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify(o)); }; handler(q, s); }).listen(18884);
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const key = 'Zz9-Usr' + Date.now().toString(36) + 'abcdefghijklmnop';
const c = new Client({ name: 'yt-users', version: '1' });
await c.connect(new StreamableHTTPClientTransport(new URL('http://localhost:18884/mcp?key=' + key)));
await c.callTool({ name: 'inventory_import', arguments: { data: 'part,color,qty\n3001,red,10\n3003,white,12\n3039,red,8\n3004,white,10\n3022,white,4', replace: true } });
const s = JSON.parse((await c.callTool({ name: 'ideas_suggest', arguments: {} })).content[0].text);
const idea = s.buildable[0].idea;
await c.callTool({ name: 'idea_build', arguments: { idea } });
await c.callTool({ name: 'show_build', arguments: { name: idea, mode: 'video' } });
for (let i = 0; i < 40 && !puts; i++) await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 400));
const again = await c.callTool({ name: 'show_build', arguments: { name: idea, mode: 'video' } });
const ev = amp.find((e) => e.event_type === 'video_published');
const crypto = await import('node:crypto');
// analytics id of an open key: "u" + 12 hex (api/mcp.mjs userId), never the key itself
const userId = 'u' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
console.log('RESULT ' + JSON.stringify({ uploads: puts, userId, eventUser: ev && ev.user_id, linkNextTime: again.structuredContent.youtubeUrl }));
await c.close(); srv.close(); g.close(); ampSrv.close();
process.exit(0);
