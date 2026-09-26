// Recognising parts from photos.
//
// Single part: Brickognize (https://brickognize.com, free public API) gives the part number;
// the colour is estimated from the pixels inside its bounding box (CIEDE2000 against the palette),
// because Brickognize's colour guess is unreliable for plain parts.
// A pile of parts: Brickognize only returns the most prominent part, so for piles the agent
// should look at the photo itself and write a CSV (see reference/photos.md). identify() reports
// that case with `pile: true` when the box covers little of the image.
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('./core.cjs');

const API = process.env.BRICKOGNIZE_URL || 'https://api.brickognize.com';

async function loadImage(src) {
  if (Buffer.isBuffer(src)) return { buf: src, mime: sniff(src) };
  const s = String(src);
  if (/^data:/.test(s)) {
    const m = s.match(/^data:([^;]+);base64,(.*)$/);
    return { buf: Buffer.from(m[2], 'base64'), mime: m[1] };
  }
  if (/^https?:\/\//.test(s)) {
    const r = await fetch(s);
    if (!r.ok) throw new Error(`cannot download ${s}: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return { buf, mime: r.headers.get('content-type') || sniff(buf) };
  }
  if (fs.existsSync(s)) { const buf = fs.readFileSync(s); return { buf, mime: sniff(buf), name: path.basename(s) }; }
  if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 100) { const buf = Buffer.from(s, 'base64'); return { buf, mime: sniff(buf) }; }
  throw new Error('image must be a file path, URL, data: URL or base64');
}

function sniff(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.slice(0, 4).toString() === 'RIFF') return 'image/webp';
  if (b.slice(4, 12).toString().includes('ftyp')) return 'image/heic';
  return 'application/octet-stream';
}

async function brickognize(img) {
  const fd = new FormData();
  const ext = (img.mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  fd.append('query_image', new Blob([img.buf], { type: img.mime }), 'photo.' + ext);
  const r = await fetch(API + '/predict/parts/?predict_color=true&top_k_items=3', { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`Brickognize ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ------------------------------------------------------------------ colour

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
function lab([r, g, b]) {
  const R = lin(r); const G = lin(g); const B = lin(b);
  let x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  let y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  let z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
// CIEDE2000
function de(l1, l2) {
  const [L1, a1, b1] = l1; const [L2, a2, b2] = l2;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1); const C2 = Math.hypot(a2, b2); const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G); const a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1); const C2p = Math.hypot(a2p, b2);
  const h = (a, b) => { const v = Math.atan2(b, a) / rad; return v < 0 ? v + 360 : v; };
  const h1 = h(a1p, b1); const h2 = h(a2p, b2);
  const dL = L2 - L1; const dC = C2p - C1p;
  let dh = h2 - h1; if (C1p * C2p === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * rad);
  const Lb = (L1 + L2) / 2; const Cbp = (C1p + C2p) / 2;
  let hb = h1 + h2; if (C1p * C2p !== 0) { if (Math.abs(h1 - h2) > 180) hb += h1 + h2 < 360 ? 360 : -360; hb /= 2; }
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const SC = 1 + 0.045 * Cbp; const SH = 1 + 0.015 * Cbp * T;
  const RT = -2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

// Rank palette colours for a set of pixel colours. Lit tops of LEGO parts are brighter than the
// catalogue colour and shadows darker, so each pixel is compared at a few exposures.
function rankColors(pixels) {
  const pal = Object.values(core.LEGO.COLORS).map((c) => ({ key: c.key, name: c.name, lab: lab(c.rgb) }));
  const votes = new Map();
  for (const p of pixels) {
    let best = null;
    for (const k of [1, 0.8, 1.2]) {
      const l = lab(p.map((v) => Math.min(255, v * k)));
      for (const c of pal) { const d = de(l, c.lab); if (!best || d < best.d) best = { key: c.key, d }; }
    }
    if (best.d < 25) votes.set(best.key, (votes.get(best.key) || 0) + 1);
  }
  const total = [...votes.values()].reduce((a, b) => a + b, 0) || 1;
  return [...votes].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([key, n]) => ({ color: key, share: +(n / total).toFixed(2) }));
}

// Pixels inside the box, without the background (pixels close to the border colour are dropped).
// Decoded with @napi-rs/canvas (no browser needed).
function foreground(d, W, H) {
  const px = (i, j) => { const o = 4 * (j * W + i); return [d[o], d[o + 1], d[o + 2]]; };
  const border = [];
  for (let i = 0; i < W; i++) border.push(px(i, 0), px(i, H - 1));
  for (let j = 0; j < H; j++) border.push(px(0, j), px(W - 1, j));
  const bg = [0, 1, 2].map((k) => border.map((p) => p[k]).sort((a, b) => a - b)[border.length >> 1]);
  const out = [];
  for (let j = Math.round(H * 0.15); j < H * 0.85; j++) {
    for (let i = Math.round(W * 0.15); i < W * 0.85; i++) {
      const p = px(i, j);
      if (Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]) > 40) out.push(p);
    }
  }
  return out;
}

