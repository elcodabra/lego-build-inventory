// Ideas: parametric models that adapt to the parts you own. Each generator builds a real model
// (steps of parts) from a Stock, picking colours and part lengths from what is available, so every
// suggestion is buildable by construction and passes the geometric check.
//
// suggest(inventory) -> what you can build right now (largest size that fits) and what is close
// (with the list of parts to add). build(idea, inventory, size) -> the model itself.
'use strict';
const core = require('./core.cjs');

// ------------------------------------------------------------------ stock

class Fail extends Error {}
const need = (x, why) => {
  if (!x) throw new Fail(why || 'not enough parts');
  return x;
};

class Stock {
  constructor(items, shopping, variant) {
    this.m = new Map();
    for (const it of items || []) {
      if (!core.drawable(it.id) || !(it.qty > 0)) continue;
      const k = it.id + '|' + it.color;
      this.m.set(k, (this.m.get(k) || 0) + it.qty);
    }
    this.shopping = !!shopping;
    // variant > 0 changes how lengths are split into parts, to escape splits that leave seams
    // lined up or corners unsupported; run() retries variants until the model holds.
    this.variant = variant || 0;
    this.missing = new Map();
  }
  n(id, color) { return this.m.get(id + '|' + color) || 0; }
  take(id, color) {
    const k = id + '|' + color;
    const v = this.m.get(k) || 0;
    if (v > 0) { this.m.set(k, v - 1); return true; }
    if (this.shopping) { this.missing.set(k, (this.missing.get(k) || 0) + 1); return true; }
    return false;
  }
  snap() { return [new Map(this.m), new Map(this.missing)]; }
  restore(s) { this.m = new Map(s[0]); this.missing = new Map(s[1]); }
  colors() { return [...new Set([...this.m.keys()].map((k) => k.split('|')[1]))]; }
  // how many parts of a kind a colour has, to order colour preferences
  amount(color, kind) {
    let n = 0;
    const ids = kind ? KIND_IDS[kind] : null;
    for (const [k, v] of this.m) {
      const [id, c] = k.split('|');
      if (c === color && (!ids || ids.has(id))) n += v;
    }
    return n;
  }
}

// Part families by kind, width (studs across) and length. The first id is the usual part,
// the rest are acceptable stand-ins of the same footprint and height.
const SIZES = {
  brick: {
    1: { 1: ['3005', '3062', '87087'], 2: ['3004', '3700'], 3: ['3622'], 4: ['3010', '3701'], 6: ['3009'], 8: ['3008'] },
    2: { 2: ['3003', '3941'], 3: ['3002'], 4: ['3001'], 6: ['2456'], 8: ['3007'] },
  },
  plate: {
    1: { 1: ['3024', '4073'], 2: ['3023'], 3: ['3623'], 4: ['3710'], 6: ['3666'], 8: ['3460'] },
    2: { 2: ['3022', '4032'], 3: ['3021'], 4: ['3020'], 6: ['3795'], 8: ['3034'] },
  },
  tile: {
    1: { 1: ['3070', '98138'], 2: ['3069'], 3: ['63864'], 4: ['2431'], 6: ['6636'] },
    2: { 2: ['3068', '14769'], 4: ['87079'] },
  },
  slope: { 2: { 1: ['3040'], 2: ['3039'] } },
};
const HEIGHT = { brick: 3, plate: 1, tile: 1, slope: 3 };
const KIND_IDS = {};
for (const [kind, byW] of Object.entries(SIZES)) {
  KIND_IDS[kind] = new Set(Object.values(byW).flatMap((byL) => Object.values(byL).flat()));
}
KIND_IDS.flat = new Set([...KIND_IDS.plate, ...KIND_IDS.tile]);

