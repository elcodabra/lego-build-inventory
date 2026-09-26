// Simulates what ChatGPT sends: uploaded files arrive as { download_url, file_id } objects.
//   node test/chatgpt-sim.mjs <mcp url with key> <photo url> ...
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const [url, ...photos] = process.argv.slice(2);
const c = new Client({ name: 'openai-mcp', version: '1.0.0' });
await c.connect(new StreamableHTTPClientTransport(new URL(url)));
const t0 = Date.now();
const lap = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);
const call = async (name, args) => { const r = await c.callTool({ name, arguments: args || {} }); if (r.isError) throw new Error(name + ': ' + r.content[0].text); return r; };
const J = (r) => JSON.parse(r.content[0].text);
const tools = (await c.listTools()).tools;
const pf = tools.find((t) => t.name === 'parts_from_photo');
lap('parts_from_photo _meta: ' + JSON.stringify(pf._meta) + ', files schema: ' + JSON.stringify(pf.inputSchema.properties.files.items.required));
lap('clear: ' + (await call('inventory_clear')).content[0].text);
const files = photos.map((u, i) => ({ download_url: u, file_id: 'file_test_' + i, mime_type: 'image/jpeg', file_name: u.split('/').pop() }));
const ph = J(await call('parts_from_photo', { files, add: true, qty: 4 }));
for (const r of ph.results) lap('  photo -> ' + (r.error || `${r.part.id} ${r.color} confident=${r.confident} pile=${r.pile} added=${r.added}`));
const inv = J(await call('inventory_show'));
lap('inventory: ' + inv.totalParts + ' parts ' + JSON.stringify(inv.byColor));
await c.close();
