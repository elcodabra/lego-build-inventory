// End-to-end OAuth test of the whole chain, all real code:
//   Next.js auth server (prod build) + MCP server (api/mcp.mjs with OAuth on) +
//   the official MCP SDK client (discovery -> DCR or CIMD -> PKCE -> token -> refresh) +
//   a real browser (Playwright) with a virtual WebAuthn authenticator for the passkey.
// Plus negative checks: PKCE, redirect_uri, resource/audience, code and refresh-token replay,
// revocation, CSRF on consent, SSRF via CIMD.
//   node test/e2e.mjs        (after `npx next build`)
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// a throwaway TLS certificate for the local CIMD host (generated, never committed)
const FIX = path.join(HERE, 'fixtures');
if (!fs.existsSync(path.join(FIX, 'cimd-cert.pem'))) {
  fs.mkdirSync(FIX, { recursive: true });
  (await import('node:child_process')).execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(FIX, 'cimd-key.pem'), '-out', path.join(FIX, 'cimd-cert.pem'), '-days', '30', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
}
const AUTH_DIR = path.resolve(HERE, '..');
const MCP_DIR = path.resolve(HERE, '../../plugins/lego-inventory-build/skills/lego-inventory-build');
const req = (await import('node:module')).createRequire(path.join(MCP_DIR, 'package.json'));
const { chromium } = req('playwright');
const { Client } = await import(req.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StreamableHTTPClientTransport } = await import(req.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));
const { UnauthorizedError } = await import(req.resolve('@modelcontextprotocol/sdk/client/auth.js'));