// Split length L into available parts of one colour, fewest parts first. null if impossible.
function plan(S, kind, width, color, L, ids) {
  const table = SIZES[kind] && SIZES[kind][width];
  if (!table || L <= 0) return L === 0 ? [] : null;
  const opts = [];
  for (const [len, list] of Object.entries(table)) {
    const order = ids ? [...ids.filter((i) => list.includes(i)), ...list.filter((i) => !ids.includes(i))] : list;
    for (const id of order) opts.push([Number(len), id, S.n(id, color)]);
  }
  opts.sort((a, b) => b[0] - a[0]);
  const v = S.variant;
  if (v) {
    // rotate the preference of part lengths, and cap the longest part used
    const cap = [8, 6, 4, 3, 2][v % 5];
    for (const o of opts) if (o[0] > cap && o[0] < L) o[2] = 0;
    if (v % 2) opts.reverse();
  }
  let best = null;
  const cur = [];
  const dfs = (rem, i) => {
    if (best && (v ? true : cur.length >= best.length)) return;
    if (rem === 0) { best = cur.slice(); return; }
    if (i >= opts.length) return;
    const [len, id, avail] = opts[i];
    for (let u = Math.min(Math.floor(rem / len), avail); u >= 0; u--) {
      for (let t = 0; t < u; t++) cur.push([len, id]);
      dfs(rem - u * len, i + 1);
      cur.length -= u;
    }
  };
  dfs(L, 0);
  if (best || !S.shopping) return best;
  // shopping: the ideal split with the usual parts
  const out = [];
  let rem = L;
  for (const len of Object.keys(table).map(Number).sort((a, b) => b - a)) {
    while (rem >= len) { out.push([len, (ids && ids.find((i) => table[len].includes(i))) || table[len][0]]); rem -= len; }
  }
  return rem ? null : out;
}

// One row of parts: along x (dir 'x') or y, `width` studs across, starting at (x, y, z).
function row(S, o) {
  const { kind, x, y, z, L } = o;
  const width = o.width || 1;
  const dir = o.dir || 'x';
  const place = (segs, color, w, dy) => {
    const parts = [];
    let off = 0;
    for (const [len, id] of o.reverse ? segs.slice().reverse() : segs) {
      need(S.take(id, color));
      const at = dir === 'x' ? [x + off, y + (dy || 0), z] : [x + (dy || 0), y + off, z];
      const spec = { id, color, at };
      if (kind === 'slope') { if (o.rot) spec.rot = o.rot; } else if (dir === 'y') spec.rot = 1;
      if (o.rot && kind !== 'slope') spec.rot = o.rot;
      parts.push(spec);
      off += len;
    }
    return parts;
  };
  const strict = S.shopping ? [false, true] : [false];
  for (const shop of strict) {
    const was = S.shopping;
    S.shopping = shop;
    try {
      for (const c of o.colors) {
        const segs = plan(S, kind, width, c, L, o.ids);
        if (segs) return { color: c, parts: place(segs, c, width) };
        if (width === 2 && SIZES[kind][1]) {
          const snap = S.snap();
          const a = plan(S, kind, 1, c, L, o.ids);
          if (a) {
            const pa = place(a, c, 1, 0);
            const b = plan(S, kind, 1, c, L, o.ids);
            if (b) return { color: c, parts: pa.concat(place(b, c, 1, 1)) };
          }
          S.restore(snap);
        }
      }
    } finally {
      S.shopping = was;
    }
  }
  return null;
}

// A rectangle W x D of one kind, rows `width` 2 where possible. Big plates first.
const BIG = { '6x6': ['3958', 0], '6x4': ['3032', 0], '4x6': ['3032', 1], '4x4': ['3031', 0] };
function area(S, o) {
  const { kind, x, y, z, W, D } = o;
  const dir = o.dir || 'x';
  const big = kind === 'plate' && BIG[`${W}x${D}`];
  if (big) {
    for (const c of o.colors) {
      if (S.n(big[0], c) > 0) { S.take(big[0], c); return { color: c, parts: [{ id: big[0], color: c, at: [x, y, z], ...(big[1] ? { rot: 1 } : {}) }] }; }
    }
  }
  const len = dir === 'x' ? W : D;
  const across = dir === 'x' ? D : W;
  const tryColors = (colors) => {
    const snap = S.snap();
    const parts = [];
    let used = null;
    let k = 0;
    while (k < across) {
      const width = across - k >= 2 ? 2 : 1;
      const cs = used ? [used, ...colors.filter((c) => c !== used)] : colors;
      const r = row(S, { kind, width, L: len, dir, z, x: dir === 'x' ? x : x + k, y: dir === 'x' ? y + k : y, colors: cs, reverse: o.reverse, ids: o.ids });
      if (!r) { S.restore(snap); return null; }
      used = used || r.color;
      parts.push(...r.parts);
      k += width;
    }
    return { color: used, parts };
  };
  for (const c of o.colors) {
    const r = tryColors([c]);
    if (r) return r;
  }
  return o.mix === false ? null : tryColors(o.colors);
}

// Run fn(colors) with one colour for everything, else mixed. Returns fn's result and the colour.
function oneColor(S, colors, fn, notes, what) {
  for (const c of colors) {
    const snap = S.snap();
    try { return { color: c, result: fn([c]) }; } catch (e) { if (!(e instanceof Fail)) throw e; S.restore(snap); }
  }
  const r = fn(colors);
  if (notes) notes.push(`${what}: разноцветные, одного цвета не хватило`);
  return { color: 'mix', result: r };
}

