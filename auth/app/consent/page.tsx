// Login (if needed) + consent for one pending authorization request.
import Login from '@/components/Login';
import { getAuthRequest } from '@/lib/authorize';
import { currentUser } from '@/lib/users';
import { decide } from '../actions';

export const dynamic = 'force-dynamic';

export default async function Consent({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const { r } = await searchParams;
  const req = await getAuthRequest(String(r || ''));
  if (!req) {
    return (<div className="card"><h1>This link has expired · Ссылка устарела</h1><p className="muted">Go back to ChatGPT or Claude and connect the app again.</p></div>);
  }
  const user = await currentUser();
  // A client's name is only trusted when its identity is bound to a domain we know (ChatGPT, Claude).
  // Anyone else is shown by its real domain first, with a warning, so "ChatGPT" from evil.example
  // cannot pass for the real one.
  const who = req.verified
    ? <><b>{req.clientName}</b> <span className="muted">({req.clientHost})</span></>
    : <><b>{req.clientHost || 'unknown app'}</b> <span className="muted">(calls itself “{req.clientName}”)</span></>;
  const warn = !req.verified && (
    <p className="error small" data-testid="unverified">This app is not verified. Allow access only if you connected it yourself and recognise the address {req.clientHost}.</p>
  );
  if (!user) {
    return (
      <div className="card">
        <h1>Sign in · Вход</h1>
        <p>{who} wants to connect to your LEGO parts. Sign in to continue. · Войдите, чтобы продолжить.</p>
        {warn}
        <Login />
      </div>
    );
  }
  const allow = decide.bind(null, req.id, true);
  const deny = decide.bind(null, req.id, false);
  return (
    <div className="card">
      <h1>Allow access? · Разрешить доступ?</h1>
      <p>{who} will get access to the account <b>{user.name}</b>:</p>
      <ul className="perm">
        <li>see and change your parts list · видеть и менять ваш набор деталей;</li>
        <li>build, save and show models, make build pictures and videos · собирать и показывать модели.</li>
      </ul>
      <p className="muted small">You can disconnect at any time on the account page. · Отключить доступ можно на странице аккаунта.</p>
      {warn}
      <div className="row">
        <form action={deny} style={{ flex: 1 }}><button className="btn" type="submit" data-testid="deny">Cancel · Отмена</button></form>
        <form action={allow} style={{ flex: 1 }}><button className="btn primary" type="submit" data-testid="allow">Allow · Разрешить</button></form>
      </div>
    </div>
  );
}
