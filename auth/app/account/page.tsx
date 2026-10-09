// Account: connected apps (revoke), passkeys, name, sign out.
import Login from '@/components/Login';
import { listGrants } from '@/lib/grants';
import { currentUser } from '@/lib/users';
import { logout, rename, revoke } from '../actions';

export const dynamic = 'force-dynamic';

const date = (t: number) => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

export default async function Account() {
  const user = await currentUser();
  if (!user) {
    return (<div className="card"><h1>Аккаунт</h1><p>Войдите, чтобы управлять подключениями.</p><Login /></div>);
  }
  const grants = await listGrants(user.id);
  return (
    <>
      <div className="card">
        <h1>{user.name}</h1>
        <p className="muted small">Аккаунт с {date(user.created)} · ключей доступа: {user.credentials.length}</p>
        <form action={async (fd: FormData) => { 'use server'; await rename(String(fd.get('name') || '')); }} className="row" style={{ marginTop: 8 }}>
          <input type="text" name="name" defaultValue={user.name} maxLength={60} aria-label="Имя" />
          <button className="btn" type="submit" style={{ width: 'auto' }}>Сохранить</button>
        </form>
      </div>
      <div className="card">
        <h2>Подключённые приложения</h2>
        {grants.length === 0 && <p className="muted">Пока нет. Подключите «LEGO из моих деталей» в ChatGPT или Claude.</p>}
        {grants.map((g) => (
          <div className="app" key={g.id} data-testid="grant">
            <div><b>{g.clientName}</b><div className="muted small">последний раз {date(g.lastUsed)}</div></div>
            <form action={revoke.bind(null, g.id)}><button className="btn danger" type="submit" style={{ width: 'auto' }} data-testid="revoke">Отключить</button></form>
          </div>
        ))}
      </div>
      <div className="card">
        <h2>Ключи доступа</h2>
        <p className="muted small">Добавьте ключ на другом устройстве, чтобы входить и с него.</p>
        <Login addOnly />
      </div>
      <form action={logout}><button className="btn" type="submit">Выйти</button></form>
    </>
  );
}
