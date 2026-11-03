// Usage analytics for the hosted server: one Amplitude event per MCP request, sent after the reply
// (waitUntil), never blocking or failing a tool call. Off unless AMPLITUDE_API_KEY is set.
//
// What is sent: an anonymous user id (a hash prefix, never the key), the method / tool name, the
// argument NAMES (not values), duration, status, error flag, the client name (ChatGPT, Claude...),
// and for some tools a few counts (parts, steps, idea name). Never photos, part lists, model JSON,
// URLs or the key itself.
const ENDPOINT = process.env.AMPLITUDE_ENDPOINT || 'https://api2.amplitude.com/2/httpapi'; // EU: https://api.eu.amplitude.com/2/httpapi

export function clientOf(ua, body) {
  const info = body && !Array.isArray(body) && body.method === 'initialize' && body.params && body.params.clientInfo;
  const s = `${(info && info.name) || ''} ${ua || ''}`.toLowerCase();
  if (/openai|chatgpt/.test(s)) return 'chatgpt';
  if (/claude|anthropic/.test(s)) return 'claude';
  if (/codex/.test(s)) return 'codex';
  if (/cursor/.test(s)) return 'cursor';
  if (/mcp-inspector|inspector/.test(s)) return 'inspector';
  if (/^\s*node\b|undici/.test(s)) return 'node';
  return 'other';
}

// Small, value-free facts from a tool result (structuredContent or the JSON text).
function resultFacts(tool, payload) {
  try {
    const j = JSON.parse(payload);
    const r = j && j.result;
    if (!r) return {};
    const sc = r.structuredContent;
    if (sc && typeof sc === 'object') {
      if (sc.kind === 'ideas') {
        const list = Array.isArray(sc.ideas) ? sc.ideas : [];
        return { buildable: list.length, almost: Array.isArray(sc.almost) ? sc.almost.length : 0, top_idea: list[0] && list[0].idea, top_uses_percent: list[0] && list[0].usesPercent, drawable_parts: sc.drawableParts, thumbs: list.filter((x) => x.thumbUrl).length };
      }
      if (sc.disassembly) return { model: sc.name, parts: sc.parts, steps: sc.steps, mode: sc.mode, direction: 'disassemble', exploded: !!(sc.disassembly.explodedRendered || sc.disassembly.explodedUrl), step_images: Array.isArray(sc.stepUrls) ? sc.stepUrls.length : 0 };
      return { model: sc.name, parts: sc.parts, steps: sc.steps, mode: sc.mode, has_video: !!sc.videoUrl, ...(sc.mode === 'video' ? { pile_intro: !!sc.pileIntro } : {}) };
    }
    const t = r.content && r.content[0] && r.content[0].type === 'text' ? r.content[0].text : '';
    if (!t || t[0] !== '{') return {};
    const o = JSON.parse(t);
    if (tool === 'idea_build') return { idea: o.name, parts: o.parts, steps: o.steps, ok: o.ok, missing: Array.isArray(o.missing) ? o.missing.length : undefined };
    if (tool === 'ideas_suggest') {
      const b = o.buildable || [];
      return { buildable: b.length, almost: (o.almost || o.close || []).length, top_idea: b[0] && b[0].idea, top_uses_percent: b[0] && b[0].usesPercent, drawable_parts: o.drawableParts };
    }
    if (tool === 'parts_from_pile_photo' || tool === 'parts_from_photo') return { recognised: Array.isArray(o.results) ? o.results.length : (o.totalParts ?? o.total), added: o.added, pile_mode: o.mode, replaced_previous: o.replacedPrevious ? true : undefined };
    if (tool === 'inventory_undo') return { restored: !!o.restored, total_parts: o.totalParts };
    if (tool === 'inventory_import') return { lines: o.imported, format: o.format };
    if (tool === 'inventory_show') return { total_parts: o.totalParts };
    return {};
  } catch {
    return {};
  }
}

