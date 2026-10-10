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
      return { model: sc.name, parts: sc.parts, steps: sc.steps, mode: sc.mode, has_video: !!sc.videoUrl };
    }
    const t = r.content && r.content[0] && r.content[0].type === 'text' ? r.content[0].text : '';
    if (!t || t[0] !== '{') return {};
    const o = JSON.parse(t);
    if (tool === 'idea_build') return { idea: o.name, parts: o.parts, steps: o.steps, ok: o.ok, missing: Array.isArray(o.missing) ? o.missing.length : undefined };
    if (tool === 'ideas_suggest') {
      const b = o.buildable || [];
      return { buildable: b.length, almost: (o.almost || o.close || []).length, top_idea: b[0] && b[0].idea, top_uses_percent: b[0] && b[0].usesPercent, drawable_parts: o.drawableParts };
    }
    if (tool === 'parts_from_pile_photo' || tool === 'parts_from_photo') return { recognised: Array.isArray(o.results) ? o.results.length : o.total, added: o.added };
    if (tool === 'inventory_import') return { lines: o.imported, format: o.format };
    if (tool === 'inventory_show') return { total_parts: o.totalParts };
    return {};
  } catch {
    return {};
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
    } else {
      out.push({ ...base, event_type: m.method === 'initialize' ? 'session_start' : 'mcp_' + m.method.replace(/\W+/g, '_'), event_properties: { client, status, ms } });
    }
  }
  return out;
}

export async function send(evts) {
  const key = process.env.AMPLITUDE_API_KEY;
  if (!key || !evts.length) return;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: key, events: evts }), signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) console.log(JSON.stringify({ ev: 'amplitude_error', status: r.status, body: (await r.text()).slice(0, 200) }));
  } catch (e) {
    console.log(JSON.stringify({ ev: 'amplitude_error', err: e.message }));
  }
}
