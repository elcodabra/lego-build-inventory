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
const MAX_BYTES = 15 * 1024 * 1024; // photos bigger than this are refused
const MAX_PIXELS = 40e6; // decoded size limit (decompression bombs)
const safeMode = () => core.safeMode();

// On a server (LEGO_SAFE_NAMES=1) only https URLs to public hosts, data: URLs and base64 are
// accepted: no local files, no http, no private/loopback/link-local addresses (SSRF).
const dns = require('dns').promises;
const net = require('net');
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}
async function assertPublicUrl(u) {
  const url = new URL(u);
  if (url.protocol !== 'https:') throw new Error('only https image URLs are accepted');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(privateIp)) throw new Error('image host is not allowed');
}

async function download(u, hops = 0) {
  if (safeMode()) await assertPublicUrl(u);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(u, { signal: ctl.signal, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      if (hops > 3) throw new Error('too many redirects');
      return download(new URL(r.headers.get('location'), u).href, hops + 1);
    }
    if (!r.ok) throw new Error(`cannot download the image: HTTP ${r.status}`);
    if (Number(r.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('image is too large (max 15 MB)');
    const chunks = [];
    let size = 0;
    for await (const ch of r.body) {
      size += ch.length;
      if (size > MAX_BYTES) throw new Error('image is too large (max 15 MB)');
      chunks.push(ch);
    }
    const buf = Buffer.concat(chunks);
    return { buf, mime: sniff(buf) !== 'application/octet-stream' ? sniff(buf) : (r.headers.get('content-type') || '').split(';')[0] };
  } finally {
    clearTimeout(timer);
  }
}

async function loadImage(src) {
  const out = await loadImageRaw(src);
  if (out.buf.length > MAX_BYTES) throw new Error('image is too large (max 15 MB)');
  if (/heic|heif/.test(out.mime)) return heicToJpeg(out);
  if (!/^image\//.test(out.mime)) throw new Error('not an image (JPEG, PNG or WebP expected)');
  const dim = dimensions(out.buf);
  if (dim && dim.w * dim.h > MAX_PIXELS) throw new Error(`image is too large (${dim.w}×${dim.h}, max 40 megapixels)`);
  return out;
}

// iPhone photos are HEIC. Decode with libheif (wasm, via heic-decode) and re-encode as JPEG so
// the rest of the pipeline (canvas, Brickognize) sees an ordinary image. The pixel cap is
// checked on the decoded size before any canvas work.
async function heicToJpeg(img) {
  let decode;
  try { decode = require('heic-decode'); } catch { throw new Error('HEIC is not supported here: export the photo as JPEG'); }
  let raw;
  try { raw = await decode({ buffer: img.buf }); } catch (e) { throw new Error('could not read the HEIC photo: ' + e.message); }
  if (raw.width * raw.height > MAX_PIXELS) throw new Error(`image is too large (${raw.width}×${raw.height}, max 40 megapixels)`);
  const { createCanvas } = require('@napi-rs/canvas');
  const c = createCanvas(raw.width, raw.height);
  const x = c.getContext('2d');
  const id = x.createImageData(raw.width, raw.height);
  id.data.set(raw.data);
  x.putImageData(id, 0, 0);
  return { buf: c.toBuffer('image/jpeg', 92), mime: 'image/jpeg', name: img.name };
}

// Width/height from the file header, before decoding (PNG, JPEG, WebP), to refuse decompression bombs.
function dimensions(b) {
  try {
    if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') {
      const kind = b.slice(12, 16).toString();
      if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
      if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { /* unknown layout: let the decoder decide */ }
  return null;
}

async function loadImageRaw(src) {
  if (Buffer.isBuffer(src)) return { buf: src, mime: sniff(src) };
  const s = String(src);
  if (/^data:/.test(s)) {
    const m = s.match(/^data:([^;,]+);base64,([\s\S]*)$/);
    if (!m) throw new Error('bad data: URL (base64 expected)');
    return { buf: Buffer.from(m[2], 'base64'), mime: m[1] };
  }
  if (/^https?:\/\//i.test(s)) return download(s);
  if (!safeMode() && fs.existsSync(s)) { const buf = fs.readFileSync(s); return { buf, mime: sniff(buf), name: path.basename(s) }; }
  if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 100) { const buf = Buffer.from(s, 'base64'); return { buf, mime: sniff(buf) }; }
  throw new Error(safeMode() ? 'image must be an https URL, data: URL or base64' : 'image must be a file path, URL, data: URL or base64');
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
  // Brickognize mixes up neutral shades (white / light grey / dark grey / black) under uneven
  // light; the pixels are more reliable there: if both are neutral and the pixels clearly vote
  // for another shade that Brickognize also lists (or any shade with a strong pixel majority), use it.
  const NEUTRAL = ['white', 'lbg', 'dbg', 'black'];
  const shade = (k) => NEUTRAL.indexOf(k);
  if (colors[0] && pixels[0] && NEUTRAL.includes(colors[0].color) && NEUTRAL.includes(pixels[0].color) && colors[0].color !== pixels[0].color && pixels[0].share >= 0.5) {
    // move one shade from Brickognize's pick toward the pixels, preferring a shade Brickognize lists
    const dir = Math.sign(shade(pixels[0].color) - shade(colors[0].color));
    const step = NEUTRAL[shade(colors[0].color) + dir];
    const pick = bl.some((c) => c.color === pixels[0].color) ? pixels[0].color : bl.some((c) => c.color === step) ? step : (pixels[0].share >= 0.8 ? pixels[0].color : null);
    if (pick) {
      const i = colors.findIndex((c) => c.color === pick);
      const [p0] = i >= 0 ? colors.splice(i, 1) : [{ color: pick }];
      colors.unshift({ ...p0, source: 'pixels+brickognize', score: pixels[0].share });
    }
  }
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

// ------------------------------------------------------------------ piles

// A photo of many parts: split it into separate parts by background subtraction and connected
// components, then recognise each crop with Brickognize. Works when parts lie apart on a plain
// background (touching parts merge into one blob). Returns merged counts plus per-part details.
// Work surface = largest connected area of the most common colour (quantised). Returns the image
// cropped to it, or the image unchanged when the surface already fills the frame or is too small
// to be trusted.
function cropToSurface(im, createCanvas) {
  const S = Math.min(1, 160 / Math.max(im.width, im.height));
  const W = Math.max(1, Math.round(im.width * S));
  const H = Math.max(1, Math.round(im.height * S));
  const c = createCanvas(W, H);
  c.getContext('2d').drawImage(im, 0, 0, W, H);
  const d = c.getContext('2d').getImageData(0, 0, W, H).data;
  // The surface is the largest SMOOTH region: neighbouring pixels differ little, even when the
  // light makes one end of the table much darker than the other (a single "most common colour"
  // splits such a gradient and can pick a textured floor instead). Parquet, rugs and feet are
  // textured or bounded by strong edges, so they break into small regions.
  const near = new Uint8Array(W * H);
  {
    const rl = new Int32Array(W * H);
    const diff = (a, b) => Math.abs(d[4 * a] - d[4 * b]) + Math.abs(d[4 * a + 1] - d[4 * b + 1]) + Math.abs(d[4 * a + 2] - d[4 * b + 2]);
    let n = 0; let bestN = 0; let bestA = 0;
    for (let s0 = 0; s0 < W * H; s0++) {
      if (rl[s0]) continue;
      n++;
      const st = [s0]; rl[s0] = n; let area = 0;
      while (st.length) {
        const p = st.pop(); area++;
        const px = p % W; const py = (p / W) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx; const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const r = ny * W + nx;
          if (!rl[r] && diff(p, r) < 24) { rl[r] = n; st.push(r); }
        }
      }
      if (area > bestA) { bestA = area; bestN = n; }
    }
    for (let i = 0; i < W * H; i++) near[i] = rl[i] === bestN ? 1 : 0;
  }
  // parts sit on the surface and break it up: fill each row/column gap that is enclosed by
  // surface on both sides, so the surface is one solid region around the pile
  const solid = near.slice();
  for (let y = 0; y < H; y++) {
    let a = -1; let b = -1;
    for (let x = 0; x < W; x++) if (near[y * W + x]) { if (a < 0) a = x; b = x; }
    for (let x = a; a >= 0 && x <= b; x++) solid[y * W + x] = 1;
  }
  const lab = new Int32Array(W * H);
  let bestBox = null; let n = 0;
  for (let s0 = 0; s0 < W * H; s0++) {
    if (!solid[s0] || lab[s0]) continue;
    n++;
    const st = [s0]; lab[s0] = n;
    let x0 = W; let y0 = H; let x1 = 0; let y1 = 0; let area = 0;
    while (st.length) {
      const p = st.pop(); const px = p % W; const py = (p / W) | 0; area++;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = px + dx; const ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const r = ny * W + nx;
        if (solid[r] && !lab[r]) { lab[r] = n; st.push(r); }
      }
    }
    if (!bestBox || area > bestBox.area) bestBox = { x0, y0, x1, y1, area };
  }
  if (!bestBox || bestBox.area < W * H * 0.25) return im;
  const bw = bestBox.x1 - bestBox.x0 + 1; const bh = bestBox.y1 - bestBox.y0 + 1;
  if (bw * bh > W * H * 0.92) return im; // the surface already fills the frame
  const inset = 2; // stay off the table edge
  const x0 = Math.max(0, (bestBox.x0 + inset) / S); const y0 = Math.max(0, (bestBox.y0 + inset) / S);
  const x1 = Math.min(im.width, (bestBox.x1 + 1 - inset) / S); const y1 = Math.min(im.height, (bestBox.y1 + 1 - inset) / S);
  const out = createCanvas(Math.round(x1 - x0), Math.round(y1 - y0));
  out.getContext('2d').drawImage(im, x0, y0, x1 - x0, y1 - y0, 0, 0, out.width, out.height);
  return out;
}

// Split blobs that are much bigger than a typical part (see segment). Mutates lab/boxes: a split
// blob's box is replaced by one box per core.
function splitBlobs(edge, lab, boxes, W, H, minArea) {
  const areas = boxes.map((b) => b.area).filter((a) => a >= minArea).sort((a, b) => a - b);
  if (!areas.length) return;
  const typical = areas[Math.floor(areas.length / 2)];
  const bigLimit = Math.max(typical * 3, W * H * 0.02);
  const out = [];
  boxes.forEach((b, idx) => {
    const id = idx + 1;
    if (b.area < bigLimit) { out.push(b); return; }
    // pixels of this blob
    const px = [];
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (lab[y * W + x] === id) px.push(y * W + x);
    const inBlob = new Uint8Array(W * H);
    for (const p of px) inBlob[p] = 1;
    // distance to the blob edge (4-neighbour BFS from the boundary). Strong colour edges inside
    // the blob count as boundary too, so two touching parts of different colours separate.
    const dist = new Int32Array(W * H).fill(-1);
    const q = [];
    for (const p of px) {
      const x = p % W; const y = (p / W) | 0;
      if (edge[p] || x === 0 || y === 0 || x === W - 1 || y === H - 1 || !inBlob[p - 1] || !inBlob[p + 1] || !inBlob[p - W] || !inBlob[p + W]) { dist[p] = 0; q.push(p); }
    }
    for (let h = 0; h < q.length; h++) {
      const p = q[h];
      for (const r of [p - 1, p + 1, p - W, p + W]) if (r >= 0 && r < W * H && inBlob[r] && dist[r] < 0) { dist[r] = dist[p] + 1; q.push(r); }
    }
    let maxD = 0;
    for (const p of px) if (dist[p] > maxD) maxD = dist[p];
    // try deeper and deeper cores; keep the depth that gives the most sizable cores
    const coreMin = Math.max(4, minArea * 0.15);
    let bestCores = null;
    for (let t = 1; t <= Math.min(maxD - 1, 14); t++) {
      const seen = new Uint8Array(W * H);
      const cores = [];
      for (const p of px) {
        if (dist[p] < t || seen[p]) continue;
        const st = [p]; seen[p] = 1; const members = [];
        while (st.length) {
          const s = st.pop(); members.push(s);
          for (const r of [s - 1, s + 1, s - W, s + W]) if (r >= 0 && r < W * H && inBlob[r] && dist[r] >= t && !seen[r]) { seen[r] = 1; st.push(r); }
        }
        if (members.length >= coreMin) cores.push(members);
      }
      if (!bestCores || cores.length > bestCores.length) bestCores = cores;
    }
    if (!bestCores || bestCores.length < 2) { out.push(b); return; }
    // grow cores back over the blob (multi-source BFS)
    const owner = new Int32Array(W * H).fill(-1);
    const gq = [];
    bestCores.forEach((members, k) => { for (const p of members) { owner[p] = k; gq.push(p); } });
    for (let h = 0; h < gq.length; h++) {
      const p = gq[h];
      for (const r of [p - 1, p + 1, p - W, p + W]) if (r >= 0 && r < W * H && inBlob[r] && owner[r] < 0) { owner[r] = owner[p]; gq.push(r); }
    }
    const sub = bestCores.map(() => ({ x0: W, y0: H, x1: 0, y1: 0, area: 0 }));
    for (const p of px) {
      const k = owner[p];
      if (k < 0) continue;
      const s = sub[k]; const x = p % W; const y = (p / W) | 0;
      s.area++; if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x; if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y;
    }
    out.push(...sub.filter((s) => s.area > 0));
  });
  boxes.length = 0;
  boxes.push(...out);
}

// The pile on a clean white page: every part kept in its place and colours, the table, shadows
// and specks removed. Mask = foreground components big enough to be a part (from the 480 px
// working mask), lightly grown and feathered, applied to the photo at up to 960 px; cropped to
// the parts with a margin. Returns a JPEG data URL (small enough to keep with the user's state).
function cleanPile(im, lab, comps, minArea, W, H, createCanvas) {
  // a region touching the frame is the floor, the table edge or a hand, not a part laid out
  const ok = comps.map((c) => c.area >= minArea && c.area < W * H * 0.5 && c.x0 > 0 && c.y0 > 0 && c.x1 < W - 1 && c.y1 < H - 1);
  const keep = new Uint8Array(W * H);
  let x0 = W; let y0 = H; let x1 = -1; let y1 = -1;
  for (let i = 0; i < W * H; i++) {
    const id = lab[i];
    if (!id || !ok[id - 1]) continue;
    keep[i] = 1;
    const x = i % W; const y = (i / W) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  // grow by 1 px so dark outlines of parts are not cut off
  const grown = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!keep[y * W + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx; const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H) grown[ny * W + nx] = 1;
    }
  }
  const mask = createCanvas(W, H);
  const mx = mask.getContext('2d');
  const md = mx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) { md.data[4 * i + 3] = grown[i] ? 255 : 0; }
  mx.putImageData(md, 0, 0);
  // crop box in mask pixels with a margin, then the photo at up to 960 px on its long side
  const m = Math.round(0.06 * Math.max(x1 - x0, y1 - y0)) + 4;
  const cx0 = Math.max(0, x0 - m); const cy0 = Math.max(0, y0 - m);
  const cw = Math.min(W, x1 + m + 1) - cx0; const ch = Math.min(H, y1 + m + 1) - cy0;
  const k = Math.min(960 / Math.max(cw, ch), im.width / W);
  const OW = Math.max(1, Math.round(cw * k)); const OH = Math.max(1, Math.round(ch * k));
  const sx = im.width / W;
  const parts = createCanvas(OW, OH);
  const px = parts.getContext('2d');
  px.imageSmoothingQuality = 'high';
  px.drawImage(im, cx0 * sx, cy0 * sx, cw * sx, ch * sx, 0, 0, OW, OH);
  px.globalCompositeOperation = 'destination-in';
  px.filter = `blur(${Math.max(0.6, k * 0.6).toFixed(1)}px)`;
  px.drawImage(mask, cx0, cy0, cw, ch, 0, 0, OW, OH);
  const out = createCanvas(OW, OH);
  const ox = out.getContext('2d');
  ox.fillStyle = '#ffffff';
  ox.fillRect(0, 0, OW, OH);
  ox.drawImage(parts, 0, 0);
  return 'data:image/jpeg;base64,' + out.toBuffer('image/jpeg', 82).toString('base64');
}

async function segment(img, opts) {
  const o = opts || {};
  const { loadImage, createCanvas } = require('@napi-rs/canvas');
  let im = await loadImage(img.buf);
  // work on at most 2000 px: enough detail for recognition, bounded memory and crop cost
  const big = Math.max(im.width, im.height);
  if (big > 2000) {
    const k = 2000 / big;
    const small = createCanvas(Math.round(im.width * k), Math.round(im.height * k));
    small.getContext('2d').drawImage(im, 0, 0, small.width, small.height);
    im = small;
  }
  // The background is taken from the photo border. When the shot also shows the floor, a rug or
  // feet past the table edge, that border is not the table, the whole table becomes "foreground"
  // and the pile is one blob. So first find the work surface (the largest even area of the most
  // common colour) and crop to it.
  im = cropToSurface(im, createCanvas);
  const S = Math.min(1, 480 / Math.max(im.width, im.height));
  const W = Math.round(im.width * S);
  const H = Math.round(im.height * S);
  const c = createCanvas(W, H);
  const x = c.getContext('2d');
  x.drawImage(im, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H).data;
  // background model: the photo blurred a lot (follows vignetting and uneven light), but taken
  // from a copy where strong-colour pixels are replaced by the border median, so parts do not
  // bleed into it. Foreground = different chroma, clearly lighter (white parts on cream) or much
  // darker than a shadow would make it.
  const at = (i) => [d[4 * i], d[4 * i + 1], d[4 * i + 2]];
  const border = [];
  for (let i = 0; i < W; i++) border.push(at(i), at((H - 1) * W + i));
  for (let j = 0; j < H; j++) border.push(at(j * W), at(j * W + W - 1));
  const med = [0, 1, 2].map((k) => border.map((p) => p[k]).sort((a, b) => a - b)[border.length >> 1]);
  const medS = med[0] + med[1] + med[2] || 1;
  const chromaOf = (p, q, ps, qs) => Math.hypot(p[0] / ps - q[0] / qs, p[1] / ps - q[1] / qs, p[2] / ps - q[2] / qs) * 255;
  const clean = createCanvas(W, H);
  const cx2 = clean.getContext('2d');
  const cd = cx2.createImageData(W, H);
  // The table may be much darker at one end (light from one side). So the reference is not one
  // colour but a coarse grid of local medians of table-like pixels (same chroma as the border,
  // any brightness), smoothed; a cell with too few such pixels takes its neighbours' value.
  const G = 8;
  const gw = Math.ceil(W / G); const gh = Math.ceil(H / G);
  const cells = Array.from({ length: gw * gh }, () => []);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = at(y * W + x);
    const s = p[0] + p[1] + p[2] || 1;
    if (chromaOf(p, med, s, medS) < 10) cells[((y * gh / H) | 0) * gw + ((x * gw / W) | 0)].push(s);
  }
  const ref = new Float32Array(gw * gh).fill(-1);
  for (let k = 0; k < cells.length; k++) if (cells[k].length > (W * H) / (gw * gh) * 0.2) {
    const a = cells[k].sort((u, v) => u - v);
    // upper quantile: grey parts have the table's (neutral) chroma but are darker, the table is
    // the brightest neutral thing in its neighbourhood
    ref[k] = a[Math.floor(a.length * 0.8)];
  }
  for (let pass = 0; pass < gw + gh; pass++) {
    let missing = 0;
    for (let k = 0; k < ref.length; k++) {
      if (ref[k] >= 0) continue;
      const gx = k % gw; const gy = (k / gw) | 0; let sum = 0; let n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = gx + dx; const ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const v = ref[ny * gw + nx]; if (v >= 0) { sum += v; n++; }
      }
      if (n) ref[k] = -2 - sum / n; else missing++;
    }
    for (let k = 0; k < ref.length; k++) if (ref[k] <= -2) ref[k] = -2 - ref[k];
    if (!missing) break;
  }
  // Only an uneven table needs this: when the local table levels differ by less than ~40 per
  // channel, keep the old single-level rules (they find white parts on a light table better).
  const levels = [...ref].filter((v) => v >= 0).sort((u, v) => u - v);
  const spread = levels.length > 4 ? (levels[Math.floor(levels.length * 0.9)] - levels[Math.floor(levels.length * 0.1)]) / 3 : 0;
  const uneven = spread > (o.unevenAt || 40);
  if (o.debugLevels) Object.assign(o.debugLevels, { uneven, spread: Math.round(spread) });
  const localS = (x, y) => { if (!uneven) return medS; const v = ref[((y * gh / H) | 0) * gw + ((x * gw / W) | 0)]; return v >= 0 ? v : medS; };
  // smooth (bilinear between cell centres) version for the brightness test below
  const refAt = (gx, gy) => { const v = ref[Math.min(gh - 1, Math.max(0, gy)) * gw + Math.min(gw - 1, Math.max(0, gx))]; return v >= 0 ? v : medS; };
  const smoothS = (x, y) => {
    const fx = (x * gw) / W - 0.5; const fy = (y * gh) / H - 0.5;
    const x0 = Math.floor(fx); const y0 = Math.floor(fy); const tx = fx - x0; const ty = fy - y0;
    return (refAt(x0, y0) * (1 - tx) + refAt(x0 + 1, y0) * tx) * (1 - ty) + (refAt(x0, y0 + 1) * (1 - tx) + refAt(x0 + 1, y0 + 1) * tx) * ty;
  };
  for (let i = 0; i < W * H; i++) {
    const p = at(i);
    const s = p[0] + p[1] + p[2] || 1;
    const ls = localS(i % W, (i / W) | 0);
    const keep = chromaOf(p, med, s, medS) < 10 && Math.abs(s - ls) / 3 < 25;
    // parts are replaced by the table colour at the LOCAL brightness, so the blurred reference
    // follows the light gradient instead of averaging bright and dark ends together
    const v = keep ? p : uneven ? med.map((m) => Math.min(255, (m * ls) / medS)) : med;
    cd.data[4 * i] = v[0]; cd.data[4 * i + 1] = v[1]; cd.data[4 * i + 2] = v[2]; cd.data[4 * i + 3] = 255;
  }
  cx2.putImageData(cd, 0, 0);
  const bc = createCanvas(W, H);
  const bx = bc.getContext('2d');
  bx.filter = `blur(${Math.round(Math.max(W, H) / (uneven ? 16 : 10))}px)`;
  bx.drawImage(clean, 0, 0);
  const b = bx.getImageData(0, 0, W, H).data;
  const fg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const p = at(i);
    const q = [b[4 * i], b[4 * i + 1], b[4 * i + 2]];
    const sum = p[0] + p[1] + p[2] || 1;
    const qs = q[0] + q[1] + q[2] || 1;
    const chroma = chromaOf(p, q, sum, qs);
    // brightness against the table's local level (upper quantile, follows the light), so the
    // table between parts is not "lighter than the blurred background"
    const ts = smoothS(i % W, (i / W) | 0);
    const lighter = (sum - (uneven ? Math.max(qs, ts) : qs)) / 3;
    const darker = (qs - sum) / 3;
    fg[i] = chroma > 16 || lighter > 10 || darker > 60 ? 1 : 0;
  }
  // close small gaps (edges drawn in the part colour), then label components
  // Strong colour edges between two foreground pixels. Not cut here (a white brick's top and
  // its grey side would fall apart); splitBlobs uses them only inside blobs that are too big to
  // be one part, where they are most likely the border between two touching parts.
  const edge = new Uint8Array(W * H);
  if (o.colorCut !== false) {
    const lum = (i) => d[4 * i] * 0.3 + d[4 * i + 1] * 0.59 + d[4 * i + 2] * 0.11;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!fg[i]) continue;
      for (const r of [i + 1, i + W]) {
        if (!fg[r]) continue;
        const dc = Math.abs(d[4 * i] - d[4 * r]) + Math.abs(d[4 * i + 1] - d[4 * r + 1]) + Math.abs(d[4 * i + 2] - d[4 * r + 2]);
        const p = at(i); const pr = at(r);
        const ch = chromaOf(p, pr, p[0] + p[1] + p[2] || 1, pr[0] + pr[1] + pr[2] || 1);
        if (dc > 150 && (ch > 40 || Math.abs(lum(i) - lum(r)) > 90)) edge[lum(i) < lum(r) ? i : r] = 1;
      }
    }
  }
  const lab = new Int32Array(W * H);
  const boxes = [];
  let n = 0;
  const stack = [];
  for (let s0 = 0; s0 < W * H; s0++) {
    if (!fg[s0] || lab[s0]) continue;
    n++;
    let x0 = W; let y0 = H; let x1 = 0; let y1 = 0; let area = 0;
    stack.push(s0);
    lab[s0] = n;
    while (stack.length) {
      const q = stack.pop();
      const qx = q % W; const qy = (q / W) | 0;
      area++;
      if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = qx + dx; const ny = qy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const r = ny * W + nx;
        if (fg[r] && !lab[r]) { lab[r] = n; stack.push(r); }
      }
    }
    boxes.push({ x0, y0, x1, y1, area });
  }
  const minArea = (W * H) * 0.0006;
  // the connected components before splitting (lab ids are 1-based indexes into this)
  const comps = boxes.map((bb) => ({ ...bb }));
  // Touching parts merge into one blob. Split big blobs: erode the mask until thin joins break
  // into several sizable cores, then grow every core back over its blob (geodesic, so each pixel
  // goes to the nearest core). Parts that overlap a lot stay together; parts that only touch
  // along an edge or through a thin cable/axle come apart.
  splitBlobs(edge, lab, boxes, W, H, minArea);
  if (o.debug) {
    const dc = createCanvas(W, H);
    const dx2 = dc.getContext('2d');
    dx2.drawImage(c, 0, 0);
    const id = dx2.getImageData(0, 0, W, H);
    for (let i = 0; i < W * H; i++) if (fg[i]) { id.data[4 * i] = 255; id.data[4 * i + 1] *= 0.4; id.data[4 * i + 2] *= 0.4; }
    dx2.putImageData(id, 0, 0);
    dx2.strokeStyle = '#00f';
    for (const bb of boxes) if (bb.area >= minArea) dx2.strokeRect(bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0);
    fs.writeFileSync(o.debug, dc.toBuffer('image/png'));
  }
  const parts = boxes.filter((b) => b.area >= minArea && b.area < W * H * 0.5);
  const max = o.max || 80;
  // the pile as the user laid it out, with the table removed: the opening shot of build videos
  const cleanShot = o.clean === false || (o.segmentOnly && !o.withClean) ? null : cleanPile(im, lab, comps, minArea, W, H, createCanvas);
  if (o.segmentOnly) return { found: parts.length, boxes: parts, ...(cleanShot ? { clean: cleanShot } : {}) };
  if (parts.length > max) throw new Error(`found ${parts.length} parts, more than ${max}: photograph fewer parts at once`);
  // crop each part from the full-resolution image with a margin, recognise in small batches
  const crops = parts.map((b) => {
    const m = Math.max(6, 0.15 * Math.max(b.x1 - b.x0, b.y1 - b.y0));
    const sx = Math.max(0, (b.x0 - m) / S); const sy = Math.max(0, (b.y0 - m) / S);
    const sw = Math.min(im.width - sx, (b.x1 - b.x0 + 2 * m) / S); const sh = Math.min(im.height - sy, (b.y1 - b.y0 + 2 * m) / S);
    // a small crop (a downscaled upload, a small part) is enlarged to at least 224 px on its long
    // side: the recogniser works on bigger inputs and does much worse on tiny ones
    const up = Math.max(1, Math.min(3, 224 / Math.max(sw, sh)));
    const cw = Math.round(sw * up); const ch = Math.round(sh * up);
    const cc = createCanvas(cw, ch);
    const cx3 = cc.getContext('2d');
    cx3.imageSmoothingQuality = 'high';
    cx3.drawImage(im, sx, sy, sw, sh, 0, 0, cw, ch);
    return { box: [Math.round(sx), Math.round(sy), Math.round(sw), Math.round(sh)], buf: cc.toBuffer('image/jpeg', 90) };
  });
  const results = [];
  const conc = o.concurrency || 6;
  for (let i = 0; i < crops.length; i += conc) {
    results.push(...await Promise.all(crops.slice(i, i + conc).map(async (cr) => {
      try {
        const r = await identify(cr.buf);
        return { box: cr.box, id: r.part && r.part.id, name: r.part && r.part.name, score: r.part && r.part.score, color: r.color, confident: r.confident, alt: r.candidates.slice(1).map((c2) => c2.id) };
      } catch (e) {
        return { box: cr.box, error: e.message };
      }
    })));
  }
  const counts = new Map();
  for (const r of results) {
    if (!r.id || !r.color) continue;
    const k = r.id + '|' + r.color;
    const v = counts.get(k) || { id: r.id, color: r.color, qty: 0, name: r.name, unsure: 0 };
    v.qty++;
    if (!r.confident) v.unsure++;
    counts.set(k, v);
  }
  const items = [...counts.values()].sort((a, b) => a.color.localeCompare(b.color) || a.id.localeCompare(b.id));
  return { found: parts.length, recognised: results.filter((r) => r.id).length, items, parts: results, ...(cleanShot ? { clean: cleanShot } : {}) };
}

