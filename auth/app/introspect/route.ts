// POST /introspect (RFC 7662, minimal): lets the MCP server ask whether a token's grant is still
// active. Authenticated by a shared secret (AUTH_INTROSPECT_SECRET) so it cannot be used to probe.
import { equal } from '@/lib/crypto';
import { json } from '@/lib/metadata';
import { verifyAccessToken } from '@/lib/verify';

export const dynamic = 'force-dynamic';
export async function POST(req: Request) {
  const secret = process.env.AUTH_INTROSPECT_SECRET || '';
  const got = req.headers.get('x-introspect-secret') || '';
  if (!secret || !equal(got, secret)) return json({ error: 'unauthorized' }, 401);
  const f = new URLSearchParams(await req.text());
  const p = await verifyAccessToken(f.get('token') || '');
  return json(p ? { active: true, sub: p.sub, aud: p.aud, scope: p.scope, client_id: p.client_id, exp: p.exp } : { active: false });
}
