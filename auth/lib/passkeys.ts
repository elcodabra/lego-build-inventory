// Passkeys (WebAuthn) with SimpleWebAuthn. Challenges are single-use and short-lived; the browser
// gets an opaque challenge id in a cookie-free JSON exchange (bound to the same-origin page).
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { ISSUER, RP_ID, RP_NAME, TTL } from './config';
import { kv } from './kv';
import { randomId } from './crypto';
import { addPasskey, createUser, getPasskey, getUser, updatePasskeyCounter } from './users';

const ORIGIN = ISSUER;

// ---------------------------------------------------------------- sign up: new account + passkey

export async function registrationOptions(displayName: string) {
  const name = (displayName || '').trim().slice(0, 60) || 'LEGO builder';
  const userHandle = randomId(16);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: name,
    userDisplayName: name,
    userID: new TextEncoder().encode(userHandle),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  const cid = randomId(18);
  await kv.set(`chal:${cid}`, { kind: 'reg', challenge: options.challenge, name }, TTL.challenge);
  return { cid, options };
}

export async function finishRegistration(cid: string, response: any, addToUserId?: string) {
  const c = await kv.take(`chal:${String(cid)}`);
  if (!c || c.kind !== 'reg') throw new Error('Время вышло, попробуйте ещё раз');
  const v = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: false });
  if (!v.verified || !v.registrationInfo) throw new Error('Не удалось проверить ключ доступа');
  const cred = v.registrationInfo.credential;
  if (await getPasskey(cred.id)) throw new Error('Этот ключ доступа уже зарегистрирован');
  const user = addToUserId ? await getUser(addToUserId) : await createUser(c.name);
  if (!user) throw new Error('Аккаунт не найден');
  await addPasskey({
    id: cred.id, userId: user.id, publicKey: Buffer.from(cred.publicKey).toString('base64url'), counter: cred.counter,
    transports: response?.response?.transports, created: Date.now(), name: v.registrationInfo.credentialDeviceType === 'multiDevice' ? 'Синхронизируемый ключ' : 'Ключ на устройстве',
  });
  return user;
}

// ---------------------------------------------------------------- sign in with an existing passkey

export async function authenticationOptions() {
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'preferred' });
  const cid = randomId(18);
  await kv.set(`chal:${cid}`, { kind: 'auth', challenge: options.challenge }, TTL.challenge);
  return { cid, options };
}

export async function finishAuthentication(cid: string, response: any) {
  const c = await kv.take(`chal:${String(cid)}`);
  if (!c || c.kind !== 'auth') throw new Error('Время вышло, попробуйте ещё раз');
  const pk = await getPasskey(String(response?.id || ''));
  if (!pk) throw new Error('Этот ключ доступа нам не знаком. Создайте аккаунт.');
  const v = await verifyAuthenticationResponse({
    response, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: false,
    credential: { id: pk.id, publicKey: Buffer.from(pk.publicKey, 'base64url'), counter: pk.counter, transports: pk.transports as any },
  });
  if (!v.verified) throw new Error('Не удалось проверить ключ доступа');
  await updatePasskeyCounter(pk, v.authenticationInfo.newCounter);
  const user = await getUser(pk.userId);
  if (!user) throw new Error('Аккаунт не найден');
  return user;
}