async function identifyPile(src, opts) {
  const img = await loadImage(src);
  const o = opts || {};
  // the size of what the client actually sent (ChatGPT may downscale uploads): server log only
  if (process.env.VERCEL && !o.segmentOnly) { const dm = dimensions(img.buf); console.log(JSON.stringify({ ev: 'pile_photo', mime: img.mime, bytes: img.buf.length, w: dm && dm.w, h: dm && dm.h })); }
  if (o.segmentOnly || o.unevenAt != null) return segment(img, o);
  // On an evenly lit table one pass is enough. On an uneven one the two background models catch
  // different parts (the flat one keeps big dark parts whole, the local one finds parts in the
  // dark end and between others), so run both and keep the one that recognised more parts.
  const probe = { segmentOnly: true, debugLevels: {} };
  await segment(img, probe);
  if (!probe.debugLevels.uneven) return segment(img, o);
  const tryPass = async (opt) => { try { return await segment(img, opt); } catch (e) { return { error: e.message, parts: [], recognised: 0, found: 0 }; } };
  const flat = await tryPass({ ...o, unevenAt: 1e9 });
  const local = await tryPass({ ...o, debug: null });
  if (flat.error && local.error) throw new Error(local.error);
  // merge: the pass that recognised more is the base; a part from the other pass is added where
  // the base recognised nothing (no recognised base part overlaps it much): a spot the base left
  // empty or could not name. Nothing recognised is counted twice.
  const [base, extra] = local.recognised >= flat.recognised ? [local, flat] : [flat, local];
  const inter = (a, b) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  // Both passes' recognised parts, best fitting first: a part is kept when no kept part covers
  // most of it, and a big box that contains several kept parts is dropped (it was a merged
  // blob of those). Area-wise matching, so a wheel brick found by one pass and a plate under it
  // found by the other both stay.
  const area = (b) => b[2] * b[3];
  const cand = [...base.parts, ...extra.parts].filter((p) => p.id && p.color && p.box)
    .sort((a2, b2) => area(a2.box) - area(b2.box) || (b2.score || 0) - (a2.score || 0));
  const kept = [];
  for (const p of cand) {
    const ap = area(p.box);
    // the same part seen by the other pass: nearly the same box
    if (kept.some((k) => inter(p.box, k.box) > 0.6 * Math.max(ap, area(k.box)))) continue;
    // a merged blob: covers two or more kept parts almost completely
    if (kept.filter((k) => inter(p.box, k.box) > 0.8 * area(k.box)).length >= 2) continue;
    kept.push(p);
  }
  const counts = new Map();
  for (const r of kept) {
    const k = r.id + '|' + r.color;
    const v = counts.get(k) || { id: r.id, color: r.color, qty: 0, name: r.name, unsure: 0 };
    v.qty++;
    if (!r.confident) v.unsure++;
    counts.set(k, v);
  }
  const items = [...counts.values()].sort((a, b) => a.color.localeCompare(b.color) || a.id.localeCompare(b.id));
  return { found: Math.max(flat.found, local.found), recognised: kept.length, items, parts: kept, mode: 'merged', passes: { flat: flat.recognised, local: local.recognised }, ...(base.clean ? { clean: base.clean } : {}) };
}

module.exports = { identify, identifyPile, rankColors, loadImage };
