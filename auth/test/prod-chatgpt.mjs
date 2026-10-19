// node test/prod-chatgpt.mjs [mcp url]: plays ChatGPT's exact OAuth client against production: CIMD client_id, stable redirect,
// PKCE S256, resource = MCP URL, token exchange with auth method "none", then real MCP calls.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const req = createRequire(new URL('../../plugins/lego-inventory-build/skills/lego-inventory-build/package.json', import.meta.url));
const { chromium } = req('playwright');
const { Client } = await import(req.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StreamableHTTPClientTransport } = await import(req.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));
const ok = (m) => console.log('  ok ', m);
const MCP = process.argv[2] || 'https://lego-mcp.vercel.app/mcp';
const CID = 'https://chatgpt.com/oauth/client.json';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

// 1. what ChatGPT does first: hit the MCP server, follow the challenge to the metadata
const r401 = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"openai-mcp","version":"1.0.0"}}}' });
const prmUrl = r401.headers.get('www-authenticate').match(/resource_metadata="([^"]+)"/)[1];
const prm = await (await fetch(prmUrl)).json();
const asm = await (await fetch(prm.authorization_servers[0] + '/.well-known/oauth-authorization-server')).json();
assert.equal(asm.issuer, prm.authorization_servers[0]);
assert.ok(asm.client_id_metadata_document_supported && asm.code_challenge_methods_supported.includes('S256') && asm.authorization_response_iss_parameter_supported);
const cimd = await (await fetch(CID)).json();
const methods = cimd.token_endpoint_auth_methods_supported.filter((m) => asm.token_endpoint_auth_methods_supported.includes(m));
assert.deepEqual(methods, ['none']);
ok(`discovery like ChatGPT: 401 -> ${prmUrl.replace('https://', '')} -> issuer ${asm.issuer}; auth-method intersection with ChatGPT CIMD = ${methods}`);

// 2. authorization request exactly as ChatGPT builds it
const verifier = crypto.randomBytes(48).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(16).toString('base64url');
const au = new URL(asm.authorization_endpoint);
for (const [k, v] of Object.entries({ response_type: 'code', client_id: CID, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state, resource: prm.resource, scope: prm.scopes_supported.join(' ') })) au.searchParams.set(k, v);

const b = await chromium.launch(); const ctx = await b.newContext(); const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page); await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
let cb = null;
await page.route(REDIRECT + '**', (r) => { cb = r.request().url(); return r.fulfill({ status: 200, body: 'intercepted' }); });
await page.goto(au.toString());
const loginText = await page.locator('.card p').first().innerText();
await page.fill('input[aria-label="Имя"]', 'ChatGPT path test');
await page.click('[data-testid=signup]');
await page.waitForSelector('[data-testid=allow]', { timeout: 20000 });
const consent = await page.locator('.card').first().innerText();
const unverified = await page.locator('[data-testid=unverified]').count();
await page.screenshot({ path: '/tmp/chatgpt-consent.png' });
await page.click('[data-testid=allow]');
for (let i = 0; i < 100 && !cb; i++) await new Promise((r) => setTimeout(r, 100));
const back = new URL(cb);
assert.equal(back.origin + back.pathname, REDIRECT); assert.equal(back.searchParams.get('state'), state); assert.equal(back.searchParams.get('iss'), asm.issuer);
ok(`browser: login screen says "${loginText.slice(0, 60)}…"; consent names ChatGPT as verified (warning shown: ${!!unverified})`);
ok(`redirect to ${REDIRECT} with code, same state, iss=${back.searchParams.get('iss')}`);

// 3. token exchange like ChatGPT with method "none"
const tr = await fetch(asm.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: REDIRECT, client_id: CID, code_verifier: verifier, resource: prm.resource }) });
const tok = await tr.json();
assert.equal(tr.status, 200, JSON.stringify(tok));
const claims = JSON.parse(Buffer.from(tok.access_token.split('.')[1], 'base64url'));
assert.equal(claims.aud, prm.resource); assert.equal(claims.client_id, CID);
ok(`token: aud=${claims.aud}, client_id=${claims.client_id}, expires_in=${tok.expires_in}s, refresh issued: ${!!tok.refresh_token}`);

// 4. real MCP session with that token, the way ChatGPT calls tools
const t = new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: 'Bearer ' + tok.access_token, 'user-agent': 'openai-mcp/1.0.0' } } });
const c = new Client({ name: 'openai-mcp', version: '1.0.0' });
await c.connect(t);
const tools = (await c.listTools()).tools;
const empty = (await c.callTool({ name: 'inventory_show', arguments: {} })).content[0].text;
await c.callTool({ name: 'inventory_import', arguments: { data: 'part,color,qty\n3001,red,8\n3003,white,10\n3039,red,6\n3004,white,8' } });
const s = JSON.parse((await c.callTool({ name: 'ideas_suggest', arguments: {} })).content[0].text);
const idea = s.buildable[0].idea;
await c.callTool({ name: 'idea_build', arguments: { idea } });
const card = await c.callTool({ name: 'show_build', arguments: { name: idea } });
const pic = await fetch(card.structuredContent.posterUrl, { method: 'HEAD' });
ok(`MCP: ${tools.length} tools; new account starts empty (${/empty/i.test(empty)}); built "${idea}", card picture HTTP ${pic.status}`);

