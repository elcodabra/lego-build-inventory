// Live smoke for Meta Model API. Runs only when MODEL_API_KEY is set; prints model id, usage and
// outcome, never the key, prompt or photo. Usage: MODEL_API_KEY=... node test/meta-live.mjs [photo.png]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const meta = require('../lib/meta.cjs');

if (!meta.available()) { console.log('skip: MODEL_API_KEY not set'); process.exit(0); }
const file = process.argv[2] || new URL('./fixtures/3001-red.png', import.meta.url).pathname;
const ext = file.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
const img = `data:image/${ext};base64,` + fs.readFileSync(file).toString('base64');
meta.checkImage(img);
try {
  const r = await meta.respond({
    input: [{ role: 'user', content: [
      { type: 'input_text', text: 'What object is in this photo? Answer in one short sentence.' },
      { type: 'input_image', image_url: img },
    ] }],
  });
  console.log(JSON.stringify({ ok: true, model: r.model, response_id: r.id, usage: r.usage, ms: r.ms, attempts: r.attempts, answer_chars: r.text.length }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, code: e.code, status: e.status, message: e.message }));
  process.exit(1);
}
