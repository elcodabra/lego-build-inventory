// Tiny dependency-free rasteriser for the SVG subset produced by svg.cjs (paths with M/L/Z/h/v/A,
// solid and linear-gradient fills, strokes, opacity, even-odd clip) -> PNG via zlib. Enough to
// show model pictures inline in chats whose sandbox has Node but no image libraries.
'use strict';
const zlib = require('zlib');

// ------------------------------------------------------------------ colours

function parseColor(s) {
  s = String(s).trim();
  let m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  return [0, 0, 0, 1];
}

// ------------------------------------------------------------------ geometry

// Path data -> list of closed polygons (arcs flattened).
function flatten(d) {
  const polys = [];
  let cur = null;
  let x = 0; let y = 0; let sx = 0; let sy = 0;
  const re = /([MLHVAZmlhvaz])([^MLHVAZmlhvaz]*)/g;
  let m;
  while ((m = re.exec(d))) {
    const cmd = m[1];
    const n = (m[2].match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number);
    if (cmd === 'M') { cur = [[n[0], n[1]]]; polys.push(cur); x = sx = n[0]; y = sy = n[1]; for (let i = 2; i + 1 < n.length; i += 2) { x = n[i]; y = n[i + 1]; cur.push([x, y]); } }
    else if (cmd === 'L') { for (let i = 0; i + 1 < n.length; i += 2) { x = n[i]; y = n[i + 1]; if (!cur) { cur = [[x, y]]; polys.push(cur); } else cur.push([x, y]); } }
    else if (cmd === 'h') { x += n[0]; cur.push([x, y]); }
    else if (cmd === 'v') { y += n[0]; cur.push([x, y]); }
    else if (cmd === 'H') { x = n[0]; cur.push([x, y]); }
    else if (cmd === 'V') { y = n[0]; cur.push([x, y]); }
    else if (cmd === 'A') {
      for (let i = 0; i + 6 < n.length + 1; i += 7) {
        const pts = arcPoints(x, y, n[i], n[i + 1], n[i + 2], n[i + 3], n[i + 4], n[i + 5], n[i + 6]);
        for (const p of pts) cur.push(p);
        x = n[i + 5]; y = n[i + 6];
      }
    } else if (cmd === 'Z' || cmd === 'z') { x = sx; y = sy; cur = null; }
  }
  return polys.filter((p) => p.length > 1);
}

function arcPoints(x1, y1, rx, ry, rotDeg, large, sweep, x2, y2) {
  if (!rx || !ry) return [[x2, y2]];
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi); const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2; const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy; const y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const sign = large === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
  const cxp = (co * rx * y1p) / ry; const cyp = (-co * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2; const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
  const steps = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 24)));
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const t = t1 + (dt * i) / steps;
    const ex = rx * Math.cos(t); const ey = ry * Math.sin(t);
    out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
  return out;
}

