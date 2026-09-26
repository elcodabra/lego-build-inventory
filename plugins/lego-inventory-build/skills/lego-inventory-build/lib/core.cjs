// Shared core for the CLI tools and the MCP server: models, the build check, the bill of
// materials (BOM), and the inventory of parts the user actually owns.
//
// Everything here is plain Node, no browser. Rendering lives in lib/film.cjs.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
global.window = global.window || global;
require(path.join(ROOT, 'src/lego.js'));
const LEGO = global.window.LEGO;
global.window.MODELS = global.window.MODELS || {};

const EPS = 1e-6;

// User data (inventory, saved models, renders) lives outside the skill folder so it survives
// plugin updates and is shared by the CLI tools and the MCP server: $LEGO_DATA_DIR or ~/.lego-build.
const DATA_DIR = path.resolve(process.env.LEGO_DATA_DIR || path.join(require('os').homedir(), '.lego-build'));

// ------------------------------------------------------------------ colours and parts

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/[\s_-]+/g, ' ');

// Colour aliases people and exports use for the same thing.
const COLOR_ALIASES = {
  'light gray': 'lbg', 'light grey': 'lbg', 'light bluish grey': 'lbg', 'medium stone grey': 'lbg', 'medium stone gray': 'lbg',
  'dark gray': 'dbg', 'dark grey': 'dbg', 'dark bluish grey': 'dbg', 'dark stone grey': 'dbg', 'dark stone gray': 'dbg',
  'bright red': 'red', 'bright blue': 'blue', 'bright yellow': 'yellow', 'dark green': 'darkGreen',
  'bright orange': 'orange', 'brick yellow': 'tan', 'sand yellow': 'darkTan', 'earth blue': 'darkBlue',
  'new dark red': 'darkRed', 'medium lilac': 'lavender', 'bright reddish violet': 'magenta',
  'flame yellowish orange': 'blo', 'bright light orange': 'blo', 'light orange': 'blo',
  'reddish brown': 'brown', 'bright green': 'brightGreen', 'medium azure': 'azure', 'bright pink': 'pink',
  'light pink': 'pink', 'dark pink': 'darkPink', 'bright yellowish green': 'lime',
};

// Resolve a colour given as key ('red'), name ('Light Bluish Gray', 'Светло-серый'),
// or catalogue id ({ bl: 86 } / { rb: 71 }). Returns the palette key or null.
function colorKey(c, idSystem) {
  if (c == null || c === '') return null;
  const C = LEGO.COLORS;
  if (typeof c === 'number' || /^\d+$/.test(String(c).trim())) {
    const n = Number(c);
    const sys = idSystem || 'bl';
    const hit = Object.values(C).find((x) => x[sys] === n);
    return hit ? hit.key : null;
  }
  const s = String(c).trim();
  if (C[s]) return s;
  const n = norm(s);
  for (const x of Object.values(C)) {
    if (norm(x.key) === n || norm(x.name) === n || norm(x.ru) === n) return x.key;
  }
  return COLOR_ALIASES[n] || null;
}

// Part number aliases: moulds with a/b suffixes and Rebrickable/BrickLink differences.
const PART_ALIASES = { '3044': '3044c', '3044b': '3044c', '3062b': '3062', '3062a': '3062', '4073a': '4073', '3070b': '3070', '98138pr': '98138', '87079a': '87079', '3069b': '3069', '3068b': '3068', '4032a': '4032', '4032b': '4032', '3941a': '3941', '6143': '3941' };
function partId(p) {
  const s = String(p == null ? '' : p).trim();
  if (LEGO.LIB[s]) return s;
  const low = s.toLowerCase();
  if (LEGO.LIB[low]) return low;
  if (PART_ALIASES[low]) return PART_ALIASES[low];
  return s;
}
const drawable = (id) => !!LEGO.LIB[id];

function catalog() {
  return {
    parts: LEGO.ORDER.map((id) => {
      const d = LEGO.LIB[id];
      return { id, name: d.ru, w: d.w, d: d.d, plates: Math.round(d.h / LEGO.PLATE), shape: d.kind === 'cyl' ? 'round' : d.profile.length === 4 ? (d.studs.length ? 'box' : 'tile') : 'slope', studs: d.studs.length };
    }),
    colors: Object.values(LEGO.COLORS).map((c) => ({ key: c.key, name: c.name, ru: c.ru, hex: c.hex, bricklink: c.bl, rebrickable: c.rb })),
  };
}

// ------------------------------------------------------------------ models

