// Build films carry a soundtrack synthesized from code (lib/sound.cjs): an audio stream in the mp4,
// audible (not silence), as long as the video, the same bytes for the same film, quiet in the
// first 50 ms and at the very end (fades), a click when each part lands, and LEGO_SOUND=0 turns
// it off. Uses only ffmpeg (no ffprobe): stream info from `ffmpeg -i`, PCM decoded via pipe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.LEGO_RENDERER = 'node';
const film = require('../lib/film.cjs');
const sound = require('../lib/sound.cjs');
const ok = (m) => console.log('  ok  ' + m);
const ff = (() => { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } })();

const model = { title: 'Tower', theta: 35, phi: 28, lang: 'en', steps: [
  [{ id: '3001', color: 'red', at: [0, 0, 0] }],
  [{ id: '3001', color: 'white', at: [0, 0, 3] }, { id: '3003', color: 'blue', at: [2, 0, 3] }],
  [{ id: '3003', color: 'yellow', at: [0, 0, 6] }],
] };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snd-'));

// 1. the synthesizer alone: cues line up, deterministic, fades
{
  const cues = [{ t: 0.55, kind: 'step', k: 0 }, { t: 0.93, kind: 'land', k: 0, i: 0 }, { t: 1.5, kind: 'done' }];
  const a = sound.synth(4, cues, { title: 'x' });
  const b = sound.synth(4, cues, { title: 'x' });
  assert.equal(a.length, 4 * sound.RATE);
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer), 'same film, same audio');
  const c = sound.synth(4, cues, { title: 'another model' });
  assert.notDeepEqual(Buffer.from(a.buffer), Buffer.from(c.buffer), 'title changes key / pattern');
  const peak = (arr, t0, t1) => { let p = 0; for (let i = Math.floor(t0 * sound.RATE); i < Math.floor(t1 * sound.RATE); i++) p = Math.max(p, Math.abs(arr[i])); return p; };
  assert.ok(peak(a, 0, 4) <= 0.71 && peak(a, 0, 4) > 0.5, 'normalized, no clipping');
  assert.ok(peak(a, 0, 0.002) < 0.01, 'fade in');
  assert.ok(peak(a, 3.98, 4) < 0.02, 'fade out');
  assert.ok(peak(a, 0.93, 0.96) > peak(a, 0.85, 0.9), 'a click when the part lands');
  const w = sound.wav(a);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF'); assert.equal(w.readUInt32LE(24), 44100); assert.equal(w.length, 44 + a.length * 2);
  ok('synth: deterministic per title, normalized, fades, click on landing, valid WAV');
}

// 2. a real film: mp4 has an AAC stream as long as the video, and it is not silent
function probe(file) {
  const r = spawnSync(ff, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  return r.stderr;
}
function pcm(file) {
  const r = spawnSync(ff, ['-loglevel', 'error', '-i', file, '-vn', '-f', 's16le', '-ac', '1', '-ar', '8000', '-'], { maxBuffer: 64 << 20 });
  const b = r.stdout; const s = new Int16Array(b.buffer, b.byteOffset, b.length >> 1);
  return s;
}
const out = path.join(dir, 'tower.mp4');
const r = await film.render(model, out, { scale: 0.4 });
assert.equal(r.audio, true, 'render reports audio');
const info = probe(out);
assert.match(info, /Audio: aac/, 'mp4 has an AAC audio stream');
assert.match(info, /Video: h264/);
const dur = Number((info.match(/Duration: (\d+):(\d+):([\d.]+)/) || []).slice(1).reduce((a, x, i) => a + Number(x) * [3600, 60, 1][i], 0));
assert.ok(Math.abs(dur - r.seconds) < 0.25, `duration ${dur} ≈ film ${r.seconds}`);
const s = pcm(out);
assert.ok(Math.abs(s.length / 8000 - r.seconds) < 0.25, 'audio lasts as long as the film');
let rms = 0; for (const v of s) rms += v * v; rms = Math.sqrt(rms / s.length) / 32768;
assert.ok(rms > 0.02, 'audible, rms ' + rms.toFixed(3));
assert.ok(!fs.existsSync(out + '.wav'), 'temporary WAV removed');
ok(`film with sound: aac, ${dur.toFixed(2)} s, rms ${rms.toFixed(3)}, temp WAV removed`);

// 3. same film rendered twice -> identical audio (the mp4 is deduplicated by its hash for YouTube)
{
  const out2 = path.join(dir, 'tower2.mp4');
  await film.render(model, out2, { scale: 0.4 });
  assert.deepEqual(Buffer.from(pcm(out2).buffer), Buffer.from(s.buffer), 'audio deterministic');
  ok('same film twice: identical audio');
}

// 4. the pile intro shifts the cues by the intro length, and LEGO_SOUND=0 turns sound off
{
  global.window = global.window || global;
  require('../src/booklet.js');
  const L = global.window.LEGO;
  const plain = L.booklet(model, 'vertical', 'en').cues();
  const img = { width: 10, height: 10 };
  const withPile = L.bookletWithPile(model, 'vertical', img, 'en').cues();
  assert.equal(withPile[0].kind, 'intro');
  assert.ok(Math.abs(withPile[1].t - plain[0].t - L.PILE_INTRO) < 1e-9, 'cues shifted by the pile intro');
  assert.equal(plain.filter((c) => c.kind === 'land').length, 4, 'one landing cue per part');
  process.env.LEGO_SOUND = '0';
  const out3 = path.join(dir, 'mute.mp4');
  const r3 = await film.render(model, out3, { scale: 0.4 });
  assert.equal(r3.audio, false);
  assert.doesNotMatch(probe(out3), /Audio:/, 'LEGO_SOUND=0: no audio stream');
  delete process.env.LEGO_SOUND;
  ok('pile intro shifts cues; LEGO_SOUND=0 renders a silent film');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('sound checks passed');