// Colour preference: preferred colours you have most of, then the rest (if any=true).
function order(S, prefs, kind, any = true) {
  const have = (c) => S.amount(c, kind);
  const pref = prefs.filter((c) => core.LEGO.COLORS[c]);
  const withStock = pref.filter((c) => have(c) > 0).sort((a, b) => have(b) - have(a));
  const rest = any ? S.colors().filter((c) => !pref.includes(c) && have(c) > 0).sort((a, b) => have(b) - have(a)) : [];
  const out = [...withStock, ...rest];
  if (S.shopping) for (const c of pref) if (!out.includes(c)) out.push(c);
  return out.length ? out : pref;
}

// Optional single part: the first (id, colour) you have, or nothing.
function optional(S, ids, colors, at, extra) {
  if (S.shopping) return null;
  for (const c of colors) for (const id of ids) if (S.n(id, c) > 0) { S.take(id, c); return { id, color: c, at, ...(extra || {}) }; }
  return null;
}

// ------------------------------------------------------------------ generators

const WALLS = ['white', 'tan', 'red', 'yellow', 'lbg', 'blue', 'azure', 'mediumBlue', 'sandGreen', 'orange', 'darkTan', 'lightNougat'];
const GROUND = ['green', 'brightGreen', 'darkGreen', 'lbg', 'tan', 'dbg'];
const GREENS = ['green', 'brightGreen', 'darkGreen', 'lime', 'sandGreen', 'olive'];

// Ring wall around W x D, one stud thick, courses alternate the corners like real brickwork.
function ringWall(S, colors, { W, D, H, z0, door, windowCourse, notes }) {
  const build = (cs) => {
    const courses = [];
    for (let c = 0; c < H; c++) {
      const z = z0 + 3 * c;
      const odd = c % 2 === 1;
      const parts = [];
      const seg = (x, y, L, dir) => { if (L > 0) parts.push(...need(row(S, { kind: 'brick', x, y, z, L, dir, colors: cs, reverse: odd })).parts); };
      const fx0 = odd ? 1 : 0;
      const fx1 = odd ? W - 1 : W;
      if (door && c < door.courses) {
        seg(fx0, 0, door.x - fx0, 'x');
        seg(door.x + door.w, 0, fx1 - door.x - door.w, 'x');
      } else if (door && c === door.courses) {
        // lintel: one run from post to post, so nothing hangs over the opening
        const l0 = Math.max(fx0, door.x - 1);
        const l1 = Math.min(fx1, door.x + door.w + 1);
        seg(fx0, 0, l0 - fx0, 'x');
        seg(l0, 0, l1 - l0, 'x');
        seg(l1, 0, fx1 - l1, 'x');
      } else seg(fx0, 0, fx1 - fx0, 'x');
      seg(fx0, D - 1, fx1 - fx0, 'x');
      const sy0 = odd ? 0 : 1;
      const sy1 = odd ? D : D - 1;
      for (const sx of [0, W - 1]) {
        if (c === windowCourse && D >= 4) {
          const g = Math.floor(D / 2);
          seg(sx, sy0, g - sy0, 'y');
          seg(sx, g + 1, sy1 - g - 1, 'y');
        } else seg(sx, sy0, sy1 - sy0, 'y');
      }
      courses.push(parts);
    }
    return courses;
  };
  return oneColor(S, colors, build, notes, 'стены');
}

