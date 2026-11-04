// Meta Muse Spark as a referee for pile recognition. The part recogniser (Brickognize) gives its top
// part numbers and colours for each crop; Muse Spark looks at a contact sheet of the crops and, for
// every crop, picks ONE of the offered part numbers and ONE of the offered colours (or keeps the
// recogniser's first choice). It never invents a part number: the schema only allows the offered
// options, so the answer stays inside the catalogue we can draw and count.
'use strict';
const meta = require('./meta.cjs');
const core = require('./core.cjs');

const MAX_CROPS = 48;
const CELL = 160;
const COLS = 8;

// contact sheet: numbered cells, one crop each
async function sheet(crops) {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const rows = Math.ceil(crops.length / COLS);
  const cv = createCanvas(COLS * CELL, rows * CELL);
  const x = cv.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < crops.length; i++) {
    const im = await loadImage(crops[i]);
    const k = Math.min((CELL - 8) / im.width, (CELL - 24) / im.height);
    const w = im.width * k; const h = im.height * k;
    const cx = (i % COLS) * CELL; const cy = Math.floor(i / COLS) * CELL;
    x.drawImage(im, cx + (CELL - w) / 2, cy + 20 + (CELL - 24 - h) / 2, w, h);
    x.fillStyle = '#d00'; x.font = 'bold 18px Inter'; x.fillText(String(i + 1), cx + 4, cy + 18);
    x.strokeStyle = '#ccc'; x.strokeRect(cx + 0.5, cy + 0.5, CELL - 1, CELL - 1);
  }
  return 'data:image/jpeg;base64,' + cv.toBuffer('image/jpeg', 85).toString('base64');
}

const colorName = (k) => { const c = Object.values(core.LEGO ? core.LEGO.COLORS : {}).find((v) => v.key === k); return c ? c.name : k; };

/**
 * refine(parts, { budget }) -> { parts (same order, id/color possibly changed, refined:true), changed, costUsd, model, responseId }
 * parts: results of photo.identifyBoxes(..., { keepCrops: true }) with crop, candidates, colors.
 */
async function refine(parts, { budget, fetchImpl, model } = {}) {
  if (!meta.available()) throw new meta.MetaError('META_UNAVAILABLE', 'Meta Model API is not configured on this server');
  const idx = parts.map((p, i) => i).filter((i) => parts[i].crop && parts[i].candidates && parts[i].candidates.length).slice(0, MAX_CROPS);
  if (!idx.length) return { parts, changed: 0, costUsd: 0 };
  const opts = idx.map((i) => {
    const p = parts[i];
    const ids = [...new Set(p.candidates.map((c) => c.id))].slice(0, 3);
    const cols = [...new Set((p.colors || []).map((c) => c.color).filter(Boolean))].slice(0, 3);
    if (p.color && !cols.includes(p.color)) cols.unshift(p.color);
    return { ids, names: ids.map((id) => (p.candidates.find((c) => c.id === id) || {}).name || id), cols };
  });
  const img = await sheet(idx.map((i) => parts[i].crop));
  const lines = opts.map((o, n) => `${n + 1}: parts ${o.ids.map((id, j) => `${String.fromCharCode(65 + j)}=${id} (${o.names[j]})`).join(', ')}; colours ${o.cols.map((c, j) => `${j + 1}=${colorName(c)}`).join(', ')}`);
  const text = `The image is a sheet of ${idx.length} numbered crops, each one LEGO part from a photo of loose parts.\nFor each crop a part recogniser proposed these options:\n${lines.join('\n')}\nFor every crop pick the part letter and colour number that best match what you SEE. Prefer the first options unless the crop clearly shows otherwise. Use only the offered options.`;
  const schema = {
    type: 'object', additionalProperties: false, required: ['picks'],
    properties: { picks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', 'part', 'colour'], properties: { n: { type: 'integer' }, part: { type: 'string', enum: ['A', 'B', 'C'] }, colour: { type: 'integer' } } } } },
  };
  const call = () => meta.respond({ model, fetchImpl, schema, schemaName: 'pile_referee', maxOutputTokens: 4000, input: [{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: img }] }] });
  const cfg = meta.config();
  const r = budget ? await budget.run(meta.maxCost(model || cfg.models[0], 4000, 4000), call) : await call();
  const out = parts.map((p) => ({ ...p }));
  let changed = 0;
  for (const pk of (r.json && r.json.picks) || []) {
    const n = pk.n - 1;
    if (!(n >= 0 && n < idx.length)) continue;
    const o = opts[n];
    const id = o.ids[pk.part.charCodeAt(0) - 65];
    const col = o.cols[pk.colour - 1];
    const p = out[idx[n]];
    if (id && id !== p.id) { p.id = id; p.name = o.names[o.ids.indexOf(id)]; changed++; }
    if (col && col !== p.color) { p.color = col; changed++; }
    p.refined = true;
  }
  return { parts: out, changed, costUsd: r.costUsd, model: r.model, responseId: r.id, ms: r.ms };
}

module.exports = { refine, sheet };
