// Disassembly of a KNOWN model: pure functions over the stored JSON steps.
// Nothing here mutates the model, and exploded offsets exist only in render copies (never stored,
// never passed to core.checkGeometry). The reverse order is the build order backwards: it is
// geometrically consistent with the model data but NOT a physically tested removal sequence.
'use strict';

const clone = (x) => JSON.parse(JSON.stringify(x));

// Reverse step k (1..N) removes the original step N-k+1: the last one still on the model.
function reverseSteps(model) {
  return clone(model.steps).reverse();
}

// Parts still on the model after reverse step k (k = 0: the whole model, k = N: nothing).
function modelAtReverseStep(model, k) {
  const n = model.steps.length;
  if (!Number.isInteger(k) || k < 0 || k > n) throw new Error(`reverse step must be 0..${n}`);
  return { ...model, steps: clone(model.steps.slice(0, n - k)) };
}

// BOM of the whole original model, independent of any reverse step.
function disassemblyBOM(model) {
  const map = new Map();
  for (const s of model.steps.flat()) {
    const key = s.id + '|' + s.color;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map].map(([key, qty]) => { const [id, color] = key.split('|'); return { id, color, qty }; })
    .sort((a, b) => a.color.localeCompare(b.color) || a.id.localeCompare(b.id));
}

// Render-only copy where every build step is lifted by `gap` plates more than the one below, so
// groups separate on the picture. Returns { steps } of parts with a visual `at`; physical data intact.
function explodedScene(model, opts) {
  const gap = (opts && opts.gap) || 3;
  return {
    title: model.title, theta: model.theta, phi: model.phi, visualOnly: true,
    steps: model.steps.map((st, k) => st.map((p) => ({ ...clone(p), at: [p.at[0], p.at[1], p.at[2] + k * gap] }))),
  };
}

// Invariants: reverse is an involution, counts never grow, frame 0 = full, frame N = empty, BOM equal.
function assertReverseInvariant(model) {
  const n = model.steps.length;
  const fail = (m) => { throw new Error('disassembly invariant: ' + m); };
  const back = reverseSteps({ steps: reverseSteps(model) });
  if (JSON.stringify(back) !== JSON.stringify(model.steps)) fail('reverse(reverse(steps)) != steps');
  let prev = Infinity;
  for (let k = 0; k <= n; k++) {
    const c = modelAtReverseStep(model, k).steps.flat().length;
    if (c > prev) fail(`part count grows at reverse step ${k}`);
    prev = c;
  }
  if (modelAtReverseStep(model, 0).steps.flat().length !== model.steps.flat().length) fail('first frame is not the whole model');
  if (modelAtReverseStep(model, n).steps.flat().length !== 0) fail('last frame is not empty');
  const removed = new Map();
  for (const st of reverseSteps(model)) for (const p of st) removed.set(p.id + '|' + p.color, (removed.get(p.id + '|' + p.color) || 0) + 1);
  for (const b of disassemblyBOM(model)) if (removed.get(b.id + '|' + b.color) !== b.qty) fail(`BOM mismatch for ${b.id} ${b.color}`);
  return { ok: true, steps: n, parts: model.steps.flat().length, sequence: 'reverse-of-build', physicallyValidated: false };
}

module.exports = { reverseSteps, modelAtReverseStep, disassemblyBOM, explodedScene, assertReverseInvariant };
