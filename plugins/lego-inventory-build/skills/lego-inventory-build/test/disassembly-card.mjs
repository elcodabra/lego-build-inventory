// Browser check of the card (mcp/player.html) for Build <-> Disassemble, Exploded, step paging and
// keyboard, at desktop and mobile width. Runs the real HTTP MCP server locally; the card only loads
// https media, so files are published as https://media.test/files/... and Playwright serves them.
//   node test/disassembly-card.mjs [outdir]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'lego-card-'));
fs.mkdirSync(OUT, { recursive: true });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-card-data-'));
const PORT = 18791;
const ok = (m) => console.log('  ok  ' + m);

const srv = spawn('node', [path.join(ROOT, 'mcp/server.mjs'), '--http', '--port', String(PORT)], {
  env: { ...process.env, LEGO_DATA_DIR: DATA, PUBLIC_URL: 'https://media.test', LEGO_MCP_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((res, rej) => { srv.stderr.on('data', (d) => /HTTP ready/.test(d) && res()); srv.stdout.on('data', (d) => /HTTP ready/.test(d) && res()); setTimeout(() => rej(new Error('server did not start')), 15000); });
const c = new Client({ name: 'openai-mcp', version: '1.0.0' });
await c.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`)));
const tool = (await c.listTools()).tools.find((t) => t.name === 'model_disassemble');
const res = (await c.readResource({ uri: tool._meta.ui.resourceUri })).contents[0];
const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https://media.test data:; media-src https://media.test; connect-src 'none'";

const b = await chromium.launch();
async function card(width, first) {
  const p = await b.newPage({ viewport: { width, height: 900 } });
  await p.route('https://media.test/**', (r) => r.fulfill({ path: path.join(DATA, 'exports', decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop())), contentType: 'image/png' }));
  const calls = [];
  await p.exposeFunction('hostCall', async (params) => { calls.push(params.name + ':' + (params.arguments.mode || '')); const rr = await c.callTool(params); return { structuredContent: rr.structuredContent, content: rr.content }; });
  await p.setContent(`<html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="width:${width - 20}px;height:860px;border:0;margin:10px"></iframe></body></html>`);
  await p.evaluate(({ html, result }) => {
    const f = document.getElementById('f');
    addEventListener('message', (e) => {
      const m = e.data;
      if (!m || m.jsonrpc !== '2.0') return;
      if (m.method === 'ui/initialize') f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'fake', version: '0' }, hostCapabilities: {}, hostContext: {} } }, '*');
      if (m.method === 'tools/call') window.hostCall(m.params).then((r) => f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: r }, '*'));
      if (m.method === 'ui/notifications/initialized') f.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
    });
    f.srcdoc = html;
  }, { html: res.text.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`), result: { structuredContent: first.structuredContent } });
  const f = p.frameLocator('#f');
  await f.locator('h2').waitFor();
  return { p, f, calls };
}
const imgLoaded = (f, sel) => f.locator(sel).evaluate((i) => i.complete && i.naturalWidth > 0);

