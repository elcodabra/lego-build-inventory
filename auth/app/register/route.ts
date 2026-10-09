// Dynamic client registration (RFC 7591). Public clients only.
import { clientKind, track } from '@/lib/analytics';
import { ClientError, registerClient } from '@/lib/clients';
import { corsPreflight, json, oauthError } from '@/lib/metadata';
import { rateLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';
export async function POST(req: Request) {
  if (!(await rateLimit('register', 20, 3600))) return oauthError('slow_down', 'too many registrations, try later', 429);
  let body: unknown;
  try { body = await req.json(); } catch { return oauthError('invalid_client_metadata', 'JSON body required'); }
  try {
    const c = await registerClient(body);
    track('client_registered', { client: clientKind(String(c.client_id), c.client_name), method: 'dcr' });
    return json(c, 201);
  } catch (e) {
    if (e instanceof ClientError) { track('client_rejected', { error: e.code, kind: 'register' }); return oauthError(e.code, e.message); }
    throw e;
  }
}
export const OPTIONS = corsPreflight;
