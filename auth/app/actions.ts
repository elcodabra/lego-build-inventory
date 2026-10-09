'use server';
// Server actions: passkey sign-up/sign-in, consent (allow/deny), account management.
import { redirect } from 'next/navigation';
import { clientKind, track } from '@/lib/analytics';
import { assertSameOrigin } from '@/lib/csrf';
import { dropAuthRequest, getAuthRequest, redirectWith } from '@/lib/authorize';
import { findOrCreateGrant, issueCode, listGrants, revokeGrant } from '@/lib/grants';
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
    if (!me) { await startSession(user.id); track('signup', { method: 'passkey' }, user.id); }
    else track('passkey_added', { passkeys: user.credentials.length + 1 }, user.id);
    return { ok: true };
  } catch (e) { track('signup_failed', { reason: e instanceof Error ? e.message.slice(0, 60) : 'error' }); return fail(e); }
}
export async function passkeyLoginStart(): Promise<Result> {
  try { await guard('login'); return { ok: true, data: await authenticationOptions() }; } catch (e) { return fail(e); }
}
export async function passkeyLoginFinish(cid: string, response: unknown): Promise<Result> {
  try {
    await guard('login');
    const u = await finishAuthentication(String(cid), response);
    await startSession(u.id);
    track('login', { method: 'passkey' }, u.id);
    return { ok: true };
  } catch (e) { track('login_failed', { reason: e instanceof Error ? e.message.slice(0, 60) : 'error' }); return fail(e); }
}

// Consent: only the request id comes from the form; everything else was validated at /authorize.
export async function decide(requestId: string, allow: boolean) {
  await assertSameOrigin();
  const req = await getAuthRequest(String(requestId));
  if (!req) redirect('/?expired=1');
  const user = await currentUser();
  if (!user) redirect(`/consent?r=${encodeURIComponent(req.id)}`);
  await dropAuthRequest(req.id); // single use
  const client = clientKind(req.clientId, req.clientName);
  if (!allow) {
    track('consent_denied', { client, verified: req.verified }, user.id);
    redirect(redirectWith(req.redirectUri, { error: 'access_denied', error_description: 'The user declined', state: req.state }));
  }
  const before = (await listGrants(user.id)).some((g) => g.clientId === req.clientId && g.resource === req.resource);
  const grant = await findOrCreateGrant(user.id, req.clientId, req.clientName, req.resource, req.scope);
  track(before ? 'app_reconnected' : 'app_connected', { client, verified: req.verified }, user.id);
  const code = await issueCode({ grantId: grant.id, userId: user.id, clientId: req.clientId, redirectUri: req.redirectUri, resource: req.resource, scope: req.scope, challenge: req.challenge });
  redirect(redirectWith(req.redirectUri, { code, state: req.state }));
}

export async function revoke(grantId: string) {
  await assertSameOrigin();
  const user = await currentUser();
  if (user) {
    const g = (await listGrants(user.id)).find((x) => x.id === String(grantId));
    if (await revokeGrant(user.id, String(grantId))) track('app_disconnected', { client: clientKind(g?.clientId, g?.clientName) }, user.id);
  }
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
  const user = await currentUser();
  if (user) track('logout', {}, user.id);
  await endSession();
  redirect('/');
}
