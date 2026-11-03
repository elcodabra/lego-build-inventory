// Records the hackathon demo video against the PRODUCTION server with real Meta calls (about $0.02).
// A plain chat-like page hosts the real card (mcp/player.html from the server, same CSP as ChatGPT),
// captions say what is happening and what is real. Output: webm -> mp4 (ffmpeg-static).
//   node --use-system-ca test/record-demo.mjs "https://lego-mcp.vercel.app/mcp?key=<key>" <real-photo> [out.mp4]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const require = createRequire(import.meta.url);
const [url, realPhoto, outArg] = process.argv.slice(2);
const OUT = outArg || path.join(process.cwd(), 'demo.mp4');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));

const c = new Client({ name: 'openai-mcp', version: '1.0.0' });
await c.connect(new StreamableHTTPClientTransport(new URL(url)));
const tool = (await c.listTools()).tools.find((t) => t.name === 'model_disassemble');
const res = (await c.readResource({ uri: tool._meta.ui.resourceUri })).contents[0];
const media = res._meta.ui.csp.resourceDomains.join(' ');
const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${media} data:; media-src ${media}; connect-src 'none'`;
const log = [];
const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); log.push({ name, ms: 0 }); return r; };

// photos: the real one (shown + sent as-is) and the cat render (labelled as a render)
const nf = require('../lib/nodefilm.cjs');
const catPng = await nf.hero(require('../lib/core.cjs').loadModel('cat'), { size: 900, theta: 30 });
const catUrl = 'data:image/png;base64,' + catPng.toString('base64');
const realJpg = path.join(TMP, 'real.jpg');
execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '1200', realPhoto, '--out', realJpg], { stdio: 'ignore' });
const realUrl = 'data:image/jpeg;base64,' + fs.readFileSync(realJpg).toString('base64');

const W = 1280; const H = 800;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: TMP, size: { width: W, height: H } } });
const p = await ctx.newPage();
await p.exposeFunction('hostCall', async (params) => { const rr = await call(params.name, params.arguments); return { structuredContent: rr.structuredContent, content: rr.content }; });
await p.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#f7f7f8;font:16px/1.45 Inter,system-ui,-apple-system,sans-serif;color:#1f2328}
  .top{height:52px;display:flex;align-items:center;gap:10px;padding:0 24px;border-bottom:1px solid #e5e7eb;background:#fff;font-weight:600}
  .top small{font-weight:400;color:#6b7280}
  .chat{max-width:860px;margin:0 auto;padding:18px 24px 120px;height:${H - 52}px;box-sizing:border-box;overflow:auto}
  .u{display:flex;justify-content:flex-end;margin:14px 0}.u .b{background:#e9eef6;border-radius:16px;padding:10px 14px;max-width:70%}
  .u img{display:block;max-width:240px;max-height:200px;border-radius:12px;margin-bottom:8px}
  .a{margin:14px 0}.a .t{margin:6px 0}
  iframe{width:100%;border:0;background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .cap{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:rgba(17,24,39,.92);color:#fff;padding:10px 18px;border-radius:12px;font-size:17px;max-width:900px;text-align:center;opacity:0;transition:opacity .4s}
  .cap.on{opacity:1}.cap b{color:#FFD21A}
</style></head><body><div class="top">LEGO from My Bricks <small>· MCP app · live on lego-mcp.vercel.app · Meta Muse Spark 1.3</small></div>
<div class="chat" id="chat"></div><div class="cap" id="cap"></div></body></html>`);
await p.evaluate(({ html }) => {
  window.__html = html;
  window.frames_ = [];
  addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.jsonrpc !== '2.0') return;
    const f = window.frames_.find((x) => x.contentWindow === e.source);
    if (!f) return;
    if (m.method === 'ui/initialize') f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'demo', version: '0' }, hostCapabilities: {}, hostContext: { theme: 'light' } } }, '*');
    if (m.method === 'ui/notifications/initialized') f.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: f.__result }, '*');
    if (m.method === 'ui/notifications/size-changed' && m.params) f.style.height = Math.min(640, Math.max(200, m.params.height + 4)) + 'px';
    if (m.method === 'tools/call') window.hostCall(m.params).then((r) => f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: r }, '*'));
  });
}, { html: res.text.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`) });

const wait = (ms) => p.waitForTimeout(ms);
const caption = async (html, ms) => { await p.evaluate((h) => { const c = document.getElementById('cap'); c.innerHTML = h; c.classList.add('on'); }, html); if (ms) await wait(ms); };
const user = (text, img) => p.evaluate(({ text, img }) => {
  const d = document.createElement('div'); d.className = 'u';
  d.innerHTML = `<div class="b">${img ? `<img src="${img}">` : ''}${text}</div>`;
  document.getElementById('chat').appendChild(d); d.scrollIntoView({ behavior: 'smooth', block: 'end' });
}, { text, img });
const assistantCard = (text, result) => p.evaluate(({ text, result }) => {
  const d = document.createElement('div'); d.className = 'a';
  d.innerHTML = `<div class="t">${text}</div>`;
  const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.style.height = '420px';
  f.__result = result; window.frames_.push(f); d.appendChild(f);
  document.getElementById('chat').appendChild(d);
  f.srcdoc = window.__html;
  setTimeout(() => d.scrollIntoView({ behavior: 'smooth', block: 'start' }), 900);
  return window.frames_.length - 1;
}, { text, result });
const frame = (i) => p.frameLocator('iframe').nth(i);
const scrollChat = () => p.evaluate(() => { const c = document.getElementById('chat'); c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' }); });

// ---- 1. intro
await caption('Show a photo of a LEGO model you <b>already built</b>. Get the exact way to take it apart.', 3500);

// ---- 2. a real photo of an unknown build: honest "no match"
await user('What is this model and how do I take it apart?', realUrl);
await caption('A <b>real iPhone photo</b> of a build the app does not know. Sent to <b>Meta Muse Spark 1.3</b> (live call)…');
const a1 = await call('model_analyze_photo', { image: realUrl });
const r1 = a1.structuredContent;
await assistantCard('I described what is visible. None of your known models matches, so I will not invent instructions.', { structuredContent: r1 });
await wait(1500); await scrollChat();
await caption(`Muse Spark: "${(r1.analysis && r1.analysis.object_summary || '').slice(0, 90)}…" · <b>no match</b>, no made-up steps`, 6500);

// ---- 3. a known model (render, labelled): match -> confirm
await user('And this one?', catUrl);
await caption('A <b>render</b> of the built-in cat (we have no physical one built yet) · live Muse call…');
const a2 = await call('model_analyze_photo', { image: catUrl });
const r2 = a2.structuredContent;
const i2 = await assistantCard('Possible match among your models. Please confirm.', { structuredContent: r2 });
await wait(2000); await scrollChat();
await caption(`AI estimate: <b>${r2.candidates[0] ? r2.candidates[0].title : 'none'}</b> (${r2.analysis.match_confidence}). The user confirms, the AI never draws geometry.`, 4500);
await frame(i2).locator('button[data-confirm]').first().click();
await frame(i2).locator('.tag', { hasText: 'Based on exact model JSON' }).waitFor({ timeout: 60000 });
await wait(1200); await scrollChat();
await caption('<b>Exact</b> parts list and geometry from the saved model JSON: 106 parts.', 4500);

// ---- 4. exploded, reverse steps, build again
await frame(i2).locator('#explode').click();
await caption('Exploded view: the build steps lifted apart (an illustration, not a physical extraction path).', 4500);
await frame(i2).locator('button[data-dmode=steps]').click();
await frame(i2).locator('#next').waitFor({ timeout: 60000 });
await wait(800); await scrollChat();
await caption('Disassembly steps: each step outlines the parts to remove (the build steps in reverse).', 2500);
for (let k = 0; k < 4; k++) { await frame(i2).locator('#next').click(); await wait(1100); }
await frame(i2).locator('button[data-dir=build]').click();
await frame(i2).locator('button[data-dir=build][aria-pressed=true]').waitFor({ timeout: 60000 });
await caption('One switch back to <b>Build</b>: same parts, build order. Model and inventory never change.', 4500);
await caption('Real Meta API · user-confirmed match · exact data · honest limits. <b>LEGO from My Bricks</b>', 4000);

const vid = p.video();
await ctx.close();
await b.close();
await c.close();
const webm = await vid.path();
const ff = require('ffmpeg-static');
execFileSync(ff, ['-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', OUT], { stdio: 'ignore' });
console.log(JSON.stringify({ out: OUT, bytes: fs.statSync(OUT).size, real_photo: { status: r1.status, candidates: r1.candidates.length, response: r1.provider && r1.provider.responseId }, render: { top: r2.candidates[0] && r2.candidates[0].name, response: r2.provider && r2.provider.responseId } }));
