// Tiny key-value layer: Upstash Redis in production, an in-memory map for local runs/tests.
// Values are JSON. take() is an atomic get-and-delete (one-time codes, challenges).
import { Redis } from '@upstash/redis';

type Json = any;

interface KV {
  get(key: string): Promise<Json | null>;
  set(key: string, value: Json, ttlSeconds?: number): Promise<void>;
  setnx(key: string, value: Json, ttlSeconds?: number): Promise<boolean>;
  take(key: string): Promise<Json | null>;
  del(...keys: string[]): Promise<void>;
  incr(key: string, ttlSeconds: number): Promise<number>;
  sadd(key: string, member: string): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
}

const NS = process.env.AUTH_REDIS_PREFIX || 'auth';
const k = (key: string) => `${NS}:${key}`;

function redisKV(): KV {
  const r = new Redis({ url: process.env.KV_REST_API_URL!, token: process.env.KV_REST_API_TOKEN!, automaticDeserialization: false });
  const enc = (v: Json) => JSON.stringify(v);
  const dec = (s: unknown) => (s == null ? null : JSON.parse(String(s)));
  return {
    async get(key) { return dec(await r.get(k(key))); },
    async set(key, value, ttl) { if (ttl) await r.set(k(key), enc(value), { ex: ttl }); else await r.set(k(key), enc(value)); },
    async setnx(key, value, ttl) { return (await r.set(k(key), enc(value), ttl ? { nx: true, ex: ttl } : { nx: true })) === 'OK'; },
    async take(key) { return dec(await r.getdel(k(key))); },
    async del(...keys) { if (keys.length) await r.del(...keys.map(k)); },
    async incr(key, ttl) { const p = r.pipeline(); p.incr(k(key)); p.expire(k(key), ttl, 'NX'); const [n] = await p.exec(); return Number(n); },
    async sadd(key, m) { await r.sadd(k(key), m); },
    async srem(key, m) { await r.srem(k(key), m); },
    async smembers(key) { return (await r.smembers(k(key))).map(String); },
  };
}

function memoryKV(): KV {
  const g = globalThis as any;
  const m: Map<string, { v: string; exp: number }> = (g.__authMem ||= new Map());
  const live = (key: string) => { const e = m.get(key); if (!e) return null; if (e.exp && e.exp < Date.now()) { m.delete(key); return null; } return e; };
  const put = (key: string, v: string, ttl?: number) => m.set(key, { v, exp: ttl ? Date.now() + ttl * 1000 : 0 });
  return {
    async get(key) { const e = live(k(key)); return e ? JSON.parse(e.v) : null; },
    async set(key, value, ttl) { put(k(key), JSON.stringify(value), ttl); },
    async setnx(key, value, ttl) { if (live(k(key))) return false; put(k(key), JSON.stringify(value), ttl); return true; },
    async take(key) { const e = live(k(key)); m.delete(k(key)); return e ? JSON.parse(e.v) : null; },
    async del(...keys) { for (const x of keys) m.delete(k(x)); },
    async incr(key, ttl) { const e = live(k(key)); const n = (e ? Number(JSON.parse(e.v)) : 0) + 1; m.set(k(key), { v: String(n), exp: e?.exp || Date.now() + ttl * 1000 }); return n; },
    async sadd(key, mem) { const e = live(k(key)); const s = new Set<string>(e ? JSON.parse(e.v) : []); s.add(mem); put(k(key), JSON.stringify([...s])); },
    async srem(key, mem) { const e = live(k(key)); const s = new Set<string>(e ? JSON.parse(e.v) : []); s.delete(mem); put(k(key), JSON.stringify([...s])); },
    async smembers(key) { const e = live(k(key)); return e ? JSON.parse(e.v) : []; },
  };
}

export const kv: KV = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN ? redisKV() : memoryKV();
export const kvBackend = process.env.KV_REST_API_URL ? 'redis' : 'memory';
