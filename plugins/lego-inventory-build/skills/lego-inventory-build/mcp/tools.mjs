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

// Everything below reads the data dir per call (core.ctx on the multi-user host).
const exportsDir = () => {
  const d = path.join(core.dataDir(), 'exports');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const GUIDE = [
  fs.readFileSync(path.join(core.ROOT, 'reference/modeling.md'), 'utf8'),
  fs.readFileSync(path.join(core.ROOT, 'reference/inventory.md'), 'utf8'),
].join('\n\n---\n\n');
const PHOTO_GUIDE = fs.readFileSync(path.join(core.ROOT, 'reference/photos.md'), 'utf8');

const INSTRUCTIONS = `LEGO builder that designs models ONLY from parts the user owns.
Photos: pass the uploaded image FILE to the tools, do not describe it yourself and do not write a
parts list by eye (inventory_import is for text lists only). Many parts on one
photo -> parts_from_pile_photo (the server finds and recognises every part). One part per photo ->
parts_from_photo. Show the user the resulting list, fix doubts with inventory_update, then
ideas_suggest (a card with real pictures of each idea from the user's parts) -> idea_build -> show_build.
Never show pictures from the web or of official sets: they do not match what the user can build.
Be brief: the card shows the model and its parts, never retell steps or parts lists in text.
Show models ONLY with show_build cards drawn from the user's parts: never add pictures from the web
or other sets (they would not match what the user can build).
Offer "шаги картинками" (show_build mode=steps) or "видео" (mode=video); make them only on request.
Only if the file cannot be passed: read the photo yourself per lego_photo_guide and inventory_import.
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
  steps: z.array(z.array(Part).min(1).max(24)).min(1).max(60).describe('building steps bottom-up, 1..12 parts each (max 60 steps, 400 parts)'),
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

export { film };

export function buildServer(opts) {
  const fileUrl = (opts && opts.publish) || (() => null);
  const s = new McpServer({ name: 'lego-inventory-build', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  // All four hints on every tool (OpenAI's app directory requires explicit booleans).
  const hints = (readOnly, destructive, idempotent, openWorld) => ({ readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: openWorld });
  const ro = hints(true, false, true, false);

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
    description: 'Add parts from a TEXT list the user gave (not for photos: an uploaded photo goes to parts_from_pile_photo as a file). Formats: CSV "part,color,qty" (colour as key, name or BrickLink id), Rebrickable CSV export ("Part,Color,Quantity"), BrickLink XML, or JSON [{id,color,qty}].',
    inputSchema: {
      data: z.string().max(2_000_000).optional().describe('file contents'),
      text: z.string().max(2_000_000).optional().describe('same as data'),
      format: z.enum(['csv', 'rebrickable', 'bricklink', 'json']).optional().describe('auto-detected when omitted'),
      replace: z.boolean().optional().describe('replace the inventory instead of adding'),
      source: z.string().optional().describe('label, e.g. "box in the attic"'),
    },
    annotations: hints(false, true, false, false), // replace=true wipes the inventory
  }, safe(async ({ data, text: txt, format, replace, source }) => {
    data = data || txt;
    if (!data) throw new Error('pass the parts list in "data"');
    const inv = core.loadInventory();
    const r = core.parseInventory(data, format);
    if (replace) { inv.items = []; inv.sources = []; }
    inv.items.push(...r.items);
    inv.sources.push(source || `import ${r.format}`);
    const saved = core.saveInventory(inv);
    // a list written by eye from a photo is much worse than the server's recognition: say so
    const fromPhoto = /photo|фото|img_|\.heic|\.jpe?g|\.png/i.test(source || '');
    return text({ imported: r.items.length, format: r.format, skippedUnknownColours: r.unknownColors, inventoryLines: saved.items.length,
      ...(fromPhoto ? { warning: 'This list was read from a photo by eye. Pass the uploaded photo file to parts_from_pile_photo (replace=true) instead: the server finds and recognises far more parts.' } : {}) });
  }));

  s.registerTool('inventory_add_set', {
    title: 'Add a LEGO set',
    description: 'Add all parts of official sets by number (e.g. "31058" or "31058-1") via Rebrickable. Needs REBRICKABLE_API_KEY on the server.',
    inputSchema: { sets: z.array(z.string()).min(1) },
    annotations: hints(false, false, false, true),
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
    inputSchema: { items: z.array(z.object({ id: z.string().max(40), color: z.string().max(40), qty: z.number().int().min(-10000).max(10000) })).min(1).max(500) },
    annotations: hints(false, true, false, false), // negative qty removes parts
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

  s.registerTool('inventory_undo', {
    title: 'Bring back the previous parts list',
    description: 'Use this when the user wants the parts list from before the last photo or import back (a photo replaces the saved list). Swaps the current list with the previous one, so calling it again redoes.',
    annotations: hints(false, true, true, false),
  }, safe(async () => {
    const r = core.undoInventory();
    if (!r) return text('There is no previous parts list to bring back.');
    return text({ restored: true, totalParts: r.items.reduce((a, x) => a + x.qty, 0), sources: r.sources });
  }));

  s.registerTool('inventory_clear', {
    title: 'Clear inventory',
    description: 'Delete all parts from the inventory. Only when the user explicitly asks.',
    annotations: hints(false, true, true, false),
  }, safe(async () => {
    const inv = core.loadInventory();
    const n = inv.items.length;
    inv.items = [];
    inv.sources = [];
    core.saveInventory(inv);
    return text(`cleared ${n} lines`);
  }));

  // card widget: shared by the ideas list and every visual tool (declared before the tools use it)
  const PLAYER_URI = 'ui://lego/card-v5.html';
  const colorInfo = (k) => core.LEGO.COLORS[k] || { hex: '#999', ru: k };
  // Every tool that produces something visual answers with the same card, so the user sees the
  // model whichever of them the chat model happens to pick.
  const cardMeta = {
    ui: { resourceUri: PLAYER_URI },
    'openai/outputTemplate': PLAYER_URI,
    'openai/widgetAccessible': true,
    'openai/toolInvocation/invoking': 'Рисую…',
    'openai/toolInvocation/invoked': 'Готово',
  };

  // ---------------------------------------------------------------- photos and ideas

  s.registerTool('lego_photo_guide', {
    title: 'How to read parts from photos',
    description: 'FALLBACK ONLY. Do not use when the user uploaded a photo: pass the file to parts_from_pile_photo instead (the server recognises the parts far better than reading them by eye). Use this only if a photo cannot be passed as a file: how to identify part numbers and colours by eye, and the CSV format for inventory_import.',
    annotations: ro,
  }, safe(async () => text(PHOTO_GUIDE)));

  // ChatGPT passes uploaded files as { download_url, file_id } objects (openai/fileParams).
  const FileObj = z.object({ download_url: z.string(), file_id: z.string(), mime_type: z.string().optional(), file_name: z.string().optional() });
  s.registerTool('parts_from_photo', {
    title: 'Recognise parts on photos',
    description: 'Use this when the user sends photos of SINGLE LEGO parts (one part per photo). Identifies the part number (Brickognize) and colour, and with add=true adds confident results to the inventory. For a photo with many parts use parts_from_pile_photo.',
    inputSchema: {
      files: z.array(FileObj).optional().describe('uploaded photos (ChatGPT)'),
      images: z.array(z.string()).optional().describe('photos as URLs, file paths, data: URLs or base64'),
      add: z.boolean().optional().describe('add confident results to the inventory'),
      qty: z.number().int().min(1).optional().describe('how many of each photographed part the user has (default 1)'),
    },
    annotations: hints(false, false, false, true),
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

  s.registerTool('parts_from_pile_photo', {
    title: 'Recognise a pile of parts',
    description: 'Use this whenever the user uploads a photo with MANY LEGO parts (laid out on a table, a tray, a pile), before anything else. Pass the uploaded file, do not read the photo yourself. The server finds every separate part on the photo, recognises each one (part number + colour) and returns the counts. By default the recognised parts REPLACE the saved list (a new photo is the pile the user has now; the previous list is kept for inventory_undo). Pass mode="add" only when the user says the photo shows MORE parts in addition to what was saved (e.g. a second photo of the same pile in one go: send all photos in one call instead). Works best when parts do not touch and the background is plain. Takes 5-40 s.',
    inputSchema: {
      files: z.array(FileObj).optional().describe('uploaded photos (ChatGPT)'),
      images: z.array(z.string()).optional().describe('photos as URLs, file paths, data: URLs or base64'),
      mode: z.enum(['replace', 'add', 'none']).optional().describe('replace (default): the photo becomes the parts list; add: add to the saved list; none: only show what was recognised'),
      add: z.boolean().optional().describe('deprecated: false = mode "none"'),
      replace: z.boolean().optional().describe('deprecated: true = mode "replace"'),
    },
    annotations: hints(false, true, false, true), // replaces the saved list (undo with inventory_undo)
    _meta: { 'openai/fileParams': ['files'] },
  }, safe(async ({ files, images, mode, add, replace }) => {
    const srcs = [...(files || []).map((f) => f.download_url), ...(images || [])];
    if (!srcs.length) throw new Error('pass "files" (the uploaded photo) or "images"');
    const md = mode || (add === false ? 'none' : replace === false ? 'add' : 'replace');
    const inv = core.loadInventory();
    const photos = [];
    const all = new Map();
    for (const src of srcs.slice(0, 6)) {
      let r;
      try {
        r = await photo.identifyPile(src);
      } catch (e) {
        photos.push({ error: e.message });
        continue;
      }
      photos.push({ found: r.found, recognised: r.recognised, failed: r.parts.filter((p) => p.error).length });
      for (const it of r.items) {
        const k = it.id + '|' + it.color;
        const v = all.get(k) || { ...it, qty: 0, unsure: 0 };
        v.qty += it.qty;
        v.unsure += it.unsure;
        all.set(k, v);
      }
    }
    const items = [...all.values()];
    let previous;
    if (md !== 'none' && items.length) {
      if (md === 'replace' && inv.items.length) {
        core.backupInventory(inv);
        previous = inv.items.reduce((a, x) => a + x.qty, 0);
        inv.items = []; inv.sources = [];
      }
      inv.items.push(...items.map((it) => ({ id: it.id, color: it.color, qty: it.qty })));
      inv.sources.push(`pile photo ×${srcs.length}`);
      core.saveInventory(inv);
    }
    const total = items.reduce((a, x) => a + x.qty, 0);
    return text({
      photos,
      totalParts: total,
      parts: items.map((it) => ({ id: it.id, name: it.name, color: it.color, qty: it.qty, unsure: it.unsure || undefined, drawable: core.drawable(it.id) })),
      mode: md,
      added: md !== 'none' && items.length > 0,
      ...(previous ? { replacedPrevious: `${previous} parts saved before were replaced by this photo (inventory_undo brings them back)` } : {}),
      next: 'Show this list to the user as a table (part, name, colour, qty), mention unsure lines and that touching parts may be counted as one. Fix with inventory_update if the user corrects it. Then ideas_suggest.' +
        (previous ? ' Tell the user in one short line that the old list was replaced and can be restored.' : ''),
    });
  }));

  s.registerTool('ideas_suggest', {
    title: 'What can I build?',
    description: 'Use this when the user asks what they can build from their parts. Shows the ideas as a card with a REAL picture of each model built from the user\'s own parts (and a «Собрать» button), plus ideas that are close with the exact parts missing. ' +
      'The card is the answer: never add pictures from the web or of official sets, and do not invent ideas that are not in the list.',
    annotations: ro,
    _meta: cardMeta,
  }, safe(async () => {
    const inv = core.loadInventory();
    const s = ideas.suggest(inv);
    if (!s.drawableParts) return text('Inventory is empty: ask for photos of the parts (parts_from_photo), a parts list (inventory_import) or set numbers (inventory_add_set).');
    // a thumbnail of every buildable idea, built from these very parts (same generator as idea_build)
    const nf = require('../lib/nodefilm.cjs');
    const list = s.buildable.slice(0, 6);
    const thumbs = await Promise.all(list.map(async (b) => {
      try {
        const r = ideas.build(b.idea, inv, b.sizeIndex);
        const f = path.join(exportsDir(), `idea-${b.idea}-${b.sizeIndex}-thumb.png`);
        fs.writeFileSync(f, await nf.hero(r.model, { size: 360, trim: true }));
        return await fileUrl(f);
      } catch { return null; }
    }));
    const data = {
      kind: 'ideas', name: 'ideas', title: 'Что собрать из твоих деталей', drawableParts: s.drawableParts,
      ideas: list.map((b, i) => ({ idea: b.idea, title: b.title, about: b.about, parts: b.parts, steps: b.steps, usesPercent: b.usesPercent, thumbUrl: thumbs[i] || null })),
      almost: s.almost.slice(0, 2).map((a) => ({ idea: a.idea, title: a.title, missing: (a.missing || []).slice(0, 4).map((m) => ({ name: m.name || m.id, color: colorInfo(m.color).ru, qty: m.qty })) })),
    };
    return {
      structuredContent: data,
      content: [{ type: 'text', text: JSON.stringify({ recommended: s.buildable[0] ? `${s.buildable[0].idea} (${s.buildable[0].parts} parts, ${s.buildable[0].usesPercent}% of the pile)` : undefined, ...s,
        next: 'The ideas card with real pictures of each model (built from the user\'s parts) is shown to the user. Answer in one or two sentences: recommend the first idea (it uses the most parts) with its part count. ' +
          'Do NOT show any other pictures (no web images, no official sets) and do not invent other models: if the user wants something else, design it from the inventory (lego_guide, model_check). ' +
          'When the user picks one (or presses «Собрать»): idea_build, then show_build.' }) },
        ...(thumbs.some(Boolean) ? [{ type: 'text', text: `Если карточки не видно (агент, чат с навыками), вставь эти картинки как markdown, они нарисованы из деталей пользователя:\n${list.map((b, i) => (thumbs[i] ? `![${b.title}](${thumbs[i]})` : '')).filter(Boolean).join('\n')}` }] : [])],
    };
  }));

  s.registerTool('idea_build', {
    title: 'Build an idea',
    description: 'Generate the step-by-step model for an idea from ideas_suggest, from the user\'s parts. Saves it under the idea name, so model_preview / model_render work with name=<idea>.',
    inputSchema: {
      idea: z.enum(Object.keys(ideas.GENERATORS)),
      size: z.union([z.number().int(), z.string()]).optional().describe('sizeIndex or size label from ideas_suggest; default: largest that fits'),
      allowMissing: z.boolean().optional().describe('build even if parts are missing (lists what to add)'),
    },
    annotations: hints(false, false, true, false), // overwrites the saved model of that idea with the same result
    _meta: { 'openai/widgetAccessible': true }, // the ideas card's «Собрать» button calls it
  }, safe(async ({ idea, size, allowMissing }) => {
    const inv = core.loadInventory();
    const r = ideas.build(idea, inv, size, { shopping: !!allowMissing });
    const saved = core.saveModel({ ...r.model, name: idea });
    const check = core.fullCheck(core.loadModel(saved.name), inv);
    return text({ name: idea, title: r.model.title, size: r.size, parts: check.parts, steps: check.steps, notes: r.notes, missing: r.missing, ok: check.ok, next: `show_build with name="${idea}" (picture card). Show only this card, no other images.` });
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
    annotations: hints(false, true, true, false), // overwrites a saved model with the same name
  }, safe(async ({ model, name }) => {
    const m = core.loadModel(JSON.parse(JSON.stringify(model)));
    const saved = core.saveModel({ ...m, name });
    return text({ name: saved.name, saved: true, next: `show_build with name="${saved.name}"` });
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

  // ---------------------------------------------------------------- inline player (MCP Apps)

  const mediaOrigin = (opts && opts.mediaOrigin) || null;
  s.registerResource('lego-player', PLAYER_URI, { title: 'LEGO build player', mimeType: 'text/html;profile=mcp-app' }, async () => ({
    contents: [{
      uri: PLAYER_URI,
      mimeType: 'text/html;profile=mcp-app',
      text: fs.readFileSync(path.join(core.ROOT, 'mcp/player.html'), 'utf8'),
      _meta: {
        ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: mediaOrigin ? [mediaOrigin] : [] } },
        'openai/widgetCSP': { connect_domains: [], resource_domains: mediaOrigin ? [mediaOrigin] : [] },
        'openai/widgetDescription': 'Shows the build: the step-by-step video (or the final picture) and the parts list. No need to repeat the parts list in text.',
        'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] },
      },
    }],
  }));

  async function card(m, md, format, fallbackName) {
    const base = String(m.name || fallbackName || 'model').replace(/[^a-z0-9_-]+/gi, '-') + (format === 'horizontal' ? '-16x9' : '');
    // model-only square pictures: the finished model, and for steps one picture per step with
    // earlier parts pale and the new ones outlined (same camera, so they line up when paging)
    const nf = require('../lib/nodefilm.cjs');
    const shots = [{ png: await nf.hero(m, { size: 720 }) }];
    if (md === 'steps') for (let k = 1; k <= m.steps.length; k++) shots.push({ png: await nf.hero(m, { size: 720, upto: k }) });
    const urls = [];
    await Promise.all(shots.map(async (sh, i) => {
      const f = path.join(exportsDir(), `${base}-${i ? 'step' + i : 'model'}.png`);
      fs.writeFileSync(f, sh.png);
      urls[i] = await fileUrl(f);
    }));
    let videoUrl = null;
    let youtubeUrl = null;
    if (md === 'video') {
      const r = await film.render(m, path.join(exportsDir(), base + '.mp4'), { format });
      videoUrl = await fileUrl(r.file);
      // the host may copy the film elsewhere (the hosted server: the owner's YouTube channel);
      // it returns a link only when one already exists, the upload itself runs after the reply
      if (opts && opts.onVideo) youtubeUrl = await opts.onVideo(r.file, { title: m.title, parts: m.steps.flat().length, steps: m.steps.length, format: format || 'vertical' }).catch(() => null);
    }
    const bom = core.bom(m).map((b) => ({ id: b.id, name: b.name, color: b.color, colorName: colorInfo(b.color).ru, hex: colorInfo(b.color).hex, qty: b.qty }));
    const data = {
      name: m.name || fallbackName || '', title: m.title, parts: m.steps.flat().length, steps: m.steps.length, format: format || 'vertical', mode: md,
      posterUrl: urls[0], stepUrls: urls.slice(1), videoUrl, youtubeUrl, bom,
    };
    const next = md === 'picture' ? '«шаги картинками» или «видео»' : md === 'steps' ? '«видео»' : 'собрать что-то ещё';
    // Markdown fallback for hosts that do not render the card: images inline, video as a link.
    const md2 = [
      urls[0] && md !== 'steps' ? `![${m.title}](${urls[0]})` : '',
      md === 'steps' ? urls.slice(1).map((u, i) => (u ? `![Шаг ${i + 1}](${u})` : '')).join('\n') : '',
      videoUrl ? `[▶ Видео сборки](${videoUrl})` : '',
      youtubeUrl ? `[На YouTube](${youtubeUrl})` : '',
    ].filter(Boolean).join('\n');
    return {
      data,
      shots,
      result: {
        structuredContent: data,
        content: [{ type: 'text', text:
          `Карточка «${m.title}» (${data.parts} деталей, ${data.steps} шагов) показана пользователю. Не пересказывай шаги и детали, ответь одной фразой и предложи ${next}.\n` +
          `Если ты работаешь как агент или в чате с навыками (карточки там не видно), пользователь картинку НЕ видит: ` +
          `вставь в ответ этот markdown как есть, а если картинки так не показываются, скачай их по ссылкам и приложи как изображения (PNG), не SVG:\n${md2}` }],
      },
    };
  }

  s.registerTool('model_preview', {
    title: 'Preview frames',
    description: 'Render PNG frames of the build film so you can look at the model yourself. Default is the final frame. Times in seconds, negative from the end, or "final". ' +
      'To show a saved model to the user, use show_build.',
    inputSchema: {
      ...ModelRef,
      times: z.array(z.union([z.number(), z.literal('final')])).max(4).optional(),
      format: z.enum(['vertical', 'horizontal']).optional(),
    },
    annotations: ro,
    _meta: cardMeta,
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
    // local server: file paths are the user's own; multi-user host: only public URLs
    for (const f of links) urls.push((await fileUrl(f)) || (core.safeMode() && process.env.VERCEL ? '' : f));
    const c = await card(m, 'picture', a.format, a.name);
    return {
      structuredContent: c.data,
      content: [
        ...shots.map((s) => ({ type: 'image', data: s.png.toString('base64'), mimeType: 'image/png' })),
        { type: 'text', text: `frames at ${shots.map((s) => s.t.toFixed(2)).join(', ')} s of ${core.duration(m).toFixed(2)} s\n${urls.join('\n')}` },
        ...c.result.content,
      ],
    };
  }));

  s.registerTool('show_build', {
    title: 'Show the build in the chat',
    description: 'Use this to SHOW a model inside the chat as a card (do not describe it in text). ' +
      'mode "picture" (default, fast): the finished model and its parts, call it right after idea_build. ' +
      'mode "steps": step-by-step pictures, when the user asks how to build it. ' +
      'mode "video": the build video playing inside the card (~25 s to render), use this whenever the user asks for a video ' +
      '(prefer it over model_render, which only returns a download link).',
    inputSchema: {
      name: z.string().describe('saved model name, e.g. the idea name after idea_build'),
      mode: z.enum(['picture', 'steps', 'video']).optional(),
      format: z.enum(['vertical', 'horizontal']).optional(),
    },
    annotations: ro,
    _meta: cardMeta,
  }, safe(async ({ name, mode, format }) => (await card(core.loadModel(name), mode || 'picture', format, name)).result));

  s.registerTool('model_render', {
    title: 'Render build video',
    description: 'Render the build film to an mp4 FILE for download (takes ~10-60 s). To show a video to the user in chat use show_build mode "video" instead; ' +
      'use this only when the user explicitly wants the file or a specific format.',
    inputSchema: { ...ModelRef, format: z.enum(['vertical', 'horizontal']).optional() },
    annotations: ro,
    _meta: cardMeta,
  }, safe(async (a) => {
    const m = pickModel(a);
    const c = await card(m, 'video', a.format, a.name);
    const base = String(m.name || a.name || 'model').replace(/[^a-z0-9_-]+/gi, '-') + (a.format === 'horizontal' ? '-16x9' : '');
    const file = path.join(exportsDir(), base + '.mp4');
    const info = { url: c.data.videoUrl, ...(c.data.videoUrl ? {} : { file }) };
    return { structuredContent: c.data, content: [{ type: 'text', text: JSON.stringify(info) }, ...c.result.content] };
  }));

  return s;
}
