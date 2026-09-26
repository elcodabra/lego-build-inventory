// Tool definitions shared by the stdio/HTTP server (mcp/server.mjs) and the Vercel function
// (api/mcp.mjs). buildServer({ publish }) -> McpServer; publish(file) returns a public URL for a
// rendered file (or null when files are only local).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const core = require('../lib/core.cjs');
const film = require('../lib/film.cjs');
const ideas = require('../lib/ideas.cjs');
const photo = require('../lib/photo.cjs');

// Data dir is read per call (a serverless host switches it per request). The local server pins
// the inventory to the data dir, never ./inventory.json of whatever cwd it was started in.
const DATA = core.DATA_DIR;
if (!process.env.VERCEL) process.env.LEGO_INVENTORY = process.env.LEGO_INVENTORY || path.join(DATA, 'inventory.json');
const exportsDir = () => {
  const d = path.join(core.dataDir(), 'exports');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const EXPORTS = exportsDir();
fs.mkdirSync(path.join(DATA, 'models'), { recursive: true });

const GUIDE = [
  fs.readFileSync(path.join(core.ROOT, 'reference/modeling.md'), 'utf8'),
  fs.readFileSync(path.join(core.ROOT, 'reference/inventory.md'), 'utf8'),
].join('\n\n---\n\n');
const PHOTO_GUIDE = fs.readFileSync(path.join(core.ROOT, 'reference/photos.md'), 'utf8');

const INSTRUCTIONS = `LEGO builder that designs models ONLY from parts the user owns.
Photos of parts: one part per photo -> parts_from_photo (add=true). A pile/tray of many parts ->
look at the photo yourself, list parts as CSV "part,color,qty" per lego_photo_guide, show the list
to the user, then inventory_import. Then ideas_suggest -> offer 2-4 ideas -> idea_build -> model_preview.
Workflow for a custom model: 1) inventory_show (import with inventory_import / inventory_add_set if empty).
2) lego_guide once, to learn coordinates and rules. 3) Design a model as JSON steps using ONLY
(part, colour) pairs from the drawable inventory; build bottom-up, bricks +3 plates, plates +1.
4) model_check until geometry is clean and nothing is missing (use suggested alternatives).
5) model_preview to look at the final frame, fix what reads badly. 6) model_save, then model_render
for the mp4. Never invent printed parts. Be honest that a checked model was not built by hand.`;

// ------------------------------------------------------------------ schemas

const Part = z.object({
  id: z.string().describe('BrickLink part number from lego_catalog, e.g. "3001"'),
  color: z.string().describe('colour key from lego_catalog, e.g. "red", "lbg"'),
  at: z.array(z.number()).length(3).describe('[x, y, z]: x, y in studs, z in plates (brick = 3). Min corner after rotation'),
  rot: z.number().int().min(0).max(3).optional().describe('quarter turns around vertical'),
  up: z.enum(['+z', '-z', '-y', '+y', '+x', '-x']).optional().describe('studs direction for SNOT parts, "-y" faces the viewer'),
  from: z.array(z.number()).length(3).optional().describe('slide-in offset instead of dropping from above'),
}).passthrough();

const Model = z.object({
  title: z.string(),
  theta: z.number().optional().describe('camera azimuth, 35..45 looks from front right'),
  phi: z.number().optional().describe('camera elevation, ~30'),
  steps: z.array(z.array(Part).min(1)).min(1).describe('building steps bottom-up, 1..12 parts each'),
});

const ModelRef = {
  model: Model.optional().describe('the model itself'),
  name: z.string().optional().describe('or the name of a saved model (see model_list)'),
};

const pickModel = ({ model, name }) => {
  if (model) return core.loadModel(JSON.parse(JSON.stringify(model)));
  if (name) return core.loadModel(name);
  throw new Error('pass either "model" or "name"');
};

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const safe = (fn) => async (a) => {
  try {
    return await fn(a || {});
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
};

// ------------------------------------------------------------------ server

export { DATA, EXPORTS, film };

export function buildServer(opts) {
  const fileUrl = (opts && opts.publish) || (() => null);
  const s = new McpServer({ name: 'lego-inventory-build', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const ro = { readOnlyHint: true, openWorldHint: false };

  s.registerTool('lego_guide', {
    title: 'How to design a model',
    description: 'Modelling rules: coordinates, part placement, side studs, honest building, inventory rules. Read once before designing.',
    annotations: ro,
  }, safe(async () => text(GUIDE)));

  s.registerTool('lego_catalog', {
    title: 'Drawable parts and colours',
    description: 'All parts the engine can draw (id, name, size in studs, height in plates) and all colour keys with BrickLink/Rebrickable ids.',
    annotations: ro,
  }, safe(async () => text(core.catalog())));

  s.registerTool('inventory_show', {
    title: 'Show my parts',
    description: 'The user\'s parts: drawable ones grouped by colour (use only these in models) and parts the engine cannot draw.',
    annotations: ro,
  }, safe(async () => {
    const sum = core.summarizeInventory(core.loadInventory());
    if (!sum.totalParts) return text('Inventory is empty. Ask the user for a parts list (CSV part,color,qty, a Rebrickable CSV, BrickLink XML) or set numbers, then use inventory_import / inventory_add_set.');
    return text({ ...sum, notDrawable: sum.notDrawable.length > 60 ? `${sum.notDrawable.length} lines (not drawable, ignore for design)` : sum.notDrawable });
  }));

  s.registerTool('inventory_import', {
    title: 'Import parts list',
    description: 'Add parts from text. Formats: CSV "part,color,qty" (colour as key, name or BrickLink id), Rebrickable CSV export ("Part,Color,Quantity"), BrickLink XML, or JSON [{id,color,qty}].',
    inputSchema: {
      data: z.string().describe('file contents'),
      format: z.enum(['csv', 'rebrickable', 'bricklink', 'json']).optional().describe('auto-detected when omitted'),
      replace: z.boolean().optional().describe('replace the inventory instead of adding'),
      source: z.string().optional().describe('label, e.g. "box in the attic"'),
    },
    annotations: { destructiveHint: false, openWorldHint: false },
  }, safe(async ({ data, format, replace, source }) => {
    const inv = core.loadInventory();
    const r = core.parseInventory(data, format);
    if (replace) { inv.items = []; inv.sources = []; }
    inv.items.push(...r.items);
    inv.sources.push(source || `import ${r.format}`);
    const saved = core.saveInventory(inv);
    return text({ imported: r.items.length, format: r.format, skippedUnknownColours: r.unknownColors, inventoryLines: saved.items.length });
  }));

  s.registerTool('inventory_add_set', {
    title: 'Add a LEGO set',
    description: 'Add all parts of official sets by number (e.g. "31058" or "31058-1") via Rebrickable. Needs REBRICKABLE_API_KEY on the server.',
    inputSchema: { sets: z.array(z.string()).min(1) },
    annotations: { openWorldHint: true },
  }, safe(async ({ sets }) => {
    const inv = core.loadInventory();
    const out = [];
    for (const n of sets) {
      const r = await core.fetchSet(n);
      inv.items.push(...r.items);
      inv.sources.push(`set ${r.set}`);
      out.push({ set: r.set, parts: r.items.reduce((a, x) => a + x.qty, 0), skipped: r.skipped.length });
    }
    core.saveInventory(inv);
    return text(out);
  }));

  s.registerTool('inventory_update', {
    title: 'Add or remove parts',
    description: 'Change quantities by hand. Positive qty adds, negative removes.',
    inputSchema: { items: z.array(z.object({ id: z.string(), color: z.string(), qty: z.number().int() })).min(1) },
  }, safe(async ({ items }) => {
    const inv = core.loadInventory();
    const bad = [];
    for (const it of items) {
      const c = core.colorKey(it.color);
      if (!c) bad.push(it.color);
      else inv.items.push({ id: core.partId(it.id), color: c, qty: it.qty });
    }
    const saved = core.saveInventory(inv);
    return text({ ok: !bad.length, unknownColours: bad, inventoryLines: saved.items.length });
  }));

  s.registerTool('inventory_clear', {
    title: 'Clear inventory',
    description: 'Delete all parts from the inventory. Only when the user explicitly asks.',
    annotations: { destructiveHint: true },
  }, safe(async () => {
    const inv = core.loadInventory();
    const n = inv.items.length;
    inv.items = [];
    inv.sources = [];
    core.saveInventory(inv);
    return text(`cleared ${n} lines`);
  }));

  // ---------------------------------------------------------------- photos and ideas

  s.registerTool('lego_photo_guide', {
    title: 'How to read parts from photos',
    description: 'Use this before listing parts from a photo of a pile or tray: how to identify part numbers and colours by eye, and the CSV format for inventory_import.',
    annotations: ro,
  }, safe(async () => text(PHOTO_GUIDE)));

  // ChatGPT passes uploaded files as { download_url, file_id } objects (openai/fileParams).
  const FileObj = z.object({ download_url: z.string(), file_id: z.string(), mime_type: z.string().optional(), file_name: z.string().optional() });
  s.registerTool('parts_from_photo', {
    title: 'Recognise parts on photos',
    description: 'Use this when the user sends photos of SINGLE LEGO parts (one part per photo, plain background). Identifies the part number (Brickognize) and colour, and with add=true adds confident results to the inventory. For a photo of many parts at once, read the photo yourself instead (see lego_photo_guide) and use inventory_import.',
    inputSchema: {
      files: z.array(FileObj).optional().describe('uploaded photos (ChatGPT)'),
      images: z.array(z.string()).optional().describe('photos as URLs, file paths, data: URLs or base64'),
      add: z.boolean().optional().describe('add confident results to the inventory'),
      qty: z.number().int().min(1).optional().describe('how many of each photographed part the user has (default 1)'),
    },
    annotations: { openWorldHint: true },
    _meta: { 'openai/fileParams': ['files'] },
  }, safe(async ({ files, images, add, qty }) => {
    const srcs = [...(files || []).map((f) => f.download_url), ...(images || [])];
    if (!srcs.length) throw new Error('pass "files" or "images"');
    const inv = core.loadInventory();
    const out = [];
    for (const src of srcs.slice(0, 20)) {
      try {
        const r = await photo.identify(src);
        const added = !!(add && r.confident && !r.pile);
        if (added) inv.items.push({ id: r.part.id, color: r.color, qty: qty || 1 });
        out.push({ part: r.part && { id: r.part.id, name: r.part.name, score: r.part.score, drawable: r.part.drawable }, color: r.color, colorCandidates: r.colors.map((c) => c.color), otherParts: r.candidates.slice(1).map((c) => c.id), confident: r.confident, pile: r.pile, added, hint: r.hint });
      } catch (e) {
        out.push({ error: e.message });
      }
    }
    if (add) { inv.sources.push(`photos ×${out.filter((x) => x.added).length}`); core.saveInventory(inv); }
    return text({ results: out, next: 'Show the user what was recognised; ask about unconfident ones (fix with inventory_update). Then ideas_suggest.' });
  }));

  s.registerTool('ideas_suggest', {
    title: 'What can I build?',
    description: 'Use this when the user asks what they can build from their parts. Returns ideas that are buildable right now from the inventory (largest size that fits, colours picked from what they have) and ideas that are close, with the exact parts missing.',
    annotations: ro,
  }, safe(async () => {
    const s = ideas.suggest(core.loadInventory());
    if (!s.drawableParts) return text('Inventory is empty: ask for photos of the parts (parts_from_photo), a parts list (inventory_import) or set numbers (inventory_add_set).');
    return text({ ...s, next: 'Offer the user 2-4 of these. For the chosen one call idea_build, then model_preview to show it. You can also design a custom model from the same parts.' });
  }));

  s.registerTool('idea_build', {
    title: 'Build an idea',
    description: 'Generate the step-by-step model for an idea from ideas_suggest, from the user\'s parts. Saves it under the idea name, so model_preview / model_render work with name=<idea>.',
    inputSchema: {
      idea: z.enum(Object.keys(ideas.GENERATORS)),
      size: z.union([z.number().int(), z.string()]).optional().describe('sizeIndex or size label from ideas_suggest; default: largest that fits'),
      allowMissing: z.boolean().optional().describe('build even if parts are missing (lists what to add)'),
    },
  }, safe(async ({ idea, size, allowMissing }) => {
    const inv = core.loadInventory();
    const r = ideas.build(idea, inv, size, { shopping: !!allowMissing });
    const saved = core.saveModel({ ...r.model, name: idea });
    const check = core.fullCheck(core.loadModel(saved.file), inv);
    return text({ name: idea, title: r.model.title, size: r.size, parts: check.parts, steps: check.steps, notes: r.notes, missing: r.missing, ok: check.ok, next: `model_preview with name="${idea}"` });
  }));

  s.registerTool('model_check', {
    title: 'Check a model',
    description: 'Validates a model: unknown parts/colours, overlapping parts, floating parts, and parts missing from the inventory (with spare alternatives). Iterate until ok=true.',
    inputSchema: ModelRef,
    annotations: ro,
  }, safe(async (a) => {
    let m;
    try { m = pickModel(a); } catch (e) { return text({ ok: false, errors: e.problems || [e.message] }); }
    const res = core.fullCheck(m, core.loadInventory());
    return text({ ok: res.ok, summary: core.formatCheck(res).split('\n').pop(), parts: res.parts, steps: res.steps, geometry: res.geometry.map((p) => p.message), missing: res.inventory ? res.inventory.missing : 'no inventory' });
  }));

  s.registerTool('model_bom', {
    title: 'Parts list of a model',
    description: 'Bill of materials: every (part, colour, qty) the model uses.',
    inputSchema: { ...ModelRef, csv: z.boolean().optional() },
    annotations: ro,
  }, safe(async (a) => {
    const b = core.bom(pickModel(a));
    return text(a.csv ? 'part,color,qty\n' + b.map((x) => `${x.id},${core.LEGO.COLORS[x.color].name},${x.qty}`).join('\n') : b);
  }));

  s.registerTool('model_save', {
    title: 'Save a model',
    description: 'Save a model under a name so it can be rendered and reopened later.',
    inputSchema: { model: Model, name: z.string().regex(/^[a-z0-9_-]+$/i).describe('file name, latin letters/digits') },
  }, safe(async ({ model, name }) => {
    const m = core.loadModel(JSON.parse(JSON.stringify(model)));
    return text(core.saveModel({ ...m, name }));
  }));

  s.registerTool('model_list', {
    title: 'List models',
    description: 'Saved models and built-in examples (cat, microduck).',
    annotations: ro,
  }, safe(async () => text(core.listModels().map((x) => x.name))));

  s.registerTool('model_get', {
    title: 'Get a model',
    description: 'The JSON of a saved or example model, e.g. to learn from the examples or edit one.',
    inputSchema: { name: z.string() },
    annotations: ro,
  }, safe(async ({ name }) => {
    const m = core.loadModel(name);
    return text({ title: m.title, theta: m.theta, phi: m.phi, steps: m.steps });
  }));

  s.registerTool('model_preview', {
    title: 'Preview frames',
    description: 'Render PNG frames of the build film so you can look at the model. Default is the final frame. Times in seconds, negative from the end, or "final".',
    inputSchema: {
      ...ModelRef,
      times: z.array(z.union([z.number(), z.literal('final')])).max(4).optional(),
      format: z.enum(['vertical', 'horizontal']).optional(),
    },
    annotations: ro,
  }, safe(async (a) => {
    const m = pickModel(a);
    const shots = await film.snap(m, a.times && a.times.length ? a.times : ['final'], a.format);
    const base = (m.name || 'preview').replace(/[^a-z0-9_-]+/gi, '-');
    const links = shots.map((s) => {
      const f = path.join(exportsDir(), `${base}-${s.t.toFixed(2)}.png`);
      fs.writeFileSync(f, s.png);
      return f;
    });
    const urls = [];
    for (const f of links) urls.push((await fileUrl(f)) || f);
    return { content: [...shots.map((s) => ({ type: 'image', data: s.png.toString('base64'), mimeType: 'image/png' })), { type: 'text', text: `frames at ${shots.map((s) => s.t.toFixed(2)).join(', ')} s of ${core.duration(m).toFixed(2)} s\n${urls.join('\n')}` }] };
  }));

  s.registerTool('model_render', {
    title: 'Render build video',
    description: 'Render the full step-by-step build film to mp4 (takes ~10-60 s). Returns the file path and, over HTTP, a download link.',
    inputSchema: { ...ModelRef, format: z.enum(['vertical', 'horizontal']).optional() },
  }, safe(async (a) => {
    const m = pickModel(a);
    const base = (m.name || 'model').replace(/[^a-z0-9_-]+/gi, '-') + (a.format === 'horizontal' ? '-16x9' : '');
    const r = await film.render(m, path.join(exportsDir(), base + '.mp4'), { format: a.format });
    return text({ file: r.file, url: await fileUrl(r.file), seconds: +r.seconds.toFixed(2), frames: r.frames });
  }));

  return s;
}