// 1) build card for cat -> Disassemble -> Exploded -> steps -> keyboard -> Build
const first = await c.callTool({ name: 'show_build', arguments: { name: 'cat' } });
const { p, f, calls } = await card(760, first);
assert.equal(await f.locator('button[data-dir=build]').getAttribute('aria-pressed'), 'true');
assert.equal(await f.locator('.tag').count(), 0);
await p.screenshot({ path: path.join(OUT, '1-build.png') });
await f.locator('button[data-dir=disassemble]').click();
await f.locator('.tag.warn').waitFor({ timeout: 30000 });
assert.match(await f.locator('.tag').first().textContent(), /Based on exact model JSON/);
assert.ok(await imgLoaded(f, '.stage img'));
await p.screenshot({ path: path.join(OUT, '2-disassemble.png') });
await f.locator('#explode').click();
assert.match(await f.locator('.stage img').getAttribute('alt'), /^Exploded view/);
await f.locator('.stage img').evaluate((i) => i.decode());
assert.ok(await imgLoaded(f, '.stage img'));
await p.screenshot({ path: path.join(OUT, '3-exploded.png') });
ok('Build -> Disassemble shows exact-JSON + not-validated tags; Exploded toggles to the exploded picture');
await f.locator('button[data-dmode=steps]').click();
await f.locator('#next').waitFor({ timeout: 60000 });
assert.match(await f.locator('.nav span').textContent(), /Разборка 1 из 17/);
await f.locator('#next').click();
await f.locator('#next').click();
assert.match(await f.locator('.nav span').textContent(), /Разборка 3 из 17/);
await f.locator('#next').focus();
await p.keyboard.press('ArrowLeft');
assert.match(await f.locator('.nav span').textContent(), /Разборка 2 из 17/);
await f.locator('#stepimg').evaluate((i) => i.decode());
assert.ok(await imgLoaded(f, '#stepimg'));
await p.screenshot({ path: path.join(OUT, '4-steps.png') });
ok('reverse steps page with buttons and ArrowLeft/ArrowRight');
await f.locator('button[data-dir=build]').click();
await f.locator('button[data-dir=build][aria-pressed=true]').waitFor({ timeout: 60000 });
assert.match(await f.locator('.nav span').textContent(), /Шаг 1 из 17/);
assert.equal(await f.locator('.tag').count(), 0);
ok('Disassemble -> Build keeps the steps view and returns to build step 1');
assert.deepEqual(calls, ['model_disassemble:picture', 'model_disassemble:steps', 'show_build:steps']);
await p.close();

// 1b) analysis card (synthetic result, no API call): AI estimate tag, confirm -> exact disassembly
const analysis = { structuredContent: { kind: 'analysis', status: 'ok', provider: { model: 'muse-spark-1.3', ms: 9000 },
  analysis: { is_lego_model: true, object_summary: 'orange <b>cat</b>', visible_colours: ['orange', 'white'], visible_parts: [{ category: 'brick', count_estimate: 20, confidence: 'medium' }], possible_model_names: ['cat'], match_confidence: 'high', uncertainties: ['back hidden'], suggested_views: ['side'] },
  candidates: [{ name: 'cat', title: 'Котик', parts: 106, steps: 17, rank: 1, label: 'possible match' }] } };
const A = await card(760, analysis);
assert.match(await A.f.locator('.tag.warn').textContent(), /AI estimate/);
assert.equal(await A.f.locator('p b').count(), 0, 'AI text is escaped, not HTML');
await A.p.screenshot({ path: path.join(OUT, '0-analysis.png') });
await A.f.locator('button[data-confirm=cat]').click();
await A.f.locator('.tag', { hasText: 'Based on exact model JSON' }).waitFor({ timeout: 30000 });
assert.deepEqual(A.calls, ['model_disassemble:']);
ok('analysis card: AI estimate tag, escaped AI text, "Это Котик" confirms -> exact disassembly card');
const un = await card(390, { structuredContent: { kind: 'analysis', status: 'unavailable', error: 'META_UNAVAILABLE', candidates: [], known: [{ name: 'cat', title: 'Котик', parts: 106 }, { name: 'microduck', title: 'Microduck', parts: 54 }] } });
assert.equal(await un.f.locator('button[data-confirm]').count(), 2);
assert.match(await un.f.locator('h2').textContent(), /недоступен/);
ok('Meta unavailable: card offers known models to pick by hand');
await A.p.close(); await un.p.close();

// 2) mobile width: nothing overflows horizontally, toggle reachable
const mob = await c.callTool({ name: 'model_disassemble', arguments: { name: 'microduck' } });
const m = await card(390, mob);
const overflow = await m.f.locator('body').evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert.ok(overflow <= 0, 'horizontal overflow ' + overflow);
assert.ok(await m.f.locator('button[data-dir=build]').isVisible());
await m.p.screenshot({ path: path.join(OUT, '5-mobile.png'), fullPage: true });
ok('mobile 390 px: no horizontal overflow, toggle visible');
await m.p.close();

await b.close();
await c.close();
srv.kill();
console.log('all good, screenshots in ' + OUT);
