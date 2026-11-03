// Compare Meta models on the same photos: match, confidence, latency, tokens and REAL cost.
// Spends money, so: a hard cap per run (--max-usd, default 0.50) on top of the global budget, and
// it prints the planned worst case before the first call.
//   node --use-system-ca --env-file=.env.local test/meta-compare.mjs \
//     --models muse-spark-1.3,muse-spark-1.2,muse-spark-1.1 --efforts low --photos a.jpg:cat,b.jpg:none [--max-usd 0.5]
// --photos: file[:expected] (expected = known model name, or "none" when nothing should match).
// Without --photos it uses the rendered cat and microduck (renders, NOT real photos: say so in results).
// Results: printed table + test/results/meta-compare-<date>.json (no images, no AI text).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const meta = require('../lib/meta.cjs');
const an = require('../lib/analyze.cjs');
const { budget, fileStore } = require('../lib/budget.cjs');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
if (!meta.available()) { console.log('skip: MODEL_API_KEY not set'); process.exit(0); }
const models = arg('models', 'muse-spark-1.3,muse-spark-1.2').split(',').filter(Boolean);
const efforts = arg('efforts', 'low').split(',').filter(Boolean);
const maxUsd = Number(arg('max-usd', '0.5'));
for (const m of models) if (!meta.PRICES[m]) { console.error('unknown model ' + m + ', allowed: ' + Object.keys(meta.PRICES).join(', ')); process.exit(1); }
for (const m of models) if (meta.PRICES[m].contributor && !process.argv.includes('--allow-contributor')) {
  console.error(m + ' is Contributor mode: Meta may train on the photos. Pass --allow-contributor if these photos may be shared.');
  process.exit(1);
}

let photos = arg('photos', '');
let synthetic = false;
if (!photos) {
  synthetic = true;
  const nf = require('../lib/nodefilm.cjs');
  const core = require('../lib/core.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-cmp-'));
  for (const n of ['cat', 'microduck']) fs.writeFileSync(path.join(dir, n + '.png'), await nf.hero(core.loadModel(n), { size: 900, theta: 30 }));
  photos = ['cat', 'microduck'].map((n) => path.join(dir, n + '.png') + ':' + n).join(',');
}
const cases = photos.split(',').map((p) => { const i = p.lastIndexOf(':'); return i > 1 ? { file: p.slice(0, i), expected: p.slice(i + 1) } : { file: p, expected: null }; });

const runs = cases.length * models.length * efforts.length;
const worst = models.reduce((a, m) => a + meta.maxCost(m, 2500, meta.config().maxOutputTokens), 0) * cases.length * efforts.length;
console.log(`${runs} calls (${cases.length} photos x ${models.length} models x ${efforts.length} efforts), worst case $${worst.toFixed(3)}, cap for this run $${maxUsd}${synthetic ? ', photos = RENDERS (not real photos)' : ''}`);

const b = budget(fileStore());
let spent = 0;
const rows = [];
for (const c of cases) {
  const src = 'data:image/' + (/\.png$/i.test(c.file) ? 'png' : 'jpeg') + ';base64,' + fs.readFileSync(c.file).toString('base64');
  for (const model of models) for (const effort of efforts) {
    const w = meta.maxCost(model, 2500, meta.config().maxOutputTokens);
    if (spent + w > maxUsd) { rows.push({ photo: path.basename(c.file), model, effort, outcome: 'skipped (run cap)' }); continue; }
    try {
      const r = await an.analyze({ src, model, effort, budget: b });
      spent += r.provider.costUsd || w;
      const top = r.candidates[0] ? r.candidates[0].name : 'none';
      rows.push({
        photo: path.basename(c.file), expected: c.expected, model, effort, outcome: 'ok', top, correct: c.expected ? top === c.expected : null,
        confidence: r.analysis.match_confidence, candidates: r.candidates.map((x) => x.name).join('/'), colours: r.analysis.visible_colours.length,
        ms: r.provider.ms, in: r.provider.usage && r.provider.usage.input_tokens, out: r.provider.usage && r.provider.usage.output_tokens,
        reasoning: r.provider.usage && r.provider.usage.output_tokens_details && r.provider.usage.output_tokens_details.reasoning_tokens,
        usd: r.provider.costUsd, response: r.provider.responseId,
      });
    } catch (e) {
      spent += Number.isFinite(e.costUsd) ? e.costUsd : 0;
      rows.push({ photo: path.basename(c.file), expected: c.expected, model, effort, outcome: e.code || 'error', usd: e.costUsd || 0 });
      if (e.code === 'BUDGET_EXCEEDED') break;
    }
  }
}
console.table(rows.map((r) => ({ photo: r.photo, model: r.model, effort: r.effort, outcome: r.outcome, top: r.top, ok: r.correct, conf: r.confidence, ms: r.ms, out_tok: r.out, usd: r.usd != null ? r.usd.toFixed(4) : '' })));
const by = {};
for (const r of rows.filter((x) => x.outcome === 'ok')) {
  const k = r.model + ' / ' + r.effort;
  const s = (by[k] = by[k] || { runs: 0, correct: 0, judged: 0, ms: 0, usd: 0 });
  s.runs++; s.ms += r.ms; s.usd += r.usd || 0;
  if (r.correct != null) { s.judged++; if (r.correct) s.correct++; }
}
console.table(Object.fromEntries(Object.entries(by).map(([k, s]) => [k, { runs: s.runs, accuracy: s.judged ? `${s.correct}/${s.judged}` : 'n/a', avg_ms: Math.round(s.ms / s.runs), avg_usd: (s.usd / s.runs).toFixed(4), usd_per_100: (100 * s.usd / s.runs).toFixed(2) }])));
const st = await b.status();
console.log(`this run $${spent.toFixed(4)}; budget total $${st.spentUsd.toFixed(4)} of $${st.capUsd} (${st.calls} calls)`);
const outDir = path.join(ROOT, 'test/results');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `meta-compare-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`);
fs.writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), synthetic, rows, summary: by, spentUsd: spent }, null, 1));
console.log('saved ' + path.relative(process.cwd(), out));
