// Cross-provider benchmark for the photo -> "which saved model is it" step.
// Same prompt, same JSON schema, same photos for every model; scored against the known answer.
//   node --use-system-ca test/bench-models.mjs [--providers meta,openai,anthropic] [--max-usd 1]
// Keys from env: MODEL_API_KEY (Meta), OPENAI_API_KEY, ANTHROPIC_API_KEY. A provider without a key is
// skipped. Photos: renders of the 3 built-in models from 3 new angles (labelled as renders) + real
// iPhone photos of builds the app does not know (correct answer: no match). No images or AI text are
// stored, only scores, latency, tokens and cost -> test/results/bench-<date>.json.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const meta = require('../lib/meta.cjs');
const an = require('../lib/analyze.cjs');
const core = require('../lib/core.cjs');
const nf = require('../lib/nodefilm.cjs');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const maxUsd = Number(arg('max-usd', '1'));
const want = arg('providers', 'meta,openai,anthropic').split(',');

// USD per 1M tokens (list prices, checked 2026-11-04; Meta from lib/meta.cjs)
const OPENAI_PRICES = { 'gpt-4.1-mini': [0.4, 1.6], 'gpt-4.1': [2, 8], 'gpt-5.6-luna': [0.2, 1.2], 'gpt-5.6-terra': [2, 12], 'gpt-5.6-sol': [4, 20], 'gpt-5.4-mini': [0.75, 4.5], 'gpt-5.5': [5, 30] };
const OPENAI = (process.env.BENCH_OPENAI || 'gpt-4.1-mini,gpt-4.1').split(',').filter(Boolean).map((model) => ({ provider: 'openai', model, key: 'OPENAI_API_KEY', price: { input: (OPENAI_PRICES[model] || [0, 0])[0], output: (OPENAI_PRICES[model] || [0, 0])[1] } }));
const ANTHROPIC_PRICES = { 'claude-haiku-5-5': [0.1, 0.5], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20], 'claude-haiku-4-5-20251001': [1, 5] };
const ANTHROPIC = (process.env.BENCH_ANTHROPIC || 'claude-haiku-5-5,claude-sonnet-5-5').split(',').filter(Boolean).map((model) => ({ provider: 'anthropic', model, key: 'ANTHROPIC_API_KEY', price: { input: (ANTHROPIC_PRICES[model] || [0, 0])[0], output: (ANTHROPIC_PRICES[model] || [0, 0])[1] } }));
const META = (process.env.BENCH_META || 'muse-spark-1.3,muse-spark-1.2').split(',').filter(Boolean).map((s) => { const [model, effort] = s.split('@'); return { provider: 'meta', model, effort, key: 'MODEL_API_KEY', label: effort ? `${model}@${effort}` : model }; });
const MODELS = [
  ...META,
  ...OPENAI,
  ...ANTHROPIC,
].filter((m) => want.includes(m.provider) && process.env[m.key]).map((m) => ({ label: m.model, ...m }));
for (const m of MODELS) if (m.provider === 'meta' && meta.PRICES[m.model] && meta.PRICES[m.model].contributor) { console.error(m.model + ' is Contributor mode (Meta may train on inputs): not used in the benchmark'); process.exit(1); }

