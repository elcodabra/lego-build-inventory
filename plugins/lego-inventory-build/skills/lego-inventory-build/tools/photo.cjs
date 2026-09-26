// Photos of parts -> inventory.
//   node tools/photo.cjs part1.jpg part2.jpg ...        recognise one part per photo (Brickognize), print results
//   node tools/photo.cjs --add [--qty 3] part.jpg ...   and add the confident ones to the inventory
// A photo of a pile is not split into parts here: the agent reads it itself (reference/photos.md).
const core = require('../lib/core.cjs');
const photo = require('../lib/photo.cjs');
const film = require('../lib/film.cjs');

const args = process.argv.slice(2);
const opt = (n) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
const files = args.filter((a, i) => !a.startsWith('--') && !['--qty', '--inv'].includes(args[i - 1]));
const add = args.includes('--add');
const qty = Number(opt('--qty') || 1);

(async () => {
  if (!files.length) throw new Error('usage: node tools/photo.cjs [--add] [--qty N] photo.jpg ...');
  const inv = core.loadInventory(opt('--inv'));
  const out = [];
  for (const f of files) {
    const r = await photo.identify(f);
    out.push({ file: f, ...r });
    const p = r.part;
    const alt = r.candidates.slice(1).map((c) => `${c.id} ${c.score}`).join(', ');
    console.log(`${f}: ${p ? `${p.id} ${p.name} (${p.score})` : 'не распознано'}, цвет ${r.color || '?'} ${r.colors.slice(1, 3).map((c) => `/ ${c.color} ${c.score}`).join(' ')}` +
      `${alt ? `, еще: ${alt}` : ''}${r.confident ? '' : '  НЕУВЕРЕННО'}${r.pile ? '  ПОХОЖЕ НА КУЧУ: ' + r.hint : ''}${p && !p.drawable ? '  (движок эту деталь не рисует)' : ''}`);
    if (add && r.confident && !r.pile) inv.items.push({ id: p.id, color: r.color, qty });
  }
  if (add) {
    const n = out.filter((r) => r.confident && !r.pile).length;
    inv.sources.push(`photos ×${n}`);
    core.saveInventory(inv);
    console.log(`добавлено ${n} из ${out.length}; неуверенные проверь и добавь руками: node tools/inventory.cjs add <деталь> <цвет> <кол-во>`);
  }
  if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
  await film.close();
})().catch(async (e) => { console.error(e.message); await film.close(); process.exit(2); });