async function boxPixels(img, box) {
  const { loadImage, createCanvas } = require('@napi-rs/canvas');
  const im = await loadImage(img.buf);
  const W = 96;
  const sx = box ? box.left : 0; const sy = box ? box.upper : 0;
  const sw = box ? box.right - box.left : im.width; const sh = box ? box.lower - box.upper : im.height;
  const H = Math.max(8, Math.round((W * sh) / sw));
  const c = createCanvas(W, H);
  const x = c.getContext('2d');
  x.drawImage(im, sx, sy, sw, sh, 0, 0, W, H);
  return foreground(x.getImageData(0, 0, W, H).data, W, H);
}

// Identify the most prominent part on a photo.
async function identify(src, opts) {
  const o = opts || {};
  const img = await loadImage(src);
  if (/heic|heif/.test(img.mime)) throw new Error('HEIC is not supported: export the photo as JPEG');
  const res = await brickognize(img);
  const box = res.bounding_box || null;
  const candidates = (res.items || []).slice(0, 3).map((it) => {
    const id = core.partId(it.id);
    return { id, name: it.name, score: +it.score.toFixed(2), drawable: core.drawable(id), bricklink: `https://www.bricklink.com/v2/catalog/catalogitem.page?P=${it.id}` };
  });
  // Colour: Brickognize's own prediction (BrickLink ids), cross-checked with the pixels.
  const bl = (res.colors || []).map((c) => ({ color: core.colorKey(c.id, 'bl') || core.colorKey(c.name), name: c.name, score: +(c.score || 0).toFixed(2) }));
  let pixels = [];
  if (!o.noColor) {
    try {
      const px = await boxPixels(img, box);
      if (px && px.length) pixels = rankColors(px);
    } catch { /* colour is a best effort */ }
  }
  const colors = [];
  for (const c of bl) {
    if (c.color && !colors.some((x) => x.color === c.color)) colors.push({ color: c.color, score: c.score, source: 'brickognize' });
  }
  for (const c of pixels) if (!colors.some((x) => x.color === c.color)) colors.push({ color: c.color, score: c.share, source: 'pixels' });
  const agree = colors[0] && pixels[0] && colors[0].color === pixels[0].color;
  const coverage = box ? ((box.right - box.left) * (box.lower - box.upper)) / (box.image_width * box.image_height) : 1;
  const top = candidates[0];
  return {
    part: top || null,
    color: colors[0] ? colors[0].color : null,
    candidates,
    colors: colors.slice(0, 4),
    confident: !!top && top.score >= 0.6 && !!colors[0] && !!colors[0].color && (colors[0].score >= 0.6 || !!agree),
    // a lone part often fills little of a phone photo, so small coverage alone is only a hint;
    // the caller (the model) sees the photo and decides whether it is a pile
    pile: coverage < 0.08,
    coverage: +coverage.toFixed(2),
    hint: coverage < 0.08 ? 'Only one part was recognised and it is tiny in the frame: if the photo shows many parts, read them yourself (lego_photo_guide) and use inventory_import.' : undefined,
  };
}

module.exports = { identify, rankColors, loadImage };
