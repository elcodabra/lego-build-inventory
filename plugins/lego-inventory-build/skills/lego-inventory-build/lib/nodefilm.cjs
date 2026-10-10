// Rendering without a browser: the same Canvas 2D engine on @napi-rs/canvas (Skia).
// Used on serverless hosts (Vercel) where Chromium is not available, or with LEGO_RENDERER=node.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./core.cjs');

let napi = null;
function canvasLib() {
  if (napi) return napi;
  napi = require('@napi-rs/canvas');
  const dir = path.join(core.ROOT, 'assets/fonts');
  // booklet.js asks for "Helvetica Neue", Helvetica, Arial: register Inter under the first name,
  // latin and cyrillic subsets together so both scripts render.
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (f.endsWith('.ttf')) napi.GlobalFonts.registerFromPath(path.join(dir, f), 'Inter');
  }
  return napi;
}

// booklet.js reads LEGO from the global it was loaded into.
let booklet = null;
function loadBooklet() {
  if (!booklet) {
    global.window = global.window || global;
    require(path.join(core.ROOT, 'src/booklet.js'));
    booklet = global.window.LEGO.booklet;
  }
  return booklet;
}

function view(model, format) {
  const { createCanvas } = canvasLib();
  const film = loadBooklet()({ title: model.title, theta: model.theta, phi: model.phi, step: model.step, steps: model.steps }, format || 'vertical');
  const canvas = createCanvas(film.W, film.H);
  return { film, canvas, ctx: canvas.getContext('2d') };
}

const frameTime = (model, t) => {
  if (t === 'final' || t == null) return core.duration(model) - 0.5;
  const n = Number(t);
  return n < 0 ? core.duration(model) + n : n;
};

async function snap(model, times, format) {
  const { film, canvas, ctx } = view(model, format);
  return times.map((t) => {
    const tt = frameTime(model, t);
    film.draw(ctx, tt);
    return { t: tt, png: canvas.toBuffer('image/png') };
  });
}

function ffmpegPath() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; }
}

async function render(model, outFile, opts) {
  const o = opts || {};
  const fps = o.fps || 30;
  const { film } = view(model, o.format);
  // scale < 1: the same layout drawn smaller (a chat card shows the film at ~400 px wide, so
  // 720p looks the same there and costs about half the CPU of 1080p)
  const k = o.scale && o.scale > 0 && o.scale < 1 ? o.scale : 1;
  const W = Math.round((film.W * k) / 2) * 2;
  const H = Math.round((film.H * k) / 2) * 2;
  const { createCanvas } = canvasLib();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const n = Math.round(film.duration * fps);
  const ff = spawn(ffmpegPath(), [
    '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-framerate', String(fps), '-i', '-',
    '-c:v', 'libx264', '-preset', o.preset || 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err += d; });
  const failed = new Promise((_, rej) => ff.on('error', (e) => rej(new Error('ffmpeg not found: ' + e.message))));
  let drawMs = 0;
  for (let i = 0; i < n; i++) {
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const td = Date.now();
    film.draw(ctx, i / fps);
    drawMs += Date.now() - td;
    // canvas.data() is the raw RGBA buffer without the getImageData copy
    const buf = typeof canvas.data === 'function' ? Buffer.from(canvas.data()) : Buffer.from(ctx.getImageData(0, 0, W, H).data.buffer);
    if (!ff.stdin.write(buf)) await Promise.race([new Promise((r) => ff.stdin.once('drain', r)), failed]);
    if (o.onProgress && i % 30 === 0) o.onProgress(i, n);
  }
  ff.stdin.end();
  const code = await Promise.race([new Promise((r) => ff.on('close', r)), failed]);
  if (code !== 0) throw new Error('ffmpeg failed: ' + err.trim());
  return { file: outFile, frames: n, seconds: film.duration, width: W, height: H, drawMs };
}

// Decode an image into RGBA pixels (for photo colour estimation).
async function decode(buf) {
  const { loadImage, createCanvas } = canvasLib();
  const im = await loadImage(buf);
  const c = createCanvas(im.width, im.height);
  const x = c.getContext('2d');
  x.drawImage(im, 0, 0);
  return { width: im.width, height: im.height, canvas: c, ctx: x, image: im };
}

// The model alone, centred on a square (for chat cards). upto = number of steps to draw (default
// all); with upto, earlier steps are pale and the parts of the last step get the yellow outline,
// like in the booklet. The camera frames the whole finished model, so all step pictures line up.
async function hero(model, opts) {
  const o = opts || {};
  // trim: render at twice the size, crop to the drawn pixels (scenes spread along a diagonal
  // leave a lot of empty frame otherwise), square it with a small margin and scale back down
  if (o.trim) {
    const S0 = o.size || 900;
    const { createCanvas, loadImage } = canvasLib();
    const big = await loadImage(await hero(model, { ...o, trim: false, size: S0 * 2 }));
    const bc = createCanvas(big.width, big.height);
    const bx = bc.getContext('2d');
    bx.drawImage(big, 0, 0);
    const px = bx.getImageData(0, 0, big.width, big.height).data;
    let x0 = big.width; let y0 = big.height; let x1 = -1; let y1 = -1;
    for (let y = 0; y < big.height; y++) for (let x = 0; x < big.width; x++) {
      const i = 4 * (y * big.width + x);
      if (px[i] < 245 || px[i + 1] < 245 || px[i + 2] < 245) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return hero(model, { ...o, trim: false });
    const side = Math.round(Math.max(x1 - x0, y1 - y0) * 1.08) + 2;
    const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2;
    const out = createCanvas(S0, S0);
    const ox = out.getContext('2d');
    ox.fillStyle = o.background || '#ffffff';
    ox.fillRect(0, 0, S0, S0);
    ox.drawImage(big, cx - side / 2, cy - side / 2, side, side, 0, 0, S0, S0);
    return out.toBuffer('image/png');
  }
  const S = o.size || 900;
  const { createCanvas } = canvasLib();
  loadBooklet();
  const L = global.window.LEGO;
  const all = model.steps.flat().map((s) => L.place(s));
  const theta = model.theta == null ? 40 : model.theta;
  const phi = model.phi == null ? 30 : model.phi;
  const b = L.bounds(all);
  const e = L.extent(b, theta, phi);
  const scale = (S * 0.82) / Math.max(e.w, e.h);
  const c = createCanvas(S, S);
  const x = c.getContext('2d');
  x.fillStyle = o.background || '#ffffff';
  x.fillRect(0, 0, S, S);
  const cam = L.camera({ theta, phi, scale, cx: S / 2, cy: S / 2, target: b.center });
  const n = o.upto == null ? model.steps.length : o.upto;
  const items = [];
  model.steps.slice(0, n).forEach((st, k) => {
    const last = o.upto != null && k === n - 1;
    for (const spec of st) items.push({ part: L.place(spec), pale: o.upto != null && !last ? 0.45 : 0, halo: last ? 1 : 0 });
  });
  L.draw(x, items, cam, { lineWidth: Math.max(1.5, scale * 0.03) });
  if (o.upto != null) {
    x.fillStyle = '#1f2328';
    x.font = `bold ${Math.round(S * 0.09)}px Inter`;
    x.fillText(String(n), S * 0.05, S * 0.12);
  }
  return c.toBuffer('image/png');
}

module.exports = { snap, render, decode, hero, frameTime, available: () => { try { canvasLib(); return true; } catch { return false; } } };
