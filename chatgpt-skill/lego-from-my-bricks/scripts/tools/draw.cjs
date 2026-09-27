// Pictures of a model with no dependencies: SVG files (and PNG when a converter is available).
//   node tools/draw.cjs <model.json|name> [--steps] [--out dir] [--size 720]
// Writes <out>/<name>-model.svg and, with --steps, <name>-step1.svg ... one per step (new parts
// outlined in yellow, earlier ones pale, same camera on every picture). If rsvg-convert, magick or
// cairosvg is available, PNG copies are made too.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('../lib/core.cjs');
const { SvgContext } = require('../lib/svg.cjs');

const args = process.argv.slice(2);
const opt = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
const ref = args.find((a, i) => !a.startsWith('--') && !['--out', '--size'].includes(args[i - 1]));
const outDir = path.resolve(opt('--out', 'exports'));
const S = Number(opt('--size', 720));
const L = core.LEGO;

function picture(model, upto) {
  const all = model.steps.flat().map((s) => L.place(s));
  const theta = model.theta == null ? 40 : model.theta;
  const phi = model.phi == null ? 30 : model.phi;
  const b = L.bounds(all);
  const e = L.extent(b, theta, phi);
  const scale = (S * 0.82) / Math.max(e.w, e.h);
  const ctx = new SvgContext(S, S);
  const cam = L.camera({ theta, phi, scale, cx: S / 2, cy: S / 2, target: b.center });
  const n = upto == null ? model.steps.length : upto;
  const items = [];
  model.steps.slice(0, n).forEach((st, k) => {
    const last = upto != null && k === n - 1;
    for (const spec of st) items.push({ part: L.place(spec), pale: upto != null && !last ? 0.45 : 0, halo: last ? 1 : 0 });
  });
  L.draw(ctx, items, cam, { lineWidth: Math.max(1.5, scale * 0.03) });
  if (upto != null) {
    ctx.fillStyle = '#1f2328';
    ctx.font = `bold ${Math.round(S * 0.09)}px sans-serif`;
    ctx.fillText(String(n), S * 0.05, S * 0.12);
  }
  return ctx.toSVG('#ffffff');
}

function toPng(svgFile) {
  const png = svgFile.replace(/\.svg$/, '.png');
  const tries = [
    ['rsvg-convert', ['-o', png, svgFile]],
    ['magick', [svgFile, png]],
    ['convert', [svgFile, png]],
    ['cairosvg', [svgFile, '-o', png]],
  ];
  for (const [cmd, a] of tries) {
    try { execFileSync(cmd, a, { stdio: 'ignore' }); if (fs.existsSync(png)) return png; } catch { /* try next */ }
  }
  try {
    execFileSync('python3', ['-c', 'import sys,cairosvg;cairosvg.svg2png(url=sys.argv[1],write_to=sys.argv[2])', svgFile, png], { stdio: 'ignore' });
    if (fs.existsSync(png)) return png;
  } catch { /* no converter: SVG only */ }
  return null;
}

try {
  if (!ref) throw new Error('usage: node tools/draw.cjs <model.json|name> [--steps] [--out dir]');
  const m = core.loadModel(ref);
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  const write = (name, svg) => { const f = path.join(outDir, name); fs.writeFileSync(f, svg); files.push(f); };
  write(`${m.name}-model.svg`, picture(m));
  if (args.includes('--steps')) m.steps.forEach((_, k) => write(`${m.name}-step${k + 1}.svg`, picture(m, k + 1)));
  for (const f of files) {
    const png = toPng(f);
    console.log(png ? `${f}\n${png}` : f);
  }
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