// A model is { title, theta?, phi?, steps: [[{ id, color, at: [x, y, z], rot?, up?, from? }, ...], ...] }.
// It can be a .js file that registers window.MODELS.<name> (the upstream format) or a .json file.
function modelDirs() {
  return [path.join(process.cwd(), 'models'), path.join(DATA_DIR, 'models'), path.join(ROOT, 'src/models')];
}

function resolveModelFile(ref) {
  if (/[\\/]/.test(ref) || /\.(js|json)$/.test(ref)) {
    const p = path.resolve(ref);
    if (fs.existsSync(p)) return p;
    throw new Error(`model file not found: ${p}`);
  }
  for (const dir of modelDirs()) {
    for (const ext of ['.json', '.js']) {
      const p = path.join(dir, ref + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error(`no model "${ref}" in ${modelDirs().join(', ')}`);
}

function loadModel(ref) {
  if (ref && typeof ref === 'object') return validateModel(ref);
  const file = resolveModelFile(ref);
  const name = path.basename(file).replace(/\.(js|json)$/, '');
  if (file.endsWith('.json')) return validateModel(JSON.parse(fs.readFileSync(file, 'utf8')), name);
  delete require.cache[file];
  require(file);
  const m = global.window.MODELS[name];
  if (!m) throw new Error(`${file} does not register window.MODELS.${name}`);
  return validateModel(m, name);
}

function listModels() {
  const seen = new Map();
  for (const dir of modelDirs()) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(.+)\.(js|json)$/);
      if (m && !seen.has(m[1])) seen.set(m[1], path.join(dir, f));
    }
  }
  return [...seen].map(([name, file]) => ({ name, file }));
}

function validateModel(m, name) {
  if (!m || !Array.isArray(m.steps) || !m.steps.length) throw new Error('model needs a non-empty "steps" array of steps');
  const errors = [];
  m.steps.forEach((st, i) => {
    if (!Array.isArray(st) || !st.length) errors.push(`step ${i + 1} must be a non-empty array of parts`);
    else st.forEach((s, j) => {
      const where = `step ${i + 1} part ${j + 1}`;
      if (!s || typeof s !== 'object') return errors.push(`${where}: not an object`);
      s.id = partId(s.id);
      if (!LEGO.LIB[s.id]) errors.push(`${where}: part ${s.id} is not in the drawable library (see catalog)`);
      const ck = colorKey(s.color);
      if (!ck) errors.push(`${where}: unknown colour ${s.color}`);
      else s.color = ck;
      if (!Array.isArray(s.at) || s.at.length !== 3 || s.at.some((v) => typeof v !== 'number')) errors.push(`${where}: "at" must be [x, y, zPlates]`);
    });
  });
  if (errors.length) {
    const e = new Error('invalid model:\n' + errors.join('\n'));
    e.problems = errors;
    throw e;
  }
  return Object.assign({ title: name || 'Model', theta: 40, phi: 30 }, m, { name: m.name || name });
}

// Bill of materials: [{ id, color, qty, name }], sorted by colour then part.
function bom(model) {
  const map = new Map();
  for (const s of model.steps.flat()) {
    const k = s.id + '|' + s.color;
    map.set(k, (map.get(k) || 0) + 1);
  }
  return [...map].map(([k, qty]) => {
    const [id, color] = k.split('|');
    return { id, color, qty, name: LEGO.LIB[id] ? LEGO.LIB[id].ru : id };
  }).sort((a, b) => a.color.localeCompare(b.color) || a.id.localeCompare(b.id));
}

