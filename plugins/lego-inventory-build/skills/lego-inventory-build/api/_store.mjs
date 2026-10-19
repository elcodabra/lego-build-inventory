// Per-user state store for the hosted server: inventory.json (+ inventory.prev.json, the list a
// photo replaced, for undo) + models/*.json of one user.
//
// Redis (Upstash REST, KV_REST_API_URL/TOKEN) is the primary store: the whole state of a user is
// ONE key (gzip+base64 JSON with a version number), read with one GET and written with one Lua
// compare-and-set, so a request costs 1-2 cheap Redis commands and no Blob operations. The first
// read of a user that only exists in the old Blob layout (state/<user>/...) copies it over once.
// Without Redis the old Blob layout (one blob per file, ETag-guarded) is used; without either, a
// local directory (tests). Daily quotas are an atomic Redis counter (or a local file).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const STATE_BLOB = process.env.STATE_BLOB_TOKEN;
export const backend = REDIS_URL && REDIS_TOKEN ? 'redis' : STATE_BLOB ? 'blob' : 'local';
const NS = process.env.LEGO_REDIS_PREFIX || 'lego'; // tests use their own prefix

const LOCAL_STORE = path.join('/tmp/lego', '_store');
const FILE = /^(inventory(\.prev)?\.json|pile\.json|models\/[a-z0-9_-]{1,64}\.json)$/;
const MAX_STATE = 2 * 1024 * 1024; // compressed bytes per user
const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// ---------------------------------------------------------------- Redis (REST)

