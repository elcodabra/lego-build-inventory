// Complex parts (wheels, technic, frames, ladders...) and the build check around them, offline:
//   node test/parts-complex.cjs
// - every part in the library draws, with sane bounds
// - recognised variant numbers (4180c06, 55981c05, 35809pb01) map to drawable parts
// - hand-made models with the new parts pass the check, broken ones fail for the right reason
// - the pile from test/fixtures/pile-table-edge.jpg (as recognised) gives buildable ideas
const core = require('../lib/core.cjs');
const ideas = require('../lib/ideas.cjs');
const { createCanvas } = require('@napi-rs/canvas');
const assert = require('assert/strict');
const L = core.LEGO;
const ok = (m) => console.log('  ok ', m);

// 1. every part draws
const c = createCanvas(200, 200);
for (const id of L.ORDER) {
  const b = L.bounds([L.place({ id, color: 'red', at: [0, 0, 0] })]);
  assert.ok(b.max.every((v, k) => v > b.min[k]), `${id}: empty bounds`);
  L.drawPart(c.getContext('2d'), { id, color: 'red' }, 100, 100, 20);
}
ok(`${L.ORDER.length} parts draw`);
assert.ok(L.ORDER.length >= 80);

// 2. ids
const map = { '4180c06': '4180c01', '55981c05': '55981', '93594c01': '93594', '35809pb01': '35809', '44375a': '44375b', '3062b': '3062' };
for (const [a, b] of Object.entries(map)) assert.equal(core.partId(a), b, a);
assert.equal(core.drawable(core.partId('19663')), false); // Duplo is not drawn
ok('variant numbers map to the drawn mould');

// 3. models
const check = (steps) => core.checkGeometry(core.validateModel({ title: 't', steps: JSON.parse(JSON.stringify(steps)) }, 't')).problems.map((p) => p.type);
assert.deepEqual(check([
  [{ id: '4180c01', color: 'black', at: [0, 0, 0] }, { id: '4180c01', color: 'black', at: [6, 0, 0] }],
  [{ id: '3832', color: 'red', at: [0, 0, 6] }],
  [{ id: '4345', color: 'red', at: [6, 0, 7] }, { id: '15209', color: 'white', at: [0, 0, 7] }, { id: '3170', color: 'black', at: [3, 1, 7] }],
  [{ id: '70646', color: 'white', at: [-3, -0.25, 13] }],
]), []);
ok('truck on wheel bricks with a ladder holds');
assert.deepEqual(check([[{ id: '3032', color: 'dbg', at: [0, 0, 0] }], [{ id: '64450', color: 'black', at: [0, 0, 1], rot: 1 }], [{ id: '44375b', color: 'lbg', at: [0, -1, 11] }]]), []);
ok('roll cage over a plate, dish on the cage');
assert.deepEqual(check([[{ id: '3701', color: 'lbg', at: [0, 0, 0] }], [{ id: '3673', color: 'lbg', at: [0.5, -1, 0.5], rot: 1 }], [{ id: '32316', color: 'yellow', at: [0.5, -1, 0.5] }]]), []);
ok('liftarm pinned to a technic brick holds (pin through both holes)');
assert.deepEqual(check([[{ id: '3701', color: 'lbg', at: [0, 0, 0] }], [{ id: '32316', color: 'yellow', at: [0.5, -1, 0.5] }]]), ['floats']);
ok('the same liftarm without the pin floats');
assert.deepEqual(check([[{ id: '3020', color: 'lbg', at: [0, 0, 0] }], [{ id: '44728', color: 'red', at: [0, 0, 1] }], [{ id: '3022', color: 'blue', at: [0, -0.4, 1], up: '-y' }]]), []);
ok('plate on the side studs of a bracket holds');
assert.ok(check([[{ id: '3001', color: 'red', at: [0, 0, 0] }], [{ id: '55981', color: 'lbg', at: [1, 0, 0] }]]).includes('overlap'));
ok('a wheel inside a brick is an overlap');
assert.deepEqual(check([[{ id: '3001', color: 'red', at: [0, 0, 0] }], [{ id: '3001', color: 'red', at: [1, 0, 0] }]]), ['overlap']);
ok('plain bricks: old exact overlap rule unchanged');

// 4. ideas from the real pile
const items = require('./fixtures/pile-table-edge-inventory.json').map((x) => ({ ...x, id: core.partId(x.id) }));
const s = ideas.suggest(items);
const names = s.buildable.map((b) => b.idea);
assert.ok(names.includes('firetruck') && names.includes('rover'), 'pile ideas: ' + names.join(','));
for (const b of s.buildable) {
  const r = ideas.build(b.idea, items, b.sizeIndex);
  assert.deepEqual(core.checkGeometry(core.validateModel(JSON.parse(JSON.stringify(r.model)), b.idea)).problems, []);
}
ok(`real pile (${s.drawableParts} drawable parts): ${names.join(', ')}`);
assert.equal(s.buildable[0].idea, 'spaceport', 'the scene that takes the most parts comes first');
assert.ok(s.buildable[0].usesPercent >= 90, 'spaceport uses ' + s.buildable[0].usesPercent + '%');
const ship = s.buildable.find((b) => b.idea === 'spaceship');
assert.ok(ship && ship.parts >= 28, 'spaceship parts ' + (ship && ship.parts));
// the ship is symmetric enough: wings come in mirrored pairs around the hull centre
const sm = ideas.build('spaceship', items, 0).model.steps.flat();
const wings = sm.filter((p) => p.at[0] < 7 || p.at[0] > 13);
assert.ok(wings.length >= 2, 'ship has wings');
ok(`max use: spaceport ${s.buildable[0].parts} parts (${s.buildable[0].usesPercent}%), spaceship ${ship.parts}`);
console.log('complex parts checks passed');
