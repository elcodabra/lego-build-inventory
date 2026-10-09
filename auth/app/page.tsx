// Landing of the auth server: what this is and how to connect.
import Link from 'next/link';
import { RESOURCES } from '@/lib/config';
import { currentUser } from '@/lib/users';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  const { expired } = await searchParams;
  const user = await currentUser();
  return (
    <>
      {expired && <div className="card"><p>Запрос на вход устарел. Подключите приложение в ChatGPT или Claude ещё раз.</p></div>}
      <div className="card">
        <h1>Подключение к ChatGPT и Claude</h1>
        <p>Сфотографируйте свои детали LEGO, получите идеи, что собрать, и инструкцию картинками или видео.</p>
        <ol className="perm">
          <li><b>ChatGPT</b>: Settings → Apps → Create app, адрес <code>{RESOURCES[0]}</code>, Authentication: OAuth.</li>
          <li><b>Claude</b>: Settings → Connectors → Add custom connector, тот же адрес.</li>
          <li>При подключении откроется эта страница: войдите ключом доступа и нажмите «Разрешить».</li>
        </ol>
        <Link className="btn primary" href="/account">{user ? 'Мой аккаунт' : 'Войти или создать аккаунт'}</Link>
      </div>
    </>
  );
}
