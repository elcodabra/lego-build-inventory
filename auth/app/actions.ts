'use server';
// Server actions: passkey sign-up/sign-in, consent (allow/deny), account management.
import { redirect } from 'next/navigation';
import { assertSameOrigin } from '@/lib/csrf';
import { dropAuthRequest, getAuthRequest, redirectWith } from '@/lib/authorize';
import { findOrCreateGrant, issueCode, revokeGrant } from '@/lib/grants';
import { authenticationOptions, finishAuthentication, finishRegistration, registrationOptions } from '@/lib/passkeys';
import { rateLimit } from '@/lib/ratelimit';
import { currentUser, endSession, saveUser, startSession } from '@/lib/users';

type Result<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };
const fail = (e: unknown): Result => ({ ok: false, error: e instanceof Error ? e.message : 'Ошибка' });

async function guard(bucket: string, limit = 30) {
  await assertSameOrigin();
  if (!(await rateLimit(bucket, limit, 60))) throw new Error('Слишком много попыток, подождите минуту');
}

export async function passkeyRegisterStart(name: string): Promise<Result> {
  try { await guard('reg'); return { ok: true, data: await registrationOptions(String(name || '')) }; } catch (e) { return fail(e); }
}
export async function passkeyRegisterFinish(cid: string, response: unknown): Promise<Result> {
  try {
    await guard('reg');
    const me = await currentUser();
    const user = await finishRegistration(String(cid), response, me?.id); // signed in: add a passkey to this account
    if (!me) await startSession(user.id);
    return { ok: true };
  } catch (e) { return fail(e); }
}
export async function passkeyLoginStart(): Promise<Result> {
  try { await guard('login'); return { ok: true, data: await authenticationOptions() }; } catch (e) { return fail(e); }
}
export async function passkeyLoginFinish(cid: string, response: unknown): Promise<Result> {
  try { await guard('login'); const u = await finishAuthentication(String(cid), response); await startSession(u.id); return { ok: true }; } catch (e) { return fail(e); }
}

// Consent: only the request id comes from the form; everything else was validated at /authorize.
export async function decide(requestId: string, allow: boolean) {
  await assertSameOrigin();
  const req = await getAuthRequest(String(requestId));
  if (!req) redirect('/?expired=1');
  const user = await currentUser();
  if (!user) redirect(`/consent?r=${encodeURIComponent(req.id)}`);
  await dropAuthRequest(req.id); // single use
  if (!allow) redirect(redirectWith(req.redirectUri, { error: 'access_denied', error_description: 'The user declined', state: req.state }));
  const grant = await findOrCreateGrant(user.id, req.clientId, req.clientName, req.resource, req.scope);
  const code = await issueCode({ grantId: grant.id, userId: user.id, clientId: req.clientId, redirectUri: req.redirectUri, resource: req.resource, scope: req.scope, challenge: req.challenge });
  redirect(redirectWith(req.redirectUri, { code, state: req.state }));
}

export async function revoke(grantId: string) {
  await assertSameOrigin();
  const user = await currentUser();
  if (user) await revokeGrant(user.id, String(grantId));
  redirect('/account');
}

export async function rename(name: string) {
  await assertSameOrigin();
  const user = await currentUser();
  if (user) { user.name = String(name || '').trim().slice(0, 60) || user.name; await saveUser(user); }
  redirect('/account');
}

export async function logout() {
  await assertSameOrigin();
  await endSession();
  redirect('/');
}