// ---- photos
// BENCH_DISTRACTORS=1: save 9 generated models (house, tower, robot...) to a temp data dir first, so
// every model chooses among 12 saved models instead of 3 (harder, closer to a real user's shelf).
if (process.env.BENCH_DISTRACTORS === '1') {
  process.env.LEGO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-data-'));
  const I = require('../lib/ideas.cjs');
  const stock = [];
  for (const c of ['red', 'white', 'blue', 'yellow', 'black', 'lbg', 'dbg', 'green', 'orange', 'tan']) for (const id of ['3001', '3003', '3004', '3010', '3009', '3008', '3020', '3022', '3023', '3024', '3039', '3040', '3005', '3622', '3710', '3666', '3795', '3034', '3460', '3069b', '3068b', '3070b', '3665', '3298', '3038', '2412b', '3958', '3832', '4073', '98138', '2357', '3037', '3045', '4460', '3062b', '3941', '4032', '6141', '3741', '3742', '6143']) stock.push({ id, color: c, qty: 40 });
  for (const k of ['house', 'tower', 'robot', 'rocket', 'tree', 'mushroom', 'spaceship', 'firetruck', 'rover']) {
    try { const r = I.build(k, stock); core.saveModel({ ...r.model, name: 'shelf-' + k }); } catch (e) { console.log('distractor', k, 'skipped:', e.message.slice(0, 60)); }
  }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
const cases = [];
if (process.env.BENCH_DISTRACTORS === '1') {
  for (const k of ['shelf-house', 'shelf-tower', 'shelf-robot', 'shelf-spaceship']) {
    const f = path.join(dir, `${k}.png`);
    fs.writeFileSync(f, await nf.hero(core.loadModel(k), { size: 900, theta: 120 }));
    cases.push({ id: `${k}@120° (render)`, file: f, expected: k, real: false });
  }
}
for (const name of ['cat', 'microduck', 'cottage']) {
  for (const theta of [75, 160, 250]) {
    const f = path.join(dir, `${name}-${theta}.png`);
    fs.writeFileSync(f, await nf.hero(core.loadModel(name), { size: 900, theta }));
    cases.push({ id: `${name}@${theta}° (render)`, file: f, expected: name, real: false });
  }
}
for (const f of (process.env.BENCH_REAL || '').split(',').filter(Boolean)) cases.push({ id: path.basename(f) + ' (real photo)', file: f, expected: 'none', real: true });

const list = an.candidates();
const names = list.map((c) => c.name);
const schema = an.schemaFor(names);
const text = an.prompt(list, '');
const pics = {};
for (const c of cases) pics[c.file] = await an.preparePhoto(c.file);

// ---- one call per provider, all with the same JSON schema
async function callOpenAI(m, dataUrl) {
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ model: m.model, input: [{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: dataUrl }] }], text: { format: { type: 'json_schema', name: 'lego_photo_analysis', schema, strict: true } }, max_output_tokens: 4000, ...(/^(gpt-5|o\d)/.test(m.model) ? { reasoning: { effort: 'low' } } : {}) }),
    signal: AbortSignal.timeout(90000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('openai ' + r.status + ' ' + (j.error && j.error.message || '').slice(0, 120));
  const u = j.usage || {};
  return { json: JSON.parse(meta.outputText(j)), inTok: u.input_tokens, outTok: u.output_tokens, usd: (u.input_tokens * m.price.input + u.output_tokens * m.price.output) / 1e6 };
}
async function callAnthropic(m, dataUrl) {
  const [, mime, b64] = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: m.model, max_tokens: 4000, output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } }, { type: 'text', text }] }] }),
    signal: AbortSignal.timeout(90000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + (j.error && j.error.message || '').slice(0, 120));
  const tb = (j.content || []).find((c) => c.type === 'text');
  const u = j.usage || {};
  return { json: tb ? JSON.parse(tb.text) : null, inTok: u.input_tokens, outTok: u.output_tokens, usd: (u.input_tokens * m.price.input + u.output_tokens * m.price.output) / 1e6 };
}
async function callMeta(m, dataUrl) {
  const r = await meta.respond({ model: m.model, effort: m.effort, schema, schemaName: 'lego_photo_analysis', input: [{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: dataUrl }] }] });
  return { json: r.json, inTok: r.usage && r.usage.input_tokens, outTok: r.usage && r.usage.output_tokens, usd: r.costUsd };
}
const CALL = { meta: callMeta, openai: callOpenAI, anthropic: callAnthropic };

// ---- run
console.log(`${cases.length} photos x ${MODELS.length} models: ${MODELS.map((m) => m.label).join(', ')} (cap $${maxUsd})`);
const rows = [];
let spent = 0;
for (const m of MODELS) {
  for (const c of cases) {
    if (spent >= maxUsd) { console.log('cap reached'); break; }
    const t = Date.now();
    let row = { model: m.label, provider: m.provider, photo: c.id, real: c.real, expected: c.expected };
    try {
      const r = await CALL[m.provider](m, pics[c.file].dataUrl);
      const v = an.dtoSchema(names).safeParse(r.json);
      const a = v.success ? v.data : null;
      const top = a && a.is_lego_model && a.match_confidence !== 'none' && a.possible_model_names[0] ? a.possible_model_names[0] : 'none';
      spent += r.usd || 0;
      row = { ...row, ok: true, valid: !!a, top, correct: top === c.expected, confidence: a ? a.match_confidence : null, ms: Date.now() - t, in: r.inTok, out: r.outTok, usd: r.usd };
    } catch (e) {
      row = { ...row, ok: false, error: String(e.message || e).slice(0, 140), ms: Date.now() - t };
    }
    rows.push(row);
    process.stdout.write(`${row.model.padEnd(18)} ${c.id.padEnd(28)} ${row.ok ? (row.correct ? 'OK ' : 'NO ') + row.top : 'ERR ' + row.error}  ${row.ms}ms\n`);
  }
}
const pct = (a) => { const s = [...a].sort((x, y) => x - y); return (q) => s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
const summary = MODELS.map((m) => {
  const r = rows.filter((x) => x.model === m.label);
  const done = r.filter((x) => x.ok);
  const p = pct(done.map((x) => x.ms));
  const known = done.filter((x) => x.expected !== 'none'); const unknown = done.filter((x) => x.expected === 'none');
  return {
    model: m.label, provider: m.provider, runs: r.length, errors: r.length - done.length,
    accuracy: `${done.filter((x) => x.correct).length}/${r.length}`,
    known_models: `${known.filter((x) => x.correct).length}/${known.length}`,
    unknown_no_match: `${unknown.filter((x) => x.correct).length}/${unknown.length}`,
    schema_valid: `${done.filter((x) => x.valid).length}/${done.length}`,
    p50_ms: p(0.5), p90_ms: p(0.9),
    usd_per_photo: done.length ? +(done.reduce((s, x) => s + (x.usd || 0), 0) / done.length).toFixed(5) : null,
  };
});
console.table(summary);
const out = path.join(ROOT, 'test/results', `bench-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`);
fs.writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), note: 'renders of built-in models at new angles + real photos of unknown builds; same prompt and schema for all', summary, rows }, null, 1));
console.log('saved', path.relative(ROOT, out), 'spent $' + spent.toFixed(4));