const AUTH = 'http://localhost:3101';
const MCP = 'http://localhost:18800';
const RESOURCE = `${MCP}/mcp`;
const CB_PORT = 18899;
const CIMD_PORT = 18898;
const ok = (m) => console.log('  ok ', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- start servers
const introspectSecret = crypto.randomBytes(24).toString('hex');
const authEnv = { ...process.env, AUTH_ISSUER: AUTH, AUTH_RESOURCES: RESOURCE, AUTH_SECRET: crypto.randomBytes(32).toString('hex'), AUTH_INTROSPECT_SECRET: introspectSecret, AUTH_REDIRECT_ALLOW: '', AUTH_CIMD_TEST_HOSTS: `localhost:${CIMD_PORT}`, AUTH_CIMD_TEST_CA: fs.readFileSync(path.join(HERE, 'fixtures/cimd-cert.pem'), 'utf8'), AUTH_REFRESH_GRACE_SECONDS: '2', NODE_ENV: 'production', PORT: '3101' };
delete authEnv.KV_REST_API_URL; delete authEnv.KV_REST_API_TOKEN; delete authEnv.VERCEL;
const auth = spawn(process.execPath, [req.resolve('next/dist/bin/next', { paths: [AUTH_DIR] }), 'start', '-p', '3101'], { cwd: AUTH_DIR, env: authEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let authLog = ''; auth.stdout.on('data', (d) => { authLog += d; }); auth.stderr.on('data', (d) => { authLog += d; });

Object.assign(process.env, { VERCEL: '1', AUTH_ACTIVE_CACHE_MS: '0', AUTH_ISSUER: AUTH, MCP_RESOURCE: RESOURCE, AUTH_INTROSPECT_SECRET: introspectSecret, LEGO_MCP_TOKEN: 'owner-key-123' });
delete process.env.LEGO_OPEN; delete process.env.KV_REST_API_URL; delete process.env.STATE_BLOB_TOKEN; delete process.env.MEDIA_BLOB_TOKEN; delete process.env.AMPLITUDE_API_KEY;
const { default: handler } = await import(path.join(MCP_DIR, 'api/mcp.mjs'));
const mcp = http.createServer((q, s) => { s.status = (c) => { s.statusCode = c; return s; }; s.json = (o) => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify(o)); }; handler(q, s); }).listen(18800);

// a CIMD client document (like https://chatgpt.com/oauth/client.json), served locally
const CIMD_ID = `https://localhost:${CIMD_PORT}/oauth/client.json`;
const cimd = https.createServer({ key: fs.readFileSync(path.join(HERE, 'fixtures/cimd-key.pem')), cert: fs.readFileSync(path.join(HERE, 'fixtures/cimd-cert.pem')) }, (q, s) => {
  if (q.url === '/oauth/client.json') { s.setHeader('content-type', 'application/json'); return s.end(JSON.stringify({ client_id: CIMD_ID, client_name: 'Test CIMD client', redirect_uris: [`http://127.0.0.1:${CB_PORT}/callback`], token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })); }
  s.statusCode = 404; s.end();
}).listen(CIMD_PORT);

for (let i = 0; i < 60; i++) { try { if ((await fetch(`${AUTH}/.well-known/oauth-authorization-server`)).ok) break; } catch { /* wait */ } await sleep(250); }

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

try {
  // ---------------------------------------------------------------- discovery
  const r401 = await fetch(RESOURCE, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal(r401.status, 401);
  const wa = r401.headers.get('www-authenticate');
  assert.match(wa, /resource_metadata="http:\/\/localhost:18800\/\.well-known\/oauth-protected-resource\/mcp"/); ok('401 with WWW-Authenticate resource_metadata');
  const prm = await (await fetch(`${MCP}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, RESOURCE); assert.deepEqual(prm.authorization_servers, [AUTH]); ok('protected resource metadata');
  const asm = await (await fetch(`${AUTH}/.well-known/oauth-authorization-server`)).json();
  assert.equal(asm.issuer, AUTH); assert.ok(asm.code_challenge_methods_supported.includes('S256'));
  assert.equal(asm.authorization_response_iss_parameter_supported, true); assert.equal(asm.client_id_metadata_document_supported, true); ok('authorization server metadata (S256, CIMD, RFC 9207)');

  // ---------------------------------------------------------------- full flow with the SDK client (DCR)
  // OAuthClientProvider whose "user agent" is our Playwright page
  const makeProvider = (opts = {}) => {
    let tokens, info, verifier, lastUrl;
    return {
      get redirectUrl() { return `http://127.0.0.1:${CB_PORT}/callback`; },
      get clientMetadata() { return { client_name: 'E2E test client', redirect_uris: [`http://127.0.0.1:${CB_PORT}/callback`], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
      ...(opts.cimd ? { clientMetadataUrl: CIMD_ID } : {}),
      clientInformation: () => info,
      saveClientInformation: (i) => { info = i; },
      tokens: () => tokens,
      saveTokens: (t) => { tokens = t; },
      redirectToAuthorization: (u) => { lastUrl = u; },
      saveCodeVerifier: (v) => { verifier = v; },
      codeVerifier: () => verifier,
      get lastUrl() { return lastUrl; },
      get savedTokens() { return tokens; },
      set savedTokens(t) { tokens = t; },
      get info() { return info; },
    };
  };
  // the browser part: open the authorization URL, sign up / sign in with the passkey, allow
  const loginAndAllow = async (url, { signUp = false, deny = false } = {}) => {
    let callback = null;
    await page.route(`http://127.0.0.1:${CB_PORT}/**`, (route) => { callback = route.request().url(); return route.fulfill({ status: 200, body: 'ok' }); });
    await page.goto(String(url));
    if (signUp) { await page.fill('input[aria-label="Имя"]', 'Тестовый строитель'); await page.click('[data-testid=signup]'); }
    else if (await page.locator('[data-testid=signin]').count()) await page.click('[data-testid=signin]');
    await page.waitForSelector(deny ? '[data-testid=deny]' : '[data-testid=allow]', { timeout: 15000 });
    await page.click(deny ? '[data-testid=deny]' : '[data-testid=allow]');
    for (let i = 0; i < 100 && !callback; i++) await sleep(100);
    await page.unroute(`http://127.0.0.1:${CB_PORT}/**`);
    assert.ok(callback, 'redirected back to the client');
    return new URL(callback);
  };

  const p1 = makeProvider();
  const t1 = new StreamableHTTPClientTransport(new URL(RESOURCE), { authProvider: p1 });
  const c1 = new Client({ name: 'e2e', version: '1' });
  await assert.rejects(c1.connect(t1), (e) => e instanceof UnauthorizedError);
  assert.ok(p1.info?.client_id?.startsWith('c_')); ok(`DCR registered client ${p1.info.client_id.slice(0, 8)}…`);
  const au = new URL(p1.lastUrl);
  assert.equal(au.searchParams.get('code_challenge_method'), 'S256'); assert.equal(au.searchParams.get('resource'), RESOURCE); ok('authorization URL carries PKCE S256 and resource');
  const cb = await loginAndAllow(au, { signUp: true });
  assert.equal(cb.searchParams.get('iss'), AUTH); assert.equal(cb.searchParams.get('state'), au.searchParams.get('state')); ok('callback has iss (RFC 9207) and the same state');
  await t1.finishAuth(cb.searchParams.get('code'));
  assert.ok(p1.savedTokens.access_token && p1.savedTokens.refresh_token); ok('tokens issued (passkey sign-up in a real browser)');
  const c1b = new Client({ name: 'e2e', version: '1' });
  await c1b.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { authProvider: p1 }));
  const tools = (await c1b.listTools()).tools;
  assert.ok(tools.length >= 20); ok(`MCP tools with the access token: ${tools.length}`);
  await c1b.callTool({ name: 'inventory_import', arguments: { data: 'part,color,qty\n3001,red,6\n3003,white,8', replace: true } });
  const inv1 = JSON.parse((await c1b.callTool({ name: 'inventory_show', arguments: {} })).content[0].text);
  assert.equal(inv1.totalParts, 14); ok('account state: import + show (14 parts)');

  // token claims
  const claims = JSON.parse(Buffer.from(p1.savedTokens.access_token.split('.')[1], 'base64url'));
  assert.equal(claims.aud, RESOURCE); assert.equal(claims.iss, AUTH); assert.ok(claims.sub.startsWith('u_')); ok('access token: iss, aud = resource, sub = account');

  // ---------------------------------------------------------------- refresh rotation + replay
  const tok = (body) => fetch(`${AUTH}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }).then(async (r) => ({ status: r.status, j: await r.json() }));
  const rt1 = p1.savedTokens.refresh_token;
  const r1 = await tok({ grant_type: 'refresh_token', refresh_token: rt1, client_id: p1.info.client_id, resource: RESOURCE });
  assert.equal(r1.status, 200); assert.notEqual(r1.j.refresh_token, rt1); ok('refresh token rotates');
  const replay = await tok({ grant_type: 'refresh_token', refresh_token: rt1, client_id: p1.info.client_id });
  assert.equal(replay.status, 200); assert.equal(replay.j.refresh_token, r1.j.refresh_token); ok('retry within the grace window returns the same tokens');
  await sleep(2200); // grace window in this test: 2 s
  const stolen = await tok({ grant_type: 'refresh_token', refresh_token: rt1, client_id: p1.info.client_id });
  assert.equal(stolen.j.error, 'invalid_grant'); ok('reuse after the grace window refused (theft)');
  const after = await tok({ grant_type: 'refresh_token', refresh_token: r1.j.refresh_token, client_id: p1.info.client_id });
  assert.equal(after.j.error, 'invalid_grant'); ok('replay revoked the whole connection (new refresh token dead too)');
  const deadAccess = await fetch(RESOURCE, { method: 'POST', headers: { authorization: 'Bearer ' + r1.j.access_token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal(deadAccess.status, 401); ok('access token of the revoked connection refused by the MCP server');

  // ---------------------------------------------------------------- second login: same account, CIMD client
  const p2 = makeProvider({ cimd: true });
  const t2 = new StreamableHTTPClientTransport(new URL(RESOURCE), { authProvider: p2 });
  await assert.rejects(new Client({ name: 'e2e2', version: '1' }).connect(t2), (e) => e instanceof UnauthorizedError);
  const au2 = new URL(p2.lastUrl);
  assert.equal(au2.searchParams.get('client_id'), CIMD_ID); ok('CIMD: client_id is the metadata URL, no registration');
  await page.context().clearCookies(); // fresh browser session: sign in with the existing passkey
  const cb2 = await loginAndAllow(au2);
  await t2.finishAuth(cb2.searchParams.get('code'));
  const c2 = new Client({ name: 'e2e2', version: '1' });
  await c2.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { authProvider: p2 }));
  const inv2 = JSON.parse((await c2.callTool({ name: 'inventory_show', arguments: {} })).content[0].text);
  assert.equal(inv2.totalParts, 14); ok('passkey sign-in from another client sees the same account data');

  // ---------------------------------------------------------------- negative: authorization endpoint
  const authz = (q) => fetch(`${AUTH}/authorize?${new URLSearchParams(q)}`, { redirect: 'manual' });
  const base = { response_type: 'code', client_id: p1.info.client_id, redirect_uri: `http://127.0.0.1:${CB_PORT}/callback`, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's', resource: RESOURCE };
  let r = await authz({ ...base, redirect_uri: 'https://evil.example/cb' });
  assert.equal(r.status, 400); ok('unregistered redirect_uri: error page, no redirect');
  r = await authz({ ...base, code_challenge_method: 'plain' });
  assert.equal(r.status, 302); assert.match(r.headers.get('location'), /error=invalid_request.*iss=/); ok('PKCE plain refused (error redirect with iss)');
  r = await authz({ ...base, resource: 'https://other.example/mcp' });
  assert.match(r.headers.get('location'), /error=invalid_target/); ok('foreign resource refused');
  r = await authz({ ...base, client_id: 'c_doesnotexist' });
  assert.equal(r.status, 400); ok('unknown client refused');

  // ---------------------------------------------------------------- negative: token endpoint
  // a fresh code via the browser, then try to misuse it
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const fresh = await authz({ ...base, code_challenge: challenge, state: 'x1' });
  const consentUrl = new URL(fresh.headers.get('location'), AUTH);
  const cb3 = await loginAndAllow(consentUrl);
  const code = cb3.searchParams.get('code');
  let t = await tok({ grant_type: 'authorization_code', code, client_id: p1.info.client_id, redirect_uri: base.redirect_uri, code_verifier: crypto.randomBytes(32).toString('base64url'), resource: RESOURCE });
  assert.equal(t.j.error, 'invalid_grant'); ok('wrong code_verifier refused');
  t = await tok({ grant_type: 'authorization_code', code, client_id: p1.info.client_id, redirect_uri: base.redirect_uri, code_verifier: verifier, resource: RESOURCE });
  assert.equal(t.j.error, 'invalid_grant'); ok('code is single-use (burnt by the failed attempt)');

  // CSRF: consent POST from another origin is refused
  const fresh2 = await authz({ ...base, code_challenge: challenge, state: 'x2' });
  const rid = new URL(fresh2.headers.get('location'), AUTH).searchParams.get('r');
  await page.goto(`${AUTH}/consent?r=${rid}`);
  const actionId = await page.evaluate(() => { const f = document.querySelector('form'); return f ? f.querySelector('input[name^="$ACTION_ID"]')?.getAttribute('name') : null; });
  const cookies = (await ctx.cookies(AUTH)).map((c) => `${c.name}=${c.value}`).join('; ');
  const csrf = await fetch(`${AUTH}/consent?r=${rid}`, { method: 'POST', redirect: 'manual', headers: { cookie: cookies, origin: 'https://evil.example', 'content-type': 'multipart/form-data; boundary=x', ...(actionId ? { 'next-action': actionId.replace('$ACTION_ID_', '') } : {}) }, body: '--x--' });
  assert.ok(!/code=/.test(csrf.headers.get('location') || ''), 'no code for cross-site consent'); ok(`cross-site consent POST refused (HTTP ${csrf.status})`);

  // SSRF: CIMD URL pointing at a private address
  r = await authz({ ...base, client_id: 'https://127.0.0.1/oauth/client.json' });
  assert.equal(r.status, 400); ok('CIMD on a private address refused (SSRF)');
  r = await authz({ ...base, client_id: 'http://example.com/client.json' });
  assert.equal(r.status, 400); ok('CIMD over plain http refused');

  // DCR: redirect URIs outside the allowlist
  const reg = await fetch(`${AUTH}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
  assert.equal(reg.status, 400); ok('DCR with a foreign https redirect refused');

  // audience: a token for another resource is refused by the MCP server
  const { SignJWT, generateKeyPair } = await import(req.resolve('jose'));
  const { privateKey } = await generateKeyPair('ES256');
  const forged = await new SignJWT({ scope: 'lego', gid: 'g' }).setProtectedHeader({ alg: 'ES256', kid: 'x', typ: 'at+jwt' }).setIssuer(AUTH).setSubject('u_x').setAudience(RESOURCE).setExpirationTime('5m').sign(privateKey);
  r = await fetch(RESOURCE, { method: 'POST', headers: { authorization: 'Bearer ' + forged, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal(r.status, 401); ok('token signed by another key refused');

  // ---------------------------------------------------------------- review findings
  // parallel refresh of the same token: both get the same new pair, nothing revoked (grace window)
  const pf = makeProvider();
  const tf = new StreamableHTTPClientTransport(new URL(RESOURCE), { authProvider: pf });
  await assert.rejects(new Client({ name: 'pf', version: '1' }).connect(tf), (e) => e instanceof UnauthorizedError);
  const cbf = await loginAndAllow(new URL(pf.lastUrl));
  await tf.finishAuth(cbf.searchParams.get('code'));
  const rtp = pf.savedTokens.refresh_token;
  const [pa, pb] = await Promise.all([1, 2].map(() => tok({ grant_type: 'refresh_token', refresh_token: rtp, client_id: pf.info.client_id })));
  assert.equal(pa.status, 200); assert.equal(pb.status, 200); assert.equal(pa.j.refresh_token, pb.j.refresh_token); ok('parallel refresh: both succeed with the same new tokens');
  const next = await tok({ grant_type: 'refresh_token', refresh_token: pa.j.refresh_token, client_id: pf.info.client_id });
  assert.equal(next.status, 200); ok('connection still alive after a parallel refresh');

  // reusing an authorization code revokes the connection it created
  const v2 = crypto.randomBytes(32).toString('base64url');
  const ch2 = crypto.createHash('sha256').update(v2).digest('base64url');
  const fr = await authz({ ...base, client_id: pf.info.client_id, code_challenge: ch2, state: 'cr' });
  const cbr = await loginAndAllow(new URL(fr.headers.get('location'), AUTH));
  const goodCode = cbr.searchParams.get('code');
  const first = await tok({ grant_type: 'authorization_code', code: goodCode, client_id: pf.info.client_id, redirect_uri: base.redirect_uri, code_verifier: v2, resource: RESOURCE });
  assert.equal(first.status, 200);
  const again = await tok({ grant_type: 'authorization_code', code: goodCode, client_id: pf.info.client_id, redirect_uri: base.redirect_uri, code_verifier: v2, resource: RESOURCE });
  assert.equal(again.j.error, 'invalid_grant');
  const afterReuse = await tok({ grant_type: 'refresh_token', refresh_token: first.j.refresh_token, client_id: pf.info.client_id });
  assert.equal(afterReuse.j.error, 'invalid_grant'); ok('code reuse revokes the connection it created');

  // CIMD errors never redirect (no open redirect through a hostile metadata URL)
  r = await authz({ ...base, client_id: 'https://nonexistent.invalid/client.json', redirect_uri: 'https://evil.example/cb' });
  assert.equal(r.status, 400); assert.equal(r.headers.get('location'), null); ok('CIMD failure: error page, no redirect');
  r = await authz({ ...base, client_id: 'https://[::1]/client.json' });
  assert.equal(r.status, 400); ok('CIMD IPv6 literal refused');
  r = await authz({ ...base, client_id: 'https://2130706433/client.json' });
  assert.equal(r.status, 400); ok('CIMD decimal IP literal refused');
  // missing redirect_uri is an error page (no default)
  const { redirect_uri: _drop, ...noRedirect } = base;
  r = await authz(noRedirect);
  assert.equal(r.status, 400); ok('missing redirect_uri refused');
  // unverified client: the consent shows its real host and a warning
  await page.goto(new URL((await authz({ ...base, code_challenge: ch2, state: 'w' })).headers.get('location'), AUTH).toString());
  assert.ok(await page.locator('[data-testid=unverified]').count()); ok('unverified client: warning on the consent screen');
  // JWT in ?key= is not accepted
  r = await fetch(`${RESOURCE}?key=${encodeURIComponent(next.j.access_token)}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal(r.status, 401); ok('access token in the URL refused (header only)');
  // DCR asking for a client secret is registered as a public client
  const regs = await (await fetch(`${AUTH}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [`http://127.0.0.1:${CB_PORT}/callback`], token_endpoint_auth_method: 'client_secret_post' }) })).json();
  assert.equal(regs.token_endpoint_auth_method, 'none'); ok('DCR client_secret_post request registered as public client');

  // ---------------------------------------------------------------- account page: revoke
  await page.goto(`${AUTH}/account`);
  const grants = await page.locator('[data-testid=grant]').count();
  assert.ok(grants >= 1); ok(`account page lists ${grants} connected app(s)`);
  for (let i = 0; i < grants; i++) {
    await page.goto(`${AUTH}/account`);
    await Promise.all([page.waitForURL(`${AUTH}/account`), page.locator('[data-testid=revoke]').first().click()]);
    await page.waitForLoadState('networkidle');
  }
  await page.goto(`${AUTH}/account`);
  assert.equal(await page.locator('[data-testid=grant]').count(), 0); ok('all connections revoked from the account page');
  const r4 = await fetch(RESOURCE, { method: 'POST', headers: { authorization: 'Bearer ' + p2.savedTokens.access_token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal(r4.status, 401); ok('after "Отключить" the client loses access');

  // owner key still works
  const own = await fetch(`${RESOURCE}?key=owner-key-123`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal(own.status, 200); ok('owner key still works');

  await page.screenshot({ path: path.join(HERE, 'account.png') });
  console.log('oauth e2e passed');
} catch (e) {
  console.error(e);
  console.error('--- auth server log tail ---\n' + authLog.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser.close();
  auth.kill();
  mcp.close(); cimd.close();
  setTimeout(() => process.exit(process.exitCode || 0), 200);
}
