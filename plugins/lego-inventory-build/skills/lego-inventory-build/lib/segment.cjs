// SAM 3.1 (Meta Model API) on a photo of a built model: outline of the whole model + the visible
// bricks it can find, drawn as an overlay PNG. This only highlights VISIBLE regions of the photo;
// it never produces 3D geometry or hidden parts. Same key, budget cap and error codes as lib/meta.cjs.
'use strict';
const meta = require('./meta.cjs');

// $2.50 per 1,000 images (https://dev.meta.ai/docs/pricing-rate-limits, checked 2026-11-03)
const SAM_USD_PER_IMAGE = 0.0025;
const MODEL = 'sam-3.1';
const MIN_CONF = 0.45;
const MAX_BRICKS = 120;

let parser = null;
const loadParser = async () => (parser = parser || await import('@meta-sam/parser'));

// One SAM request (non-streaming: one image is one line of output).
async function samCall(dataUrl, prompt, fetchImpl) {
  const f = fetchImpl || fetch;
  const cfg = meta.config();
  let res;
  try {
    res = await f(cfg.base + '/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + process.env.MODEL_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: dataUrl }] }],
        metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    throw new meta.MetaError('META_UNAVAILABLE', e.name === 'TimeoutError' ? 'SAM timed out' : 'SAM unreachable');
  }
  if (res.status === 429) throw new meta.MetaError('QUOTA_EXCEEDED', 'Meta API rate limit or quota reached', { status: 429 });
  if (!res.ok) throw new meta.MetaError(res.status === 401 || res.status === 403 || res.status >= 500 ? 'META_UNAVAILABLE' : 'INVALID_IMAGE', 'SAM refused the request (' + res.status + ')', { status: res.status });
  const j = await res.json().catch(() => null);
  if (!j) throw new meta.MetaError('INVALID_MODEL_OUTPUT', 'SAM returned non-JSON');
  return { text: meta.outputText(j), id: j.id || null, images: (j.usage && j.usage.images_processed) || 1 };
}

// Parse one image line into records { id, box:{x1,y1,x2,y2}, w, h, c, mask:{height,width,payload} }.
function parseLine(text) {
  const out = [];
  const re = /(\d+)<\|box;([^|]*)\|><\|mask;([^|]*?)data=(\d+),(\d+),([\s\S]*?)\|>/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const kv = Object.fromEntries(m[2].split(';').map((s) => s.split('=')));
    const num = (k) => Number(kv[k]);
    if (![num('x1'), num('y1'), num('x2'), num('y2'), num('w'), num('h')].every(Number.isFinite)) continue;
    out.push({
      id: Number(m[1]), box: { x1: num('x1'), y1: num('y1'), x2: num('x2'), y2: num('y2') }, w: num('w'), h: num('h'),
      c: kv.c != null ? Number(kv.c) : null, mask: { height: Number(m[4]), width: Number(m[5]), payload: m[6] },
    });
  }
  return out;
}

// Mask raster -> where it sits on the image: the mask covers the record's box (H x W cells).
async function paintMask(ctx, rec, color, alpha) {
  const P = await loadParser();
  const enc = rec.mask.payload[0] === '~' ? 'lossless' : 'one_bit';
  let raster;
  try { raster = P.decodeMaskToRaster({ encoding: enc, height: rec.mask.height, width: rec.mask.width, payload: rec.mask.payload }); } catch { return 0; }
  const { createCanvas } = require('@napi-rs/canvas');
  const W = rec.mask.width; const H = rec.mask.height;
  const c = createCanvas(W, H);
  const x = c.getContext('2d');
  const img = x.createImageData(W, H);
  let on = 0;
  for (let i = 0; i < raster.length; i++) {
    if (!raster[i]) continue;
    on++;
    img.data[i * 4] = color[0]; img.data[i * 4 + 1] = color[1]; img.data[i * 4 + 2] = color[2]; img.data[i * 4 + 3] = Math.round(255 * alpha);
  }
  x.putImageData(img, 0, 0);
  ctx.drawImage(c, rec.box.x1, rec.box.y1, rec.box.x2 - rec.box.x1 + 1, rec.box.y2 - rec.box.y1 + 1);
  return on;
}

/**
 * segment({ dataUrl, budget }) -> { overlay: PNG Buffer, model, bricks, outline, responseIds, costUsd }
 * dataUrl: the already prepared photo (lib/analyze preparePhoto: JPEG, <= 1024 px).
 */
