import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'My Bricks Builder · sign in',
  description: 'Sign in to connect “My Bricks Builder” to ChatGPT and Claude',
  robots: { index: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="wrap">
          <header className="brand"><span className="logo">🧱</span> My Bricks Builder</header>
          {children}
          <footer className="muted small">
            <a href="https://github.com/elcodabra/lego-build-inventory">GitHub</a> · <a href="https://lego-mcp.vercel.app/privacy.html">Privacy</a> · <a href="https://lego-mcp.vercel.app/terms.html">Terms</a> · LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize or endorse this project.
          </footer>
        </main>
      </body>
    </html>
  );
}
