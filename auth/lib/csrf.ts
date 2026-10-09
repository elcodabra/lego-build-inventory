// Same-origin check for state-changing requests (login, consent, revoke). Server actions already
// check Origin in Next.js; this is the explicit guard for our own API routes and actions.
import { headers } from 'next/headers';
import { ISSUER } from './config';

export async function assertSameOrigin() {
  const h = await headers();
  const origin = h.get('origin');
  const site = h.get('sec-fetch-site');
  if (origin && origin !== ISSUER) throw new Error('cross-site request refused');
  if (!origin && site && site !== 'same-origin' && site !== 'none') throw new Error('cross-site request refused');
}
