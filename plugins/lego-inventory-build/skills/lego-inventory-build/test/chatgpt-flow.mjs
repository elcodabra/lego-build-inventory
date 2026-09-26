// Rest of the ChatGPT flow after the photos: import a pile CSV, ideas, build, preview, render.
//   node test/chatgpt-flow.mjs <mcp url with key> pile.csv [--render]
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const [url, csv] = process.argv.slice(2);
const c = new Client({ name: 'openai-mcp', version: '1.0.0' });
await c.connect(new StreamableHTTPClientTransport(new URL(url)));
const t0 = Date.now();
const lap = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);
const call = async (name, args) => { const r = await c.callTool({ name, arguments: args || {} }); if (r.isError) throw new Error(name + ': ' + r.content[0].text); return r; };
const J = (r) => JSON.parse(r.content[0].text);
lap('guide: ' + (await call('lego_photo_guide')).content[0].text.length + ' chars');
lap('import pile: ' + JSON.stringify(J(await call('inventory_import', { data: fs.readFileSync(csv, 'utf8'), source: 'photo of a pile' }))));
const inv = J(await call('inventory_show'));
lap(`inventory: ${inv.totalParts} parts ${JSON.stringify(inv.byColor)}`);
const s = J(await call('ideas_suggest'));
for (const b of s.buildable) lap(`  can build: ${b.title} ${b.size}, ${b.parts} parts, ${b.colors.join('+')}${b.notes.length ? ' (' + b.notes.join('; ') + ')' : ''}`);
for (const a of s.almost) lap(`  almost: ${a.title}, missing ${a.missing.map((m) => m.id + ' ' + m.color + '×' + m.qty).join(', ')}`);
const pick = s.buildable.find((b) => b.idea === 'house') || s.buildable[0];
const b = J(await call('idea_build', { idea: pick.idea }));
lap(`build ${pick.idea}: ${b.size}, ${b.parts} parts, ${b.steps} steps, ok=${b.ok}`);
const p = await call('model_preview', { name: pick.idea, times: [3, 'final'] });
lap('preview: ' + p.content.filter((x) => x.type === 'text')[0].text.split('\n').slice(1).join(' '));
if (process.argv.includes('--render')) { const r = J(await call('model_render', { name: pick.idea })); lap('video: ' + r.url); }
await c.close();
