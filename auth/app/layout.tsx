import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LEGO из моих деталей · вход',
  description: 'Вход для подключения «LEGO из моих деталей» к ChatGPT и Claude',
  robots: { index: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <main className="wrap">
          <header className="brand"><span className="logo">🧱</span> LEGO из моих деталей</header>
          {children}
          <footer className="muted small">
            <a href="https://github.com/elcodabra/lego-build-inventory">GitHub</a> · LEGO® is a trademark of the LEGO Group, this project is not affiliated with it.
          </footer>
        </main>
      </body>
    </html>
  );
}
