// Configuration of the authorization server. Everything comes from the environment so the same code
// runs locally (tests) and on Vercel.
//
//   AUTH_ISSUER          https://lego-auth.vercel.app   issuer, exact string (no trailing slash)
//   AUTH_RESOURCES       https://lego-mcp.vercel.app/mcp   comma-separated protected resources
//   AUTH_SIGNING_KEY     private JWK (JSON) for signing access tokens; generated per process if absent (dev)
//   AUTH_SECRET          32+ random bytes (hex/base64) for cookies and CSRF
//   KV_REST_API_URL/TOKEN  Upstash Redis (in-memory store when absent: dev/tests only)
//   AUTH_REDIRECT_ALLOW  extra exact redirect URIs allowed for DCR (comma-separated)
// Sign-in method: passkeys (WebAuthn) only.

const strip = (s: string) => s.replace(/\/+$/, '');

export const ISSUER = strip(process.env.AUTH_ISSUER || 'http://localhost:3100');
export const RESOURCES = (process.env.AUTH_RESOURCES || 'http://localhost:18800/mcp').split(',').map((s) => s.trim()).filter(Boolean);
export const SCOPES = ['lego'];
export const RP_ID = new URL(ISSUER).hostname;
export const RP_NAME = 'LEGO из моих деталей';
export const SECURE = ISSUER.startsWith('https://');

export const TTL = {
  code: 60, // authorization code, seconds
  access: 60 * 60, // access token
  refresh: 60 * 60 * 24 * 60, // refresh token (rotated on use)
  session: 60 * 60 * 24 * 30, // browser session at the auth server
  challenge: 5 * 60, // passkey / login challenge
  request: 15 * 60, // pending authorization request (login + consent)
  cimd: 60 * 60, // cached client metadata document
};


// Redirect URIs accepted for dynamically registered clients: exact callback URLs of the known MCP
// hosts, plus loopback (native/CLI clients). CIMD clients bring their own redirect list from their
// HTTPS document (on their own domain).
export const DCR_REDIRECT_ALLOW = [
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  ...(process.env.AUTH_REDIRECT_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean),
];
// ChatGPT's callback-ID-specific redirect (used when the issuer check is not available).
export const isChatGptCallback = (u: string) => /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,100}$/.test(u);

export function isLoopback(u: URL) {
  return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]');
}
