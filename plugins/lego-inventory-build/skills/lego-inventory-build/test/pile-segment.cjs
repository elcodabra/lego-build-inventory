// Pile segmentation regressions, offline (no Brickognize calls): node test/pile-segment.cjs
//  - a shot that also shows the floor past the table edge must not collapse into one blob
//    (the background used to come from the photo border, i.e. the rug)
//  - a dense pile of touching parts must be split into many parts
const P = require('../lib/photo.cjs');
const path = require('path');
const assert = require('assert/strict');
(async () => {
  const f = path.join(__dirname, 'fixtures/pile-table-edge.jpg');
  const t = Date.now();
  const r = await P.identifyPile(f, { segmentOnly: true, max: 200 });
  console.log(`  table-edge pile: ${r.found} parts found in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  // old code: 3 blobs (table taken as one), new: ~37 on this downscaled fixture
  assert.ok(r.found >= 30, `expected >= 30 separate parts on the table photo, got ${r.found}`);
  assert.ok(r.found <= 80, `expected <= 80 (the API cap), got ${r.found}`);
  // no box may cover most of the frame: that is the old "the whole table is one blob" failure
  // (a dense clump in the middle of the pile is fine, it is still a fraction of the table)
  const W = Math.max(...r.boxes.map((b) => b.x1)) + 1; const H = Math.max(...r.boxes.map((b) => b.y1)) + 1;
  const big = r.boxes.filter((b) => (b.x1 - b.x0) * (b.y1 - b.y0) > 0.7 * W * H);
  assert.equal(big.length, 0, 'a single blob covers most of the table');
  // - a white table lit from one side, parquet above it: the table is the largest SMOOTH region
  //   (not the most common colour, which picked the floor), and the parts are found against the
  //   local table brightness (old code: 1 blob on this fixture, the whole table)
  {
    const f2 = path.join(__dirname, 'fixtures/pile-white-table.jpg');
    const lv = {};
    const r2 = await P.identifyPile(f2, { segmentOnly: true, max: 200, debugLevels: lv });
    console.log(`  white table, uneven light (spread ${lv.spread}): ${r2.found} parts found`);
    assert.ok(lv.uneven, 'the light gradient is detected');
    assert.ok(r2.found >= 50, `expected >= 50 parts on the white table, got ${r2.found}`);
    const W2 = Math.max(...r2.boxes.map((b) => b.x1)) + 1; const H2 = Math.max(...r2.boxes.map((b) => b.y1)) + 1;
    const huge = r2.boxes.filter((b) => (b.area || 0) > 0.05 * W2 * H2);
    assert.equal(huge.length, 0, 'no blob is a big piece of the table: ' + huge.map((b) => b.area).join(','));
  }
  console.log('pile segmentation checks passed');
})().catch((e) => { console.error(e.message); process.exit(1); });