// The geometric check from upstream: no overlaps, everything held by a chain of stud
// connections down to the ground.
function checkGeometry(model) {
  const specs = model.steps.flat();
  const parts = specs.map((s) => LEGO.place(s));
  const box = (p) => {
    const d = p.def;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const x of [0, d.w]) for (const y of [0, d.d]) for (const z of [0, d.h]) {
      const v = [0, 1, 2].map((k) => p.M[k][0] * x + p.M[k][1] * y + p.M[k][2] * z + p.off[k]);
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
    }
    return { lo, hi };
  };
  const B = parts.map(box);
  const stepOf = specs.map((s) => 1 + model.steps.findIndex((st) => st.includes(s)));
  const label = (i) => `step ${stepOf[i]}: ${specs[i].id} ${specs[i].color} at [${specs[i].at}]`;
  const overlap = (a, b, k) => Math.min(a.hi[k], b.hi[k]) - Math.max(a.lo[k], b.lo[k]);
  const sideAxis = (i) => {
    const up = specs[i].up;
    return !up || up === '+z' ? -1 : 'xyz'.indexOf(up[1]);
  };
  const problems = [];
  const links = B.map(() => []);
  for (let i = 0; i < B.length; i++) {
    for (let j = i + 1; j < B.length; j++) {
      const a = B[i];
      const b = B[j];
      if ([0, 1, 2].every((k) => overlap(a, b, k) > EPS)) {
        problems.push({ type: 'overlap', message: 'OVERLAP  ' + label(i) + '  |  ' + label(j) });
        continue;
      }
      const stacked = overlap(a, b, 0) > EPS && overlap(a, b, 1) > EPS &&
        (Math.abs(a.hi[2] - b.lo[2]) < EPS || Math.abs(b.hi[2] - a.lo[2]) < EPS);
      let side = false;
      for (const [p, q] of [[i, j], [j, i]]) {
        const k = sideAxis(p);
        if (k < 0) continue;
        const others = [0, 1, 2].filter((m) => m !== k);
        const touching = Math.abs(B[p].hi[k] - B[q].lo[k]) < EPS || Math.abs(B[p].lo[k] - B[q].hi[k]) < EPS;
        if (touching && others.every((m) => overlap(B[p], B[q], m) > EPS)) side = true;
      }
      if (stacked || side) { links[i].push(j); links[j].push(i); }
    }
  }
  const held = new Uint8Array(B.length);
  const queue = [];
  B.forEach((b, i) => { if (Math.abs(b.lo[2]) < EPS) { held[i] = 1; queue.push(i); } });
  while (queue.length) {
    const i = queue.shift();
    for (const j of links[i]) if (!held[j]) { held[j] = 1; queue.push(j); }
  }
  held.forEach((h, i) => { if (!h) problems.push({ type: 'floats', message: 'FLOATS   ' + label(i) }); });
  return { parts: parts.length, steps: model.steps.length, problems };
}

// ------------------------------------------------------------------ inventory

// Inventory file: { updated, sources: [...], items: [{ id, color, qty, name? }] }.
// Items whose part is not in the drawable library are kept (the user owns them), but
// flagged so the model is designed from drawable parts only.
// Where: $LEGO_INVENTORY, else ./inventory.json if it exists, else <data dir>/inventory.json.
function defaultInventoryPath() {
  if (process.env.LEGO_INVENTORY) return path.resolve(process.env.LEGO_INVENTORY);
  const local = path.resolve('inventory.json');
  if (fs.existsSync(local)) return local;
  return path.join(DATA_DIR, 'inventory.json');
}

function loadInventory(file) {
  const p = file || defaultInventoryPath();
  if (!fs.existsSync(p)) return { file: p, updated: null, sources: [], items: [] };
  const inv = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Object.assign({ sources: [], items: [] }, inv, { file: p });
}

function saveInventory(inv) {
  const out = { updated: new Date().toISOString(), sources: inv.sources || [], items: mergeItems(inv.items) };
  fs.mkdirSync(path.dirname(inv.file), { recursive: true });
  fs.writeFileSync(inv.file, JSON.stringify(out, null, 2) + '\n');
  return Object.assign(out, { file: inv.file });
}

function mergeItems(items) {
  const map = new Map();
  for (const it of items) {
    if (!it || !it.qty) continue;
    const k = it.id + '|' + it.color;
    const prev = map.get(k);
    if (prev) prev.qty += it.qty;
    else map.set(k, { id: it.id, color: it.color, qty: it.qty, ...(it.name ? { name: it.name } : {}) });
  }
  return [...map.values()].filter((x) => x.qty > 0).sort((a, b) => a.color.localeCompare(b.color) || a.id.localeCompare(b.id));
}

function invMap(inv) {
  const m = new Map();
  for (const it of inv.items) m.set(it.id + '|' + it.color, (m.get(it.id + '|' + it.color) || 0) + it.qty);
  return m;
}