const GENERATORS = {
  house: {
    title: 'Домик',
    about: 'Домик с дверью, окнами и двускатной крышей из скосов',
    sizes: [{ W: 8, D: 6, H: 3, label: '8×6' }, { W: 6, D: 4, H: 3, label: '6×4' }, { W: 4, D: 4, H: 2, label: '4×4' }],
    theta: 35,
    build(S, { W, D, H }, notes) {
      const steps = [];
      steps.push(need(area(S, { kind: 'plate', x: 0, y: 0, z: 0, W, D, colors: order(S, GROUND, 'plate') })).parts);
      const door = W >= 6 ? { x: Math.floor((W - 2) / 2), w: 2, courses: H >= 3 ? 2 : 1 } : { x: 1, w: 1, courses: 1 };
      const walls = ringWall(S, order(S, WALLS, 'brick'), { W, D, H, z0: 1, door, windowCourse: H >= 3 ? 1 : -1, notes });
      steps.push(...walls.result);
      const zTop = 1 + 3 * H;
      const roofColors = order(S, ['red', 'dbg', 'darkRed', 'brown', 'black', 'blue', 'darkBlue', 'darkGreen', 'lbg', 'orange'], 'slope');
      const snap = S.snap();
      try {
        const roof = oneColor(S, roofColors, (cs) => {
          const layers = [];
          for (let i = 0; D - 2 * i >= 4; i++) {
            const z = zTop + 3 * i;
            const parts = [];
            parts.push(...need(row(S, { kind: 'slope', width: 2, x: 0, y: i, z, L: W, colors: cs })).parts);
            parts.push(...need(row(S, { kind: 'slope', width: 2, x: 0, y: D - 2 - i, z, L: W, colors: cs, rot: 2 })).parts);
            const M = D - 4 - 2 * i;
            if (M > 0) parts.push(...need(area(S, { kind: 'brick', x: 0, y: i + 2, z, W, D: M, colors: cs })).parts);
            layers.push(parts);
          }
          return layers;
        }, notes, 'крыша');
        steps.push(...roof.result);
      } catch (e) {
        if (!(e instanceof Fail)) throw e;
        S.restore(snap);
        // two plate layers laid crosswise, so the roof locks together over the room
        const pc = order(S, ['red', 'dbg', 'black', 'brown', 'lbg'], 'plate');
        steps.push(need(area(S, { kind: 'plate', x: 0, y: 0, z: zTop, W, D, dir: 'y', colors: pc })).parts);
        steps.push(need(area(S, { kind: 'plate', x: 0, y: 0, z: zTop + 1, W, D, dir: 'x', colors: pc })).parts);
        notes.push('крыша плоская: скосов 3039/3040 не хватило');
      }
      return steps;
    },
  },
  tree: {
    title: 'Дерево',
    about: 'Дерево на полянке: ствол и пышная крона слоями',
    sizes: [{ s: 6, t: 3, label: 'большое' }, { s: 4, t: 2, label: 'маленькое' }],
    build(S, { s, t }) {
      const steps = [];
      const c = (s - 2) / 2;
      steps.push(need(area(S, { kind: 'plate', x: 0, y: 0, z: 0, W: s, D: s, colors: order(S, GREENS.concat(['tan', 'lbg']), 'plate') })).parts);
      const trunk = order(S, ['brown', 'darkBrown', 'darkTan', 'tan', 'dbg'], 'brick');
      const tr = oneColor(S, trunk, (cs) => {
        const parts = [];
        for (let k = 0; k < t; k++) parts.push(...need(row(S, { kind: 'brick', width: 2, x: c, y: c, z: 1 + 3 * k, L: 2, colors: cs })).parts);
        return parts;
      });
      steps.push(tr.result);
      const z0 = 1 + 3 * t;
      const leaves = order(S, GREENS, 'brick');
      const crown = oneColor(S, leaves, (cs) => {
        const L = [];
        L.push(need(area(S, { kind: 'brick', x: 0, y: 0, z: z0, W: s, D: s, colors: cs, dir: 'x' })).parts);
        L.push(need(area(S, { kind: 'brick', x: 0, y: 0, z: z0 + 3, W: s, D: s, colors: cs, dir: 'y' })).parts);
        L.push(need(area(S, { kind: 'brick', x: 1, y: 1, z: z0 + 6, W: s - 2, D: s - 2, colors: cs, dir: 'x' })).parts);
        if (s === 6) L.push(need(area(S, { kind: 'brick', x: 2, y: 2, z: z0 + 9, W: 2, D: 2, colors: cs })).parts);
        return L;
      });
      steps.push(...crown.result);
      return steps;
    },
  },
  mushroom: {
    title: 'Грибок',
    about: 'Мухомор: ножка и шляпка в крапинку',
    sizes: [{ cap: 6, h: 2, label: 'большой' }, { cap: 4, h: 2, label: 'маленький' }],
    build(S, { cap, h }) {
      const steps = [];
      const c = (cap - 2) / 2;
      const stem = oneColor(S, order(S, ['white', 'tan', 'lightNougat', 'lbg', 'bly'], 'brick'), (cs) => {
        const parts = [];
        for (let k = 0; k < h; k++) parts.push(...need(row(S, { kind: 'brick', width: 2, x: c, y: c, z: 3 * k, L: 2, colors: cs })).parts);
        return parts;
      });
      steps.push(stem.result);
      const z = 3 * h;
      const capColors = order(S, ['red', 'darkRed', 'orange', 'brown', 'coral', 'magenta', 'blue'], 'brick');
      const capR = oneColor(S, capColors, (cs) => [
        need(area(S, { kind: 'plate', x: 0, y: 0, z, W: cap, D: cap, colors: cs, dir: 'x' })).parts,
        need(area(S, { kind: 'brick', x: 0, y: 0, z: z + 1, W: cap, D: cap, colors: cs, dir: 'y' })).parts,
        need(area(S, { kind: 'brick', x: 1, y: 1, z: z + 4, W: cap - 2, D: cap - 2, colors: cs, dir: 'x' })).parts,
      ]);
      steps.push(...capR.result);
      const spots = [];
      const ring = cap === 6 ? [[0, 1], [5, 4], [1, 5], [4, 0], [0, 4]] : [[0, 0], [3, 3], [3, 0]];
      const top = cap === 6 ? [[2, 2], [3, 3]] : [[1, 2]];
      for (const [x, y] of ring) { const p = optional(S, ['4073', '98138', '3024', '3070'], ['white', 'bly', 'yellow'], [x, y, z + 4]); if (p) spots.push(p); }
      for (const [x, y] of top) { const p = optional(S, ['4073', '98138', '3024', '3070'], ['white', 'bly', 'yellow'], [x, y, z + 7]); if (p) spots.push(p); }
      if (spots.length) steps.push(spots);
      return steps;
    },
  },
  rocket: {
    title: 'Ракета',
    about: 'Ракета на старте: круглый корпус, стабилизаторы, острый нос',
    sizes: [{ h: 5, label: 'высокая' }, { h: 3, label: 'короткая' }],
    theta: 40,
    build(S, { h }, notes) {
      const steps = [];
      const finColors = order(S, ['red', 'dbg', 'black', 'blue', 'orange', 'lbg'], 'slope');
      const fins = oneColor(S, finColors, (cs) => {
        const out = [];
        for (const [x, y, rot] of [[1, -1, 0], [2, 3, 2], [-1, 2, 3], [3, 1, 1]]) {
          const c = cs.find((cc) => S.n('3040', cc) > 0) || (S.shopping ? cs[0] : null);
          need(c && S.take('3040', c));
          out.push({ id: '3040', color: c, at: [x, y, 0], ...(rot ? { rot } : {}) });
        }
        return out;
      });
      const body = order(S, ['white', 'lbg', 'bly', 'yellow', 'azure'], 'brick');
      const bodyR = oneColor(S, body, (cs) => {
        const parts = [];
        for (let k = 0; k < h; k++) parts.push(...need(row(S, { kind: 'brick', width: 2, x: 1, y: 1, z: 3 * k, L: 2, colors: cs, ids: ['3941'] })).parts);
        return parts;
      }, notes, 'корпус');
      steps.push(bodyR.result.slice(0, 1), fins.result, bodyR.result.slice(1));
      const z = 3 * h;
      const nose = ['red', 'dbg', 'black', 'blue', 'orange', 'white', 'lbg'];
      let top = null;
      for (const c of order(S, nose, 'slope')) {
        if (S.n('3044c', c) >= 2) { S.take('3044c', c); S.take('3044c', c); top = [{ id: '3044c', color: c, at: [1, 1, z] }, { id: '3044c', color: c, at: [2, 1, z] }]; break; }
      }
      if (!top) for (const c of order(S, nose, 'slope')) if (S.n('3039', c) > 0) { S.take('3039', c); top = [{ id: '3039', color: c, at: [1, 1, z] }]; break; }
      if (!top && S.shopping) { S.take('3044c', 'red'); S.take('3044c', 'red'); top = [{ id: '3044c', color: 'red', at: [1, 1, z] }, { id: '3044c', color: 'red', at: [2, 1, z] }]; }
      if (!top) {
        const r = row(S, { kind: 'plate', width: 2, x: 1, y: 1, z, L: 2, colors: order(S, nose, 'plate'), ids: ['4032'] });
        if (r) { top = r.parts; notes.push('нос плоский: двойных скосов 3044 не нашлось'); }
      }
      steps.push(need(top));
      return steps;
    },
  },
  robot: {
    title: 'Робот',
    about: 'Робот на двух ногах с руками и антенной, глаза на боковых шипах если есть 87087',
    sizes: [{ label: 'стандарт' }],
    theta: 40,
    build(S, _p, notes) {
      const steps = [];
      const dark = order(S, ['dbg', 'black', 'lbg', 'blue'], 'brick');
      const legs = oneColor(S, dark, (cs) => {
        const parts = [];
        for (const k of [0, 1]) for (const x of [0, 3]) parts.push(...need(row(S, { kind: 'brick', x, y: 0, z: 3 * k, L: 2, dir: 'y', colors: cs })).parts);
        return parts;
      });
      steps.push(legs.result);
      steps.push(need(row(S, { kind: 'plate', width: 2, x: 0, y: 0, z: 6, L: 4, colors: order(S, ['dbg', 'black', 'lbg'], 'plate') })).parts);
      const main = order(S, ['lbg', 'white', 'blue', 'red', 'yellow', 'orange', 'azure', 'dbg'], 'brick');
      const torso = oneColor(S, main, (cs) => [7, 10].flatMap((z, i) => need(row(S, { kind: 'brick', width: 2, x: 0, y: 0, z, L: 4, colors: cs, reverse: i === 1 })).parts), notes, 'корпус');
      steps.push(torso.result);
      const arms = oneColor(S, [torso.color !== 'mix' ? torso.color : main[0], ...main, ...dark].filter((c, i, a) => a.indexOf(c) === i), (cs) => [-1, 4].flatMap((x) => need(row(S, { kind: 'brick', x, y: 0, z: 10, L: 2, dir: 'y', colors: cs })).parts));
      // shoulders: one plate across the whole top ties both arms to the torso; else a 2x2 per
      // shoulder, which must be a single part spanning the arm/torso seam
      const sc = order(S, ['dbg', 'black', 'lbg', 'blue'], 'plate');
      let shoulders = null;
      for (const c of sc) {
        const segs = plan(S, 'plate', 2, c, 6);
        if (segs && segs.length === 1) { shoulders = need(row(S, { kind: 'plate', width: 2, x: -1, y: 0, z: 13, L: 6, colors: [c] })).parts; break; }
      }
      if (!shoulders) {
        const one = (x) => {
          for (const c of sc) for (const id of ['3022', '4032']) if (S.n(id, c) > 0 || S.shopping) { S.take(id, c); return { id, color: c, at: [x, 0, 13] }; }
          return need(null, 'нужны пластины 2×2 на плечи');
        };
        const mid = row(S, { kind: 'plate', width: 2, x: 1, y: 0, z: 13, L: 2, colors: sc });
        shoulders = [one(-1), ...need(mid).parts, one(3)];
      }
      steps.push([...arms.result, ...shoulders]);
      const headColors = order(S, ['lbg', 'white', 'yellow', 'dbg', 'azure'], 'brick');
      let head = null;
      let face = [];
      for (const c of headColors) {
        if (S.n('87087', c) >= 2 && !S.shopping) {
          const snap = S.snap();
          S.take('87087', c); S.take('87087', c);
          const back = row(S, { kind: 'brick', x: 1, y: 1, z: 14, L: 2, colors: [c, ...headColors] });
          const eyes = [];
          for (const x of [1, 2]) { const e = optional(S, ['98138', '4073', '3070', '3024'], ['black', 'azure', 'darkAzure', 'blue', 'red', 'yellow', 'bly', 'white'], [x, -0.4, 14.5], { up: '-y', from: [0, -3, 0] }); if (e) eyes.push(e); }
          if (back && eyes.length === 2) { head = [{ id: '87087', color: c, at: [1, 0, 14] }, { id: '87087', color: c, at: [2, 0, 14] }, ...back.parts]; face = eyes; break; }
          S.restore(snap);
        }
      }
      if (!head) {
        head = need(row(S, { kind: 'brick', width: 2, x: 1, y: 0, z: 14, L: 2, colors: headColors })).parts;
        notes.push('глаза не поставить: нужны 2 кирпича 87087 и 2 круглые плитки 1×1');
      }
      steps.push(head);
      const topParts = [];
      const cap = row(S, { kind: 'tile', width: 2, x: 1, y: 0, z: 17, L: 2, colors: order(S, ['dbg', 'lbg', 'black', 'white'], 'tile') })
        || row(S, { kind: 'plate', width: 2, x: 1, y: 0, z: 17, L: 2, colors: order(S, ['dbg', 'lbg', 'black', 'white'], 'plate') });
      if (cap) {
        topParts.push(...cap.parts);
        if (!cap.parts.some((p) => p.id === '3068' || p.id === '14769')) {
          const ant = optional(S, ['3062', '3005'], ['lbg', 'dbg', 'black', 'white', 'red'], [1, 0, 18]);
          if (ant) { topParts.push(ant); const tip = optional(S, ['4073', '98138', '3024'], ['red', 'yellow', 'azure', 'bly', 'lime'], [1, 0, 21]); if (tip) topParts.push(tip); }
        }
      }
      if (topParts.length) steps.push(topParts);
      if (face.length) steps.push(face);
      return steps;
    },
  },
  tower: {
    title: 'Башня',
    about: 'Крепостная башня с воротами, бойницами и зубцами',
    sizes: [{ s: 6, H: 5, label: '6×6' }, { s: 4, H: 4, label: '4×4' }, { s: 4, H: 2, label: 'низкая' }],
    theta: 35,
    build(S, { s, H }, notes) {
      const steps = [];
      steps.push(need(area(S, { kind: 'plate', x: 0, y: 0, z: 0, W: s, D: s, colors: order(S, ['dbg', 'green', 'lbg', 'tan', 'darkTan'], 'plate') })).parts);
      const stone = order(S, ['lbg', 'dbg', 'tan', 'darkTan', 'white', 'sandGreen'], 'brick');
      const door = s >= 6 ? { x: 2, w: 2, courses: 2 } : null;
      // arrow slit one course below the top, so every merlon sits on wall
      const walls = ringWall(S, stone, { W: s, D: s, H, z0: 1, door, windowCourse: H >= 4 ? H - 2 : -1, notes });
      steps.push(...walls.result);
      const z = 1 + 3 * H;
      const cs = walls.color !== 'mix' ? [walls.color, ...stone] : stone;
      const merlons = [];
      const spots = [];
      for (let x = 0; x < s; x++) for (let y = 0; y < s; y++) {
        const edge = x === 0 || y === 0 || x === s - 1 || y === s - 1;
        if (edge && (x + y) % 2 === 0) spots.push([x, y]);
      }
      for (const [x, y] of spots) {
        let p = null;
        for (const c of cs) for (const id of ['3005', '3062']) if (!p && S.n(id, c) > 0) { S.take(id, c); p = { id, color: c, at: [x, y, z] }; }
        if (!p && S.shopping) { S.take('3005', cs[0]); p = { id: '3005', color: cs[0], at: [x, y, z] }; }
        if (p) merlons.push(p);
      }
      need(merlons.length >= 4, 'нужно хотя бы 4 кирпича 1×1 на зубцы');
      if (merlons.length < spots.length) notes.push(`зубцов ${merlons.length} из ${spots.length}`);
      steps.push(merlons);
      return steps;
    },
  },
  heart: {
    title: 'Сердечко',
    about: 'Плоская картинка-сердечко на пластине, пиксель-арт из пластин или плиток',
    sizes: [{ label: '7×6' }],
    theta: 30,
    phi: 50,
    build(S, _p, notes) {
      const PIC = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
      const steps = [];
      const bg = order(S, ['white', 'lbg', 'black', 'tan', 'dbg', 'azure'], 'plate');
      steps.push(need(area(S, { kind: 'plate', x: 0, y: 0, z: 0, W: 7, D: 6, colors: bg })).parts);
      const reds = ['red', 'pink', 'darkPink', 'coral', 'magenta', 'darkRed'];
      const fill = (cs, kind) => {
        const parts = [];
        PIC.forEach((line, r) => {
          const y = PIC.length - 1 - r;
          for (const m of line.matchAll(/X+/g)) parts.push(...need(row(S, { kind, x: m.index, y, z: 1, L: m[0].length, colors: cs })).parts);
        });
        return parts;
      };
      let res = null;
      for (const kind of ['tile', 'plate']) {
        const snap = S.snap();
        try { res = oneColor(S, order(S, reds, kind, false), (cs) => fill(cs, kind)); break; } catch (e) { if (!(e instanceof Fail)) throw e; S.restore(snap); }
      }
      if (!res) res = oneColor(S, order(S, reds, 'flat'), (cs) => { try { return fill(cs, 'plate'); } catch (e) { return fill(cs, 'tile'); } }, notes, 'сердце');
      steps.push(res.result);
      return steps;
    },
  },
  pyramid: {
    title: 'Пирамида',
    about: 'Ступенчатая пирамида-зиккурат, съест почти любые кирпичи',
    sizes: [{ s: 8, label: '8×8' }, { s: 6, label: '6×6' }, { s: 4, label: '4×4' }],
    build(S, { s }) {
      const steps = [];
      const all = order(S, ['tan', 'darkTan', 'yellow', 'lbg', 'dbg', 'white', 'red', 'blue'], 'brick');
      for (let k = 0, n = s; n >= 2; k++, n -= 2) {
        steps.push(need(area(S, { kind: 'brick', x: k, y: k, z: 3 * k, W: n, D: n, colors: all.slice().sort((a, b) => S.amount(b, 'brick') - S.amount(a, 'brick')), dir: k % 2 ? 'y' : 'x' })).parts);
      }
      return steps;
    },
  },
};

