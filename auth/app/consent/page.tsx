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
    return (<div className="card"><h1>Ссылка устарела</h1><p className="muted">Вернитесь в ChatGPT или Claude и подключите приложение ещё раз.</p></div>);
  }
  const user = await currentUser();
  // A client's name is only trusted when its identity is bound to a domain we know (ChatGPT, Claude).
  // Anyone else is shown by its real domain first, with a warning, so "ChatGPT" from evil.example
  // cannot pass for the real one.
  const who = req.verified
    ? <><b>{req.clientName}</b> <span className="muted">({req.clientHost})</span></>
    : <><b>{req.clientHost || 'неизвестное приложение'}</b> <span className="muted">(называет себя «{req.clientName}»)</span></>;
  const warn = !req.verified && (
    <p className="error small" data-testid="unverified">Это приложение не проверено. Разрешайте доступ, только если сами подключали его и узнаёте адрес {req.clientHost}.</p>
  );
  if (!user) {
    return (
      <div className="card">
        <h1>Вход</h1>
        <p>{who} хочет подключиться к вашим деталям LEGO. Войдите, чтобы продолжить.</p>
        {warn}
        <Login />
      </div>
    );
  }
  const allow = decide.bind(null, req.id, true);
  const deny = decide.bind(null, req.id, false);
  return (
    <div className="card">
      <h1>Разрешить доступ?</h1>
      <p>{who} получит доступ к аккаунту <b>{user.name}</b>:</p>
      <ul className="perm">
        <li>видеть и менять ваш набор деталей;</li>
        <li>собирать, сохранять и показывать модели, делать картинки и видео сборки.</li>
      </ul>
      <p className="muted small">Отключить доступ можно в любой момент на странице аккаунта.</p>
      {warn}
      <div className="row">
        <form action={deny} style={{ flex: 1 }}><button className="btn" type="submit" data-testid="deny">Отмена</button></form>
        <form action={allow} style={{ flex: 1 }}><button className="btn primary" type="submit" data-testid="allow">Разрешить</button></form>
      </div>
    </div>
  );
}
