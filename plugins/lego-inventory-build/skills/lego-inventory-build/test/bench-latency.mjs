// End-to-end latency of the production tools (what a ChatGPT/Claude user waits for), N runs each.
//   node --use-system-ca test/bench-latency.mjs "<mcp url>" [runs=5]
// Photo analysis calls Meta (Muse Spark + SAM 3.1 in parallel): about 1 cent each.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const [url, runsArg] = process.argv.slice(2);
const N = Number(runsArg || 5);
const c = new Client({ name: 'bench', version: '1' });
await c.connect(new StreamableHTTPClientTransport(new URL(url)));
const nf = require('../lib/nodefilm.cjs'); const core = require('../lib/core.cjs');
const cat = 'data:image/png;base64,' + (await nf.hero(core.loadModel('cat'), { size: 900, theta: 200 })).toString('base64');
const cases = [
  ['model_analyze_photo (Muse Spark 1.3 + SAM 3.1)', { name: 'model_analyze_photo', arguments: { image: cat, lang: 'en' } }],
  ['model_disassemble (card, exact data)', { name: 'model_disassemble', arguments: { name: 'cat', confirmed: true, lang: 'en' } }],
  ['model_disassemble steps', { name: 'model_disassemble', arguments: { name: 'cat', mode: 'steps', lang: 'en' } }],
  ['ideas_suggest from_model (rebuild)', { name: 'ideas_suggest', arguments: { from_model: 'cat', lang: 'en' } }],
];
const rows = [];
for (const [label, call] of cases) {
  const ms = [];
  for (let i = 0; i < N; i++) { const t = Date.now(); const r = await c.callTool(call); if (r.isError) throw new Error(label + ' failed'); ms.push(Date.now() - t); }
  ms.sort((a, b) => a - b);
  rows.push({ tool: label, runs: N, first_ms: ms.includes ? undefined : undefined, p50_ms: ms[Math.floor(N / 2)], p90_ms: ms[Math.min(N - 1, Math.floor(N * 0.9))], min_ms: ms[0], max_ms: ms[N - 1] });
}
console.table(rows.map(({ first_ms, ...r }) => r));
await c.close();
