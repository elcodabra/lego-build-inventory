// Render single frames to PNG.
//   node tools/snap.cjs 3 6 final [--model cat|file.json] [--format horizontal] [--out dir]
//     times in seconds, negative counts from the end, "final" is half a second before the end
//   node tools/snap.cjs --parts   -> exports/parts.png
const fs = require('fs');
const path = require('path');
const core = require('../lib/core.cjs');
const film = require('../lib/film.cjs');

(async () => {
  const args = process.argv.slice(2);
  const opt = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
  const parts = args.includes('--parts');
  const ref = opt('--model', 'cat');
  const format = opt('--format', 'vertical');
  const outDir = path.resolve(opt('--out', path.join(core.ROOT, 'exports')));
  const skip = new Set(['--model', '--format', '--out'].map((n) => args.indexOf(n) + 1).filter((i) => i > 0));
  let times = args.filter((a, i) => !a.startsWith('--') && !skip.has(i));
  if (!times.length) times = ['final'];
  const model = parts ? 'parts' : core.loadModel(ref);
  const base = parts ? 'parts' : model.name + (format === 'horizontal' ? '-16x9' : '');
  fs.mkdirSync(outDir, { recursive: true });
  const shots = await film.snap(model, parts ? [0] : times, format);
  for (const s of shots) {
    const file = path.join(outDir, parts ? 'parts.png' : `${base}-${s.t.toFixed(2)}.png`);
    fs.writeFileSync(file, s.png);
    console.log(file);
  }
  await film.close();
})().catch(async (e) => { console.error(e.message); await film.close(); process.exit(1); });
