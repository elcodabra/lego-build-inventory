// Product analytics for the sign-in server: Amplitude HTTP API, sent after the response (never
// blocks or fails a request). Off unless AMPLITUDE_API_KEY is set. Same project and user id as the
// MCP server, so a person's sign-in and their tool calls line up in one funnel:
//   user_id = "a" + first 24 hex chars of sha256(account id)  (the MCP server derives the same id)
// Never sent: passkeys, tokens, codes, client secrets, e-mail, names, IPs.
import crypto from 'node:crypto';
import { after } from 'next/server';

const ENDPOINT = process.env.AMPLITUDE_ENDPOINT || 'https://api2.amplitude.com/2/httpapi';

export const analyticsUserId = (accountId: string) => 'a' + crypto.createHash('sha256').update(accountId).digest('hex').slice(0, 24);

// Coarse client label from a client_id / name: chatgpt, claude, other.
export function clientKind(clientId = '', name = '') {
  const s = `${clientId} ${name}`.toLowerCase();
  if (s.includes('chatgpt.com') || s.includes('chatgpt') || s.includes('openai')) return 'chatgpt';
  if (s.includes('claude')) return 'claude';
  return 'other';
}

export function track(event: string, props: Record<string, unknown> = {}, accountId?: string) {
  const key = process.env.AMPLITUDE_API_KEY;
  if (!key) return;
  const payload = {
    api_key: key,
    events: [{
      event_type: event,
      // anonymous events (before sign-in) need a device id; a random one per event is enough here
      ...(accountId ? { user_id: analyticsUserId(accountId) } : { device_id: 'auth-' + crypto.randomBytes(8).toString('hex') }),
      time: Date.now(),
      platform: 'auth',
      app_version: '0.1.0',
      event_properties: props,
    }],
  };
  const send = async () => {
    try {
      const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(3000) });
      if (!r.ok) console.log(JSON.stringify({ ev: 'amplitude_error', status: r.status }));
    } catch (e: any) {
      console.log(JSON.stringify({ ev: 'amplitude_error', err: e?.message }));
    }
  };
  try { after(send); } catch { void send(); } // outside a request scope (tests): just send
}
