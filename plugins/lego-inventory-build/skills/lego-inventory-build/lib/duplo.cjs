// DUPLO ideas: parametric models for toddlers' bricks, the same contract as lib/ideas.cjs
// generators (build(S, params, notes) -> steps), registered into ideas.GENERATORS with `duplo: true`.
//
// Units: the engine draws DUPLO at real scale, twice LEGO in every direction. A generator works in
// DUPLO studs and DUPLO bricks and converts on output: x, y * 2 (LEGO studs), z * 6 (plates).
// Every model is checked by core.checkGeometry like any other idea (no overlaps, nothing floats,
// DUPLO grid, no LEGO mixed in).
'use strict';

const U = 2; // LEGO units per DUPLO stud
const ZB = 6; // plates per DUPLO brick
const ZP = 3; // plates per DUPLO plate (half a brick)

// brick rows 2 studs wide, by length: the usual part first
const BRICK2 = { 8: ['4199'], 6: ['2300'], 4: ['3011'], 2: ['3437'] };
// 1-wide tall bricks (1x2x2), used for thin walls two bricks high
const PLATE2 = { 8: ['44524'], 6: ['98233'], 4: ['40666'] };
const BIG_PLATE = { '8x4': ['4672', 0], '4x8': ['4672', 1], '6x4': ['25549', 0], '4x6': ['25549', 1], '4x4': ['14721', 0] };

const WALLS = ['red', 'yellow', 'blue', 'white', 'green', 'brightGreen', 'orange', 'azure', 'pink', 'lime', 'tan', 'mediumBlue'];
const ROOF = ['red', 'blue', 'darkBlue', 'orange', 'green', 'brown', 'dbg', 'yellow'];
const GROUND = ['brightGreen', 'green', 'lime', 'lbg', 'tan', 'blue'];

