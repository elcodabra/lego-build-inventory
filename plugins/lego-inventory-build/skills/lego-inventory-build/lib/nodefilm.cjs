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
  const { film, canvas, ctx } = view(model, o.format);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const n = Math.round(film.duration * fps);
  const ff = spawn(ffmpegPath(), [
    '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${film.W}x${film.H}`, '-framerate', String(fps), '-i', '-',
    '-c:v', 'libx264', '-preset', o.preset || 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err += d; });
  const failed = new Promise((_, rej) => ff.on('error', (e) => rej(new Error('ffmpeg not found: ' + e.message))));
  for (let i = 0; i < n; i++) {
    film.draw(ctx, i / fps);
    const buf = Buffer.from(ctx.getImageData(0, 0, film.W, film.H).data.buffer);
    if (!ff.stdin.write(buf)) await Promise.race([new Promise((r) => ff.stdin.once('drain', r)), failed]);
    if (o.onProgress && i % 30 === 0) o.onProgress(i, n);
  }
  ff.stdin.end();
  const code = await Promise.race([new Promise((r) => ff.on('close', r)), failed]);
  if (code !== 0) throw new Error('ffmpeg failed: ' + err.trim());
  return { file: outFile, frames: n, seconds: film.duration };
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

module.exports = { snap, render, decode, frameTime, available: () => { try { canvasLib(); return true; } catch { return false; } } };
