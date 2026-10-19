// Build films open on the cleaned photo of the user's pile (table removed, parts in place):
//   node test/pile-intro.mjs
// Real segmentation of a real fixture photo; only part recognition (Brickognize) is mocked.
// Checks: the photo tool keeps the cleaned shot with the list; the video of a model made from
// that pile is longer by the intro and its first frames are the pile; a model the pile cannot
// make gets no intro; undo swaps the shot with its list, clear drops it; the hosted store keeps
// it; the film cache key changes with the shot.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-pile-intro-'));
process.env.LEGO_DATA_DIR = TMP;
process.env.LEGO_INVENTORY = '';
process.env.LEGO_RENDERER = 'node';
const photo = require('../lib/photo.cjs');
const core = require('../lib/core.cjs');
const nf = require('../lib/nodefilm.cjs');
const ok = (m) => console.log('  ok ', m);

// recognition mocked: every found part is a red 2x4 brick (enough for a red house-like model)
const realIdentify = photo.identify;
const fixture = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/pile-table-edge.jpg');
const realPile = photo.identifyPile;
photo.identifyPile = async (src) => {
  const seg = await realPile(fixture, { segmentOnly: true, withClean: true, max: 200 });
  return { found: seg.found, recognised: seg.found, parts: seg.boxes.map(() => ({})), clean: seg.clean,
    items: [{ id: '3001', color: 'red', qty: seg.found, name: 'Brick 2 x 4', unsure: 0 }] };
};
void realIdentify;

const films = new Map();
const { buildServer } = await import('../mcp/tools.mjs');
const server = buildServer({
  publish: async (f) => 'https://media.test/' + path.basename(f),
  videoCache: { get: async (k) => films.get(k) || null, set: async (k, u) => { films.set(k, u); } },
});
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const c = new Client({ name: 'openai-mcp', version: '1.0.0' });
await c.connect(b);
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args || {} });
  assert.ok(!r.isError, `${name}: ${r.content[0].text}`);
  return r;
};
const J = (r) => JSON.parse(r.content[0].text);
const pileFile = path.join(TMP, 'pile.json');

// 1. the photo tool keeps the cleaned shot with the list
await call('inventory_import', { data: 'part,color,qty\n3020,black,50', replace: true });
const r1 = J(await call('parts_from_pile_photo', { images: ['data:image/jpeg;base64,AAAA'] }));
assert.ok(r1.totalParts >= 30);
const pile = JSON.parse(fs.readFileSync(pileFile, 'utf8'));
assert.match(pile.image, /^data:image\/jpeg;base64,/);
const shotBytes = Buffer.from(pile.image.split(',')[1], 'base64').length;
assert.ok(shotBytes > 20_000 && shotBytes < 400_000, `cleaned shot ${shotBytes} bytes`);
ok(`photo -> list of ${r1.totalParts} parts + cleaned pile shot (${(shotBytes / 1024).toFixed(0)} KB) saved`);
// the cleaned shot is the pile on white: its border is (almost) pure white
{
  const im = await nf.decode(Buffer.from(pile.image.split(',')[1], 'base64'));
  const d = im.ctx.getImageData(0, 0, im.width, im.height).data;
  let edge = 0; let white = 0;
  for (let x = 0; x < im.width; x++) for (const y of [0, im.height - 1]) { edge++; const i = 4 * (y * im.width + x); if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++; }
  assert.ok(white / edge > 0.97, `border white ${(100 * white / edge).toFixed(1)}%`);
  ok(`table removed: ${(100 * white / edge).toFixed(1)}% of the shot's border is white`);
}

// 2. a model made from this pile: the film opens on the pile
const house = { title: 'Домик', steps: [[{ id: '3001', color: 'red', at: [0, 0, 0] }, { id: '3001', color: 'red', at: [4, 0, 0] }], [{ id: '3001', color: 'red', at: [2, 0, 3] }]] };
await call('model_save', { name: 'redhouse', model: house });
const v1 = await call('show_build', { name: 'redhouse', mode: 'video' });
assert.ok(v1.structuredContent.videoUrl);
const withIntro = { ...house, intro: pile.image };
assert.ok(Math.abs(core.duration(withIntro) - core.duration(house) - core.INTRO) < 1e-9);
const [f0, fEnd] = await nf.snap(withIntro, [1.2, 'final']);
const [p0, plainEnd] = await nf.snap(house, [1.2, 'final']);
// the intro frame is the photo: many coloured pixels, unlike the plain film at the same time
const colourful = async (png) => { const im = await nf.decode(png); const d = im.ctx.getImageData(0, 0, im.width, im.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 60 || d[i] + d[i + 1] + d[i + 2] < 150) n++; return n; };
const [cIntro, cPlain] = [await colourful(f0.png), await colourful(p0.png)];
assert.ok(!f0.png.equals(p0.png) && cIntro > 50_000, `intro frame shows the pile (${cIntro} parts pixels vs ${cPlain})`);
assert.ok(fEnd.png.equals(plainEnd.png), 'the build itself is unchanged, only shifted');
ok(`film from this pile: +${core.INTRO}s intro (${cIntro} pile pixels at 1.2 s), build frames identical to the plain film`);
assert.equal(v1.structuredContent.pileIntro, true);
{
  const { events } = await import('../api/_analytics.mjs');
  const ev = events({ userId: 'u1', msgs: [{ method: 'tools/call', params: { name: 'show_build', arguments: { name: 'redhouse', mode: 'video' } } }], ua: 'openai-mcp/1.0.0', client: 'chatgpt', status: 200, ms: 5, payload: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: v1.structuredContent, content: [] } }) });
  const p = ev[0].event_properties;
  assert.equal(p.pile_intro, true);
  assert.ok(!JSON.stringify(ev).includes('base64'), 'no image data in analytics');
  ok('amplitude tool_call: pile_intro=true, no image data in the payload');
}

