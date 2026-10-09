// GET /userinfo with an access token: the stable account id and display name.
import { corsPreflight, json } from '@/lib/metadata';
import { getUser } from '@/lib/users';
import { bearer, verifyAccessToken } from '@/lib/verify';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const p = await verifyAccessToken(bearer(req));
  if (!p) return json({ error: 'invalid_token' }, 401, { 'www-authenticate': 'Bearer error="invalid_token"' });
  const u = await getUser(String(p.sub));
  if (!u) return json({ error: 'invalid_token' }, 401);
  return json({ sub: u.id, name: u.name, ...(u.email ? { email: u.email, email_verified: true } : {}) });
}
export const OPTIONS = corsPreflight;
