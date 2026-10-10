// Chat videos: 720p / 24 fps (a third of the work of 1080p), downloads stay 1080p; a film is
// rendered once per model (videoCache) and a repeated «Видео» returns the same URL at once.
//   node test/video-fast.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-video-'));
process.env.LEGO_DATA_DIR = TMP; process.env.LEGO_INVENTORY = ''; process.env.LEGO_RENDERER = 'node';
const { buildServer } = await import('../mcp/tools.mjs');
const ok = (m) => console.log('  ok ', m);
const published = [];
const cacheMap = new Map();
const server = buildServer({
  publish: (f) => { published.push(f); return 'https://media.test/' + path.basename(f); },
  videoCache: { get: async (k) => cacheMap.get(k) || null, set: async (k, u) => { cacheMap.set(k, u); } },
});
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const c = new Client({ name: 'openai-mcp', version: '1.0.0' });
await c.connect(b);
const call = async (n, args) => { const r = await c.callTool({ name: n, arguments: args || {} }); assert.ok(!r.isError, n + ': ' + r.content[0].text); return r; };
await call('inventory_import', { data: 'part,color,qty\n3001,red,8\n3003,white,8\n3020,blue,6', replace: true });
await call('idea_build', { idea: 'house', allowMissing: true });

const dims = (f) => {
  // ffmpeg prints the input stream line; parse WxH and fps from it
  let out = '';
  try { execFileSync(require('ffmpeg-static'), ['-hide_banner', '-i', f], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { out = String(e.stderr); }
  const m = out.match(/, (\d+)x(\d+)[ ,].*?(\d+(?:\.\d+)?) fps/);
  return m ? { w: +m[1], h: +m[2], fps: +m[3] } : null;
};

// 1. chat video: 720p, 24 fps, rendered and published once
let t = Date.now();
const v1 = await call('show_build', { name: 'house', mode: 'video' });
const tChat = Date.now() - t;
const f1 = published.find((f) => f.endsWith('.mp4'));
const d1 = dims(f1);
assert.deepEqual([d1.w, d1.h, d1.fps], [720, 1280, 24], JSON.stringify(d1));
assert.equal(v1.structuredContent.videoUrl, 'https://media.test/' + path.basename(f1));
ok(`chat video ${d1.w}x${d1.h} @ ${d1.fps} fps in ${(tChat / 1000).toFixed(1)}s`);

// 2. the same again: from the cache, no new render
const nPub = published.length;
t = Date.now();
const v2 = await call('show_build', { name: 'house', mode: 'video' });
assert.equal(v2.structuredContent.videoUrl, v1.structuredContent.videoUrl);
assert.equal(published.filter((f) => f.endsWith('.mp4')).length, published.slice(0, nPub).filter((f) => f.endsWith('.mp4')).length, 'no second mp4 published');
ok(`repeated «Видео»: same URL from the cache in ${((Date.now() - t) / 1000).toFixed(1)}s`);

// 3. a changed model is a new film
await call('inventory_update', { items: [{ id: '3001', color: 'red', qty: 4 }] });
await call('idea_build', { idea: 'house', allowMissing: true });
const k = cacheMap.size;
await call('show_build', { name: 'house', mode: 'video' });
assert.ok(cacheMap.size >= k, 'cache keyed by model');

// 4. download (model_render): full 1080p / 30 fps
t = Date.now();
await call('model_render', { name: 'house' });
const tFull = Date.now() - t;
const f4 = published.filter((f) => f.endsWith('.mp4')).pop();
const d4 = dims(f4);
assert.deepEqual([d4.w, d4.h, d4.fps], [1080, 1920, 30], JSON.stringify(d4));
ok(`download video ${d4.w}x${d4.h} @ ${d4.fps} fps in ${(tFull / 1000).toFixed(1)}s (chat one: ${(tChat / 1000).toFixed(1)}s)`);

await c.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log('video checks passed');
