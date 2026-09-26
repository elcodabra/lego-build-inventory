// node test/chatgpt-pile.mjs <mcp url with key> <photo url>   (ChatGPT-style file param)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const [url, photo] = process.argv.slice(2);
const c = new Client({ name: 'openai-mcp', version: '1.0.0' });
await c.connect(new StreamableHTTPClientTransport(new URL(url)));
const t = Date.now();
const r = await c.callTool({ name: 'parts_from_pile_photo', arguments: { files: [{ download_url: photo, file_id: 'file_x', mime_type: 'image/jpeg' }], replace: true } });
if (r.isError) throw new Error(r.content[0].text);
const j = JSON.parse(r.content[0].text);
console.log(`${((Date.now() - t) / 1000).toFixed(1)}s`, JSON.stringify(j.photos), 'total', j.totalParts);
for (const p of j.parts) console.log(' ', p.id, p.color, p.qty, p.unsure ? `(unsure ${p.unsure})` : '');
await c.close();
