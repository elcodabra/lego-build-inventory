// Soundtrack for build films, synthesized from code: no samples, no third-party music, nothing a
// copyright matcher (YouTube Content ID) can claim. A soft marimba arpeggio over a four-chord loop
// paced by the film's steps, a wooden click whenever a part lands, a little chime when the model
// is complete, then a fade out. Deterministic: the same film always gets the same audio (the
// mp4 is deduplicated by its hash), and the key / pattern vary with the model title.
'use strict';
const fs = require('fs');

const RATE = 44100;
const TAU = Math.PI * 2;

function seedOf(s) {
  let h = 2166136261;
  for (const c of String(s || '')) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return h >>> 0;
}
function rng(seed) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

// adds one voice into buf: f = frequency, at = start (s), dur = decay length (s), v = volume
function marimba(buf, f, at, dur, v) {
  const i0 = Math.max(0, Math.round(at * RATE));
  const n = Math.min(buf.length - i0, Math.round(dur * 4 * RATE));
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const att = Math.min(1, t / 0.004);
    const e = Math.exp(-t / dur);
    buf[i0 + i] += v * att * (e * Math.sin(TAU * f * t) + 0.22 * Math.exp(-t / (dur * 0.18)) * Math.sin(TAU * f * 3.98 * t));
  }
}
function bell(buf, f, at, dur, v) {
  const i0 = Math.max(0, Math.round(at * RATE));
  const n = Math.min(buf.length - i0, Math.round(dur * 4 * RATE));
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const att = Math.min(1, t / 0.003);
    buf[i0 + i] += v * att * (Math.exp(-t / dur) * Math.sin(TAU * f * t) + 0.35 * Math.exp(-t / (dur * 0.5)) * Math.sin(TAU * f * 2.76 * t) + 0.12 * Math.exp(-t / (dur * 0.25)) * Math.sin(TAU * f * 5.4 * t));
  }
}
// a brick snapping into place: a short knock (two damped partials) plus a breath of noise
function click(buf, at, pitch, v, rand) {
  const i0 = Math.max(0, Math.round(at * RATE));
  const n = Math.min(buf.length - i0, Math.round(0.06 * RATE));
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    lp += 0.35 * (rand() * 2 - 1 - lp);
    buf[i0 + i] += v * (Math.exp(-t / 0.012) * (0.7 * Math.sin(TAU * pitch * t) + 0.3 * Math.sin(TAU * pitch * 2.3 * t)) + 0.5 * Math.exp(-t / 0.004) * lp);
  }
}

// cues: [{ t, kind: 'intro' | 'step' | 'land' | 'done', k, i }] from the film (booklet.js)
function synth(duration, cues, opts) {
  const o = opts || {};
  const rand = rng(seedOf(o.title));
  const buf = new Float32Array(Math.ceil(duration * RATE));
  const step = o.step || 0.85;
  const beat = step / 2;
  const root = 48 + [0, 2, 5, 7][Math.floor(rand() * 4)]; // C, D, F or G
  // I - V - vi - IV, one chord per step
  const CHORDS = [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]];
  const PATTERNS = [[0, 1, 2, 1], [0, 2, 1, 2], [0, 1, 2, 3], [2, 1, 0, 1]];
  const pat = PATTERNS[Math.floor(rand() * PATTERNS.length)];
  const done = (cues.find((c) => c.kind === 'done') || { t: duration - 3 }).t;
  const first = (cues.find((c) => c.kind === 'step') || { t: 0.5 }).t;
  const end = duration - 0.2;
  // music: from the start (quiet under the pile intro) until the end, eighth-note arpeggio
  const eighth = beat / 2;
  for (let j = 0, t = first % eighth; t < end - 0.3; j++, t += eighth) {
    const bar = Math.floor((t - first) / step);
    const ch = CHORDS[((bar % 4) + 4) % 4];
    const note = pat[j % 4];
    const midi = root + 12 + (note === 3 ? ch[0] + 12 : ch[note]);
    const intro = t < first ? 0.45 : 1;
    const after = t > done + 0.6 ? 0.8 : 1;
    marimba(buf, hz(midi), t, 0.32, 0.11 * intro * after * (j % 2 ? 0.75 : 1));
    if (j % 4 === 0) marimba(buf, hz(root + ch[0] - 12), t, 0.5, 0.13 * intro * after); // bass on every beat pair
  }
  for (const c of cues) {
    if (c.kind === 'land') click(buf, c.t, 900 + ((c.i || 0) % 5) * 90 + rand() * 40, 0.16, rand);
    if (c.kind === 'step') bell(buf, hz(root + 24 + CHORDS[c.k % 4][0]), c.t, 0.25, 0.05);
    if (c.kind === 'done') {
      [0, 4, 7, 12, 16].forEach((d, i) => bell(buf, hz(root + 24 + d), c.t + i * 0.07, 0.9, 0.08));
      marimba(buf, hz(root - 12), c.t, 1.2, 0.18);
    }
    if (c.kind === 'intro') [0, 7, 12].forEach((d, i) => bell(buf, hz(root + 24 + d), c.t + i * 0.12, 0.7, 0.05));
  }
  // fade in 0.05 s, fade out over the last 1.6 s, soft limiter
  const fadeOut = Math.round(1.6 * RATE);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const g = Math.min(1, i / (0.05 * RATE), (buf.length - i) / fadeOut);
    buf[i] = Math.tanh(buf[i] * 1.4) * g;
    peak = Math.max(peak, Math.abs(buf[i]));
  }
  const k = peak > 0 ? 0.7 / peak : 1;
  for (let i = 0; i < buf.length; i++) buf[i] *= k;
  return buf;
}

function wav(samples) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + samples.length * 2, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(RATE, 24); out.writeUInt32LE(RATE * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return out;
}

// Writes the soundtrack of a film as a WAV file; returns the path or null when sound is off.
function writeTrack(file, duration, cues, opts) {
  if (!enabled()) return null;
  fs.writeFileSync(file, wav(synth(duration, cues || [], opts)));
  return file;
}
const enabled = () => process.env.LEGO_SOUND !== '0';

module.exports = { synth, wav, writeTrack, enabled, RATE };
