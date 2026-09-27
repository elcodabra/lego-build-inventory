// Pictures of a model with no dependencies: PNG (built-in rasteriser) plus the SVG source.
//   node tools/draw.cjs <model.json|name> [--steps] [--sheet] [--out dir] [--size 720]
// <out>/<name>-model.png           the finished model
// --steps: <name>-step1.png ...     one per step (new parts outlined in yellow, earlier ones pale,
//                                   same camera on every picture)
// --sheet: <name>-steps.png         all steps in one picture (grid), easiest to show in a chat
// --all:   <name>-build.png         the finished model (left, large) and all steps (right) in ONE picture
// Prints the PNG paths, one per line.
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('../lib/core.cjs');
const { SvgContext } = require('../lib/svg.cjs');
const { svgToPng } = require('../lib/raster.cjs');

const args = process.argv.slice(2);
const opt = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
const ref = args.find((a, i) => !a.startsWith('--') && !['--out', '--size'].includes(args[i - 1]));
const outDir = path.resolve(opt('--out', 'exports'));
const L = core.LEGO;

// Draw into ctx at (ox, oy) with size S: finished model, or the first `upto` steps.
function drawModel(ctx, model, S, ox, oy, upto) {
  const all = model.steps.flat().map((s) => L.place(s));
  const theta = model.theta == null ? 40 : model.theta;
  const phi = model.phi == null ? 30 : model.phi;
  const b = L.bounds(all);
  const e = L.extent(b, theta, phi);
  const scale = (S * 0.8) / Math.max(e.w, e.h);
  const cam = L.camera({ theta, phi, scale, cx: ox + S / 2, cy: oy + S / 2 + S * 0.03, target: b.center });
  const n = upto == null ? model.steps.length : upto;
  const items = [];
  model.steps.slice(0, n).forEach((st, k) => {
    const last = upto != null && k === n - 1;
    for (const spec of st) items.push({ part: L.place(spec), pale: upto != null && !last ? 0.45 : 0, halo: last ? 1 : 0 });
  });
  L.draw(ctx, items, cam, { lineWidth: Math.max(1.2, scale * 0.03) });
  if (upto != null) {
    ctx.fillStyle = '#1f2328';
    ctx.font = `bold ${Math.round(S * 0.1)}px sans-serif`;
    ctx.fillText(String(n), ox + S * 0.05, oy + S * 0.13);
  }
}

function single(model, S, upto) {
  const ctx = new SvgContext(S, S);
  drawModel(ctx, model, S, 0, 0, upto);
  return ctx.toSVG('#ffffff');
}

function sheet(model, cell) {
  const n = model.steps.length;
  const cols = Math.min(n, n <= 4 ? 2 : 3);
  const rows = Math.ceil(n / cols);
  const ctx = new SvgContext(cols * cell, rows * cell);
  for (let k = 0; k < n; k++) drawModel(ctx, model, cell, (k % cols) * cell, Math.floor(k / cols) * cell, k + 1);
  // thin grid lines between cells
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 2;
  for (let c = 1; c < cols; c++) { ctx.beginPath(); ctx.moveTo(c * cell, 0); ctx.lineTo(c * cell, rows * cell); ctx.stroke(); }
  for (let r = 1; r < rows; r++) { ctx.beginPath(); ctx.moveTo(0, r * cell); ctx.lineTo(cols * cell, r * cell); ctx.stroke(); }
  return ctx.toSVG('#ffffff');
}

// Finished model on the left (S x S), the step grid on the right filling the same height.
function combined(model, S) {
  const n = model.steps.length;
  const rows = n <= 2 ? 1 : n <= 6 ? 2 : 3;
  const cols = Math.ceil(n / rows);
  const cell = Math.round(S / rows);
  const W = S + cols * cell;
  const ctx = new SvgContext(W, S);
  drawModel(ctx, model, S, 0, 0);
  for (let k = 0; k < n; k++) drawModel(ctx, model, cell, S + (k % cols) * cell, Math.floor(k / cols) * cell, k + 1);
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(S, 0); ctx.lineTo(S, S); ctx.stroke();
  for (let c = 1; c < cols; c++) { ctx.beginPath(); ctx.moveTo(S + c * cell, 0); ctx.lineTo(S + c * cell, S); ctx.stroke(); }
  for (let r = 1; r < rows; r++) { ctx.beginPath(); ctx.moveTo(S, r * cell); ctx.lineTo(W, r * cell); ctx.stroke(); }
  return ctx.toSVG('#ffffff');
}

try {
  if (!ref) throw new Error('usage: node tools/draw.cjs <model.json|name> [--steps] [--sheet] [--out dir]');
  const m = core.loadModel(ref);
  const S = Number(opt('--size', 640));
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  const write = (name, svg) => {
    fs.writeFileSync(path.join(outDir, name + '.svg'), svg);
    const f = path.join(outDir, name + '.png');
    fs.writeFileSync(f, svgToPng(svg));
    out.push(f);
  };
  if (args.includes('--all')) { write(`${m.name}-build`, combined(m, S)); console.log(out.join('\n')); process.exit(0); }
  write(`${m.name}-model`, single(m, S));
  if (args.includes('--sheet')) write(`${m.name}-steps`, sheet(m, Math.round(S * 0.6)));
  if (args.includes('--steps')) m.steps.forEach((_, k) => write(`${m.name}-step${k + 1}`, single(m, S, k + 1)));
  console.log(out.join('\n'));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
