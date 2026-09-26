// Checks a model the way a builder would: no two parts overlap, every part is held through a
// chain of stud connections down to the ground, and (with an inventory) every part is one you own.
//   node tools/check-model.cjs <name|file.json> [--inv inventory.json] [--json]
// Without --inv the inventory from $LEGO_INVENTORY, $LEGO_DATA_DIR/inventory.json or ./inventory.json
// is used if it exists. --no-inv skips the inventory check.
const core = require('../lib/core.cjs');

const args = process.argv.slice(2);
const opt = (n) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
const name = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--inv') || 'cat';

try {
  const model = core.loadModel(name);
  const inv = args.includes('--no-inv') ? null : core.loadInventory(opt('--inv'));
  const res = core.fullCheck(model, inv);
  console.log(args.includes('--json') ? JSON.stringify(res, null, 2) : core.formatCheck(res));
  process.exit(res.ok ? 0 : 1);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
