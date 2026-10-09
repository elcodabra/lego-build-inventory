// Fixed-window rate limits per IP (and per key) to slow down abuse of the public endpoints.
import { kv } from './kv';
import { headers } from 'next/headers';

export async function clientIp() {
  const h = await headers();
  return (h.get('x-real-ip') || h.get('x-forwarded-for')?.split(',')[0] || 'local').trim().slice(0, 64);
}

// true = allowed
export async function rateLimit(bucket: string, limit: number, windowSeconds: number, who?: string) {
  const id = who || (await clientIp());
  const slot = Math.floor(Date.now() / 1000 / windowSeconds);
  const n = await kv.incr(`rl:${bucket}:${id}:${slot}`, windowSeconds + 5);
  return n <= limit;
}
