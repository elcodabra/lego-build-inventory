// The inventory: the LEGO parts you actually own. Stored as JSON (default ./inventory.json,
// or $LEGO_INVENTORY, or $LEGO_DATA_DIR/inventory.json; override with --inv).
//
//   node tools/inventory.cjs import my-parts.csv        CSV part,color,qty | Rebrickable CSV | BrickLink XML | JSON
//   node tools/inventory.cjs add-set 31058               parts of a set via Rebrickable (REBRICKABLE_API_KEY)
//   node tools/inventory.cjs add 3001 red 4              one line by hand (colour: key, name or BrickLink id)
//   node tools/inventory.cjs remove 3001 red 2
//   node tools/inventory.cjs show [--json]               what you have, drawable parts by colour
//   node tools/inventory.cjs fit <model> [--json]        what the model needs vs what you have
//   node tools/inventory.cjs bom <model> [--csv]         the model's parts list (e.g. for a BrickLink order)
//   node tools/inventory.cjs clear
const fs = require('fs');
const core = require('../lib/core.cjs');

const args = process.argv.slice(2);
const opt = (n) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
const pos = args.filter((a, i) => !a.startsWith('--') && !['--inv', '--format'].includes(args[i - 1]));
const [cmd, ...rest] = pos;
const json = args.includes('--json');
const inv = core.loadInventory(opt('--inv'));

function printSummary(s) {
  if (json) return console.log(JSON.stringify(s, null, 2));
  console.log(`${s.file}\nвсего деталей ${s.totalParts}, из них в библиотеке движка ${s.drawableParts}`);
  if (s.sources.length) console.log('источники: ' + s.sources.join(', '));
  const byColor = {};
  for (const it of s.drawable) (byColor[it.color] = byColor[it.color] || []).push(`${it.id}×${it.qty}`);
  for (const [c, list] of Object.entries(byColor)) console.log(`  ${c.padEnd(13)} ${list.join('  ')}`);
  if (s.notDrawable.length) console.log(`не рисуются движком (${s.notDrawable.length} позиций): ` + s.notDrawable.slice(0, 30).map((x) => `${x.id} ${x.color}×${x.qty}`).join(', ') + (s.notDrawable.length > 30 ? ' ...' : ''));
}

(async () => {
  switch (cmd) {
    case 'import': {
      if (!rest[0]) throw new Error('usage: import <file> [--format csv|rebrickable|bricklink|json]');
      const r = core.parseInventory(fs.readFileSync(rest[0], 'utf8'), opt('--format'));
      inv.items.push(...r.items);
      inv.sources.push(`file ${rest[0]}`);
      core.saveInventory(inv);
      console.log(`imported ${r.items.length} lines (${r.format})` + (r.unknownColors.length ? `, skipped colours not in the palette: ${r.unknownColors.join('; ')}` : ''));
      break;
    }
    case 'add-set': {
      for (const s of rest) {
        const r = await core.fetchSet(s);
        inv.items.push(...r.items);
        inv.sources.push(`set ${r.set}`);
        console.log(`${r.set}: ${r.items.reduce((a, x) => a + x.qty, 0)} parts` + (r.skipped.length ? `, skipped (colour not in palette): ${r.skipped.length}` : ''));
      }
      core.saveInventory(inv);
      break;
    }
    case 'add':
    case 'remove': {
      const [part, color, qty] = rest;
      const c = core.colorKey(color);
      if (!part || !c) throw new Error(`usage: ${cmd} <part> <color> [qty]; unknown colour "${color}"`);
      const n = Number(qty || 1) * (cmd === 'remove' ? -1 : 1);
      inv.items.push({ id: core.partId(part), color: c, qty: n });
      core.saveInventory(inv);
      console.log(`${cmd} ${core.partId(part)} ${c} ×${Math.abs(n)}` + (core.drawable(core.partId(part)) ? '' : ' (part is not in the drawing library)'));
      break;
    }
    case 'show':
    case undefined:
      printSummary(core.summarizeInventory(inv));
      break;
    case 'fit': {
      const model = core.loadModel(rest[0] || 'cat');
      const r = core.fitInventory(model, inv);
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        for (const m of r.missing) console.log(`не хватает ${m.id} ${m.color} (${m.name}): нужно ${m.qty}, есть ${m.have}` + (m.alternatives.length ? `; замены: ${m.alternatives.map((a) => `${a.id} ${a.color}×${a.qty}`).join(', ')}` : ''));
        console.log(r.ok ? `${model.name}: все ${r.totalNeeded} деталей есть` : `${model.name}: не хватает ${r.totalShort} из ${r.totalNeeded}`);
      }
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'bom': {
      const b = core.bom(core.loadModel(rest[0] || 'cat'));
      if (args.includes('--csv')) console.log('part,color,qty\n' + b.map((x) => `${x.id},${core.LEGO.COLORS[x.color].name},${x.qty}`).join('\n'));
      else if (json) console.log(JSON.stringify(b, null, 2));
      else b.forEach((x) => console.log(`${x.id.padEnd(6)} ${x.color.padEnd(13)} ×${x.qty}  ${x.name}`));
      break;
    }
    case 'clear':
      inv.items = [];
      inv.sources = [];
      core.saveInventory(inv);
      console.log('cleared ' + inv.file);
      break;
    default:
      throw new Error('unknown command ' + cmd + '. See the header of tools/inventory.cjs');
  }
})().catch((e) => { console.error(e.message); process.exit(2); });
