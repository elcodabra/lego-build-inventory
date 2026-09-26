// Security regression checks for server (safe) mode: node test/security.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../lib/core.cjs');
const photo = require('../lib/photo.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-sec-'));
fs.writeFileSync(path.join(tmp, 'evil.js'), 'globalThis.PWNED = 1;');
fs.writeFileSync(path.join(tmp, 'secret.json'), 'SECRET_TOKEN_123');
const ok = (m) => console.log('  ok  ' + m);
const rejects = async (fn, re, what) => { await assert.rejects(fn, re, what); ok(what); };

await core.ctx.run({ dataDir: tmp, safe: true }, async () => {
  for (const bad of [path.join(tmp, 'evil.js'), path.join(tmp, 'secret.json'), '../../etc/passwd', 'a/b', 'x.json', '']) {
    assert.throws(() => core.loadModel(bad), /model name must be/);
  }
  assert.equal(globalThis.PWNED, undefined);
  ok('model names with paths are refused, nothing required, no content in errors');
  assert.equal(core.loadModel('cat').name, 'cat');
  ok('built-in example still loads by name');
  fs.mkdirSync(path.join(tmp, 'models'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'models', 'broken.json'), 'SECRET_TOKEN_123');
  assert.throws(() => core.loadModel('broken'), (e) => !/SECRET/.test(e.message));
  ok('broken user model does not leak its content');
  fs.writeFileSync(path.join(tmp, 'models', 'sneaky.js'), 'globalThis.PWNED = 2; window.MODELS.sneaky = {steps:[[{id:"3001",color:"red",at:[0,0,0]}]]}');
  assert.throws(() => core.loadModel('sneaky'), /no saved model/);
  assert.equal(globalThis.PWNED, undefined);
  ok('.js in the user models dir is never executed');
  assert.throws(() => core.validateModel({ steps: Array.from({ length: 61 }, () => [{ id: '3001', color: 'red', at: [0, 0, 0] }]) }), /too many steps/);
  ok('step limit');

  await rejects(() => photo.loadImage('/etc/hosts'), /https URL/, 'local file paths refused');
  await rejects(() => photo.loadImage(path.join(tmp, 'secret.json')), /https URL/, 'local file (existing) refused');
  await rejects(() => photo.loadImage('http://example.com/a.png'), /only https/, 'plain http refused');
  await rejects(() => photo.loadImage('https://127.0.0.1/a.png'), /not allowed/, 'loopback refused');
  await rejects(() => photo.loadImage('https://169.254.169.254/latest/meta-data'), /not allowed/, 'cloud metadata refused');
  await rejects(() => photo.loadImage('https://[::1]/x.png'), /not allowed/, 'IPv6 loopback refused');
  await rejects(() => photo.loadImage('https://localhost/x.png'), /not allowed/, 'localhost (DNS) refused');
  await rejects(() => photo.loadImage('data:image/png,notbase64'), /bad data: URL/, 'malformed data: URL handled');
  const bomb = Buffer.alloc(33); bomb.write('\x89PNG\r\n\x1a\n', 0, 'binary'); bomb.writeUInt32BE(30000, 16); bomb.writeUInt32BE(30000, 20);
  await rejects(() => photo.loadImage(bomb), /too large/, 'decompression bomb (30000×30000 header) refused');
});
// outside safe mode (local CLI) paths still work
assert.equal(core.loadModel(path.join(core.ROOT, 'src/models/cat.js')).name, 'cat');
ok('CLI mode still accepts paths');
console.log('security checks passed');
