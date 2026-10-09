import { keys } from '@/lib/jwt';
import { corsPreflight, json } from '@/lib/metadata';

export const dynamic = 'force-dynamic';
export async function GET() {
  const { publicJwk } = await keys();
  return json({ keys: [publicJwk] }, 200, { 'cache-control': 'public, max-age=300' });
}
export const OPTIONS = corsPreflight;