// Stroke of a polyline as quads + round-ish joins (small polygons at vertices).
function strokePolys(polys, w) {
  const out = [];
  const h = w / 2;
  for (const p of polys) {
    for (let i = 0; i + 1 < p.length; i++) {
      const [ax, ay] = p[i]; const [bx, by] = p[i + 1];
      const len = Math.hypot(bx - ax, by - ay) || 1e-9;
      const nx = (-(by - ay) / len) * h; const ny = ((bx - ax) / len) * h;
      out.push([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]);
    }
    if (h > 0.6) {
      for (const [cx, cy] of p) {
        const c = [];
        for (let k = 0; k < 8; k++) c.push([cx + h * Math.cos((k * Math.PI) / 4), cy + h * Math.sin((k * Math.PI) / 4)]);
        out.push(c);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ scanline fill with 4x vertical supersampling

const SS = 4;
function coverage(W, H, polys, rule) {
  const cov = new Float32Array(W * H);
  const edges = [];
  for (const p of polys) {
    for (let i = 0; i < p.length; i++) {
      const a = p[i]; const b = p[(i + 1) % p.length];
      if (a[1] === b[1]) continue;
      edges.push(a[1] < b[1] ? [a[0], a[1], b[0], b[1], 1] : [b[0], b[1], a[0], a[1], -1]);
    }
  }
  if (!edges.length) return cov;
  let ymin = Infinity; let ymax = -Infinity;
  for (const e of edges) { if (e[1] < ymin) ymin = e[1]; if (e[3] > ymax) ymax = e[3]; }
  const y0 = Math.max(0, Math.floor(ymin * SS)); const y1 = Math.min(H * SS - 1, Math.ceil(ymax * SS));
  const xs = [];
  for (let sy = y0; sy <= y1; sy++) {
    const y = (sy + 0.5) / SS;
    xs.length = 0;
    for (const e of edges) if (y >= e[1] && y < e[3]) xs.push([e[0] + ((y - e[1]) / (e[3] - e[1])) * (e[2] - e[0]), e[4]]);
    if (xs.length < 2) continue;
    xs.sort((a, b) => a[0] - b[0]);
    const row = Math.floor(sy / SS) * W;
    let wind = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wind = rule === 'evenodd' ? wind ^ 1 : wind + xs[i][1];
      if (!wind) continue;
      const xa = Math.max(0, xs[i][0]); const xb = Math.min(W, xs[i + 1][0]);
      if (xb <= xa) continue;
      const ia = Math.floor(xa); const ib = Math.floor(xb);
      if (ia === ib) { cov[row + ia] += (xb - xa) / SS; continue; }
      cov[row + ia] += (ia + 1 - xa) / SS;
      for (let k = ia + 1; k < ib && k < W; k++) cov[row + k] += 1 / SS;
      if (ib < W) cov[row + ib] += (xb - ib) / SS;
    }
  }
  for (let i = 0; i < cov.length; i++) if (cov[i] > 1) cov[i] = 1;
  return cov;
}

// ------------------------------------------------------------------ SVG subset -> pixels

// Digits for step numbers (the only text the pictures use): 7-segment glyphs with rounded feel.
// Segments in a 0..1 x 0..2 box: a top, b top-right, c bottom-right, d bottom, e bottom-left, f top-left, g middle.
const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
function digitPolys(ch, x, y, size) {
  const w = size * 0.52; const h = size * 0.72; const t = size * 0.13; // glyph box (baseline at y)
  const top = y - h; const mid = y - h / 2;
  const r = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const s = {
    a: r(x, top, x + w, top + t), g: r(x, mid - t / 2, x + w, mid + t / 2), d: r(x, y - t, x + w, y),
    f: r(x, top, x + t, mid + t / 2), b: r(x + w - t, top, x + w, mid + t / 2),
    e: r(x, mid - t / 2, x + t, y), c: r(x + w - t, mid - t / 2, x + w, y),
  };
  return (SEG[ch] || '').split('').map((k) => s[k]);
}

function attrs(tag) {
  const o = {};
  for (const m of tag.matchAll(/([a-zA-Z][a-zA-Z0-9:-]*)="([^"]*)"/g)) o[m[1]] = m[2];
  return o;
}

function render(svg) {
  const head = attrs(svg.match(/<svg[^>]*>/)[0]);
  const W = Math.round(Number(head.width)); const H = Math.round(Number(head.height));
  const px = new Float32Array(W * H * 3).fill(255);
  const grads = {};
  for (const m of svg.matchAll(/<linearGradient([^>]*)>([\s\S]*?)<\/linearGradient>/g)) {
    const a = attrs(m[1]);
    const stops = [...m[2].matchAll(/<stop([^>]*)\/>/g)].map((s) => { const sa = attrs(s[1]); return [Number(sa.offset), parseColor(sa['stop-color'])]; });
    grads[a.id] = { x1: +a.x1, y1: +a.y1, x2: +a.x2, y2: +a.y2, stops };
  }
  const clips = {};
  for (const m of svg.matchAll(/<clipPath id="([^"]+)"><path([^>]*)\/><\/clipPath>/g)) {
    const a = attrs(m[2]);
    clips[m[1]] = coverage(W, H, flatten(a.d), a['clip-rule'] === 'evenodd' ? 'evenodd' : 'nonzero');
  }
  const paint = (cov, fill, opacity, clip) => {
    const cl = clip ? clips[clip] : null;
    let solid = null; let g = null;
    if (fill.startsWith('url(#')) g = grads[fill.slice(5, -1)]; else solid = parseColor(fill);
    const gdx = g ? g.x2 - g.x1 : 0; const gdy = g ? g.y2 - g.y1 : 0; const gl = g ? gdx * gdx + gdy * gdy || 1 : 1;
    for (let i = 0; i < W * H; i++) {
      let a = cov[i];
      if (!a) continue;
      if (cl) { a *= cl[i]; if (!a) continue; }
      let c = solid;
      if (g) {
        const x = (i % W) + 0.5; const y = ((i / W) | 0) + 0.5;
        const t = Math.max(0, Math.min(1, ((x - g.x1) * gdx + (y - g.y1) * gdy) / gl));
        let k = 0;
        while (k < g.stops.length - 1 && g.stops[k + 1][0] < t) k++;
        const s0 = g.stops[k]; const s1 = g.stops[Math.min(k + 1, g.stops.length - 1)];
        const u = s1[0] > s0[0] ? (t - s0[0]) / (s1[0] - s0[0]) : 0;
        c = [0, 1, 2].map((j) => s0[1][j] + (s1[1][j] - s0[1][j]) * Math.max(0, Math.min(1, u))).concat(1);
      }
      a *= opacity * c[3];
      const o = i * 3;
      px[o] += (c[0] - px[o]) * a; px[o + 1] += (c[1] - px[o + 1]) * a; px[o + 2] += (c[2] - px[o + 2]) * a;
    }
  };
  const body = svg.replace(/<defs>[\s\S]*?<\/defs>/, '');
  for (const m of body.matchAll(/<(rect|path)([^>]*)\/>|<text([^>]*)>([^<]*)<\/text>/g)) {
    if (m[3] != null) {
      const a = attrs(m[3]);
      const size = Number(a['font-size'] || 16);
      let x = Number(a.x); const y = Number(a.y);
      const polys = [];
      for (const ch of m[4]) { polys.push(...digitPolys(ch, x, y, size)); x += size * 0.66; }
      if (polys.length) paint(coverage(W, H, polys, 'nonzero'), a.fill || '#000', 1, null);
      continue;
    }
    const a = attrs(m[2]);
    const opacity = a.opacity ? Number(a.opacity) : 1;
    if (m[1] === 'rect') { if (a.fill) paint(new Float32Array(W * H).fill(1), a.fill, opacity, null); continue; }
    const polys = flatten(a.d || '');
    if (a.fill && a.fill !== 'none') paint(coverage(W, H, polys, a['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero'), a.fill, opacity, a['clip-path'] && a['clip-path'].slice(5, -1));
    if (a.stroke && a.stroke !== 'none') {
      const open = polys.map((p, i) => p); // strokes follow the path as drawn (closed ones repeat the first point)
      const closedD = /Z/i.test(a.d || '');
      const lines = closedD ? open.map((p) => p.concat([p[0]])) : open;
      paint(coverage(W, H, strokePolys(lines, Number(a['stroke-width'] || 1)), 'nonzero'), a.stroke, opacity, a['clip-path'] && a['clip-path'].slice(5, -1));
    }
  }
  return { W, H, px };
}

// ------------------------------------------------------------------ PNG

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png({ W, H, px }) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3; const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = px[i]; raw[o + 1] = px[i + 1]; raw[o + 2] = px[i + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const svgToPng = (svg) => png(render(svg));
module.exports = { svgToPng };