module.exports = function register(GENERATORS, { need, Fail, order, oneColor }) {
  const put = (id, color, x, y, z, rot) => ({ id, color, at: [x * U, y * U, z], ...(rot ? { rot } : {}) });

  // Split L studs into 2-wide parts of one colour from `table`, fewest parts first.
  function split(S, table, color, L) {
    const lens = Object.keys(table).map(Number).sort((a, b) => b - a);
    let best = null;
    const cur = [];
    const dfs = (rem, i) => {
      if (best && cur.length >= best.length) return;
      if (rem === 0) { best = cur.slice(); return; }
      if (i >= lens.length) return;
      const len = lens[i];
      const id = table[len].find((x) => S.n(x, color) > 0) || table[len][0];
      const avail = S.shopping ? 99 : S.n(id, color);
      for (let u = Math.min(Math.floor(rem / len), avail); u >= 0; u--) {
        for (let t = 0; t < u; t++) cur.push([len, id]);
        dfs(rem - u * len, i + 1);
        cur.length -= u;
      }
    };
    dfs(L, 0);
    return best;
  }
  // a run of 2-wide parts along x or y, starting at (x, y) in DUPLO studs, z in plates
  function run2(S, table, colors, { x, y, z, L, dir, maxParts }) {
    for (const c of colors) {
      const segs = split(S, table, c, L);
      if (!segs || (maxParts && segs.length > maxParts)) continue;
      const parts = [];
      let off = 0;
      for (const [len, id] of segs) {
        need(S.take(id, c));
        parts.push(dir === 'y' ? put(id, c, x, y + off, z, 1) : put(id, c, x + off, y, z));
        off += len;
      }
      return { color: c, parts };
    }
    throw new Fail(`нужны DUPLO-кирпичи на ряд ${L}`);
  }
  // a base W x D (DUPLO studs) of plates or, without plates, nothing (the model stands on the table)
  function base(S, W, D, notes) {
    const colors = order(S, GROUND, null);
    const big = BIG_PLATE[`${W}x${D}`];
    if (big) for (const c of colors) if (S.n(big[0], c) > 0) { S.take(big[0], c); return [put(big[0], c, 0, 0, 0, big[1])]; }
    // 2-wide plate strips across the depth
    const snap = S.snap();
    try {
      const parts = [];
      for (let y = 0; y < D; y += 2) parts.push(...run2(S, PLATE2, colors, { x: 0, y, z: 0, L: W, dir: 'x' }).parts);
      return parts;
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      S.restore(snap);
      notes.push('без опорной пластины');
      return null;
    }
  }

  // Ring wall W x D, 2 studs thick, `H` bricks high, corners alternate so the courses lock.
  // A door gap of 2 studs in the front wall for `doorH` courses.
  function ring(S, colors, { W, D, H, z0, doorH }) {
    const courses = [];
    for (let c = 0; c < H; c++) {
      const z = z0 + ZB * c;
      const odd = c % 2 === 1;
      const parts = [];
      const runs = [];
      // front and back walls take the corners on even courses, the side walls on odd ones
      const fx0 = odd ? 2 : 0;
      const fx1 = odd ? W - 2 : W;
      const door = doorH && c < doorH ? Math.floor((W - 2) / 4) * 2 : -1;
      if (door >= 0) { runs.push({ x: fx0, y: 0, L: door - fx0, dir: 'x' }, { x: door + 2, y: 0, L: fx1 - door - 2, dir: 'x' }); }
      else runs.push({ x: fx0, y: 0, L: fx1 - fx0, dir: 'x' });
      runs.push({ x: fx0, y: D - 2, L: fx1 - fx0, dir: 'x' });
      const sy0 = odd ? 0 : 2;
      const sy1 = odd ? D : D - 2;
      for (const sx of [0, W - 2]) runs.push({ x: sx, y: sy0, L: sy1 - sy0, dir: 'y' });
      for (const r of runs) if (r.L > 0) parts.push(...run2(S, BRICK2, colors, { ...r, z }).parts);
      courses.push(parts);
    }
    return courses;
  }
  // a roof of 45 degree slopes (6474) along the front and back rows, bricks between, as in ideas.house
  function roof(S, { W, D, z }) {
    const cs = order(S, ROOF, null);
    for (const c of cs) {
      const snap = S.snap();
      try {
        const parts = [];
        for (let x = 0; x < W; x += 2) {
          need(S.take('6474', c));
          parts.push(put('6474', c, x, 0, z));
          need(S.take('6474', c));
          parts.push(put('6474', c, x, D - 2, z, 2));
        }
        // the middle row spans the room: at most 2 parts, so each one rests on a side wall
        if (D > 4) parts.push(...run2(S, BRICK2, [c, ...cs], { x: 0, y: 2, z, L: W, dir: 'x', maxParts: 2 }).parts);
        return parts;
      } catch (e) { if (!(e instanceof Fail)) throw e; S.restore(snap); }
    }
    return null;
  }

  Object.assign(GENERATORS, {
    duploHouse: {
      duplo: true,
      title: 'DUPLO домик',
      about: 'Большой домик из DUPLO с дверью и крышей из скосов',
      sizes: [{ W: 8, D: 6, H: 3, label: '8×6' }, { W: 6, D: 4, H: 2, label: '6×4' }, { W: 4, D: 4, H: 2, label: '4×4' }],
      theta: 35,
      build(S, { W, D, H }, notes) {
        const steps = [];
        const b = base(S, W, D, notes);
        const z0 = b ? ZP : 0;
        if (b) steps.push(b);
        // a door needs a full-width front course above it to rest on: only on 8-wide houses
        const walls = oneColor(S, order(S, WALLS, null), (cs) => ring(S, cs, { W, D, H, z0, doorH: W >= 8 ? Math.min(2, H - 1) : 0 }), notes, 'стены');
        steps.push(...walls.result);
        const top = z0 + ZB * H;
        const r = roof(S, { W, D, z: top });
        if (r) steps.push(r);
        else notes.push('без крыши: не хватило DUPLO-скосов 6474');
        return steps;
      },
    },
    duploTower: {
      duplo: true,
      title: 'DUPLO башня',
      about: 'Высокая разноцветная башня из DUPLO, кирпичи внахлёст',
      sizes: [{ H: 8, label: '8 этажей' }, { H: 5, label: '5 этажей' }, { H: 3, label: '3 этажа' }],
      theta: 40,
      build(S, { H }) {
        // a 4x2 column: even courses one 2x4 along x, odd courses two 2x2 side by side, so every
        // course bridges the seam of the one below
        const steps = [];
        const cs = order(S, WALLS, null);
        let ci = 0;
        for (let c = 0; c < H; c++) {
          const z = ZB * c;
          const pick = (id, n) => { for (let k = 0; k < cs.length; k++) { const col = cs[(ci + k) % cs.length]; if (S.n(id, col) >= n || S.shopping) { ci = (ci + k + 1) % cs.length; return col; } } return null; };
          if (c % 2 === 0) {
            const col = need(pick('3011', 1), 'нужны DUPLO 2×4');
            S.take('3011', col);
            steps.push([put('3011', col, 0, 0, z)]);
          } else {
            const col = need(pick('3437', 2), 'нужны DUPLO 2×2');
            S.take('3437', col); S.take('3437', col);
            steps.push([put('3437', col, 0, 0, z), put('3437', col, 2, 0, z)]);
          }
        }
        return steps;
      },
    },
    duploPyramid: {
      duplo: true,
      title: 'DUPLO пирамида',
      about: 'Ступенчатая пирамида из DUPLO-кирпичей, съест почти любые',
      sizes: [{ s: 8, label: '8×8' }, { s: 6, label: '6×6' }, { s: 4, label: '4×4' }],
      build(S, { s }) {
        // each layer is one DUPLO stud smaller on every side, rows turn 90 degrees per layer
        const steps = [];
        for (let i = 0, n = s; n >= 2; i++, n -= 2) {
          const layer = [];
          const cs = order(S, WALLS, null).sort((a, b) => S.amount(b) - S.amount(a));
          const dir = i % 2 ? 'y' : 'x';
          for (let r = 0; r < n; r += 2) layer.push(...run2(S, BRICK2, cs, dir === 'x' ? { x: i, y: i + r, L: n, dir, z: ZB * i } : { x: i + r, y: i, L: n, dir, z: ZB * i }).parts);
          steps.push(layer);
        }
        return steps;
      },
    },
  });
};
