// Records the hackathon demo video against the PRODUCTION server with real Meta calls (about $0.02).
// All tool calls run FIRST (real Muse Spark + real renders on lego-mcp.vercel.app, response ids
// printed); then a chat-like page plays the real cards (mcp/player.html from the server, same CSP as
// ChatGPT) without waiting on the network. Clicks inside the card still call the server live.
// Output: webm -> mp4, English captions timed to reading speed.
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
const EN = { lang: 'en' };

const c = new Client({ name: 'openai-mcp', version: '1.0.0' });
await c.connect(new StreamableHTTPClientTransport(new URL(url)));
const tool = (await c.listTools()).tools.find((t) => t.name === 'model_disassemble');
const res = (await c.readResource({ uri: tool._meta.ui.resourceUri })).contents[0];
const media = res._meta.ui.csp.resourceDomains.join(' ');
const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${media} data:; media-src ${media}; connect-src 'none'`;

// ---- photos: the real one (sent as-is) and the cat render (labelled as a render)
const nf = require('../lib/nodefilm.cjs');
const catPng = await nf.hero(require('../lib/core.cjs').loadModel('cat'), { size: 900, theta: 30 });
const catUrl = 'data:image/png;base64,' + catPng.toString('base64');
const realJpg = path.join(TMP, 'real.jpg');
execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '1200', realPhoto, '--out', realJpg], { stdio: 'ignore' });
const realUrl = 'data:image/jpeg;base64,' + fs.readFileSync(realJpg).toString('base64');

// ---- 1) all real calls up front (results replayed below; card clicks are live and cached server-side)
const t0 = Date.now();
const r1 = (await c.callTool({ name: 'model_analyze_photo', arguments: { image: realUrl, ...EN } })).structuredContent;
const r2 = (await c.callTool({ name: 'model_analyze_photo', arguments: { image: catUrl, ...EN } })).structuredContent;
if (r1.status !== 'ok' || r2.status !== 'ok') throw new Error('Meta analysis failed: ' + (r1.error || r2.error));
const pick = r2.candidates[0] ? r2.candidates[0].name : 'cat';
// warm the server caches the card buttons will hit
const cache = new Map();
const warm = async (name, args) => { const r = await c.callTool({ name, arguments: args }); cache.set(name + JSON.stringify(args), r); return r; };
await warm('model_disassemble', { name: pick, confirmed: true, ...EN });
await warm('model_disassemble', { name: pick, mode: 'steps', ...EN });
await warm('show_build', { name: pick, mode: 'steps', ...EN });
console.log(JSON.stringify({ precomputed_s: Math.round((Date.now() - t0) / 1000), real_photo_response: r1.provider.responseId, render_response: r2.provider.responseId, top: pick }));

// ---- 2) the page
const W = 1280; const H = 800;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: TMP, size: { width: W, height: H } } });
const p = await ctx.newPage();
// card buttons: served from the warmed results when the same call was made, else a live call
await p.exposeFunction('hostCall', async (params) => {
  const key = params.name + JSON.stringify(params.arguments);
  const rr = cache.get(key) || await c.callTool(params);
  return { structuredContent: rr.structuredContent, content: rr.content };
});
await p.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#f7f7f8;font:16px/1.45 Inter,system-ui,-apple-system,sans-serif;color:#1f2328}
  .top{height:52px;display:flex;align-items:center;gap:10px;padding:0 24px;border-bottom:1px solid #e5e7eb;background:#fff;font-weight:600}
  .top small{font-weight:400;color:#6b7280}
  .chat{max-width:860px;margin:0 auto;padding:18px 24px 120px;height:${H - 52}px;box-sizing:border-box;overflow:auto}
  .u{display:flex;justify-content:flex-end;margin:14px 0}.u .b{background:#e9eef6;border-radius:16px;padding:10px 14px;max-width:70%}
  .u img{display:block;max-width:220px;max-height:180px;border-radius:12px;margin-bottom:8px}
  .a{margin:14px 0}.a .t{margin:6px 0}
  iframe{width:100%;border:0;background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .cap{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:rgba(17,24,39,.92);color:#fff;padding:10px 18px;border-radius:12px;font-size:18px;max-width:960px;text-align:center}
  .cap b{color:#FFD21A}
</style></head><body><div class="top">LEGO from My Bricks <small>· MCP app on lego-mcp.vercel.app · photo analysis by Meta Muse Spark 1.3</small></div>
<div class="chat" id="chat"></div><div class="cap" id="cap" hidden></div></body></html>`);
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
    if (m.method === 'ui/notifications/size-changed' && m.params) f.style.height = Math.min(620, Math.max(160, m.params.height + 4)) + 'px';
    if (m.method === 'tools/call') window.hostCall(m.params).then((r) => f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: r }, '*'));
  });
}, { html: res.text.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`) });

const wait = (ms) => p.waitForTimeout(ms);
// reading time ~ 55 ms per character, at least 1.6 s
const caption = async (html) => {
  await p.evaluate((h) => { const c = document.getElementById('cap'); c.innerHTML = h; c.hidden = false; }, html);
  await wait(Math.max(1600, html.replace(/<[^>]+>/g, '').length * 55));
};
const user = (text, img) => p.evaluate(({ text, img }) => {
  const d = document.createElement('div'); d.className = 'u';
  d.innerHTML = `<div class="b">${img ? `<img src="${img}">` : ''}${text}</div>`;
  document.getElementById('chat').appendChild(d); d.scrollIntoView({ block: 'end' });
}, { text, img });
const assistantCard = async (text, result) => {
  const i = await p.evaluate(({ text, result }) => {
    const d = document.createElement('div'); d.className = 'a';
    d.innerHTML = `<div class="t">${text}</div>`;
    const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.style.height = '420px';
    f.__result = result; window.frames_.push(f); d.appendChild(f);
    document.getElementById('chat').appendChild(d);
    f.srcdoc = window.__html;
    return window.frames_.length - 1;
  }, { text, result });
  await p.frameLocator('iframe').nth(i).locator('h2').waitFor();
  const imgs = p.frameLocator('iframe').nth(i).locator('img');
  if (await imgs.count()) await imgs.first().evaluate((im) => im.decode && im.decode(), null, { timeout: 5000 }).catch(() => {});
  return i;
};
const frame = (i) => p.frameLocator('iframe').nth(i);
const showTop = (i) => p.evaluate((n) => { const f = window.frames_[n]; f.parentElement.scrollIntoView({ block: 'start' }); }, i);
const imgReady = async (i, sel) => frame(i).locator(sel).evaluate((im) => (im.decode ? im.decode() : null), null, { timeout: 5000 }).catch(() => {});

// ---- scene 1: a real photo of an unknown build -> honest no match + how to add a model
await caption('Take a photo of a LEGO model you <b>already built</b>, and get an exact way to take it apart.');
await user('What is this model and how do I take it apart?', realUrl);
const i1 = await assistantCard('Here is what I can see. It does not match any of your models, so I will not make up instructions.', { structuredContent: r1 });
await showTop(i1);
await caption(`A <b>real iPhone photo</b>, analysed live by <b>Meta Muse Spark 1.3</b> (${(r1.provider.ms / 1000).toFixed(1)} s).`);
await caption('Unknown build: <b>no match</b>, so no made-up steps. The card explains how to add a model.');

// ---- scene 2: a known model -> confirm -> exact data
await user('And this one?', catUrl);
const i2 = await assistantCard('This looks like one of your models. Please confirm.', { structuredContent: r2 });
await showTop(i2);
await caption(`A <b>render</b> of the built-in cat (no physical one built yet). AI estimate: <b>${r2.candidates[0] ? r2.candidates[0].title : 'none'}</b>, ${r2.analysis.match_confidence} confidence.`);
await caption('The AI only suggests. <b>You</b> confirm the match.');
await frame(i2).locator('button[data-confirm]').first().click();
await frame(i2).locator('.tag', { hasText: 'Based on exact model JSON' }).waitFor({ timeout: 60000 });
await imgReady(i2, '.stage img');
await showTop(i2);
await caption('<b>Exact</b> parts list and geometry from the saved model: 106 parts, 17 steps.');

// ---- scene 3: exploded, reverse steps, build again
await frame(i2).locator('#explode').click();
await imgReady(i2, '.stage img');
await caption('Exploded view: the build steps pulled apart. An illustration, not a tested removal path.');
await frame(i2).locator('button[data-dmode=steps]').click();
await frame(i2).locator('#next').waitFor({ timeout: 60000 });
await imgReady(i2, '#stepimg');
await showTop(i2);
await caption('Disassembly steps: each one outlines the parts to remove next.');
for (let k = 0; k < 4; k++) { await frame(i2).locator('#next').click(); await imgReady(i2, '#stepimg'); await wait(650); }
await frame(i2).locator('button[data-dir=build]').click();
await frame(i2).locator('button[data-dir=build][aria-pressed=true]').waitFor({ timeout: 60000 });
await imgReady(i2, '#stepimg');
await caption('One switch back to <b>Build</b>: the same parts in build order. Your model and parts list never change.');

// ---- scene 4: how to add more models
await p.evaluate((n) => window.frames_[n].parentElement.scrollIntoView({ block: 'start' }), i1);
await frame(i1).locator('.add').evaluate((el) => { el.style.outline = '3px solid #FFD21A'; el.style.outlineOffset = '3px'; });
await caption('<b>Add more models:</b> photograph your loose bricks to get build ideas, or describe a model. Every saved model can then be recognised and taken apart.');
await caption('Real Meta API · you confirm the match · exact data · honest limits. <b>LEGO from My Bricks</b>');

const vid = p.video();
await ctx.close();
await b.close();
await c.close();
const webm = await vid.path();
const ff = require('ffmpeg-static');
// pauses are already tight (captions get reading time only), so a plain re-encode
execFileSync(ff, ['-y', '-i', webm, '-r', '25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-movflags', '+faststart', OUT], { stdio: 'ignore' });
console.log(JSON.stringify({ out: OUT, bytes: fs.statSync(OUT).size }));
