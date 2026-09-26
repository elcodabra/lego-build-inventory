// Live check of a deployed server: node test/remote.mjs https://<app>/mcp?key=<key>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const url = new URL(process.argv[2]);
const c = new Client({ name: 'remote-check', version: '0' });
await c.connect(new StreamableHTTPClientTransport(url));
const t0 = Date.now();
const lap = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);
lap('tools: ' + (await c.listTools()).tools.map((t) => t.name).join(', '));
const call = async (name, args) => { const r = await c.callTool({ name, arguments: args || {} }); if (r.isError) throw new Error(name + ': ' + r.content[0].text); return r; };
const J = (r) => JSON.parse(r.content[0].text);
lap('import ' + J(await call('inventory_import', { data: 'part,color,qty\n3001,red,10\n3003,white,8\n3004,white,12\n3005,red,6\n3039,red,8\n3040,red,4\n3032,green,1\n3022,white,4\n3023,red,6\n3010,white,6', replace: true, source: 'remote test' })).imported);
lap('persisted: ' + J(await call('inventory_show')).totalParts + ' parts');
const s = J(await call('ideas_suggest'));
lap('ideas: ' + s.buildable.map((b) => `${b.idea}(${b.parts})`).join(' '));
const b = J(await call('idea_build', { idea: 'house' }));
lap(`idea_build house ${b.size} ${b.parts} parts ok=${b.ok}`);
const p = await call('model_preview', { name: 'house' });
lap('preview: ' + p.content.map((x) => x.type).join(',') + ' ' + p.content.find((x) => x.type === 'text').text.split('\n').pop());
const ph = J(await call('parts_from_photo', { images: ['https://img.bricklink.com/ItemImage/PN/11/3039.png'] }));
lap('photo: ' + ph.results.map((r) => r.error || `${r.part.id} ${r.color} confident=${r.confident}`).join(', '));
if (process.argv.includes('--render')) { const r = J(await call('model_render', { name: 'house' })); lap('render: ' + r.url + ' ' + r.seconds + 's'); }
await c.close();
