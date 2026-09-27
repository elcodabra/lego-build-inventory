// A minimal Canvas 2D context that records drawing as SVG. The LEGO engine (src/lego.js) only uses
// paths, fills, strokes, linear gradients, clip and alpha, so it can render with no dependencies:
// this is what the skill uses in sandboxes without npm (ChatGPT, claude.ai).
'use strict';

const f = (n) => (Math.round(n * 100) / 100).toString();

class Gradient {
  constructor(id, x0, y0, x1, y1) { this.id = id; this.p = [x0, y0, x1, y1]; this.stops = []; }
  addColorStop(o, c) { this.stops.push([o, c]); }
}

class SvgContext {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.out = [];
    this.defs = [];
    this.ids = 0;
    this.stack = [];
    this.st = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineJoin: 'miter', lineCap: 'butt', globalAlpha: 1, clip: null, font: '10px sans-serif', textAlign: 'start' };
    this.d = '';
  }
  // state
  get fillStyle() { return this.st.fillStyle; } set fillStyle(v) { this.st.fillStyle = v; }
  get strokeStyle() { return this.st.strokeStyle; } set strokeStyle(v) { this.st.strokeStyle = v; }
  get lineWidth() { return this.st.lineWidth; } set lineWidth(v) { this.st.lineWidth = v; }
  get lineJoin() { return this.st.lineJoin; } set lineJoin(v) { this.st.lineJoin = v; }
  get lineCap() { return this.st.lineCap; } set lineCap(v) { this.st.lineCap = v; }
  get globalAlpha() { return this.st.globalAlpha; } set globalAlpha(v) { this.st.globalAlpha = v; }
  get font() { return this.st.font; } set font(v) { this.st.font = v; }
  get textAlign() { return this.st.textAlign; } set textAlign(v) { this.st.textAlign = v; }
  save() { this.stack.push({ ...this.st }); }
  restore() { if (this.stack.length) this.st = this.stack.pop(); }
  // paths
  beginPath() { this.d = ''; }
  moveTo(x, y) { this.d += `M${f(x)} ${f(y)}`; }
  lineTo(x, y) { this.d += `L${f(x)} ${f(y)}`; }
  closePath() { this.d += 'Z'; }
  rect(x, y, w, h) { this.d += `M${f(x)} ${f(y)}h${f(w)}v${f(h)}h${f(-w)}Z`; }
  arc(x, y, r, a0, a1, ccw) {
    const sx = x + r * Math.cos(a0); const sy = y + r * Math.sin(a0);
    const ex = x + r * Math.cos(a1); const ey = y + r * Math.sin(a1);
    let sweep = ccw ? a0 - a1 : a1 - a0;
    if (Math.abs(sweep) >= 2 * Math.PI - 1e-6) {
      const mx = x - r * Math.cos(a0); const my = y - r * Math.sin(a0);
      this.d += `${this.d ? 'L' : 'M'}${f(sx)} ${f(sy)}A${f(r)} ${f(r)} 0 1 ${ccw ? 0 : 1} ${f(mx)} ${f(my)}A${f(r)} ${f(r)} 0 1 ${ccw ? 0 : 1} ${f(sx)} ${f(sy)}`;
      return;
    }
    sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    this.d += `${this.d ? 'L' : 'M'}${f(sx)} ${f(sy)}A${f(r)} ${f(r)} 0 ${sweep > Math.PI ? 1 : 0} ${ccw ? 0 : 1} ${f(ex)} ${f(ey)}`;
  }
  ellipse(x, y, rx, ry, rot, a0, a1, ccw) {
    // approximated by a polygon, enough for studs and round parts
    const n = 48;
    let span = ccw ? a0 - a1 : a1 - a0;
    if (span <= 0) span += 2 * Math.PI;
    for (let i = 0; i <= n; i++) {
      const a = a0 + (ccw ? -1 : 1) * span * (i / n);
      const px = rx * Math.cos(a); const py = ry * Math.sin(a);
      const X = x + px * Math.cos(rot) - py * Math.sin(rot);
      const Y = y + px * Math.sin(rot) + py * Math.cos(rot);
      this.d += `${i === 0 && !this.d ? 'M' : 'L'}${f(X)} ${f(Y)}`;
    }
  }
  arcTo(x1, y1) { this.lineTo(x1, y1); }
  // paint
  paint(v) {
    if (v instanceof Gradient) {
      if (!v.used) {
        v.used = true;
        this.defs.push(`<linearGradient id="${v.id}" gradientUnits="userSpaceOnUse" x1="${f(v.p[0])}" y1="${f(v.p[1])}" x2="${f(v.p[2])}" y2="${f(v.p[3])}">${v.stops.map(([o, c]) => `<stop offset="${f(o)}" stop-color="${c}"/>`).join('')}</linearGradient>`);
      }
      return `url(#${v.id})`;
    }
    return String(v);
  }
  common() {
    const a = this.st.globalAlpha < 1 ? ` opacity="${f(this.st.globalAlpha)}"` : '';
    const c = this.st.clip ? ` clip-path="url(#${this.st.clip})"` : '';
    return a + c;
  }
  fill(rule) {
    if (!this.d) return;
    this.out.push(`<path d="${this.d}" fill="${this.paint(this.st.fillStyle)}"${rule === 'evenodd' ? ' fill-rule="evenodd"' : ''}${this.common()}/>`);
  }
  stroke() {
    if (!this.d) return;
    this.out.push(`<path d="${this.d}" fill="none" stroke="${this.paint(this.st.strokeStyle)}" stroke-width="${f(this.st.lineWidth)}" stroke-linejoin="${this.st.lineJoin}" stroke-linecap="${this.st.lineCap}"${this.common()}/>`);
  }
  clip(rule) {
    const id = 'c' + ++this.ids;
    this.defs.push(`<clipPath id="${id}"><path d="${this.d}"${rule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath>`);
    this.st.clip = id;
  }
  fillRect(x, y, w, h) { this.beginPath(); this.rect(x, y, w, h); this.fill(); }
  createLinearGradient(x0, y0, x1, y1) { return new Gradient('g' + ++this.ids, x0, y0, x1, y1); }
  fillText(t, x, y) {
    const size = (this.st.font.match(/(\d+(?:\.\d+)?)px/) || [0, 10])[1];
    const bold = /bold/.test(this.st.font) ? ' font-weight="bold"' : '';
    const anchor = { center: 'middle', right: 'end', end: 'end' }[this.st.textAlign] || 'start';
    const esc = String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    this.out.push(`<text x="${f(x)}" y="${f(y)}" font-family="Helvetica, Arial, sans-serif" font-size="${size}"${bold} text-anchor="${anchor}" fill="${this.paint(this.st.fillStyle)}"${this.common()}>${esc}</text>`);
  }
  measureText(t) { const size = Number((this.st.font.match(/(\d+(?:\.\d+)?)px/) || [0, 10])[1]); return { width: String(t).length * size * 0.55 }; }
  setLineDash() {} translate() {} scale() {} setTransform() {} resetTransform() {}
  toSVG(background) {
    const bg = background ? `<rect width="100%" height="100%" fill="${background}"/>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}"><defs>${this.defs.join('')}</defs>${bg}${this.out.join('')}</svg>`;
  }
}

module.exports = { SvgContext };
