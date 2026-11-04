// Renders docs/img/benchmark.png: accuracy vs cost per photo for the 11 models in docs/benchmarks.md.
//   node test/bench-chart.cjs
const { createCanvas } = require('@napi-rs/canvas');
const fs = require('fs'); const path = require('path');
const rows = [
  ['Claude Opus 5.5', 16, 0.0177, 'a'], ['Muse Spark 1.3', 15, 0.0054, 'm'], ['Muse Spark 1.2', 14, 0.0053, 'm'],
  ['Muse Spark 1.2 minimal', 14, 0.0031, 'm'], ['Claude Sonnet 5.5', 14, 0.0090, 'a'], ['GPT-4.1', 13, 0.0047, 'o'],
  ['Muse Spark 1.1', 12, 0.0041, 'm'], ['GPT-5.6 Sol', 11, 0.0138, 'o'], ['Claude Haiku 5.5', 11, 0.0006, 'a'],
  ['GPT-4.1 mini', 11, 0.0011, 'o'], ['GPT-5.6 Luna', 9, 0.0007, 'o'],
];
const C = { m: '#0866FF', a: '#D97757', o: '#10A37F' };
const W = 1400, H = 760, L = 330, R = 140, T = 110, B = 70;
const cv = createCanvas(W, H); const x = cv.getContext('2d');
x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
x.fillStyle = '#111'; x.font = 'bold 34px Inter'; x.fillText('Photo → which saved model is it? (16 photos, 12 look-alike models)', 40, 55);
x.font = '22px Inter'; x.fillStyle = '#555'; x.fillText('Same prompt and JSON schema for every model · bar = correct answers · label = cost per photo', 40, 88);
const bh = (H - T - B) / rows.length;
rows.forEach(([n, acc, usd, p], i) => {
  const y = T + i * bh; const w = (W - L - R) * acc / 16;
  x.fillStyle = '#111'; x.font = (p === 'm' ? 'bold ' : '') + '24px Inter'; x.textAlign = 'right'; x.fillText(n, L - 16, y + bh * 0.62);
  x.fillStyle = C[p]; x.fillRect(L, y + bh * 0.15, w, bh * 0.7);
  x.textAlign = 'left'; x.fillStyle = '#fff'; x.font = 'bold 22px Inter'; x.fillText(`${acc}/16`, L + 12, y + bh * 0.62);
  x.fillStyle = '#333'; x.font = '20px Inter'; x.fillText(`$${usd.toFixed(4)}`, L + w + 12, y + bh * 0.62);
});
x.font = '20px Inter'; let lx = 40;
for (const [k, t] of [['m', 'Meta (Muse Spark)'], ['a', 'Anthropic'], ['o', 'OpenAI']]) { x.fillStyle = C[k]; x.fillRect(lx, H - 42, 22, 22); x.fillStyle = '#333'; x.fillText(t, lx + 30, H - 24); lx += 260; }
x.fillStyle = '#777'; x.fillText('Nov 4, 2026 · all 256 calls schema-valid · no invented matches', 820, H - 24);
const out = path.join(__dirname, '../../../../../docs/img/benchmark.png');
fs.writeFileSync(out, cv.toBuffer('image/png')); console.log(out);