// Parse rows from text. Formats:
//  csv   : part,color,qty (header optional; colour as key, name or BrickLink id)
//  rebrickable : Rebrickable CSV export (Part,Color,Quantity with Rebrickable colour ids)
//  bricklink   : BrickLink wanted-list / inventory XML (<ITEM><ITEMID><COLOR><MINQTY|QTY>)
//  json  : [{ id|part, color, qty|quantity }]
function parseInventory(text, format) {
  const fmt = format || sniffFormat(text);
  const rows = [];
  if (fmt === 'bricklink') {
    for (const m of text.matchAll(/<ITEM>([\s\S]*?)<\/ITEM>/gi)) {
      const tag = (t) => { const r = m[1].match(new RegExp(`<${t}>([^<]*)</${t}>`, 'i')); return r ? r[1].trim() : null; };
      if ((tag('ITEMTYPE') || 'P').toUpperCase() !== 'P') continue;
      rows.push({ part: tag('ITEMID'), color: tag('COLOR'), qty: Number(tag('MINQTY') || tag('QTY') || 1), sys: 'bl' });
    }
  } else if (fmt === 'json') {
    const data = JSON.parse(text);
    for (const r of Array.isArray(data) ? data : data.items || []) rows.push({ part: r.id || r.part || r.part_num, color: r.color, qty: Number(r.qty || r.quantity || 1), sys: r.colorSystem || 'bl' });
  } else {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const split = (l) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    let cols = { part: 0, color: 1, qty: 2 };
    let start = 0;
    const head = split(lines[0] || '').map((h) => h.toLowerCase());
    if (head.some((h) => /part|item|design|деталь/.test(h))) {
      const find = (re, def) => { const i = head.findIndex((h) => re.test(h)); return i < 0 ? def : i; };
      cols = { part: find(/part|item|design|деталь/, 0), color: find(/colou?r|цвет/, 1), qty: find(/qty|quantity|count|кол/, 2) };
      start = 1;
    }
    const sys = fmt === 'rebrickable' ? 'rb' : 'bl';
    for (const l of lines.slice(start)) {
      const c = split(l);
      rows.push({ part: c[cols.part], color: c[cols.color], qty: Number(c[cols.qty] || 1), sys });
    }
  }
  const items = [];
  const unknownColors = [];
  for (const r of rows) {
    if (!r.part || !(r.qty > 0)) continue;
    const color = colorKey(r.color, r.sys);
    const id = partId(r.part);
    if (!color) { unknownColors.push(`${r.part} colour ${r.color} ×${r.qty}`); continue; }
    items.push({ id, color, qty: r.qty });
  }
  return { format: fmt, items, unknownColors };
}

function sniffFormat(text) {
  const t = text.trim();
  if (t.startsWith('<')) return 'bricklink';
  if (t.startsWith('[') || t.startsWith('{')) return 'json';
  const head = t.split(/\r?\n/)[0].toLowerCase();
  if (/part,\s*color,\s*quantity/.test(head)) return 'rebrickable';
  return 'csv';
}

// Parts of a set from the Rebrickable API (needs REBRICKABLE_API_KEY, free at rebrickable.com/api).
async function fetchSet(setNum, apiKey) {
  const key = apiKey || process.env.REBRICKABLE_API_KEY;
  if (!key) throw new Error('set this env var first: REBRICKABLE_API_KEY (free key at https://rebrickable.com/api/)');
  const num = /-\d+$/.test(setNum) ? setNum : setNum + '-1';
  let url = `https://rebrickable.com/api/v3/lego/sets/${encodeURIComponent(num)}/parts/?page_size=1000&inc_minifig_parts=1`;
  const items = [];
  const skipped = [];
  let name = num;
  try {
    const r = await fetch(`https://rebrickable.com/api/v3/lego/sets/${encodeURIComponent(num)}/`, { headers: { Authorization: 'key ' + key } });
    if (r.ok) name = `${num} ${(await r.json()).name}`;
  } catch { /* name is optional */ }
  while (url) {
    const r = await fetch(url, { headers: { Authorization: 'key ' + key } });
    if (!r.ok) throw new Error(`Rebrickable ${r.status} for set ${num}: ${(await r.text()).slice(0, 200)}`);
    const page = await r.json();
    for (const p of page.results) {
      if (p.is_spare) continue;
      const blIds = (p.part.external_ids && p.part.external_ids.BrickLink) || [];
      const cands = [p.part.part_num, ...blIds].map(partId);
      const id = cands.find(drawable) || blIds[0] || p.part.part_num;
      const color = colorKey(p.color.id, 'rb') || colorKey(p.color.name);
      if (!color) { skipped.push(`${id} ${p.color.name} ×${p.quantity}`); continue; }
      items.push({ id, color, qty: p.quantity, name: p.part.name });
    }
    url = page.next;
  }
  return { set: name, items, skipped };
}

