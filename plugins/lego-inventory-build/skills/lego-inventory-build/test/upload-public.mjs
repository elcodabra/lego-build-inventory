// Upload files to the public media store: MEDIA_BLOB_TOKEN=... node test/upload-public.mjs file...
import fs from 'node:fs';
import path from 'node:path';
import { put } from '@vercel/blob';
for (const f of process.argv.slice(2)) {
  const r = await put('test/' + path.basename(f), fs.readFileSync(f), { access: 'public', addRandomSuffix: false, allowOverwrite: true, token: process.env.MEDIA_BLOB_TOKEN });
  console.log(r.url);
}