// 4b. optional: a real photo of a pile (PILE=/path/to/photo.jpg|heic), the whole user path:
// photo -> parts -> ideas with wheels/technic parts -> build -> card picture
if (process.env.PILE) {
  const fs = await import('node:fs');
  const b64 = fs.readFileSync(process.env.PILE).toString('base64');
  const mime = /\.heic$/i.test(process.env.PILE) ? 'image/heic' : 'image/jpeg';
  const t0 = Date.now();
  // an earlier list "by eye" (what ChatGPT did before): the photo must replace it, not add to it
  await c.callTool({ name: 'inventory_import', arguments: { data: 'part,color,qty\n3020,black,50\n3004,red,9', source: 'Фото, примерный подсчет' } });
  const pr = await c.callTool({ name: 'parts_from_pile_photo', arguments: { files: [{ download_url: `data:${mime};base64,${b64}`, file_id: 'file_test', mime_type: mime }] } });
  assert.ok(!pr.isError, pr.content[0].text);
  const pj = JSON.parse(pr.content[0].text);
  const inv1 = JSON.parse((await c.callTool({ name: 'inventory_show', arguments: {} })).content[0].text);
  assert.equal(pj.mode, 'replace'); assert.ok(pj.replacedPrevious, 'says the old list was replaced');
  assert.equal(inv1.totalParts, pj.totalParts, 'the inventory is exactly the photo');
  const un = JSON.parse((await c.callTool({ name: 'inventory_undo', arguments: {} })).content[0].text);
  assert.ok(un.totalParts >= 59, 'undo brings the old list back');
  await c.callTool({ name: 'inventory_undo', arguments: {} });
  ok(`photo replaced the 59-part list by eye (${pj.totalParts} parts now), inventory_undo swaps back and forth`);
  const drawable = pj.parts.filter((p) => p.drawable).reduce((a, p) => a + p.qty, 0);
  if (process.env.PILE_JSON) fs.writeFileSync(process.env.PILE_JSON, JSON.stringify(pj, null, 1));
  ok(`pile photo: ${pj.totalParts} parts recognised in ${((Date.now() - t0) / 1000).toFixed(0)}s, ${drawable} usable in models`);
  const psr = await c.callTool({ name: 'ideas_suggest', arguments: {} });
  const ps = JSON.parse(psr.content[0].text);
  const card = psr.structuredContent;
  assert.equal(card.kind, 'ideas');
  const thumbs = await Promise.all(card.ideas.map(async (x) => (x.thumbUrl ? (await fetch(x.thumbUrl)).status : 0)));
  assert.ok(thumbs.length && thumbs.every((s) => s === 200), 'idea thumbnails: ' + thumbs.join(','));
  if (process.env.IDEAS_OUT) fs.writeFileSync(process.env.IDEAS_OUT, JSON.stringify(card));
  ok(`ideas card: ${card.ideas.map((x) => `${x.title} ${x.parts}`).join(', ')}; ${thumbs.length} pictures from the user's parts, HTTP 200`);
  assert.ok(ps.buildable.length > 0, 'no buildable ideas from the pile');
  const pidea = ps.buildable[0].idea;
  await c.callTool({ name: 'idea_build', arguments: { idea: pidea } });
  const pcard = await c.callTool({ name: 'show_build', arguments: { name: pidea, mode: 'steps' } });
  assert.ok(!pcard.isError, pcard.content && pcard.content[0].text);
  const ppic = await fetch(pcard.structuredContent.posterUrl);
  if (process.env.PILE_OUT) fs.writeFileSync(process.env.PILE_OUT, Buffer.from(await ppic.arrayBuffer()));
  ok(`pile ideas: ${ps.buildable.map((x) => x.idea).join(', ')}; built "${pidea}" (${pcard.structuredContent.parts} parts, ${pcard.structuredContent.steps} steps), picture HTTP ${ppic.status}`);
  if (process.env.VIDEO) {
    const tv = Date.now();
    // FORMAT=horizontal renders a film not yet in the cache, so the upload (and the OAuth token) runs for real
    const fmt = process.env.FORMAT ? { format: process.env.FORMAT } : {};
    const vcard = await c.callTool({ name: 'show_build', arguments: { name: pidea, mode: 'video', ...fmt } }, undefined, { timeout: 300000 });
    assert.ok(!vcard.isError && vcard.structuredContent.videoUrl, vcard.content && vcard.content[0].text);
    const vh = await fetch(vcard.structuredContent.videoUrl, { method: 'HEAD' });
    ok(`video of "${pidea}" in ${((Date.now() - tv) / 1000).toFixed(1)}s, mp4 HTTP ${vh.status}, ${vh.headers.get('content-length')} bytes`);
    // the film of a model made from the photographed pile opens on that pile
    assert.equal(vcard.structuredContent.pileIntro, true, 'video opens on the pile photo');
    ok('video opens on the cleaned pile photo (pileIntro)');
    // YOUTUBE_USERS=*: a regular user's film is copied to the channel after the reply; the card
    // links to it the next time (served from the film cache)
    if (process.env.YOUTUBE) {
      let yt = null;
      for (let i = 0; i < 12 && !yt; i++) {
        await new Promise((r) => setTimeout(r, 10000));
        const again = await c.callTool({ name: 'show_build', arguments: { name: pidea, mode: 'video', ...fmt } }, undefined, { timeout: 300000 });
        yt = again.structuredContent && again.structuredContent.youtubeUrl;
      }
      assert.match(String(yt), /^https:\/\/youtu\.be\//, 'a regular user\'s film reached YouTube');
      ok(`regular user's film uploaded to the channel: ${yt}`);
    }
  }
}

// 5. refresh like ChatGPT after an hour
const rr = await fetch(asm.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: CID, resource: prm.resource }) });
assert.equal(rr.status, 200); ok('refresh with ChatGPT client_id works');

// clean up: disconnect this test connection
await page.goto(prm.authorization_servers[0] + '/account');
await Promise.all([page.waitForURL(/\/account$/), page.locator('[data-testid=revoke]').first().click()]);
ok('test connection disconnected from the account page');
await b.close(); process.exit(0);
