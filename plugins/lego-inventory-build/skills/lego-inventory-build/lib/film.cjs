// Rendering: frames to PNG and whole films to mp4, through headless Chromium (Playwright)
// running index.html. Shared by tools/snap.cjs, tools/render.cjs and the MCP server.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { ROOT, duration } = require('./core.cjs');

let browserP = null;
async function browser() {
  if (!browserP) {
    let chromium;
    try {
      ({ chromium } = require('playwright'));
    } catch {
      throw new Error('playwright is not installed: run `npm install && npx playwright install chromium` in ' + ROOT);
    }
    browserP = chromium.launch().catch((e) => {
      browserP = null;
      throw new Error('cannot start Chromium (' + e.message.split('\n')[0] + '). Run `npx playwright install chromium`.');
    });
  }
  return browserP;
}

async function close() {
  if (browserP) {
    const b = await browserP.catch(() => null);
    browserP = null;
    if (b) await b.close();
  }
}

async function page(model, format) {
  const b = await browser();
  const p = await b.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?render=1');
  await p.waitForFunction(() => window.READY === true);
  const info = await p.evaluate(([m, f]) => window.show(m, f), [model === 'parts' ? 'parts' : strip(model), format || 'vertical']);
  if (errors.length) throw new Error('page error: ' + errors.join('; '));
  return { p, info };
}

// Only what the engine needs, so the model survives structured cloning.
const strip = (m) => JSON.parse(JSON.stringify({ title: m.title, theta: m.theta, phi: m.phi, step: m.step, steps: m.steps }));

const frameTime = (model, t) => {
  if (t === 'final' || t == null) return duration(model) - 0.5;
  const n = Number(t);
  return n < 0 ? duration(model) + n : n;
};

// Frames as PNG buffers. times: numbers in seconds, negative from the end, or 'final'.
async function snapChromium(model, times, format) {
  const { p } = await page(model, format);
  try {
    const out = [];
    for (const t of times) {
      const tt = model === 'parts' ? 0 : frameTime(model, t);
      const b64 = await p.evaluate((x) => { window.drawAt(x); return window.CANVAS.toDataURL('image/png').slice(22); }, tt);
      out.push({ t: tt, png: Buffer.from(b64, 'base64') });
    }
    return out;
  } finally {
    await p.close();
  }
}

async function renderChromium(model, outFile, opts) {
  const o = opts || {};
  const fps = o.fps || 30;
  const { p, info } = await page(model, o.format);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const n = Math.round(info.duration * fps);
  const ff = spawn(process.env.FFMPEG || 'ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let ffErr = '';
  ff.stderr.on('data', (d) => { ffErr += d; });
  const spawnErr = new Promise((_, rej) => ff.on('error', (e) => rej(new Error('ffmpeg not found (install it or set FFMPEG): ' + e.message))));
  try {
    for (let i = 0; i < n; i++) {
      const b64 = await p.evaluate((t) => { window.drawAt(t); return window.CANVAS.toDataURL('image/png').slice(22); }, i / fps);
      if (!ff.stdin.write(Buffer.from(b64, 'base64'))) await Promise.race([new Promise((r) => ff.stdin.once('drain', r)), spawnErr]);
      if (o.onProgress && i % 30 === 0) o.onProgress(i, n);
    }
    ff.stdin.end();
    const code = await Promise.race([new Promise((r) => ff.on('close', r)), spawnErr]);
    if (code !== 0) throw new Error('ffmpeg failed: ' + ffErr.trim());
  } finally {
    await p.close();
  }
  return { file: outFile, frames: n, seconds: info.duration };
}

// Backend: Chromium (Playwright) when it is there, else Skia (@napi-rs/canvas, no browser, works on
// Vercel). LEGO_RENDERER=node|chromium forces one. The parts sheet needs Chromium.
function useNode(model) {
  const want = process.env.LEGO_RENDERER;
  if (want === 'chromium' || model === 'parts') return false;
  if (want === 'node') return true;
  try { require.resolve('playwright'); } catch { return true; }
  return false;
}
async function snap(model, times, format) {
  if (useNode(model)) return require('./nodefilm.cjs').snap(model, times, format);
  try { return await snapChromium(model, times, format); } catch (e) {
    if (!/Chromium|playwright/i.test(e.message) || !require('./nodefilm.cjs').available()) throw e;
    return require('./nodefilm.cjs').snap(model, times, format);
  }
}
async function render(model, outFile, opts) {
  if (useNode(model)) return require('./nodefilm.cjs').render(model, outFile, opts);
  try { return await renderChromium(model, outFile, opts); } catch (e) {
    if (!/Chromium|playwright/i.test(e.message) || !require('./nodefilm.cjs').available()) throw e;
    return require('./nodefilm.cjs').render(model, outFile, opts);
  }
}

module.exports = { snap, render, close, frameTime, browserFor: browser };
