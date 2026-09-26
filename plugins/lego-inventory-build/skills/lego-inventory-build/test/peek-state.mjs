// Read the owner's saved state from the private store: STATE_BLOB_TOKEN=... node test/peek-state.mjs [model]
import { list, get } from '@vercel/blob';
const token = process.env.STATE_BLOB_TOKEN;
const r = await list({ prefix: 'state/owner/', token });
for (const b of r.blobs) {
  const g = await get(b.pathname, { access: 'private', useCache: false, token });
  const txt = await new Response(g.stream).text();
  if (b.pathname.endsWith('inventory.json')) {
    const inv = JSON.parse(txt);
    console.log(b.pathname, inv.updated, 'sources', inv.sources.join(' | '));
    console.log('  ', inv.items.map((i) => `${i.id} ${i.color}×${i.qty}`).join(', '));
  } else if (!process.argv[2] || b.pathname.includes(process.argv[2])) {
    const m = JSON.parse(txt);
    console.log(b.pathname, m.title, m.steps.length, 'steps', m.steps.flat().length, 'parts');
  }
}
