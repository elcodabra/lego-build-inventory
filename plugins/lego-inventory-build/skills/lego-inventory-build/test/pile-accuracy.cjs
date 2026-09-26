// node test/pile-accuracy.cjs pile.jpg answer.csv [--debug out.png]
const P = require('../lib/photo.cjs');
const fs = require('fs');
(async () => {
  const [img, ans] = process.argv.slice(2);
  const t = Date.now();
  const r = await P.identifyPile(img, { debug: process.argv.includes('--debug') ? process.argv[process.argv.indexOf('--debug') + 1] : null });
  const A = {};
  for (const l of fs.readFileSync(ans, 'utf8').trim().split('\n').slice(1)) { const [p, c, q] = l.split(','); A[p + '|' + c] = +q; }
  const G = {};
  for (const i of r.items) G[i.id + '|' + i.color] = i.qty;
  const total = Object.values(A).reduce((a, b) => a + b, 0);
  let ok = 0;
  for (const k of Object.keys(A)) ok += Math.min(A[k], G[k] || 0);
  console.log(`found ${r.found} blobs, recognised ${r.recognised}, correct ${ok}/${total}, ${((Date.now() - t) / 1000).toFixed(1)}s`);
  for (const k of new Set([...Object.keys(A), ...Object.keys(G)])) if (A[k] !== G[k]) console.log('  ', k, 'answer', A[k] || 0, 'got', G[k] || 0);
})();
