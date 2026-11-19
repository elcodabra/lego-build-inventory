'use client';
// Passkey sign-in / sign-up buttons. After success the page reloads (server components re-read the
// session cookie), so the consent screen or the account page appears.
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';
import { passkeyLoginFinish, passkeyLoginStart, passkeyRegisterFinish, passkeyRegisterStart, reviewSignIn } from '@/app/actions';

export default function Login({ addOnly = false, review = false }: { addOnly?: boolean; review?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [supported, setSupported] = useState(true);
  const [rl, setRl] = useState('');
  const [rp, setRp] = useState('');
  useEffect(() => setSupported(browserSupportsWebAuthn()), []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr('');
    try { await fn(); window.location.reload(); } catch (e: any) {
      const m = String(e?.message || e);
      setErr(/NotAllowed|abort|cancel/i.test(m) ? 'Cancelled · Отменено' : m);
      setBusy(false);
    }
  };
  const signIn = () => run(async () => {
    const s: any = await passkeyLoginStart(); if (!s.ok) throw new Error(s.error);
    const resp = await startAuthentication({ optionsJSON: s.data.options });
    const f: any = await passkeyLoginFinish(s.data.cid, resp); if (!f.ok) throw new Error(f.error);
  });
  const signUp = () => run(async () => {
    const s: any = await passkeyRegisterStart(name); if (!s.ok) throw new Error(s.error);
    const resp = await startRegistration({ optionsJSON: s.data.options });
    const f: any = await passkeyRegisterFinish(s.data.cid, resp); if (!f.ok) throw new Error(f.error);
  });

  const reviewIn = () => run(async () => { const f: any = await reviewSignIn(rl, rp); if (!f.ok) throw new Error(f.error); });
  // Test account for app-directory reviewers: shown only when the server has AUTH_REVIEW_PASSWORD.
  const reviewBox = review && (
    <details style={{ marginTop: 14 }} data-testid="review">
      <summary className="muted small">App reviewer? Sign in with the test account</summary>
      <form onSubmit={(e) => { e.preventDefault(); reviewIn(); }}>
        <input type="text" placeholder="Login" value={rl} onChange={(e) => setRl(e.target.value)} autoComplete="username" aria-label="Review login" />
        <input type="password" placeholder="Password" value={rp} onChange={(e) => setRp(e.target.value)} autoComplete="current-password" aria-label="Review password" />
        <button className="btn" type="submit" disabled={busy} data-testid="review-signin">Sign in · Войти</button>
      </form>
    </details>
  );
  if (!supported) return <>{reviewBox}<p className="error">This browser does not support passkeys. Open the page in Safari, Chrome or Edge. · Этот браузер не поддерживает ключи доступа.</p></>;
  if (addOnly) return (<><button className="btn" disabled={busy} onClick={signUp} data-testid="add-passkey">Add a passkey · Добавить ключ доступа</button>{err && <p className="error">{err}</p>}</>);
  return (
    <>
      <button className="btn primary" disabled={busy} onClick={signIn} data-testid="signin">Sign in with a passkey · Войти с ключом доступа</button>
      <p className="or">new here? · впервые здесь?</p>
      <input type="text" placeholder="Your name (optional) · Как вас называть" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Имя" />
      <button className="btn" disabled={busy} onClick={signUp} data-testid="signup">Create an account with a passkey · Создать аккаунт</button>
      <p className="muted small" style={{ marginTop: 10 }}>A passkey is Face ID, Touch ID or your device PIN. No password, no e-mail: we keep only the public part of the key. · Ключ доступа — это вход по Face ID, Touch ID или PIN-коду устройства. Без паролей и почты.</p>
      {reviewBox}
      {err && <p className="error" role="alert">{err}</p>}
    </>
  );
}