async function segment({ dataUrl, budget, fetchImpl }) {
  if (!meta.available()) throw new meta.MetaError('META_UNAVAILABLE', 'Meta Model API is not configured on this server');
  meta.checkImage(dataUrl);
  const run = async () => {
    const [whole, bricks] = await Promise.all([samCall(dataUrl, 'LEGO model', fetchImpl), samCall(dataUrl, 'LEGO brick', fetchImpl)]);
    return { whole, bricks, costUsd: SAM_USD_PER_IMAGE * (whole.images + bricks.images) };
  };
  const r = budget ? await budget.run(SAM_USD_PER_IMAGE * 2, run) : await run();
  const outline = parseLine(r.whole.text).filter((x) => x.c == null || x.c >= MIN_CONF).sort((a, b) => (b.c || 0) - (a.c || 0)).slice(0, 1);
  const bricks = parseLine(r.bricks.text).filter((x) => x.c == null || x.c >= MIN_CONF).slice(0, MAX_BRICKS);

  // draw: the photo dimmed outside the model, the model outline tinted, every found brick boxed
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const photo = await loadImage(Buffer.from(dataUrl.split(',')[1], 'base64'));
  const W = photo.width; const H = photo.height;
  const cv = createCanvas(W, H);
  const ctx = cv.getContext('2d');
  ctx.drawImage(photo, 0, 0, W, H);
  if (outline.length) {
    ctx.fillStyle = 'rgba(17,24,39,0.6)';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    // re-draw the photo only where the model is (mask as clip via a temp canvas)
    const m = createCanvas(W, H);
    const mx = m.getContext('2d');
    await paintMask(mx, outline[0], [255, 255, 255], 1);
    mx.globalCompositeOperation = 'source-in';
    mx.drawImage(photo, 0, 0, W, H);
    ctx.drawImage(m, 0, 0);
    ctx.restore();
    // the outline edge: the mask grown by a few pixels behind the model, in the accent colour
    const edge = createCanvas(W, H);
    const ex = edge.getContext('2d');
    await paintMask(ex, outline[0], [255, 210, 26], 1);
    const ring = createCanvas(W, H);
    const rx = ring.getContext('2d');
    const r = Math.max(2, Math.round(W / 250));
    for (const [dx, dy] of [[-r, 0], [r, 0], [0, -r], [0, r], [-r, -r], [r, r], [-r, r], [r, -r]]) rx.drawImage(edge, dx, dy);
    rx.globalCompositeOperation = 'destination-out';
    rx.drawImage(edge, 0, 0);
    ctx.drawImage(ring, 0, 0);
  }
  const lw = Math.max(2, Math.round(W / 300));
  ctx.lineWidth = lw;
  for (const b of bricks) {
    ctx.strokeStyle = '#FFD21A';
    ctx.strokeRect(b.box.x1, b.box.y1, b.box.x2 - b.box.x1, b.box.y2 - b.box.y1);
  }
  // label
  const label = bricks.length ? `SAM 3.1 · model outlined · ${bricks.length} visible brick${bricks.length === 1 ? '' : 's'} boxed` : 'SAM 3.1 · model outlined';
  ctx.font = `bold ${Math.round(W / 28)}px Inter`;
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(17,24,39,0.85)';
  ctx.fillRect(lw * 4, lw * 4, tw + lw * 8, Math.round(W / 28) + lw * 6);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, lw * 8, lw * 4 + Math.round(W / 28) + lw);
  return {
    overlay: cv.toBuffer('image/png'),
    model: MODEL,
    bricks: bricks.length,
    outline: outline.length ? { box: outline[0].box, confidence: outline[0].c } : null,
    responseIds: [r.whole.id, r.bricks.id].filter(Boolean),
    costUsd: r.costUsd,
  };
}

/**
 * pileBoxes({ dataUrl, budget }) -> { boxes:[{x0,y0,x1,y1,c}] normalised 0..1, raw, responseId, costUsd, ms }
 * SAM 3.1 "LEGO brick" on a photo of loose parts. Duplicates (a part and a piece of it, two
 * overlapping masks) are removed: keep the most confident, drop any box mostly covered by a kept
 * one, then drop boxes that swallow two or more kept parts (a merged group).
 */
const PILE_MIN_CONF = 0.6;
async function pileBoxes({ dataUrl, budget, fetchImpl, minConf }) {
  if (!meta.available()) throw new meta.MetaError('META_UNAVAILABLE', 'Meta Model API is not configured on this server');
  meta.checkImage(dataUrl);
  const t = Date.now();
  const run = async () => { const r = await samCall(dataUrl, 'LEGO brick', fetchImpl); return { ...r, costUsd: SAM_USD_PER_IMAGE * r.images }; };
  const r = budget ? await budget.run(SAM_USD_PER_IMAGE, run) : await run();
  const recs = parseLine(r.text);
  const th = minConf == null ? PILE_MIN_CONF : minConf;
  const A = (b) => Math.max(1, (b.x2 - b.x1) * (b.y2 - b.y1));
  const I = (a, b) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const keep = [];
  for (const x of recs.filter((q) => q.c == null || q.c >= th).sort((a, b) => (b.c || 0) - (a.c || 0))) {
    if (keep.some((k) => I(x.box, k.box) > 0.6 * Math.min(A(x.box), A(k.box)))) continue;
    keep.push(x);
  }
  const fin = keep.filter((x) => keep.filter((k) => k !== x && I(x.box, k.box) > 0.8 * A(k.box)).length < 2).slice(0, MAX_BRICKS);
  const W = (fin[0] && fin[0].w) || 1; const H = (fin[0] && fin[0].h) || 1;
  return {
    boxes: fin.map((x) => ({ x0: x.box.x1 / (x.w || W), y0: x.box.y1 / (x.h || H), x1: x.box.x2 / (x.w || W), y1: x.box.y2 / (x.h || H), c: x.c })),
    raw: recs.length, responseId: r.id, costUsd: r.costUsd, ms: Date.now() - t,
  };
}

module.exports = { segment, pileBoxes, parseLine, SAM_USD_PER_IMAGE, MODEL };
