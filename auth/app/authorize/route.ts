// GET /authorize: validate the request, remember it, then show login/consent (/consent?r=<id>).
// Errors about the client or redirect_uri are shown here (never redirected, RFC 6749 4.1.2.1).
import { redirect } from 'next/navigation';
import { clientKind, track } from '@/lib/analytics';
import { ClientError } from '@/lib/clients';
import { parseAuthorize, redirectWith, RedirectableError } from '@/lib/authorize';
import { rateLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

const page = (title: string, text: string, status = 400) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font:16px system-ui;max-width:560px;margin:60px auto;padding:0 20px"><h1>${title}</h1><p>${text.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`)}</p></body>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } },
);

export async function GET(req: Request) {
  if (!(await rateLimit('authorize', 60, 60))) return page('Слишком много запросов', 'Попробуйте через минуту.', 429);
  const params = new URL(req.url).searchParams;
  let id: string;
  try {
    const r = await parseAuthorize(params);
    id = r.id;
    track('authorize_started', { client: clientKind(r.clientId, r.clientName), verified: r.verified, cimd: /^https:/.test(r.clientId) });
  } catch (e) {
    if (e instanceof RedirectableError) { track('authorize_error', { error: e.code }); return Response.redirect(redirectWith(e.redirectUri, { error: e.code, error_description: e.message, state: e.state }), 302); }
    if (e instanceof ClientError) { track('authorize_error', { error: e.code, client_shown_page: true }); return page('Не получилось подключить приложение', e.message); }
    throw e;
  }
  redirect(`/consent?r=${encodeURIComponent(id)}`);
}
