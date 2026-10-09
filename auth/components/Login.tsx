'use client';
// Passkey sign-in / sign-up buttons. After success the page reloads (server components re-read the
// session cookie), so the consent screen or the account page appears.
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';
import { passkeyLoginFinish, passkeyLoginStart, passkeyRegisterFinish, passkeyRegisterStart } from '@/app/actions';

export default function Login({ addOnly = false }: { addOnly?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(browserSupportsWebAuthn()), []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr('');
    try { await fn(); window.location.reload(); } catch (e: any) {
      const m = String(e?.message || e);
      setErr(/NotAllowed|abort|cancel/i.test(m) ? 'Отменено' : m);
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

  if (!supported) return <p className="error">Этот браузер не поддерживает ключи доступа (passkeys). Откройте страницу в Safari, Chrome или Edge.</p>;
  if (addOnly) return (<><button className="btn" disabled={busy} onClick={signUp} data-testid="add-passkey">Добавить ключ доступа</button>{err && <p className="error">{err}</p>}</>);
  return (
    <>
      <button className="btn primary" disabled={busy} onClick={signIn} data-testid="signin">Войти с ключом доступа</button>
      <p className="or">впервые здесь?</p>
      <input type="text" placeholder="Как вас называть (необязательно)" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Имя" />
      <button className="btn" disabled={busy} onClick={signUp} data-testid="signup">Создать аккаунт с ключом доступа</button>
      <p className="muted small" style={{ marginTop: 10 }}>Ключ доступа — это вход по Face ID, Touch ID или PIN-коду устройства. Без паролей и почты: мы храним только публичную часть ключа.</p>
      {err && <p className="error" role="alert">{err}</p>}
    </>
  );
}
