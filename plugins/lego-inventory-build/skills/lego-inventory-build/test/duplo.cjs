// DUPLO: parts at real scale, checker rules (grid, no mixing), ideas only for the owned system.
'use strict';
const assert = require('assert');
const core = require('../lib/core.cjs');
const ideas = require('../lib/ideas.cjs');
const ok = (m) => console.log('  ok  ' + m);

const L = core.LEGO.LIB;
assert.equal(L['3011'].w, 8); assert.equal(L['3011'].d, 4); assert.ok(Math.abs(L['3011'].h - 2.4) < 1e-9);
assert.equal(L['3011'].studs.length, 8); assert.equal(L['3011'].studScale, 2);
ok('DUPLO 2x4 is twice a LEGO 2x4 in every direction, 8 big studs');

const geo = (steps) => core.checkGeometry(core.validateModel({ steps }, 't')).problems.map((p) => p.type);
assert.deepEqual(geo([[{ id: '3011', color: 'red', at: [0, 0, 0] }], [{ id: '3437', color: 'blue', at: [2, 0, 6] }]]), []);
ok('DUPLO 2x2 on a DUPLO 2x4 holds');
assert.ok(geo([[{ id: '3011', color: 'red', at: [1, 0, 0] }]]).includes('grid')); ok('off the DUPLO grid refused');
assert.ok(geo([[{ id: '3011', color: 'red', at: [0, 0, 0] }], [{ id: '3001', color: 'blue', at: [0, 0, 6] }]]).includes('mixed')); ok('DUPLO + LEGO in one model refused');
assert.ok(geo([[{ id: '3011', color: 'red', at: [0, 0, 0] }], [{ id: '3437', color: 'blue', at: [0, 0, 12] }]]).includes('floats')); ok('a floating DUPLO brick is caught');

const duplo = { items: [{ id: '3011', color: 'red', qty: 20 }, { id: '3437', color: 'blue', qty: 10 }, { id: '3437', color: 'red', qty: 6 }, { id: '4199', color: 'red', qty: 6 }, { id: '2300', color: 'red', qty: 6 }, { id: '4672', color: 'brightGreen', qty: 1 }, { id: '6474', color: 'blue', qty: 10 }] };
const s = ideas.suggest(duplo);
const got = s.buildable.map((b) => b.idea).sort();
assert.deepEqual(got, ['duploHouse', 'duploPyramid', 'duploTower']); ok('DUPLO pile: only DUPLO ideas (' + got.join(', ') + ')');
assert.ok(s.buildable.find((b) => b.idea === 'duploHouse').size === '8×6'); ok('DUPLO house at the largest size 8×6');
for (const b of s.buildable) {
  const r = ideas.build(b.idea, duplo);
  assert.deepEqual(core.checkGeometry(core.validateModel(JSON.parse(JSON.stringify(r.model)), b.idea)).problems, []);
  assert.ok(r.model.steps.flat().every((p) => L[p.id].duplo));
}
ok('every DUPLO idea passes the checker and uses DUPLO parts only');
const lego = { items: [{ id: '3001', color: 'red', qty: 40 }, { id: '3003', color: 'blue', qty: 20 }] };
assert.ok(ideas.suggest(lego).buildable.every((b) => !ideas.GENERATORS[b.idea].duplo)); ok('LEGO pile: no DUPLO ideas');
const close = ideas.suggest({ items: [{ id: '3011', color: 'red', qty: 2 }] });
assert.ok(close.almost.every((a) => ideas.GENERATORS[a.idea].duplo)); ok('a few DUPLO bricks: "almost" lists DUPLO ideas with what to add');
assert.equal(ideas.titleEn('DUPLO домик'), 'DUPLO house');
console.log('duplo passed');
