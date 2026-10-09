// Daily Vercel cron: deletes rendered PNG/mp4 older than LEGO_MEDIA_DAYS (default 30) from the public
// media store, so an open server does not grow without bound. Links in old chats stop working after
// that, which the key page states. Vercel calls it with "Authorization: Bearer $CRON_SECRET".
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secret || !crypto.timingSafeEqual(sha(got), sha(secret))) return res.status(401).end();
  const token = process.env.MEDIA_BLOB_TOKEN;
  if (!token) return res.status(200).json({ deleted: 0, note: 'no media store' });
  const days = Number(process.env.LEGO_MEDIA_DAYS || 30);
  const cutoff = Date.now() - days * 864e5;
  const { list, del } = await import('@vercel/blob');
  let cursor;
  let deleted = 0;
  let kept = 0;
  do {
    const r = await list({ prefix: 'media/', cursor, limit: 1000, token });
    const old = r.blobs.filter((b) => +new Date(b.uploadedAt) < cutoff).map((b) => b.url);
    kept += r.blobs.length - old.length;
    for (let i = 0; i < old.length; i += 100) await del(old.slice(i, i + 100), { token });
    deleted += old.length;
    cursor = r.hasMore ? r.cursor : null;
  } while (cursor);
  console.log(JSON.stringify({ ev: 'media_cleanup', deleted, kept, days }));
  return res.status(200).json({ deleted, kept, days });
}
