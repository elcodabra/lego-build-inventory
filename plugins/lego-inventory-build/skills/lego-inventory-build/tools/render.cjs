// Render a whole film to exports/<model>.mp4, or <model>-16x9.mp4 when horizontal (30 fps, H.264).
//   node tools/render.cjs [--model cat|file.json] [--format horizontal] [--fps 30] [--out exports/cat.mp4]
const path = require('path');
const core = require('../lib/core.cjs');
const film = require('../lib/film.cjs');

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};

(async () => {
  const model = core.loadModel(arg('--model', 'cat'));
  const format = arg('--format', 'vertical');
  const out = path.resolve(arg('--out', path.join(core.ROOT, 'exports', `${model.name}${format === 'horizontal' ? '-16x9' : ''}.mp4`)));
  const t0 = Date.now();
  const r = await film.render(model, out, { format, fps: Number(arg('--fps', 30)), onProgress: (i, n) => { if (i % 60 === 0) console.log(`frame ${i}/${n}`); } });
  await film.close();
  console.log(`${r.file} (${r.frames} frames, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
})().catch(async (e) => { console.error(e.message); await film.close(); process.exit(1); });