function summarizeInventory(inv) {
  const items = mergeItems(inv.items);
  const draw = items.filter((x) => drawable(x.id));
  const byColor = {};
  for (const it of draw) byColor[it.color] = (byColor[it.color] || 0) + it.qty;
  return {
    file: inv.file,
    updated: inv.updated,
    sources: inv.sources,
    totalParts: items.reduce((s, x) => s + x.qty, 0),
    drawableParts: draw.reduce((s, x) => s + x.qty, 0),
    byColor,
    drawable: draw.map((x) => ({ ...x, name: LEGO.LIB[x.id].ru })),
    notDrawable: items.filter((x) => !drawable(x.id)),
  };
}

// Compare a model's BOM with the inventory; suggest substitutes for what is missing.
function fitInventory(model, inv) {
  const have = invMap(inv);
  const need = bom(model);
  // spare = what is left after the model takes its own parts, so substitutes are really free
  const spare = new Map(have);
  for (const n of need) spare.set(n.id + '|' + n.color, Math.max(0, (spare.get(n.id + '|' + n.color) || 0) - n.qty));
  for (const [k, v] of spare) if (!v) spare.delete(k);
  const missing = [];
  for (const n of need) {
    const h = have.get(n.id + '|' + n.color) || 0;
    if (h < n.qty) missing.push({ ...n, have: h, short: n.qty - h, alternatives: alternatives(n, spare) });
  }
  return { ok: missing.length === 0, needed: need, missing, totalNeeded: need.reduce((s, x) => s + x.qty, 0), totalShort: missing.reduce((s, x) => s + x.short, 0) };
}

// Spare parts: the same part in other colours, or a part with the same footprint/height in the same colour.
function alternatives(n, have) {
  const d = LEGO.LIB[n.id];
  const out = [];
  for (const [k, qty] of have) {
    const [id, color] = k.split('|');
    if (id === n.id && color !== n.color) out.push({ id, color, qty, why: 'same part, other colour' });
    const e = LEGO.LIB[id];
    if (d && e && id !== n.id && color === n.color && e.w === d.w && e.d === d.d && Math.abs(e.h - d.h) < 1e-6) out.push({ id, color, qty, why: `same size (${e.ru})` });
  }
  return out.sort((a, b) => b.qty - a.qty).slice(0, 6);
}

function fullCheck(model, inv) {
  const geo = checkGeometry(model);
  const res = { name: model.name, title: model.title, parts: geo.parts, steps: geo.steps, geometry: geo.problems };
  if (inv && inv.items.length) res.inventory = fitInventory(model, inv);
  res.ok = geo.problems.length === 0 && (!res.inventory || res.inventory.ok);
  return res;
}

function formatCheck(res) {
  const lines = res.geometry.map((p) => p.message);
  if (res.inventory) {
    for (const m of res.inventory.missing) {
      const alt = m.alternatives.length ? '   есть: ' + m.alternatives.map((a) => `${a.id} ${a.color} ×${a.qty}`).join(', ') : '';
      lines.push(`MISSING  ${m.id} ${m.color} (${m.name}) нужно ${m.qty}, есть ${m.have}, не хватает ${m.short}${alt}`);
    }
  }
  const geo = res.geometry.length ? `${res.geometry.length} geometry problem(s)` : 'no overlaps, everything is held';
  const inv = !res.inventory ? 'no inventory (use --inv)' : res.inventory.ok ? 'all parts are in the inventory' : `${res.inventory.totalShort} part(s) missing from inventory`;
  lines.push(`${res.name}: ${res.parts} parts, ${res.steps} steps, ${geo}, ${inv}`);
  return lines.join('\n');
}

function saveModel(model, dir) {
  const name = String(model.name || model.title || 'model').toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '-').replace(/^-|-$/g, '') || 'model';
  const d = dir || path.join(DATA_DIR, 'models');
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, name + '.json');
  const clean = { title: model.title, theta: model.theta, phi: model.phi, steps: model.steps };
  fs.writeFileSync(file, JSON.stringify(clean, null, 1) + '\n');
  return { name, file };
}

// Film length, same formula as booklet.js.
const duration = (model) => 0.55 + (model.step || 0.85) * model.steps.length + 0.45 + 3.6 + 1.5;

module.exports = {
  ROOT, DATA_DIR, LEGO, colorKey, partId, drawable, catalog,
  loadModel, listModels, validateModel, saveModel, bom, checkGeometry, duration,
  defaultInventoryPath, loadInventory, saveInventory, parseInventory, fetchSet, mergeItems,
  summarizeInventory, fitInventory, fullCheck, formatCheck,
};