// ------------------------------------------------------------------ public API

function chunk(steps) {
  const out = [];
  for (const st of steps) {
    if (!st || !st.length) continue;
    for (let i = 0; i < st.length; i += 12) out.push(st.slice(i, i + 12));
  }
  return out;
}

function run(id, items, size, shopping) {
  const g = GENERATORS[id];
  if (!g) throw new Error(`unknown idea "${id}", known: ${Object.keys(GENERATORS).join(', ')}`);
  const params = typeof size === 'number' ? g.sizes[size] : (g.sizes.find((s) => s.label === size) || g.sizes[0]);
  let last = null;
  for (let variant = 0; variant < 8; variant++) {
    const S = new Stock(items, shopping, variant);
    const notes = [];
    try {
      const steps = chunk(g.build(S, params, notes));
      const model = { name: id + (g.sizes.length > 1 ? '-' + g.sizes.indexOf(params) : ''), title: g.title, theta: g.theta || 40, phi: g.phi || 30, steps };
      // never hand out a model that does not hold together
      const geo = core.checkGeometry(core.validateModel(JSON.parse(JSON.stringify(model)), model.name));
      if (geo.problems.length) throw new Fail('geometry: ' + geo.problems[0].message.trim());
      const missing = [...S.missing].map(([k, qty]) => {
        const [pid, color] = k.split('|');
        return { id: pid, color, qty, name: core.LEGO.LIB[pid].ru };
      });
      return { ok: true, model, notes, missing, size: params.label };
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      last = e.message;
      // plain shortage does not depend on the split: no point in retrying
      if (!/geometry/.test(e.message) && variant === 0) break;
    }
  }
  return { ok: false, reason: last, size: params.label };
}

