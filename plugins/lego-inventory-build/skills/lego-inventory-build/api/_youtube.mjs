// Copies rendered build videos to the owner's YouTube channel (YouTube Data API v3, videos.insert,
// resumable upload). Runs after the reply (waitUntil), never blocks or fails a tool call.
//
// Enabled when YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and YOUTUBE_REFRESH_TOKEN are set (a Google
// OAuth client of type "Web application" or "Desktop", scope youtube.upload, refresh token obtained
// once by the owner with scripts/youtube-auth.mjs). Videos go up as "unlisted" by default
// (YOUTUBE_PRIVACY = private | unlisted | public), without notifying subscribers.
//
// One upload per distinct video (keyed by the mp4's sha1, remembered in Redis), and a daily cap
// below the API's 100 uploads/day (YOUTUBE_DAILY_MAX, default 90).
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as store from './_store.mjs';

const ID = process.env.YOUTUBE_CLIENT_ID;
const SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REFRESH = process.env.YOUTUBE_REFRESH_TOKEN;
export const enabled = !!(ID && SECRET && REFRESH);
const PRIVACY = ['private', 'unlisted', 'public'].includes(process.env.YOUTUBE_PRIVACY) ? process.env.YOUTUBE_PRIVACY : 'unlisted';
const DAILY_MAX = Number(process.env.YOUTUBE_DAILY_MAX || 90);
const TOKEN_URL = process.env.YOUTUBE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = process.env.YOUTUBE_UPLOAD_URL || 'https://www.googleapis.com/upload/youtube/v3/videos';

let access = null; // { token, exp }
async function accessToken() {
  if (access && access.exp > Date.now() + 60_000) return access.token;
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: ID, client_secret: SECRET, refresh_token: REFRESH, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('youtube token: ' + (j.error || r.status));
  access = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return access.token;
}

export const sha1File = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
export const knownVideo = (sha) => (enabled ? store.youtubeFor(sha) : null);

// Uploads file; returns { id, url } or null (disabled, already uploaded, over the daily cap).
export async function upload(file, { title, description, tags = [] } = {}) {
  if (!enabled) return null;
  const sha = sha1File(file);
  if (await store.youtubeFor(sha)) return null;
  if (!(await store.claimYoutubeSlot(sha, DAILY_MAX))) return null; // someone else is uploading it, or cap reached
  try {
    const token = await accessToken();
    const size = fs.statSync(file).size;
    const meta = {
      snippet: { title: String(title || 'LEGO build').slice(0, 100), description: String(description || '').slice(0, 4900), tags: tags.slice(0, 15), categoryId: '26' }, // 26 = Howto & Style
      status: { privacyStatus: PRIVACY, selfDeclaredMadeForKids: false, embeddable: true },
    };
    // 1. start a resumable session
    const init = await fetch(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status&notifySubscribers=false`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(size) },
      body: JSON.stringify(meta),
      signal: AbortSignal.timeout(15_000),
    });
    const session = init.headers.get('location');
    if (!init.ok || !session) throw new Error('youtube init: ' + init.status + ' ' + (await init.text()).slice(0, 200));
    // 2. send the file (build films are a few MB: one PUT)
    const put = await fetch(session, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(size) }, body: fs.readFileSync(file), signal: AbortSignal.timeout(120_000) });
    const v = await put.json().catch(() => ({}));
    if (!put.ok || !v.id) throw new Error('youtube upload: ' + put.status + ' ' + JSON.stringify(v).slice(0, 200));
    const url = `https://youtu.be/${v.id}`;
    await store.rememberYoutube(sha, { id: v.id, url, privacy: v.status && v.status.privacyStatus });
    console.log(JSON.stringify({ ev: 'youtube_uploaded', id: v.id, privacy: v.status && v.status.privacyStatus, bytes: size }));
    return { id: v.id, url };
  } catch (e) {
    await store.releaseYoutubeSlot(sha);
    console.log(JSON.stringify({ ev: 'youtube_error', err: e.message.slice(0, 300) }));
    return null;
  }
}