export const redisStats = { commands: 0 };
async function redis(cmd) {
  redisStats.commands++;
  const r = await fetch(REDIS_URL, { method: 'POST', headers: { authorization: `Bearer ${REDIS_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('state store: ' + (j.error || r.status));
  return j.result;
}
const KEY = (user) => `${NS}:state:${user}`;
// value = "<version>:<base64 gzip JSON {files:{rel:text}}>"; set only if the stored version is ours
const CAS = `local cur = redis.call('GET', KEYS[1])
local v = 0
if cur then v = tonumber(string.match(cur, '^(%d+):')) or 0 end
if v ~= tonumber(ARGV[1]) then return -1 end
redis.call('SET', KEYS[1], ARGV[2])
return v + 1`;

const encode = (files) => zlib.gzipSync(Buffer.from(JSON.stringify({ files }))).toString('base64');
const decode = (s) => JSON.parse(zlib.gunzipSync(Buffer.from(s, 'base64')).toString('utf8')).files || {};

// ---------------------------------------------------------------- Blob (old layout)

let blobMod = null;
const B = async () => (blobMod ||= await import('@vercel/blob'));
export const blobStats = { advanced: 0, simple: 0 };
async function blobReadAll(user) {
  const { list, get } = await B();
  const files = {};
  const etags = {};
  let cursor;
  do {
    blobStats.advanced++;
    const r = await list({ prefix: `state/${user}/`, cursor, limit: 1000, token: STATE_BLOB });
    await Promise.all(r.blobs.map(async (b) => {
      const rel = b.pathname.slice(`state/${user}/`.length);
      if (!FILE.test(rel)) return;
      blobStats.simple++;
      const g = await get(b.pathname, { access: 'private', useCache: false, token: STATE_BLOB });
      // a failed read must not look like "no inventory": that would overwrite it on write
      if (!g || g.statusCode !== 200) throw new Error(`state read failed for ${rel}`);
      files[rel] = Buffer.from(await new Response(g.stream).arrayBuffer()).toString('utf8');
      // list() has the strong ETag; get() may report a weak one that ifMatch rejects
      etags[rel] = b.etag || String(g.blob.etag).replace(/^W\//, '');
    }));
    cursor = r.cursor;
  } while (cursor);
  return { files, etags };
}

// ---------------------------------------------------------------- public API

// Writes the user's files into dir; returns a token for save().
export async function load(user, dir) {
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'exports'), { recursive: true });
  let files = {};
  let ver = { backend };
  if (backend === 'redis') {
    const cur = await redis(['GET', KEY(user)]);
    if (cur) {
      const i = cur.indexOf(':');
      ver.version = Number(cur.slice(0, i));
      files = decode(cur.slice(i + 1));
    } else {
      ver.version = 0;
      // one-time migration from the old Blob layout; written to Redis by the next save()
      if (STATE_BLOB) { files = (await blobReadAll(user)).files; ver.migrated = Object.keys(files).length > 0; }
    }
  } else if (backend === 'blob') {
    const r = await blobReadAll(user);
    files = r.files;
    ver.etags = r.etags;
  } else {
    const base = path.join(LOCAL_STORE, user);
    const rels = [];
    for (const f of ['inventory.json', 'inventory.prev.json', 'pile.json']) if (fs.existsSync(path.join(base, f))) rels.push(f);
    if (fs.existsSync(path.join(base, 'models'))) for (const f of fs.readdirSync(path.join(base, 'models'))) rels.push('models/' + f);
    for (const rel of rels.filter((r) => FILE.test(r))) files[rel] = fs.readFileSync(path.join(base, rel), 'utf8');
  }
  for (const [rel, text] of Object.entries(files)) {
    if (!FILE.test(rel)) continue;
    fs.writeFileSync(path.join(dir, rel), text);
  }
  ver.hashes = Object.fromEntries(Object.entries(files).map(([rel, t]) => [rel, hash(Buffer.from(t))]));
  return ver;
}

function readDir(dir) {
  const files = {};
  for (const f of ['inventory.json', 'inventory.prev.json', 'pile.json']) if (fs.existsSync(path.join(dir, f))) files[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const f of fs.readdirSync(path.join(dir, 'models'))) if (FILE.test('models/' + f)) files['models/' + f] = fs.readFileSync(path.join(dir, 'models', f), 'utf8');
  return files;
}

// Saves dir back if anything changed. A concurrent write by another instance -> error.conflict.
// Returns the list of changed files.
export async function save(user, dir, ver) {
  const files = readDir(dir);
  const changed = Object.keys(files).filter((rel) => ver.hashes[rel] !== hash(Buffer.from(files[rel])));
  const removed = Object.keys(ver.hashes).filter((rel) => !(rel in files));
  if (!changed.length && !removed.length && !ver.migrated) return [];
  if (backend === 'redis') {
    const val = encode(files);
    if (val.length > MAX_STATE) throw new Error('your saved data is too large: delete some models');
    const r = await redis(['EVAL', CAS, '1', KEY(user), String(ver.version), `${ver.version + 1}:${val}`]);
    if (r === -1) { const e = new Error('saving failed: changed concurrently, try again'); e.conflict = true; throw e; }
    return changed;
  }
  if (backend === 'blob') {
    const { put } = await B();
    const results = await Promise.allSettled(changed.map((rel) => { blobStats.advanced++; return put(`state/${user}/${rel}`, files[rel], {
      access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', token: STATE_BLOB,
      ...(ver.etags[rel] ? { ifMatch: ver.etags[rel] } : {}),
    }); }));
    const failed = results.map((r, i) => (r.status === 'rejected' ? `${changed[i]}: ${r.reason && r.reason.message}` : null)).filter(Boolean);
    if (failed.length) {
      const e = new Error('saving failed (changed concurrently? try again): ' + failed.join('; '));
      e.conflict = failed.some((f) => /Precondition failed|ETag/i.test(f));
      throw e;
    }
    return changed;
  }
  for (const rel of changed) {
    fs.mkdirSync(path.dirname(path.join(LOCAL_STORE, user, rel)), { recursive: true });
    fs.writeFileSync(path.join(LOCAL_STORE, user, rel), files[rel]);
  }
  return changed;
}

// ---------------------------------------------------------------- daily quota

// Adds `add` ({calls, video, photo}) to today's counters if all stay within `limits`.
// Returns { ok, over, limit, first } (first = the user's first call ever).
// ARGV = triples (field, add, limit). KEYS[1] = today's counters hash, KEYS[2] = "seen" flag.
// Atomic: either every counter is incremented or none is.
const QUOTA_LUA = `for i = 1, #ARGV, 3 do
  local add = tonumber(ARGV[i + 1])
  if add > 0 then
    local cur = tonumber(redis.call('HGET', KEYS[1], ARGV[i]) or '0')
    if cur + add > tonumber(ARGV[i + 2]) then return ARGV[i] end
  end
end
for i = 1, #ARGV, 3 do
  local add = tonumber(ARGV[i + 1])
  if add > 0 then redis.call('HINCRBY', KEYS[1], ARGV[i], add) end
end
redis.call('EXPIRE', KEYS[1], 172800)
return 'ok:' .. redis.call('SETNX', KEYS[2], '1')`;

export async function chargeQuota(user, add, limits) {
  const day = new Date().toISOString().slice(0, 10);
  const fields = Object.keys(add);
  if (backend === 'redis') {
    const r = await redis(['EVAL', QUOTA_LUA, '2', `${NS}:usage:${user}:${day}`, `${NS}:seen:${user}`,
      ...fields.flatMap((f) => [f, String(add[f] || 0), String(limits[f])])]);
    if (typeof r === 'string' && r.startsWith('ok:')) return { ok: true, first: r === 'ok:1' };
    return { ok: false, over: r, limit: limits[r] };
  }
  // local / blob fallback: a small JSON file per user in /tmp (single instance only)
  const f = path.join(LOCAL_STORE, '_usage', user + '.json');
  let u = {};
  try { u = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* first call */ }
  const first = !u.seen;
  if (u.day !== day) u = { day, seen: true };
  u.seen = true;
  for (const k of fields) if (add[k] && (u[k] || 0) + add[k] > limits[k]) return { ok: false, over: k, limit: limits[k] };
  for (const k of fields) u[k] = (u[k] || 0) + add[k];
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(u));
  return { ok: true, first };
}

// ---------------------------------------------------------------- media dedup

// Same bytes -> same URL: remembers sha1(content) -> url for a week, so re-rendering the same
// picture does not upload (and pay for) it again. Kept short so a reused link still has most of
// its media lifetime left before the cleanup cron deletes the file.
export async function mediaUrlFor(sha) {
  if (backend !== 'redis') return null;
  return redis(['GET', `${NS}:media:${sha}`]);
}
export async function rememberMedia(sha, url, days) {
  if (backend !== 'redis') return;
  await redis(['SET', `${NS}:media:${sha}`, url, 'EX', String(Math.max(1, Math.min(7, days - 7)) * 86400)]);
}

// Rendered films by model hash (same model + settings = same mp4): URL kept a bit less than
// the media lifetime, so a repeated «Видео» skips the render.
export async function filmUrlFor(key) {
  if (backend !== 'redis') return null;
  return redis(['GET', `${NS}:film:${key}`]);
}
export async function rememberFilm(key, url, days) {
  if (backend !== 'redis') return;
  await redis(['SET', `${NS}:film:${key}`, url, 'EX', String(Math.max(1, Math.min(7, days - 7)) * 86400)]);
}

// Free Upstash databases unused for 30 days get archived: the daily cron writes this heartbeat.
export async function heartbeat() {
  if (backend !== 'redis') return null;
  await redis(['SET', `${NS}:heartbeat`, new Date().toISOString()]);
  return redis(['DBSIZE']);
}

// ---------------------------------------------------------------- YouTube copies of build videos
// sha1(mp4) -> { id, url } of the copy on the owner's channel (kept for good). A short "uploading"
// claim stops two instances uploading the same video; a per-day counter keeps under the API cap.
const memYt = new Map();
export async function youtubeFor(sha) {
  if (backend !== 'redis') return memYt.get(sha) || null;
  const v = await redis(['GET', `${NS}:yt:${sha}`]);
  return v ? JSON.parse(v) : null;
}
export async function rememberYoutube(sha, info) {
  if (backend !== 'redis') { memYt.set(sha, info); return; }
  await redis(['SET', `${NS}:yt:${sha}`, JSON.stringify(info)]);
  await redis(['DEL', `${NS}:yt-lock:${sha}`]);
}
const CLAIM = `if redis.call('SET', KEYS[1], '1', 'NX', 'EX', 600) == false then return 0 end
local n = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], 172800)
if n > tonumber(ARGV[1]) then redis.call('DECR', KEYS[2]); redis.call('DEL', KEYS[1]); return 0 end
return 1`;
const memClaims = new Set();
const memYtCount = new Map();
export async function claimYoutubeSlot(sha, dailyMax) {
  const day = new Date().toISOString().slice(0, 10);
  if (backend !== 'redis') {
    if (memClaims.has(sha) || (memYtCount.get(day) || 0) >= dailyMax) return false;
    memClaims.add(sha); memYtCount.set(day, (memYtCount.get(day) || 0) + 1); return true;
  }
  return (await redis(['EVAL', CLAIM, '2', `${NS}:yt-lock:${sha}`, `${NS}:yt-count:${day}`, String(dailyMax)])) === 1;
}
export async function releaseYoutubeSlot(sha) {
  const day = new Date().toISOString().slice(0, 10);
  if (backend !== 'redis') { memClaims.delete(sha); memYtCount.set(day, Math.max(0, (memYtCount.get(day) || 0) - 1)); return; }
  await redis(['DEL', `${NS}:yt-lock:${sha}`]);
  await redis(['DECR', `${NS}:yt-count:${day}`]);
}
