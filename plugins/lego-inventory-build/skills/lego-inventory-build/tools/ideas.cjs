// Ideas: what you can build from the inventory right now.
//   node tools/ideas.cjs                     suggestions: buildable now + almost (with what to add)
//   node tools/ideas.cjs build house [size]  generate the model into models/<idea>.json (size: label or index)
//   node tools/ideas.cjs list                all ideas and sizes
// Generated models are ordinary JSON models: check, snap and render them like any other.
const fs = require('fs');
const path = require('path');
const core = require('../lib/core.cjs');
const ideas = require('../lib/ideas.cjs');

const args = process.argv.slice(2);
const opt = (n) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
const pos = args.filter((a, i) => !a.startsWith('--') && !['--inv', '--out'].includes(args[i - 1]));
const inv = core.loadInventory(opt('--inv'));
const json = args.includes('--json');
const name = (c) => (core.LEGO.COLORS[c] ? core.LEGO.COLORS[c].ru.toLowerCase() : c);

try {
  if (pos[0] === 'list') {
    for (const i of ideas.list()) console.log(`${i.idea.padEnd(9)} ${i.title}: ${i.about} (${i.sizes.join(', ')})`);
  } else if (pos[0] === 'build') {
    const id = pos[1];
    const size = pos[2] == null ? null : /^\d+$/.test(pos[2]) ? Number(pos[2]) : pos[2];
    const r = ideas.build(id, inv, size, { shopping: args.includes('--shopping') });
    const file = path.resolve(opt('--out') || path.join('models', `${id}.json`));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const m = r.model;
    fs.writeFileSync(file, JSON.stringify({ title: m.title, theta: m.theta, phi: m.phi, steps: m.steps }, null, 1) + '\n');
    const res = core.fullCheck(core.loadModel(file), inv);
    console.log(`${file}: ${m.title} (${r.size}), ${res.parts} деталей, ${res.steps} шагов`);
    for (const n of r.notes) console.log('  заметка: ' + n);
    if (r.missing.length) console.log('  докупить: ' + r.missing.map((x) => `${x.id} ${x.color} ×${x.qty}`).join(', '));
    console.log(core.formatCheck(res).split('\n').pop());
  } else {
    const s = ideas.suggest(inv);
    if (json) { console.log(JSON.stringify(s, null, 2)); process.exit(0); }
    if (!s.drawableParts) { console.log('инвентарь пуст: сфотографируй детали (tools/photo.cjs) или импортируй список (tools/inventory.cjs)'); process.exit(1); }
    console.log(`деталей в инвентаре (которые рисует движок): ${s.drawableParts}\n`);
    console.log(s.buildable.length ? 'Можно собрать прямо сейчас:' : 'Пока ни одна идея не собирается целиком.');
    for (const b of s.buildable) console.log(`  ${b.title} ${b.size}: ${b.parts} деталей, ${b.colors.map(name).join(' + ')}${b.notes.length ? ' (' + b.notes.join('; ') + ')' : ''}  → node tools/ideas.cjs build ${b.idea} ${b.sizeIndex}`);
    if (s.almost.length) {
      console.log('\nПочти получается, не хватает:');
      for (const a of s.almost) console.log(`  ${a.title} ${a.size}: ${a.missing.map((x) => `${x.id} ${name(x.color)} ×${x.qty}`).join(', ')}`);
    }
  }
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