// model_analyze_photo: provider model, outcome, candidate count, confidence. Never the photo, the
// AI's free text, the hint or the response id.
function analysisFacts(payload) {
  try {
    const sc = JSON.parse(payload).result.structuredContent;
    if (sc.status === 'ok') {
      return { ok: true, seg: sc.segmentation ? { provider_model: sc.segmentation.model, bricks: sc.segmentation.bricks, outlined: !!sc.segmentation.outlined } : null, props: { photos: sc.photos, provider_model: sc.provider && sc.provider.model, provider_ms: sc.provider && sc.provider.ms, candidates: (sc.candidates || []).length, top_match: sc.candidates && sc.candidates[0] ? sc.candidates[0].name : undefined, match_confidence: sc.analysis && sc.analysis.match_confidence, is_lego: sc.analysis && sc.analysis.is_lego_model, segmented: !!sc.segmentation } };
    }
    return { ok: false, props: { error_code: sc.error } };
  } catch {
    return null; // no analysis result (quota hit, bad arguments): Meta was not involved
  }
}

export function events({ userId, msgs, ua, client, status, ms, payload, error, newUser }) {
  const out = [];
  const base = { user_id: userId, time: Date.now(), platform: 'mcp', app_version: '0.1.0' };
  if (newUser) out.push({ ...base, event_type: 'user_created', event_properties: { client } });
  for (const m of msgs) {
    if (!m || !m.method || m.method.startsWith('notifications/')) continue;
    if (m.method === 'tools/call') {
      const tool = m.params && m.params.name;
      const args = (m.params && m.params.arguments) || {};
      out.push({
        ...base,
        event_type: 'tool_call',
        event_properties: {
          tool, client, status, ms, error: !!error,
          arg_names: Object.keys(args).sort().join(','),
          mode: typeof args.mode === 'string' ? args.mode : undefined,
          idea: tool === 'idea_build' && typeof args.idea === 'string' ? args.idea : undefined,
          photos: Array.isArray(args.files) ? args.files.length : Array.isArray(args.images) ? args.images.length : undefined,
          ...(msgs.length === 1 && !error ? resultFacts(tool, payload) : {}),
        },
        user_properties: { $set: { last_client: client }, $add: { tool_calls: 1 } },
      });
      // feature events (same request, value-free): the disassembly funnel
      if (tool === 'model_disassemble' && !error && msgs.length === 1) {
        const f = resultFacts(tool, payload);
        if (f.direction) {
          out.push({ ...base, event_type: 'disassembly_opened', event_properties: { client, model: f.model, mode: f.mode, parts: f.parts, steps: f.steps, ms } });
          if (f.exploded) out.push({ ...base, event_type: 'exploded_view_rendered', event_properties: { client, model: f.model, parts: f.parts } });
          if (args.confirmed === true) out.push({ ...base, event_type: 'model_match_confirmed', event_properties: { client, model: f.model } });
        }
      }
      // the rebuild loop: ideas from a disassembled model's own parts, and a build from them
      if ((tool === 'ideas_suggest' || tool === 'idea_build') && typeof args.from_model === 'string' && !error && msgs.length === 1) {
        out.push({ ...base, event_type: tool === 'ideas_suggest' ? 'rebuild_ideas_shown' : 'rebuild_model_built', event_properties: { client, from_model: args.from_model.slice(0, 40), idea: tool === 'idea_build' && typeof args.idea === 'string' ? args.idea : undefined } });
      }
      if (tool === 'model_analyze_photo' && msgs.length === 1) {
        const a = analysisFacts(payload);
        if (a) out.push({ ...base, event_type: a.ok ? 'photo_model_analyzed' : 'meta_request_failed', event_properties: { client, ms, ...a.props } });
        if (a && a.seg) out.push({ ...base, event_type: 'photo_segmented', event_properties: { client, ...a.seg } });
      }
    } else {
      out.push({ ...base, event_type: m.method === 'initialize' ? 'session_start' : 'mcp_' + m.method.replace(/\W+/g, '_'), event_properties: { client, status, ms } });
    }
  }
  return out;
}

export async function send(evts) {
  const key = process.env.AMPLITUDE_API_KEY;
  if (!key || !evts.length) return;
  // runs after the reply; one retry for a timeout or network error (a busy instance, e.g. while
  // rendering a film, can miss the 3 s window once). Amplitude dedups by insert_id.
  const body = JSON.stringify({ api_key: key, events: evts.map((e, i) => ({ insert_id: e.insert_id || `${e.user_id || e.device_id}-${e.event_type}-${e.time}-${i}`, ...e })) });
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3000);
      const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) console.log(JSON.stringify({ ev: 'amplitude_error', status: r.status, body: (await r.text()).slice(0, 200) }));
      return;
    } catch (e) {
      if (attempt === 2) console.log(JSON.stringify({ ev: 'amplitude_error', err: e.message, attempts: attempt }));
    }
  }
}
