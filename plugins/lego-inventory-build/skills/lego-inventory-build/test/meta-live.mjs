// Live smoke for Meta Model API. Runs only when MODEL_API_KEY is set; prints model id, usage, cost
// and outcome, never the key, prompt or photo. Costs about $0.01-0.02 per run.
//   node --use-system-ca --env-file=.env.local test/meta-live.mjs [photo.jpg] [expected-name|none]
// Default: the rendered cat (expect "cat") and a photo of a loose pile (expect no match).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const meta = require('../lib/meta.cjs');
if (!meta.available()) { console.log('skip: MODEL_API_KEY not set'); process.exit(0); }

const dataUrl = (f) => `data:image/${/\.png$/i.test(f) ? 'png' : 'jpeg'};base64,` + fs.readFileSync(f).toString('base64');
let cases;
if (process.argv[2]) cases = [{ file: process.argv[2], expected: process.argv[3] || null }];
else {
  const nf = require('../lib/nodefilm.cjs');
  const core = require('../lib/core.cjs');
  const cat = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'live-')), 'cat.png');
  fs.writeFileSync(cat, await nf.hero(core.loadModel('cat'), { size: 900 }));
  cases = [{ file: cat, expected: 'cat', note: 'render' }, { file: path.join(ROOT, 'test/fixtures/pile-white-table.jpg'), expected: 'none', note: 'loose pile' }];
}
// through the real MCP tool (same code path as ChatGPT/Claude), over stdio
const client = new Client({ name: 'meta-live', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--use-system-ca', path.join(ROOT, 'mcp/server.mjs')], env: { ...process.env }, stderr: 'inherit' }));
let fail = 0;
for (const c of cases) {
  const r = await client.callTool({ name: 'model_analyze_photo', arguments: { image: dataUrl(c.file) } });
  const sc = r.structuredContent || {};
  const top = sc.candidates && sc.candidates[0] ? sc.candidates[0].name : 'none';
  const pass = sc.status === 'ok' && (!c.expected || top === c.expected);
  if (!pass) fail++;
  console.log(JSON.stringify({ photo: path.basename(c.file), note: c.note, status: sc.status, error: sc.error, model: sc.provider && sc.provider.model, response_id: sc.provider && sc.provider.responseId, ms: sc.provider && sc.provider.ms, top, expected: c.expected, confidence: sc.analysis && sc.analysis.match_confidence, pass }));
}
const { budget, fileStore } = require('../lib/budget.cjs');
console.log('budget', JSON.stringify(await budget(fileStore()).status()));
await client.close();
process.exit(fail ? 1 : 0);
