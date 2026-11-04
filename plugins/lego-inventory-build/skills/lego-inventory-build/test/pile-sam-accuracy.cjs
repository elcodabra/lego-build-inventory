// Compare pile recognition: classic segmentation vs Meta SAM 3.1 boxes, against a known answer.
//   node --use-system-ca test/pile-sam-accuracy.cjs [photo] [answer.json]   (real Meta call, ~$0.003)
const P = require('../lib/photo.cjs');
const S = require('../lib/segment.cjs');
const an = require('../lib/analyze.cjs');
const path = require('path');
(async () => {
  const img = process.argv[2] || path.join(__dirname, 'fixtures/pile-table-edge.jpg');
  const ans = require(path.resolve(process.argv[3] || path.join(__dirname, 'fixtures/pile-table-edge-inventory.json')));
  const A = {}; for (const x of ans) A[x.id + '|' + x.color] = (A[x.id + '|' + x.color] || 0) + x.qty;
  const total = Object.values(A).reduce((a, b) => a + b, 0);
  const score = (items) => { const G = {}; for (const i of items) G[i.id + '|' + i.color] = i.qty; let ok = 0; for (const k of Object.keys(A)) ok += Math.min(A[k], G[k] || 0); const got = Object.values(G).reduce((a, b) => a + b, 0); return { correct: ok, total, counted: got, precision: got ? +(ok / got).toFixed(2) : 0, recall: +(ok / total).toFixed(2) }; };
  const out = {};
  let t = Date.now();
  const c = await P.identifyPile(img);
  out.classic = { ...score(c.items), found: c.found, s: +((Date.now() - t) / 1000).toFixed(1) };
  t = Date.now();
  const pic = await an.preparePhoto(img);
  const sam = await S.pileBoxes({ dataUrl: pic.dataUrl });
  const s = await P.identifyBoxes(img, sam.boxes);
  out.sam = { ...score(s.items), found: sam.boxes.length, raw: sam.raw, samMs: sam.ms, s: +((Date.now() - t) / 1000).toFixed(1), costUsd: sam.costUsd };
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
