// Fake MCP Apps host: calls show_build on a server, loads the ui:// resource into an iframe the way
// ChatGPT does, answers ui/initialize, sends tool-result, screenshots the result.
//   node test/player-host.mjs <mcp url with key> <model name> out.png
import fs from 'node:fs';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const [url, name, out] = process.argv.slice(2);
const c = new Client({ name: 'openai-mcp', version: '1.0.0' });
await c.connect(new StreamableHTTPClientTransport(new URL(url)));
const tool = (await c.listTools()).tools.find((t) => t.name === 'show_build');
const uri = tool._meta.ui.resourceUri;
const res = (await c.readResource({ uri })).contents[0];
console.log('resource', uri, res.mimeType, 'csp', JSON.stringify(res._meta.ui.csp));
const t = Date.now();
const mode = process.argv[5] || 'picture';
const tn = process.env.TOOL || 'show_build'; // model_render / model_preview return the same card
const r = await c.callTool({ name: tn, arguments: tn === 'show_build' ? { name, mode } : { name } });
console.log(tn, ((Date.now() - t) / 1000).toFixed(1) + 's', JSON.stringify(r.structuredContent).slice(0, 200));
const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${res._meta.ui.csp.resourceDomains.join(' ')} data:; media-src ${res._meta.ui.csp.resourceDomains.join(' ')} data:; connect-src 'none'`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 760, height: 700 } });
const log = [];
await p.exposeFunction('hostLog', (m) => log.push(m));
await p.exposeFunction('hostCall', async (params) => { const rr = await c.callTool(params); return { structuredContent: rr.structuredContent, content: rr.content }; });
await p.setContent('<html><body style="margin:0;background:#212121"><iframe id="f" sandbox="allow-scripts" style="width:740px;height:680px;border:0;margin:10px;background:#fff;border-radius:12px"></iframe></body></html>');
p.on('console', (m) => log.push('console:' + m.text().slice(0, 120)));
await p.evaluate(({ html, result }) => {
  const f = document.getElementById('f');
  addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.jsonrpc !== '2.0') return;
    window.hostLog(m.method || 'reply ' + m.id);
    if (m.method === 'ui/initialize') f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'fake-host', version: '0' }, hostCapabilities: {}, hostContext: { theme: 'light', displayMode: 'inline' } } }, '*');
    if (m.method === 'tools/call') window.hostCall(m.params).then((res) => f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: res }, '*'));
    if (m.method === 'ui/notifications/initialized') f.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
  });
  f.srcdoc = html;
}, { html: res.text.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`), result: { structuredContent: r.structuredContent, content: r.content } });
await p.waitForTimeout(3000);
await p.screenshot({ path: out });
if (process.argv.includes('--click-steps')) {
  await p.frameLocator('#f').locator('button[data-mode=steps]').click();
  await p.waitForTimeout(12000);
  await p.frameLocator('#f').locator('#next').click();
  await p.waitForTimeout(1500);
  await p.screenshot({ path: out.replace('.png', '-steps.png') });
}
const state = mode !== 'video' ? 'n/a' : await p.frameLocator('#f').locator('video').evaluate((v) => ({ src: v.currentSrc, ready: v.readyState, time: v.currentTime, err: v.error && v.error.code, w: v.videoWidth })).catch((e) => 'no video: ' + e.message);
console.log('bridge', log.join(' > '));
console.log('video', JSON.stringify(state));
await b.close();
await c.close();
