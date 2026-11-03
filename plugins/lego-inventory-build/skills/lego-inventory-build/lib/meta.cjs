// Thin server-side client for Meta Model API (Responses API, https://api.meta.ai/v1).
// The key comes only from MODEL_API_KEY. Nothing here logs the key, the photo or the prompt.
//
// Models are switchable: META_MODELS is an ordered list ("muse-spark-1.3,muse-spark-1.2"); a call
// goes to the first one and moves to the next only when the provider says that model is not
// available (404 / model_not_found). Only models in PRICES can be used, so every call has a known
// price and the spend can be capped (lib/budget.cjs).
'use strict';

// USD per 1M tokens, from https://dev.meta.ai/docs/pricing-rate-limits (checked 2026-11-03).
// Contributor mode lets Meta train on the request content (user photos!): off unless chosen explicitly.
const PRICES = {
  'muse-spark-1.3': { input: 1.25, cached: 0.15, output: 4.25 },
  'muse-spark-1.2': { input: 1.25, cached: 0.15, output: 4.25 },
  'muse-spark-1.1': { input: 1.25, cached: 0.15, output: 4.25 },
  'muse-spark-1.3-contributor': { input: 0.10, cached: 0.002, output: 0.20, contributor: true },
  'muse-spark-1.2-contributor': { input: 0.10, cached: 0.002, output: 0.20, contributor: true },
  'muse-wonder-1.0': { input: 4.00, cached: 0.20, output: 20.00 },
};
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
function config() {
  const models = list(process.env.META_MODELS || process.env.META_MODEL || 'muse-spark-1.3,muse-spark-1.2').filter((m) => PRICES[m]);
  return {
    base: process.env.META_API_BASE || 'https://api.meta.ai/v1',
    models: models.length ? models : ['muse-spark-1.3'],
    effort: EFFORTS.includes(process.env.META_EFFORT) ? process.env.META_EFFORT : 'low',
    timeoutMs: Number(process.env.META_TIMEOUT_MS) || 60000,
    maxOutputTokens: Number(process.env.META_MAX_OUTPUT_TOKENS) || 4000,
    maxImageBytes: 6 * 1024 * 1024,
  };
}
const CONFIG = config();

class MetaError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    Object.assign(this, extra || {});
  }
}

const available = () => !!process.env.MODEL_API_KEY;

// Accept only data:image/(png|jpeg|webp);base64 URLs of bounded size.
function checkImage(dataUrl, maxBytes) {
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new MetaError('INVALID_IMAGE', 'photo must be a PNG, JPEG or WebP image');
  const bytes = Math.floor((m[2].length * 3) / 4);
  if (bytes < 100) throw new MetaError('INVALID_IMAGE', 'photo is empty');
  if (bytes > (maxBytes || CONFIG.maxImageBytes)) throw new MetaError('INVALID_IMAGE', 'photo is too large');
  return { mime: 'image/' + (m[1] === 'jpg' ? 'jpeg' : m[1]), bytes };
}

// Pull the output text out of a Responses API body (output_text or output[].content[]).
function outputText(body) {
  if (typeof body.output_text === 'string') return body.output_text;
  const parts = [];
  for (const o of body.output || []) for (const c of o.content || []) if (typeof c.text === 'string') parts.push(c.text);
  return parts.join('');
}

// Real cost of one call from the provider's usage numbers (never estimated from our side).
function cost(model, usage) {
  const p = PRICES[model] || PRICES[String(model).replace(/-\d{8}$/, '')];
  if (!p || !usage) return null;
  const cached = (usage.input_tokens_details && usage.input_tokens_details.cached_tokens) || 0;
  const input = Math.max(0, (usage.input_tokens || 0) - cached);
  return (input * p.input + cached * p.cached + (usage.output_tokens || 0) * p.output) / 1e6;
}

// Worst case of one call (for the budget check before sending): input estimate + full output cap.
function maxCost(model, inputTokens, maxOut) {
  const p = PRICES[model];
  return ((inputTokens || 3000) * p.input + (maxOut || CONFIG.maxOutputTokens) * p.output) / 1e6;
}