// What you can build now (largest size per idea) and what is close.
function suggest(inv, opts) {
  const o = opts || {};
  const items = inv.items || inv;
  const have = items.filter((x) => core.drawable(x.id)).reduce((a, x) => a + x.qty, 0);
  const buildable = [];
  const almost = [];
  for (const [id, g] of Object.entries(GENERATORS)) {
    let done = null;
    for (let i = 0; i < g.sizes.length && !done; i++) {
      const r = run(id, items, i, false);
      if (r.ok) {
        const parts = r.model.steps.flat().length;
        const colors = [...new Set(r.model.steps.flat().map((p) => p.color))];
        done = { idea: id, title: g.title, about: g.about, size: r.size, sizeIndex: i, parts, steps: r.model.steps.length, colors, notes: r.notes, usesPercent: have ? Math.round((100 * parts) / have) : 0 };
      }
    }
    if (done) { buildable.push(done); continue; }
    const small = g.sizes.length - 1;
    const r = run(id, items, small, true);
    if (r.ok) {
      const short = r.missing.reduce((a, x) => a + x.qty, 0);
      almost.push({ idea: id, title: g.title, about: g.about, size: r.size, sizeIndex: small, missingParts: short, missing: r.missing });
    }
  }
  buildable.sort((a, b) => b.parts - a.parts);
  almost.sort((a, b) => a.missingParts - b.missingParts);
  return { drawableParts: have, buildable, almost: almost.slice(0, o.almost || 5) };
}

function build(id, inv, size, opts) {
  const items = inv.items || inv;
  const g = GENERATORS[id];
  if (!g) throw new Error(`unknown idea "${id}", known: ${Object.keys(GENERATORS).join(', ')}`);
  let idx = size == null ? null : typeof size === 'number' ? size : g.sizes.findIndex((s) => s.label === size);
  if (idx == null || idx < 0) {
    idx = g.sizes.findIndex((_, i) => run(id, items, i, false).ok);
    if (idx < 0) idx = g.sizes.length - 1;
  }
  const r = run(id, items, idx, !!(opts && opts.shopping) || !run(id, items, idx, false).ok);
  if (!r.ok) throw new Error(`cannot build ${id}: ${r.reason}`);
  return r;
}

const list = () => Object.entries(GENERATORS).map(([id, g]) => ({ idea: id, title: g.title, about: g.about, sizes: g.sizes.map((s) => s.label) }));

module.exports = { suggest, build, list, GENERATORS, Stock };
