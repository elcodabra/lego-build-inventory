// 8 parallel inventory_update calls (+1 each) must end in +8, or fail loudly: never lose updates.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const url = new URL(process.argv[2]);
const mk = async () => { const c = new Client({ name: 'cc', version: '0' }); await c.connect(new StreamableHTTPClientTransport(url)); return c; };
const c0 = await mk();
const qty = async () => { const r = JSON.parse((await c0.callTool({ name: 'inventory_show' })).content[0].text); return (r.drawable || []).find((x) => x.id === '3024' && x.color === 'lime')?.qty || 0; };
const q0 = await qty();
const clients = await Promise.all(Array.from({ length: 8 }, mk));
const res = await Promise.allSettled(clients.map((c) => c.callTool({ name: 'inventory_update', arguments: { items: [{ id: '3024', color: 'lime', qty: 1 }] } })));
const okN = res.filter((r) => r.status === 'fulfilled' && !r.value.isError).length;
const q1 = await qty();
console.log(`before ${q0}, succeeded ${okN}/8, after ${q1}, lost ${okN - (q1 - q0)}`);
await c0.callTool({ name: 'inventory_update', arguments: { items: [{ id: '3024', color: 'lime', qty: -(q1 - q0) }] } });
process.exit(okN === q1 - q0 ? 0 : 1);