// 3. a model the pile cannot make (blue parts): no intro, a different cache key
const blue = { title: 'Синий', steps: [[{ id: '3001', color: 'blue', at: [0, 0, 0] }]] };
await call('model_save', { name: 'bluething', model: blue });
assert.equal(core.pileFits(blue, pile), false);
assert.equal(core.pileFits(house, pile), true);
await call('show_build', { name: 'bluething', mode: 'video' });
assert.equal(films.size, 2);
ok('a model with parts not on the photo gets no intro ("from this pile" stays true)');

// 4. undo swaps the shot with its list; a second undo brings it back; clear drops it
await call('inventory_undo');
assert.ok(!fs.existsSync(pileFile), 'the old typed list had no photo');
await call('inventory_undo');
assert.equal(JSON.parse(fs.readFileSync(pileFile, 'utf8')).image, pile.image);
ok('inventory_undo swaps the pile shot together with its list');
await call('inventory_clear');
assert.ok(!fs.existsSync(pileFile));
ok('inventory_clear drops the pile shot');

// 5. same film key twice (cached), a new shot -> new key
await call('parts_from_pile_photo', { images: ['data:image/jpeg;base64,AAAA'] });
const before = films.size;
await call('show_build', { name: 'redhouse', mode: 'video' });
assert.equal(films.size, before, 'same pile shot + model -> cached film');
ok('re-showing the same film hits the cache (key includes the shot)');
await c.close();

// 6. the hosted store keeps pile.json with the user state
{
  delete process.env.KV_REST_API_URL; delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.STATE_BLOB_TOKEN;
  const store = await import('../api/_store.mjs');
  if (store.backend === 'local') {
    const user = 'test-pile-' + Date.now();
    const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'pl1-')); fs.mkdirSync(d1 + '/models');
    const v = await store.load(user, d1);
    fs.copyFileSync(pileFile, d1 + '/pile.json');
    await store.save(user, d1, v);
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pl2-')); fs.mkdirSync(d2 + '/models');
    await store.load(user, d2);
    assert.equal(fs.readFileSync(d2 + '/pile.json', 'utf8'), fs.readFileSync(pileFile, 'utf8'));
    ok('the store saves and loads pile.json');
    fs.rmSync(path.join('/tmp/lego/_store', user), { recursive: true, force: true });
  } else console.log('  skip store roundtrip (backend ' + store.backend + ')');
}
// 7. films are English: a Russian-titled model gets an English (or transliterated) title, and the
// booklet's own captions switch with lang
{
  const ideas = require('../lib/ideas.cjs');
  assert.equal(ideas.titleEn('Пожарная машина'), 'Fire truck');
  assert.equal(ideas.titleEn('Мой замок'), 'Moy zamok');
  for (const [id, g] of Object.entries(ideas.GENERATORS)) assert.ok(!/[а-яё]/i.test(ideas.titleEn(g.title)), `${id} has an English title`);
  global.window = global.window || global; require('../src/booklet.js');
  const texts = [];
  const { createCanvas } = require('@napi-rs/canvas');
  const cv = createCanvas(1080, 1920);
  const ctx = cv.getContext('2d');
  const realFill = ctx.fillText.bind(ctx);
  ctx.fillText = (s, ...rest) => { texts.push(String(s)); return realFill(s, ...rest); };
  const fm = { ...house, title: ideas.titleEn(house.title), lang: 'en' };
  const f = global.window.LEGO.booklet(fm, 'vertical', 'en');
  for (const t of [0.2, 1, f.duration - 0.3]) f.draw(ctx, t);
  const all = texts.join(' | ');
  assert.ok(!/[а-яё]/i.test(all), 'no Cyrillic in an English film: ' + all.slice(0, 200));
  assert.match(all, /3 parts · 2 steps/); assert.match(all, /Drawn with code/);
  ok(`English film: "${[...new Set(texts)].slice(-3).join('" "')}", no Cyrillic; idea titles all English`);
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log('pile intro checks passed');
