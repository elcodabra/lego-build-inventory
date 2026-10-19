// Page colour of build films: light neutral tones that change from film to film, picked by the
// model title (same model -> same colour). Checks real rendered frames (corner pixel of a build
// frame and of the pile intro), that several titles land on several colours, that every colour is
// light and neutral with enough contrast for the dark text, and that the card gets the colour.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.LEGO_RENDERER = 'node';
global.window = global.window || global;
require('../src/lego.js');
require('../src/booklet.js');
const L = global.window.LEGO;
const { createCanvas } = require('@napi-rs/canvas');
const ok = (m) => console.log('  ok  ' + m);
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex) => { const c = rgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };

// 1. the palette: light, neutral (low saturation), dark text readable on each
for (const c of L.BACKGROUNDS) {
  const [r, g, b] = rgb(c);
  assert.ok(Math.min(r, g, b) >= 0xE8, c + ' is light');
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 12, c + ' is neutral');
  const contrast = (lum(c) + 0.05) / (lum('#1F2328') + 0.05);
  assert.ok(contrast > 12, c + ' contrast with the ink ' + contrast.toFixed(1));
}
ok(`${L.BACKGROUNDS.length} page colours, all light + neutral, ink contrast > 12:1`);

// 2. deterministic per title, and different titles alternate between colours
const titles = ['Spaceport', 'House', 'Tree', 'Rocket', 'Robot', 'Fire truck', 'Spaceship', 'Rover', 'Cat', 'Duck', 'Castle', 'Car'];
const picked = titles.map((t) => L.pageColor(t));
assert.deepEqual(titles.map((t) => L.pageColor(t)), picked, 'same title, same colour');
assert.ok(new Set(picked).size >= 4, 'colours vary across models: ' + new Set(picked).size);
ok(`12 titles -> ${new Set(picked).size} different page colours, stable per title`);

// 3. real frames: the build page and the pile intro are drawn on that colour
const model = { title: 'House', theta: 35, phi: 28, lang: 'en', steps: [[{ id: '3001', color: 'red', at: [0, 0, 0] }], [{ id: '3003', color: 'blue', at: [0, 0, 3] }]] };
const film = L.booklet(model, 'vertical', 'en');
assert.equal(film.bg, L.pageColor('House'));
const cv = createCanvas(film.W, film.H);
const ctx = cv.getContext('2d');
film.draw(ctx, 1.2);
const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
assert.deepEqual(px(5, film.H - 5), rgb(film.bg), 'build frame corner is the page colour');
// intro: a white cut-out (multiply) blends into the page instead of a white box
const img = createCanvas(200, 200); const ic = img.getContext('2d'); ic.fillStyle = '#fff'; ic.fillRect(0, 0, 200, 200); ic.fillStyle = '#c00'; ic.fillRect(80, 80, 40, 40);
const withPile = L.bookletWithPile(model, 'vertical', img, 'en');
withPile.draw(ctx, 1.2);
assert.deepEqual(px(5, film.H - 5), rgb(film.bg), 'intro corner is the page colour');
assert.deepEqual(px(film.W / 2, (850 + 1490) / 2 - 300), rgb(film.bg), 'white of the cut-out takes the page colour');
assert.equal(withPile.bg, film.bg);
// explicit bg overrides
assert.equal(L.booklet({ ...model, bg: '#F3F3F1' }, 'vertical', 'en').bg, '#F3F3F1');
ok(`rendered frames on ${film.bg}: build page, pile intro (cut-out white blends in), override works`);
console.log('background checks passed');
