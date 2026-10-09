#!/usr/bin/env node
// One-time: authorise uploads to YOUR YouTube channel and get a refresh token for the server.
//
//   1. Google Cloud console -> create a project -> enable "YouTube Data API v3".
//   2. OAuth consent screen: External, add yourself as a test user, scope .../auth/youtube.upload.
//   3. Credentials -> Create OAuth client ID -> type "Desktop app" -> copy client id and secret.
//   4. node scripts/youtube-auth.mjs <client_id> <client_secret>
//      A browser opens, you pick the channel and allow "Manage your YouTube videos" (upload only).
//   5. The script prints the three values to add to Vercel (it does not store them anywhere):
//        npx vercel env add YOUTUBE_CLIENT_ID production --sensitive
//        npx vercel env add YOUTUBE_CLIENT_SECRET production --sensitive
//        npx vercel env add YOUTUBE_REFRESH_TOKEN production --sensitive
//
// Note: while the consent screen is in "Testing" mode Google expires refresh tokens after 7 days.
// Publish the consent screen ("In production"; unverified is fine for your own account) to keep it.
import http from 'node:http';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error('usage: node scripts/youtube-auth.mjs <client_id> <client_secret>');
  process.exit(2);
}
const verifier = crypto.randomBytes(48).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(16).toString('hex');

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname !== '/callback') { res.statusCode = 404; return res.end(); }
  if (u.searchParams.get('state') !== state) { res.end('state mismatch'); return; }
  const code = u.searchParams.get('code');
  if (!code) { res.end('no code: ' + (u.searchParams.get('error') || '')); server.close(); return; }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
  });
  const j = await r.json();
  if (!j.refresh_token) {
    res.end('No refresh token in the answer. Remove the app at myaccount.google.com/permissions and run again.');
    console.error(j);
    server.close();
    return;
  }
  // show which channel was authorised
  const ch = await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { authorization: `Bearer ${j.access_token}` } })).json().catch(() => ({}));
  const name = ch.items && ch.items[0] ? ch.items[0].snippet.title : '(unknown channel)';
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<p>Готово: канал <b>${name.replace(/[<>&]/g, '')}</b>. Вернитесь в терминал.</p>`);
  console.log(`\nChannel: ${name}\n\nAdd these to the lego-mcp Vercel project (production, sensitive):\n`);
  console.log(`YOUTUBE_CLIENT_ID=${clientId}`);
  console.log(`YOUTUBE_CLIENT_SECRET=${clientSecret}`);
  console.log(`YOUTUBE_REFRESH_TOKEN=${j.refresh_token}`);
  console.log('\nOptional: YOUTUBE_PRIVACY=unlisted|private|public (default unlisted)');
  server.close();
});
let redirectUri;
server.listen(0, '127.0.0.1', () => {
  redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly', access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' })) auth.searchParams.set(k, v);
  console.log('Opening the browser. If it does not open, visit:\n' + auth);
  exec(`${process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'} "${auth}"`);
});
