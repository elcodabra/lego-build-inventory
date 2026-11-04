import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LEGO from My Bricks · sign in',
  description: 'Sign in to connect “LEGO from My Bricks” to ChatGPT and Claude',
  robots: { index: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="wrap">
          <header className="brand"><span className="logo">🧱</span> LEGO from My Bricks</header>
          {children}
          <footer className="muted small">
            <a href="https://github.com/elcodabra/lego-build-inventory">GitHub</a> · LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize or endorse this project.
          </footer>
        </main>
      </body>
    </html>
  );
}
