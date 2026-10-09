// Users, browser sessions and passkeys.
//
// A user is an opaque id (u_...). Login method: passkey credentials (WebAuthn) pointing at it. The
// browser session at the auth server is an HMAC-signed cookie holding a random session id in KV.
import { cookies } from 'next/headers';
import { SECURE, TTL } from './config';
import { kv } from './kv';
import { randomId, sign, unsign } from './crypto';

export type User = { id: string; name: string; email?: string; created: number; credentials: string[] };
export type Passkey = { id: string; userId: string; publicKey: string; counter: number; transports?: string[]; created: number; name: string };

export const SESSION_COOKIE = SECURE ? '__Host-lego_session' : 'lego_session';

export const getUser = (id: string): Promise<User | null> => kv.get(`user:${id}`);
export const saveUser = (u: User) => kv.set(`user:${u.id}`, u);

export async function createUser(name: string, email?: string): Promise<User> {
  const u: User = { id: 'u_' + randomId(16), name: name.slice(0, 60) || 'LEGO builder', email, created: Date.now(), credentials: [] };
  await saveUser(u);
  return u;
}

export const getPasskey = (credId: string): Promise<Passkey | null> => kv.get(`passkey:${credId}`);
export async function addPasskey(p: Passkey) {
  await kv.set(`passkey:${p.id}`, p);
  const u = await getUser(p.userId);
  if (u && !u.credentials.includes(p.id)) { u.credentials.push(p.id); await saveUser(u); }
}
export const updatePasskeyCounter = async (p: Passkey, counter: number) => kv.set(`passkey:${p.id}`, { ...p, counter });

// ---------------------------------------------------------------- session

export async function startSession(userId: string) {
  const sid = randomId(24);
  await kv.set(`session:${sid}`, { userId, created: Date.now() }, TTL.session);
  (await cookies()).set(SESSION_COOKIE, sign(sid), { httpOnly: true, secure: SECURE, sameSite: 'lax', path: '/', maxAge: TTL.session });
}

export async function currentUser(): Promise<User | null> {
  const sid = unsign((await cookies()).get(SESSION_COOKIE)?.value);
  if (!sid) return null;
  const s = await kv.get(`session:${sid}`);
  return s ? getUser(s.userId) : null;
}

export async function endSession() {
  const jar = await cookies();
  const sid = unsign(jar.get(SESSION_COOKIE)?.value);
  if (sid) await kv.del(`session:${sid}`);
  jar.delete(SESSION_COOKIE);
}