async function callOne(f, cfg, model, body) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await f(cfg.base + '/responses', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + process.env.MODEL_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, model }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (e) {
      lastErr = new MetaError('META_UNAVAILABLE', e.name === 'TimeoutError' ? 'Meta API timed out' : 'Meta API unreachable' + (e.cause && e.cause.code ? ' (' + e.cause.code + ')' : ''), { attempts: attempt });
      continue;
    }
    if (res.status === 429) throw new MetaError('QUOTA_EXCEEDED', 'Meta API rate limit or quota reached', { status: 429, attempts: attempt });
    if (res.status === 401 || res.status === 403) throw new MetaError('META_UNAVAILABLE', 'Meta API refused the key', { status: res.status, attempts: attempt });
    if (res.status === 404) throw new MetaError('MODEL_NOT_AVAILABLE', 'model not available: ' + model, { status: 404, attempts: attempt });
    if (res.status >= 500) { lastErr = new MetaError('META_UNAVAILABLE', 'Meta API error ' + res.status, { status: res.status, attempts: attempt }); continue; }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      if (/model/i.test(t) && /not[ _]?found|does not exist|unknown model|not available/i.test(t)) throw new MetaError('MODEL_NOT_AVAILABLE', 'model not available: ' + model, { status: res.status, attempts: attempt });
      throw new MetaError(/image/i.test(t) ? 'INVALID_IMAGE' : 'META_UNAVAILABLE', 'Meta API rejected the request (' + res.status + ')', { status: res.status, attempts: attempt });
    }
    let data;
    try { data = await res.json(); } catch { throw new MetaError('INVALID_MODEL_OUTPUT', 'Meta API returned non-JSON', { attempts: attempt }); }
    return { data, attempts: attempt };
  }
  throw lastErr;
}

/**
 * respond({ input, schema, schemaName, model?, effort? }) ->
 *   { text, json, usage, model, id, ms, attempts, costUsd, tried }
 * One retry on transient failures (network, timeout, 5xx). 429 -> QUOTA_EXCEEDED, no retry.
 * `model` pins one model (must be in PRICES); otherwise META_MODELS in order.
 */
async function respond({ input, schema, schemaName, model, effort, maxOutputTokens, fetchImpl }) {
  if (!available()) throw new MetaError('META_UNAVAILABLE', 'Meta Model API is not configured');
  const cfg = config();
  if (model && !PRICES[model]) throw new MetaError('MODEL_NOT_AVAILABLE', 'model not allowed: ' + model);
  const chain = model ? [model] : cfg.models;
  const f = fetchImpl || fetch;
  const eff = EFFORTS.includes(effort) ? effort : cfg.effort;
  const body = {
    input,
    max_output_tokens: maxOutputTokens || cfg.maxOutputTokens,
    reasoning: { effort: eff },
    ...(schema ? { text: { format: { type: 'json_schema', name: schemaName || 'result', schema, strict: true } } } : {}),
  };
  const t0 = Date.now();
  const tried = [];
  let lastErr = null;
  for (const m of chain) {
    tried.push(m);
    let r;
    try {
      r = await callOne(f, cfg, m, body);
    } catch (e) {
      e.tried = tried.slice();
      if (e.code === 'MODEL_NOT_AVAILABLE') { lastErr = e; continue; }
      throw e;
    }
    const { data, attempts } = r;
    const usage = data.usage || null;
    const out = { usage, model: data.model || m, id: data.id || null, ms: Date.now() - t0, attempts, tried, effort: eff, costUsd: cost(m, usage), status: data.status || null };
    const txt = outputText(data);
    let json = null;
    if (schema) {
      if (data.status === 'incomplete') throw Object.assign(new MetaError('INVALID_MODEL_OUTPUT', 'model output was cut off (max_output_tokens)'), out);
      try { json = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw Object.assign(new MetaError('INVALID_MODEL_OUTPUT', 'model output is not JSON'), out); }
    }
    return { ...out, text: txt, json };
  }
  throw lastErr || new MetaError('MODEL_NOT_AVAILABLE', 'no model available');
}

module.exports = { CONFIG, PRICES, EFFORTS, config, MetaError, available, checkImage, outputText, cost, maxCost, respond };
