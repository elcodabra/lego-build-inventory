// POST /revoke (RFC 7009): revoking a refresh token revokes its whole grant (connection).
import { sha256 } from '@/lib/crypto';
import { revokeGrant } from '@/lib/grants';
import { kv } from '@/lib/kv';
import { corsPreflight, json } from '@/lib/metadata';

export const dynamic = 'force-dynamic';
export async function POST(req: Request) {
  const f = new URLSearchParams(await req.text());
  const token = f.get('token') || '';
  if (token.startsWith('rt_')) {
    const r = await kv.get(`refresh:${sha256(token)}`);
    if (r) {
      const g = await kv.get(`grant:${r.grantId}`);
      if (g && g.clientId === f.get('client_id')) await revokeGrant(g.userId, g.id);
    }
  }
  return json({}); // always 200, per RFC 7009
}
export const OPTIONS = corsPreflight;
