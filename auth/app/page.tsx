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
      {expired && <div className="card"><p>This sign-in request has expired. Connect the app in ChatGPT or Claude again. · Запрос на вход устарел.</p></div>}
      <div className="card">
        <h1>Connect to ChatGPT and Claude · Подключение</h1>
        <p>Photograph your LEGO parts and get ideas for what to build with step-by-step instructions, or photograph a model you already built and get the exact way to take it apart.</p>
        <ol className="perm">
          <li><b>ChatGPT</b>: Settings → Apps → Create app, URL <code>{RESOURCES[0]}</code>, Authentication: OAuth.</li>
          <li><b>Claude</b>: Settings → Connectors → Add custom connector, same URL.</li>
          <li>When you connect, this page opens: sign in with a passkey and press “Allow”.</li>
        </ol>
        <Link className="btn primary" href="/account">{user ? 'My account · Мой аккаунт' : 'Sign in or create an account · Войти'}</Link>
      </div>
    </>
  );
}
