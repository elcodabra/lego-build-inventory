// Thin server-side client for Meta Model API (Responses API, https://api.meta.ai/v1).
// The key comes only from MODEL_API_KEY. Nothing here logs the key, the photo or the prompt.
'use strict';

const CONFIG = {
  base: process.env.META_API_BASE || 'https://api.meta.ai/v1',
  model: process.env.META_MODEL || 'muse-spark-1.3',
  timeoutMs: Number(process.env.META_TIMEOUT_MS) || 45000,
  maxOutputTokens: 1200,
  maxImageBytes: 6 * 1024 * 1024,
};

class MetaError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    Object.assign(this, extra || {});
  }
}

const available = () => !!process.env.MODEL_API_KEY;

// Accept only data:image/(png|jpeg|webp);base64 URLs of bounded size.
function checkImage(dataUrl) {
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new MetaError('INVALID_IMAGE', 'photo must be a PNG, JPEG or WebP image');
  const bytes = Math.floor((m[2].length * 3) / 4);
  if (bytes < 100) throw new MetaError('INVALID_IMAGE', 'photo is empty');
  if (bytes > CONFIG.maxImageBytes) throw new MetaError('INVALID_IMAGE', 'photo is too large');
  return { mime: 'image/' + (m[1] === 'jpg' ? 'jpeg' : m[1]), bytes };
}

// Pull the output text out of a Responses API body (output_text or output[].content[]).
function outputText(body) {
  if (typeof body.output_text === 'string') return body.output_text;
  const parts = [];
  for (const o of body.output || []) for (const c of o.content || []) if (typeof c.text === 'string') parts.push(c.text);
  return parts.join('');
}

/**
 * respond({ input, schema, schemaName }) -> { text, json, usage, model, id, ms, attempts }
 * One retry on transient failures (network, timeout, 5xx). 429 -> QUOTA_EXCEEDED, no retry.
 */
async function respond({ input, schema, schemaName, fetchImpl }) {
  if (!available()) throw new MetaError('META_UNAVAILABLE', 'Meta Model API is not configured');
  const f = fetchImpl || fetch;
  const body = {
    model: CONFIG.model,
    input,
    max_output_tokens: CONFIG.maxOutputTokens,
    ...(schema ? { text: { format: { type: 'json_schema', name: schemaName || 'result', schema, strict: true } } } : {}),
  };
  const t0 = Date.now();
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await f(CONFIG.base + '/responses', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + process.env.MODEL_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CONFIG.timeoutMs),
      });
    } catch (e) {
      lastErr = new MetaError('META_UNAVAILABLE', e.name === 'TimeoutError' ? 'Meta API timed out' : 'Meta API unreachable', { attempts: attempt });
      continue;
    }
    if (res.status === 429) throw new MetaError('QUOTA_EXCEEDED', 'Meta API rate limit or quota reached', { status: 429, attempts: attempt });
    if (res.status === 401 || res.status === 403) throw new MetaError('META_UNAVAILABLE', 'Meta API refused the key', { status: res.status, attempts: attempt });
    if (res.status >= 500) { lastErr = new MetaError('META_UNAVAILABLE', 'Meta API error ' + res.status, { status: res.status, attempts: attempt }); continue; }
    if (!res.ok) throw new MetaError(res.status === 400 || res.status === 422 ? 'INVALID_IMAGE' : 'META_UNAVAILABLE', 'Meta API rejected the request (' + res.status + ')', { status: res.status, attempts: attempt });
    let data;
    try { data = await res.json(); } catch { throw new MetaError('INVALID_MODEL_OUTPUT', 'Meta API returned non-JSON', { attempts: attempt }); }
    const txt = outputText(data);
    let json = null;
    if (schema) {
      try { json = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new MetaError('INVALID_MODEL_OUTPUT', 'model output is not JSON', { attempts: attempt }); }
    }
    return { text: txt, json, usage: data.usage || null, model: data.model || CONFIG.model, id: data.id || null, ms: Date.now() - t0, attempts: attempt };
  }
  throw lastErr;
}

module.exports = { CONFIG, MetaError, available, checkImage, outputText, respond };
