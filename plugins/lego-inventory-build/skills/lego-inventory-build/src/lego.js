/*
 * lego.js
 * LEGO parts drawn in plain Canvas 2D, in the look of a building-instruction booklet:
 * light from the upper left, thin dark edges, paler parts from earlier steps and a
 * yellow outline around the parts being added.
 *
 * Pure and deterministic: a frame depends only on its inputs, nothing is random and
 * nothing is kept between calls, so it drops into the procedural-film pipeline as is.
 *
 * Units: 1 = one stud pitch (8 mm). Part heights and the z of `at` count plates
 * (1 plate = 0.4, 1 brick = 3 plates = 1.2). x runs right, y away from the viewer, z up.
 *
 *   const part = LEGO.place({ id: '3001', color: 'red', at: [0, 0, 0] });
 *   const cam = LEGO.camera({ theta: 45, phi: 30, scale: 80, cx: 540, cy: 960, target: [2, 1, 0.6] });
 *   LEGO.draw(ctx, [{ part }], cam);
 *
 * An item passed to draw() can also carry move [dx, dy, dz] (world units, for animation),
 * pale 0..1 (earlier steps), halo 0..1 (yellow outline) and alpha 0..1.
 */
(function (root) {
  'use strict';

  const LEGO = (root.LEGO = root.LEGO || {});

  const PLATE = 0.4;
  const STUD_R = 0.3;
  const STUD_H = 0.2;
  const EPS = 1e-4;
  const PI = Math.PI;
  const HALO = '#FFD21A';
  const ZERO = [0, 0, 0];

  LEGO.PLATE = PLATE;

  // ------------------------------------------------------------------ vectors

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const madd = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  const mulMV = (M, v) => [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
  const mulMM = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));

  // ------------------------------------------------------------------ colours

  // Close to the LDraw / Rebrickable values; black is lifted a little so its edges read on paper.
  const PALETTE = {
    white: ['#FFFFFF', 'White', 'Белый'],
    black: ['#2E363D', 'Black', 'Черный'],
    lbg: ['#A3A8AC', 'Light Bluish Gray', 'Светло-серый'],
    dbg: ['#686A66', 'Dark Bluish Gray', 'Темно-серый'],
    orange: ['#E8791A', 'Orange', 'Оранжевый'],
    darkOrange: ['#A95500', 'Dark Orange', 'Темно-оранжевый'],
    blo: ['#FBAC16', 'Bright Light Orange', 'Светло-оранжевый'],
    pink: ['#EF9EBB', 'Bright Pink', 'Розовый'],
    red: ['#C8200E', 'Red', 'Красный'],
    blue: ['#0B5CC2', 'Blue', 'Синий'],
    yellow: ['#F6CC2E', 'Yellow', 'Желтый'],
    green: ['#1F8A4C', 'Green', 'Зеленый'],
    tan: ['#E2CB9A', 'Tan', 'Бежевый'],
    brown: ['#6A3A1F', 'Reddish Brown', 'Коричневый'],
    azure: ['#35AFC2', 'Medium Azure', 'Лазурный'],
    lime: ['#B4DA1F', 'Lime', 'Лаймовый'],
    darkRed: ['#720E0F', 'Dark Red', 'Темно-красный'],
    darkBlue: ['#0A3463', 'Dark Blue', 'Темно-синий'],
    darkGreen: ['#184632', 'Dark Green', 'Темно-зеленый'],
    darkTan: ['#958A73', 'Dark Tan', 'Темно-бежевый'],
    mediumBlue: ['#5A93DB', 'Medium Blue', 'Голубой'],
    bly: ['#FFF03A', 'Bright Light Yellow', 'Светло-желтый'],
    brightGreen: ['#4B9F4A', 'Bright Green', 'Ярко-зеленый'],
    sandGreen: ['#A0BCAC', 'Sand Green', 'Серо-зеленый'],
    lavender: ['#AC78BA', 'Medium Lavender', 'Лавандовый'],
    magenta: ['#923978', 'Magenta', 'Пурпурный'],
    darkPink: ['#C870A0', 'Dark Pink', 'Темно-розовый'],
    nougat: ['#D09168', 'Nougat', 'Нуга'],
    mediumNougat: ['#AA7D55', 'Medium Nougat', 'Средняя нуга'],
    lightNougat: ['#F6D7B3', 'Light Nougat', 'Светлая нуга'],
    darkBrown: ['#352100', 'Dark Brown', 'Темно-коричневый'],
    coral: ['#FF698F', 'Coral', 'Коралловый'],
    darkAzure: ['#078BC9', 'Dark Azure', 'Темно-лазурный'],
    olive: ['#9B9A5A', 'Olive Green', 'Оливковый'],
  };
  // Catalogue ids, so inventories exported from BrickLink (bl) or Rebrickable (rb) map onto the palette.
  const IDS = {
    white: [1, 15], black: [11, 0], lbg: [86, 71], dbg: [85, 72], orange: [4, 25], darkOrange: [68, 484],
    blo: [110, 191], pink: [104, 29], red: [5, 4], blue: [7, 1], yellow: [3, 14], green: [6, 2], tan: [2, 19],
    brown: [88, 70], azure: [156, 322], lime: [34, 27], darkRed: [59, 320], darkBlue: [63, 272],
    darkGreen: [80, 288], darkTan: [69, 28], mediumBlue: [42, 73], bly: [103, 226], brightGreen: [36, 10],
    sandGreen: [48, 378], lavender: [157, 324], magenta: [71, 26], darkPink: [47, 5], nougat: [28, 92],
    mediumNougat: [150, 84], lightNougat: [90, 78], darkBrown: [120, 308], coral: [220, 1050],
    darkAzure: [153, 321], olive: [155, 326],
  };
  const COLORS = (LEGO.COLORS = {});
  for (const k of Object.keys(PALETTE)) {
    const [hex, name, ru] = PALETTE[k];
    const n = parseInt(hex.slice(1), 16);
    const [bl, rb] = IDS[k] || [];
    COLORS[k] = { key: k, hex, name, ru, bl, rb, rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255] };
  }

  const AMB = 0.7;
  const DIF = 0.3;
  const lightOf = (cam, n) => {
    const d = n[0] * cam.L[0] + n[1] * cam.L[1] + n[2] * cam.L[2];
    return AMB + DIF * (d > 0 ? d : 0);
  };
  const byte = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  const css = (r, g, b) => 'rgb(' + byte(r) + ',' + byte(g) + ',' + byte(b) + ')';

  function tone(rgb, b, pale) {
    let r = rgb[0] * b;
    let g = rgb[1] * b;
    let u = rgb[2] * b;
    if (pale) {
      r += (255 - r) * pale;
      g += (255 - g) * pale;
      u += (255 - u) * pale;
    }
    return css(r, g, u);
  }

  // Dark lines on light parts, lighter lines on dark parts, all fading with `pale`.
  function edgeTone(rgb, pale) {
    const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    let e = lum < 0.3 ? rgb.map((c) => c + (255 - c) * 0.42) : rgb.map((c) => c * 0.22 + 26);
    if (pale) e = e.map((c) => c + (255 - c) * pale * 0.62);
    return css(e[0], e[1], e[2]);
  }

  // ------------------------------------------------------------------ parts

  const LIB = (LEGO.LIB = {});
  // Part ids in the order they are defined, family by family (object keys would sort numbers first).
  const ORDER = (LEGO.ORDER = []);
  const reg = (def) => {
    LIB[def.id] = def;
    ORDER.push(def.id);
    return def;
  };

  function grid(w, d, z) {
    const s = [];
    for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) s.push([i + 0.5, j + 0.5, z]);
    return s;
  }

  function holesToDiscs(def) {
    def.discs = [];
    for (const [x, z] of def.holes || []) {
      def.discs.push({ c: [x, 0, z], n: [0, -1, 0], r: 0.3, kind: 'hole' });
      def.discs.push({ c: [x, def.d, z], n: [0, 1, 0], r: 0.3, kind: 'hole' });
    }
    return def;
  }

  // Box-like parts: a profile in the (y, z) plane pushed along x (w along x, d along y).
  function box(id, ru, w, d, plates, studs, extra) {
    const h = plates * PLATE;
    reg(holesToDiscs(
      Object.assign(
        { id, ru, kind: 'ext', w, d, h, profile: [[0, 0], [d, 0], [d, h], [0, h]], studs: studs ? grid(w, d, h) : [] },
        extra || {}
      )
    ));
  }

  // 45 degree slope, low side toward -y, one row of studs at the back.
  function slope(id, ru, w) {
    const h = 3 * PLATE;
    const studs = [];
    for (let i = 0; i < w; i++) studs.push([i + 0.5, 1.5, h]);
    reg(holesToDiscs({ id, ru, kind: 'ext', w, d: 2, h, profile: [[0, 0], [2, 0], [2, h], [1, h], [0, 0.2]], studs }));
  }

  // Double 45 degree slope: a roof ridge along x, the triangle shows on the end caps.
  function ridge(id, ru) {
    const h = 3 * PLATE;
    reg(holesToDiscs({ id, ru, kind: 'ext', w: 1, d: 2, h, profile: [[0, 0], [2, 0], [2, 0.2], [1, h], [0, 0.2]], studs: [] }));
  }

  // Curved slope 2/3 brick high, a quarter ellipse falling toward -y, no studs.
  function curve(id, ru, w) {
    const h = 2 * PLATE;
    const lip = 0.1;
    const pts = [[0, 0], [2, 0], [2, h]];
    for (let i = 1; i <= 16; i++) {
      const t = ((i / 16) * PI) / 2;
      pts.push([2 - 2 * Math.sin(t), lip + (h - lip) * Math.cos(t)]);
    }
    reg(holesToDiscs({ id, ru, kind: 'ext', w, d: 2, h, profile: pts, studs: [] }));
  }

  function round(id, ru, size, plates, studs) {
    const h = plates * PLATE;
    const s = !studs ? [] : size === 1 ? [[0.5, 0.5, h]] : grid(2, 2, h);
    reg({ id, ru, kind: 'cyl', w: size, d: size, h, r: size / 2 - 0.02, studs: s, discs: [] });
  }

  box('3005', 'Кирпич 1×1', 1, 1, 3, true);
  box('3004', 'Кирпич 1×2', 2, 1, 3, true);
  box('3622', 'Кирпич 1×3', 3, 1, 3, true);
  box('3010', 'Кирпич 1×4', 4, 1, 3, true);
  box('3009', 'Кирпич 1×6', 6, 1, 3, true);
  box('3008', 'Кирпич 1×8', 8, 1, 3, true);
  box('3003', 'Кирпич 2×2', 2, 2, 3, true);
  box('3002', 'Кирпич 2×3', 3, 2, 3, true);
  box('3001', 'Кирпич 2×4', 4, 2, 3, true);
  box('2456', 'Кирпич 2×6', 6, 2, 3, true);
  box('3007', 'Кирпич 2×8', 8, 2, 3, true);

  box('3024', 'Пластина 1×1', 1, 1, 1, true);
  box('3023', 'Пластина 1×2', 2, 1, 1, true);
  box('3623', 'Пластина 1×3', 3, 1, 1, true);
  box('3710', 'Пластина 1×4', 4, 1, 1, true);
  box('3666', 'Пластина 1×6', 6, 1, 1, true);
  box('3460', 'Пластина 1×8', 8, 1, 1, true);
  box('3022', 'Пластина 2×2', 2, 2, 1, true);
  box('3021', 'Пластина 2×3', 3, 2, 1, true);
  box('3020', 'Пластина 2×4', 4, 2, 1, true);
  box('3795', 'Пластина 2×6', 6, 2, 1, true);
  box('3034', 'Пластина 2×8', 8, 2, 1, true);
  box('3031', 'Пластина 4×4', 4, 4, 1, true);
  box('3032', 'Пластина 4×6', 6, 4, 1, true);
  box('3958', 'Пластина 6×6', 6, 6, 1, true);
  box('91405', 'Пластина 16×16', 16, 16, 1, true);

  box('3070', 'Плитка 1×1', 1, 1, 1, false);
  box('3069', 'Плитка 1×2', 2, 1, 1, false);
  box('63864', 'Плитка 1×3', 3, 1, 1, false);
  box('2431', 'Плитка 1×4', 4, 1, 1, false);
  box('6636', 'Плитка 1×6', 6, 1, 1, false);
  box('3068', 'Плитка 2×2', 2, 2, 1, false);
  box('87079', 'Плитка 2×4', 4, 2, 1, false);

  // SNOT brick: one more stud on the front face, 0.7 up from the bottom like a technic hole
  box('87087', 'Кирпич 1×1 с шипом сбоку', 1, 1, 3, true);
  LIB['87087'].studs.push([0.5, 0, 0.7, [0, -1, 0]]);

  box('3700', 'Техник-кирпич 1×2', 2, 1, 3, true, { holes: [[1, 0.7]] });
  box('3701', 'Техник-кирпич 1×4', 4, 1, 3, true, { holes: [[1, 0.7], [2, 0.7], [3, 0.7]] });

  slope('3040', 'Скос 45° 2×1', 1);
  slope('3039', 'Скос 45° 2×2', 2);
  ridge('3044c', 'Двойной скос 45° 2×1');
  curve('11477', 'Изогнутый скос 2×1', 1);
  curve('15068', 'Изогнутый скос 2×2', 2);

  round('4073', 'Круглая пластина 1×1', 1, 1, true);
  round('3062', 'Круглый кирпич 1×1', 1, 3, true);
  round('4032', 'Круглая пластина 2×2', 2, 1, true);
  round('3941', 'Круглый кирпич 2×2', 2, 3, true);
  // both have an axle hole between the four studs
  for (const id of ['4032', '3941']) LIB[id].discs.push({ c: [1, 1, LIB[id].h], n: [0, 0, 1], r: 0.13, kind: 'hole' });
  round('98138', 'Круглая плитка 1×1', 1, 1, false);
  round('14769', 'Круглая плитка 2×2', 2, 1, false);

  // ------------------------------------------------------------------ complex parts
  // A complex part is a list of convex pieces (all coordinates in the part's own frame, studs up
  // = +z). Builders below return pieces; cpart() registers the part.
  //   box3   axis-aligned box
  //   prismZ a convex polygon in the x-y plane pushed up from z0 to z1 (wedges, rounded corners)
  //   prismX a convex polygon in the y-z plane pushed along x (slopes seen from the side)
  //   lathe  a solid of revolution around +z from a profile [[r, z]...] (cones, dishes)
  //   cylP   a cylinder with any axis (wheels, axles, pins, ladder rails)
  //   ballP  a sphere approximated by a lathe
  const box3 = (x0, y0, z0, x1, y1, z1, extra) => Object.assign({
    V: [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]],
  }, extra || {});
  function prismZ(poly, z0, z1, extra) {
    const n = poly.length;
    const V = poly.map(([x, y]) => [x, y, z0]).concat(poly.map(([x, y]) => [x, y, z1]));
    const faces = [poly.map((_, i) => n - 1 - i), poly.map((_, i) => n + i)];
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; faces.push([i, j, n + j, n + i]); }
    return Object.assign({ V, faces }, extra || {});
  }
  function prismX(poly, x0, x1, extra) {
    const n = poly.length;
    const V = poly.map(([y, z]) => [x0, y, z]).concat(poly.map(([y, z]) => [x1, y, z]));
    const faces = [poly.map((_, i) => i), poly.map((_, i) => 2 * n - 1 - i)];
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; faces.push([i, j, n + j, n + i]); }
    return Object.assign({ V, faces }, extra || {});
  }
  function prismY(poly, y0, y1, extra) {
    const n = poly.length;
    const V = poly.map(([x, z]) => [x, y0, z]).concat(poly.map(([x, z]) => [x, y1, z]));
    const faces = [poly.map((_, i) => i), poly.map((_, i) => 2 * n - 1 - i)];
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; faces.push([i, j, n + j, n + i]); }
    return Object.assign({ V, faces }, extra || {});
  }
  // rounded rectangle (stadium) from a0 to a1 along one axis, b0..b1 across, as a convex polygon
  function stadium(a0, a1, b0, b1, seg) {
    const r = (b1 - b0) / 2;
    const c = (b0 + b1) / 2;
    const s = seg || 6;
    const pts = [];
    for (let i = 0; i <= s; i++) { const t = -PI / 2 + (PI * i) / s; pts.push([a1 - r + r * Math.cos(t), c + r * Math.sin(t)]); }
    for (let i = 0; i <= s; i++) { const t = PI / 2 + (PI * i) / s; pts.push([a0 + r + r * Math.cos(t), c + r * Math.sin(t)]); }
    return pts;
  }
  function lathe(cx, cy, prof, seg, extra) {
    const s = seg || 24;
    const V = [];
    for (const [r, z] of prof) for (let i = 0; i < s; i++) { const a = (2 * PI * i) / s; V.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]); }
    const faces = [];
    const m = prof.length;
    faces.push([...Array(s).keys()].reverse());
    faces.push([...Array(s).keys()].map((i) => (m - 1) * s + i));
    for (let k = 0; k < m - 1; k++) for (let i = 0; i < s; i++) {
      const j = (i + 1) % s;
      faces.push([k * s + i, k * s + j, (k + 1) * s + j, (k + 1) * s + i]);
    }
    // a zero radius ring collapses: drop its degenerate faces
    const zeroRing = prof.map(([r]) => r < 1e-6);
    const keep = faces.filter((f) => new Set(f.map((v) => (zeroRing[Math.floor(v / s)] ? 'apex' + Math.floor(v / s) : v))).size >= 3);
    return Object.assign({ V, faces: keep.map((f) => {
      const out = [];
      for (const v of f) { const k = zeroRing[Math.floor(v / s)] ? Math.floor(v / s) * s : v; if (out[out.length - 1] !== k && out[0] !== k) out.push(k); }
      return out;
    }) }, extra || {});
  }
  const cylP = (base, ax, r, h, extra) => Object.assign({ type: 'cyl', base, ax, r, h }, extra || {});
  function ballP(c, r, extra) {
    const prof = [];
    for (let i = 0; i <= 6; i++) { const t = -PI / 2 + (PI * i) / 6; prof.push([r * Math.cos(t), c[2] + r * Math.sin(t)]); }
    return lathe(c[0], c[1], prof, 14, extra);
  }
  function cpart(def) {
    reg(Object.assign({ kind: 'ext', studs: [], discs: [] }, def));
  }
  const PH = PLATE; // plate height
  const BH = 3 * PLATE; // brick height
  // studs on top of a rectangle of the grid
  const studsAt = (cells, z) => cells.map(([x, y]) => [x + 0.5, y + 0.5, z]);
  const cellsOf = (x0, y0, x1, y1) => { const c = []; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) c.push([x, y]); return c; };
  // a technic pin hole through a face: a dark disc on both sides
  const holeX = (y, z, w) => [{ c: [0, y, z], n: [-1, 0, 0], r: 0.3, kind: 'hole' }, { c: [w, y, z], n: [1, 0, 0], r: 0.3, kind: 'hole' }];
  const holeY = (x, z, d) => [{ c: [x, 0, z], n: [0, -1, 0], r: 0.3, kind: 'hole' }, { c: [x, d, z], n: [0, 1, 0], r: 0.3, kind: 'hole' }];
  const holeZ = (x, y, z0, z1) => [{ c: [x, y, z0], n: [0, 0, -1], r: 0.3, kind: 'hole' }, { c: [x, y, z1], n: [0, 0, 1], r: 0.3, kind: 'hole' }];
  // inside a convex polygon (counter-clockwise) with a margin, for placing studs on odd shapes
  const insidePoly = (poly, x, y, m) => poly.every((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    return (ex * (y - a[1]) - ey * (x - a[0])) / Math.hypot(ex, ey) >= m;
  });
  const studsIn = (poly, W, D, z) => studsAt(cellsOf(0, 0, W, D).filter(([x, y]) => insidePoly(poly, x + 0.5, y + 0.5, 0.25)), z);

  // --- plain shapes in more sizes
  box('11212', 'Пластина 3×3', 3, 3, 1, true);
  box('3832', 'Пластина 2×10', 10, 2, 1, true);
  box('2445', 'Пластина 2×12', 12, 2, 1, true);
  box('3035', 'Пластина 4×8', 8, 4, 1, true);
  box('26603', 'Плитка 2×3', 3, 2, 1, false);
  box('6112', 'Кирпич 1×12', 12, 1, 3, true);

  // --- modified plates
  // door rail: a lower lip along the front edge (y = 0)
  cpart({ id: '4510', ru: 'Пластина 1×8 с рельсом', w: 8, d: 1, h: PH, shape: 'plate',
    pieces: [box3(0, 0.2, 0, 8, 1, PH), box3(0, 0, 0, 8, 0.2, 0.24)], studs: studsAt(cellsOf(0, 0, 8, 1), PH) });
  cpart({ id: '30586', ru: 'Пластина 2×8 с рельсом', w: 8, d: 2, h: PH, shape: 'plate',
    pieces: [box3(0, 1, 0, 8, 2, PH), box3(0, 0.25, 0, 8, 1, PH), box3(0, 0, 0, 8, 0.25, 0.24)], studs: studsAt(cellsOf(0, 1, 8, 2), PH) });
  {
    const arc = [];
    for (let i = 0; i <= 8; i++) { const t = (PI / 2) * (i / 8); arc.push([3 * Math.cos(t), 3 * Math.sin(t)]); }
    const poly = [[0, 0]].concat(arc);
    cpart({ id: '30357', ru: 'Пластина 3×3 скруглённая', w: 3, d: 3, h: PH, shape: 'plate', pieces: [prismZ(poly, 0, PH)], studs: studsAt(cellsOf(0, 0, 3, 3).filter(([x, y]) => !(x === 2 && y === 2)), PH) });
  }
  cpart({ id: '60474', ru: 'Круглая пластина 4×4', w: 4, d: 4, h: PH, shape: 'round',
    pieces: [cylP([2, 2, 0], [0, 0, 1], 1.98, PH)],
    studs: studsAt(cellsOf(0, 0, 4, 4).filter(([x, y]) => !((x === 0 || x === 3) && (y === 0 || y === 3))), PH),
    discs: [{ c: [2, 2, PH], n: [0, 0, 1], r: 0.2, kind: 'hole' }] });
  cpart({ id: '64799', ru: 'Пластина 4×4 с окном 2×2', w: 4, d: 4, h: PH, shape: 'plate',
    pieces: [box3(0, 0, 0, 4, 1, PH), box3(0, 3, 0, 4, 4, PH), box3(0, 1, 0, 1, 3, PH), box3(3, 1, 0, 4, 3, PH)],
    studs: studsAt(cellsOf(0, 0, 4, 4).filter(([x, y]) => !(x >= 1 && x <= 2 && y >= 1 && y <= 2)), PH) });
  {
    const w64 = [[0, 0], [4, 0], [4, 6], [3, 6]];
    cpart({ id: '48205', ru: 'Клиновидная пластина 6×4', w: 4, d: 6, h: PH, shape: 'wedge', pieces: [prismZ(w64, 0, PH)], studs: studsIn(w64, 4, 6, PH) });
    const w22 = [[0, 0], [2, 0], [2, 2], [1, 2], [0, 1]];
    cpart({ id: '24299', ru: 'Клиновидная пластина 2×2', w: 2, d: 2, h: PH, shape: 'wedge', pieces: [prismZ(w22, 0, PH)], studs: studsIn(w22, 2, 2, PH) });
  }
  // double inverted slope 6x2 with a 2x4 plate-high middle
  cpart({ id: '22889', ru: 'Двойной обратный скос 6×2', w: 6, d: 2, h: BH, shape: 'slope',
    pieces: [
      box3(1, 0, 0, 5, 2, PH),
      prismY([[1, 0], [1, BH], [0, BH], [0, BH - 0.2]], 0, 2),
      prismY([[5, 0], [6, BH - 0.2], [6, BH], [5, BH]], 0, 2),
    ],
    studs: studsAt(cellsOf(1, 0, 5, 2), PH).concat(studsAt([[0, 0], [0, 1], [5, 0], [5, 1]], BH)) });
  // tow balls stick out of both ends of a 1x2 plate
  cpart({ id: '3170', ru: 'Пластина 1×2 с шарами', w: 2, d: 1, h: PH, shape: 'plate',
    pieces: [box3(0, 0, 0, 2, 1, PH), box3(-0.15, 0.42, 0.12, 0, 0.58, 0.28), box3(2, 0.42, 0.12, 2.15, 0.58, 0.28), ballP([-0.35, 0.5, 0.2], 0.2), ballP([2.35, 0.5, 0.2], 0.2)],
    studs: studsAt(cellsOf(0, 0, 2, 1), PH) });
  cpart({ id: '15209', ru: 'Плитка 1×2 с двумя зубцами', w: 2, d: 1, h: PH, shape: 'tile',
    pieces: [box3(0, 0, 0, 2, 1, PH), lathe(0.5, 0.5, [[0.42, PH], [0.3, PH + 0.5], [0, PH + 1.0]], 12), lathe(1.5, 0.5, [[0.42, PH], [0.3, PH + 0.5], [0, PH + 1.0]], 12)] });

  // --- brackets: studs on a vertical face
  cpart({ id: '44728', ru: 'Кронштейн 1×2 - 2×2', w: 2, d: 1, h: 2.0, shape: 'bracket',
    pieces: [box3(0, 0, 0, 2, 0.4, 2.0), box3(0, 0.4, 1.6, 2, 1, 2.0)],
    studs: studsAt(cellsOf(0, 0, 2, 1), 2.0).concat([[0.5, 0, 0.5, [0, -1, 0]], [1.5, 0, 0.5, [0, -1, 0]], [0.5, 0, 1.5, [0, -1, 0]], [1.5, 0, 1.5, [0, -1, 0]]]) });
  cpart({ id: '3956', ru: 'Кронштейн 2×2 - 2×2', w: 2, d: 2, h: 2.0, shape: 'bracket',
    pieces: [box3(0, 0, 0, 2, 0.4, 2.0), box3(0, 0.4, 0, 2, 2, PH)],
    studs: [[0.5, 0, 0.5, [0, -1, 0]], [1.5, 0, 0.5, [0, -1, 0]], [0.5, 0, 1.5, [0, -1, 0]], [1.5, 0, 1.5, [0, -1, 0]]],
    discs: [{ c: [0.5, 1.3, PH], n: [0, 0, 1], r: 0.3, kind: 'hole' }, { c: [1.5, 1.3, PH], n: [0, 0, 1], r: 0.3, kind: 'hole' }],
    joints: [{ p: [0.5, 1.3, 0], a: [0, 0, 1], len: PH, t: 'hole' }, { p: [1.5, 1.3, 0], a: [0, 0, 1], len: PH, t: 'hole' }] });

  // --- boxes, round and odd parts
  cpart({ id: '4345', ru: 'Ящик 2×2×2', w: 2, d: 2, h: 2 * BH, shape: 'container',
    pieces: [
      box3(0, 0, 0, 2, 2, 0.2), box3(0, 0, 0.2, 0.15, 2, 2.0), box3(1.85, 0, 0.2, 2, 2, 2.0),
      box3(0.15, 1.85, 0.2, 1.85, 2, 2.0), box3(0, 0, 2.0, 2, 2, 2 * BH),
    ],
    studs: studsAt(cellsOf(0, 0, 2, 2), 2 * BH) });
  {
    const prof = [];
    for (let i = 0; i <= 6; i++) { const z = (3 * BH * i) / 6; prof.push([0.3 + 1.18 * Math.sqrt(1 - z / (3 * BH)), z]); }
    cpart({ id: '1744', ru: 'Конус 3×3×3', w: 3, d: 3, h: 3 * BH, shape: 'round', pieces: [lathe(1.5, 1.5, prof, 24)], studs: [[1.5, 1.5, 3 * BH]] });
  }
  cpart({ id: '44375b', ru: 'Тарелка-антенна 6×6', w: 6, d: 6, h: BH, shape: 'round',
    pieces: [lathe(3, 3, [[2.98, 0], [2.98, 0.1], [2.4, 0.62], [1.5, BH]], 28)],
    studs: [[2.5, 2.5, BH], [3.5, 2.5, BH], [2.5, 3.5, BH], [3.5, 3.5, BH]],
    discs: [{ c: [3, 3, BH], n: [0, 0, 1], r: 0.2, kind: 'hole' }] });
  cpart({ id: '64647', ru: 'Пламя', w: 1, d: 1, h: 1.9, shape: 'decor',
    pieces: [cylP([0.5, 0.5, 0], [0, 0, 1], 0.16, 0.4), lathe(0.5, 0.5, [[0.38, 0.4], [0.42, 0.8], [0.3, 1.3], [0, 1.9]], 14)] });
  cpart({ id: '35809', ru: 'Ручка (аксессуар)', w: 2.2, d: 0.4, h: 0.4, shape: 'decor',
    pieces: [cylP([0, 0.2, 0.2], [1, 0, 0], 0.18, 1.9), cylP([1.9, 0.2, 0.2], [1, 0, 0], 0.12, 0.3, { color: 'darkBlue' })] });
  // roll cage: four posts, a frame on top and a 2x2 studded panel
  cpart({ id: '64450', ru: 'Каркас-кабина 6×4×3⅓', w: 4, d: 6, h: 4.0, shape: 'frame',
    pieces: [
      box3(0, 0, 0, 0.35, 0.35, 3.6), box3(3.65, 0, 0, 4, 0.35, 3.6), box3(0, 5.65, 0, 0.35, 6, 3.6), box3(3.65, 5.65, 0, 4, 6, 3.6),
      box3(0, 0, 3.6, 0.35, 6, 4.0), box3(3.65, 0, 3.6, 4, 6, 4.0), box3(0.35, 0, 3.6, 3.65, 0.35, 4.0), box3(0.35, 5.65, 3.6, 3.65, 6, 4.0),
      box3(0.35, 1, 3.6, 3.65, 3, 4.0),
    ],
    studs: studsAt(cellsOf(1, 1, 3, 3), 4.0) });
  {
    const pieces = [box3(0, 0, 0, 16, 0.4, PH), box3(0, 2.1, 0, 16, 2.5, PH), box3(0, 0.4, 0, 1, 2.1, PH), box3(15, 0.4, 0, 16, 2.1, PH)];
    for (let i = 1; i < 15; i++) pieces.push(box3(i + 0.4, 0.4, 0.08, i + 0.6, 2.1, 0.32));
    cpart({ id: '70646', ru: 'Лестница 16×2.5', w: 16, d: 2.5, h: PH, shape: 'ladder', pieces, studs: [[0.5, 1.25, PH], [15.5, 1.25, PH]] });
  }

  // --- wheels. Tyres are always black; the rim takes the part colour (a print on the tyre side).
  // Brick 2x4 with train wheels: the axle runs along x, wheels at both short ends. The wheels
  // stand on the ground (at z 0) and reach the top of the brick body, which sits 3 plates up, so
  // a plate laid over the brick clears the wheels. Grid box: 4 x 2 x 6 plates.
  cpart({ id: '4180c01', ru: 'Кирпич 2×4 с колёсами', w: 4, d: 2, h: 2.4, shape: 'wheels',
    pieces: [box3(0, 0, 1.2, 4, 2, 2.4), cylP([-0.55, 1, 1.2], [1, 0, 0], 1.2, 0.55, { color: 'black' }), cylP([4, 1, 1.2], [1, 0, 0], 1.2, 0.55, { color: 'black' })],
    studs: studsAt(cellsOf(0, 0, 4, 2), 2.4),
    discs: [
      { c: [-0.55, 1, 1.2], n: [-1, 0, 0], r: 0.8, color: 'dbg' }, { c: [4.55, 1, 1.2], n: [1, 0, 0], r: 0.8, color: 'dbg' },
      { c: [-0.55, 1, 1.2], n: [-1, 0, 0], r: 0.18, color: 'red' }, { c: [4.55, 1, 1.2], n: [1, 0, 0], r: 0.18, color: 'red' },
    ] });
  function wheel(id, ru, R, W, rim) {
    cpart({ id, ru, w: W, d: 2 * R, h: 2 * R, shape: 'wheel',
      pieces: [cylP([0, R, R], [1, 0, 0], R, W, { color: 'black' })],
      discs: [
        { c: [0, R, R], n: [-1, 0, 0], r: rim, color: null }, { c: [W, R, R], n: [1, 0, 0], r: rim, color: null },
        { c: [0, R, R], n: [-1, 0, 0], r: 0.3, kind: 'hole', piece: 0 }, { c: [W, R, R], n: [1, 0, 0], r: 0.3, kind: 'hole', piece: 0 },
      ],
      joints: [{ p: [0, R, R], a: [1, 0, 0], len: W, t: 'hole' }] });
  }
  wheel('55981', 'Колесо с шиной 30×14', 1.9, 1.75, 1.1);
  wheel('93594', 'Колёсико с шиной 14×6', 0.875, 0.75, 0.55);

  // --- technic: liftarms (holes across, along y), connector, pins
  function liftarm(id, ru, L, alongZ) {
    const discs = [];
    const joints = [];
    for (let i = 0; i < L; i++) {
      if (alongZ && alongZ.includes(i)) {
        discs.push(...holeZ(i + 0.5, 0.5, 0, 1));
        joints.push({ p: [i + 0.5, 0.5, 0], a: [0, 0, 1], len: 1, t: 'hole' });
      } else {
        discs.push(...holeY(i + 0.5, 0.5, 1));
        joints.push({ p: [i + 0.5, 0, 0.5], a: [0, 1, 0], len: 1, t: 'hole' });
      }
    }
    cpart({ id, ru, w: L, d: 1, h: 1, shape: 'technic', pieces: [prismY(stadium(0, L, 0, 1), 0, 1)], discs, joints });
  }
  liftarm('32316', 'Техник-балка 1×5', 5);
  liftarm('2391', 'Техник-балка 1×7 с отверстиями', 7, [1, 2, 4, 5]);
  liftarm('40490', 'Техник-балка 1×9', 9);
  cpart({ id: '42003', ru: 'Техник-соединитель 3L', w: 3, d: 1, h: 1, shape: 'technic',
    pieces: [prismZ(stadium(0, 3, 0, 1), 0, 1)],
    discs: holeZ(1.5, 0.5, 0, 1).concat(holeZ(2.5, 0.5, 0, 1), holeY(0.5, 0.5, 1)),
    joints: [{ p: [1.5, 0.5, 0], a: [0, 0, 1], len: 1, t: 'hole' }, { p: [2.5, 0.5, 0], a: [0, 0, 1], len: 1, t: 'hole' }, { p: [0.5, 0, 0.5], a: [0, 1, 0], len: 1, t: 'axlehole' }] });
  // pins lie along x in a 1x1 cross-section (axis at y = z = 0.5); each half goes into one hole
  function pin(id, ru, kinds) {
    cpart({ id, ru, w: 2, d: 1, h: 1, shape: 'pin',
      pieces: [cylP([0, 0.5, 0.5], [1, 0, 0], kinds[0] === 'axle' ? 0.26 : 0.3, 0.93), cylP([0.93, 0.5, 0.5], [1, 0, 0], 0.37, 0.14), cylP([1.07, 0.5, 0.5], [1, 0, 0], kinds[1] === 'axle' ? 0.26 : 0.3, 0.93)],
      joints: [{ p: [0, 0.5, 0.5], a: [1, 0, 0], len: 1, t: kinds[0] }, { p: [1, 0.5, 0.5], a: [1, 0, 0], len: 1, t: kinds[1] }] });
  }
  pin('3673', 'Техник-штифт', ['pin', 'pin']);
  pin('2780', 'Техник-штифт с фиксатором', ['pin', 'pin']);
  pin('43093', 'Техник-штифт с осью', ['axle', 'pin']);

  // Joints of the old technic bricks come from their holes (through the part along y).
  for (const id of ['3700', '3701']) LIB[id].joints = LIB[id].holes.map(([x, z]) => ({ p: [x, 0, z], a: [0, 1, 0], len: LIB[id].d, t: 'hole' }));

  // Collision boxes in the part's own frame: the grid box for simple parts, one box per piece
  // for complex ones. Joints: technic holes, pins and axles as segments { p, a, len, t }.
  LEGO.collidersOf = (def) => (def.pieces ? geomOf(def).map((g) => ({ lo: g.lo, hi: g.hi })) : [{ lo: [0, 0, 0], hi: [def.w, def.d, def.h] }]);
  LEGO.jointsOf = (def) => def.joints || [];

  // Polyhedron of an extruded part, built once per part type.
  function newell(pts) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      x += (a[1] - b[1]) * (a[2] + b[2]);
      y += (a[2] - b[2]) * (a[0] + b[0]);
      z += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return norm([x, y, z]);
  }

  // Polyhedron from vertices and faces (index lists), outward normals and edges with smoothing.
  function polyGeom(V, faces) {
    const cen = [0, 0, 0];
    for (const v of V) for (let k = 0; k < 3; k++) cen[k] += v[k] / V.length;
    const F = faces.map((idx) => {
      const pts = idx.map((i) => V[i]);
      let n = newell(pts);
      const fc = [0, 0, 0];
      for (const p of pts) for (let k = 0; k < 3; k++) fc[k] += p[k] / pts.length;
      if (dot(n, [fc[0] - cen[0], fc[1] - cen[1], fc[2] - cen[2]]) < 0) n = [-n[0], -n[1], -n[2]];
      return { idx, n };
    });
    const map = new Map();
    const E = [];
    F.forEach((f, fi) => {
      for (let k = 0; k < f.idx.length; k++) {
        const a = f.idx[k];
        const b = f.idx[(k + 1) % f.idx.length];
        const key = a < b ? a * 4096 + b : b * 4096 + a;
        const e = map.get(key);
        if (e) e.f2 = fi;
        else {
          const ne = { a, b, f1: fi, f2: -1 };
          map.set(key, ne);
          E.push(ne);
        }
      }
    });
    const cosSmooth = Math.cos((30 * PI) / 180);
    for (const e of E) e.smooth = e.f2 >= 0 && dot(F[e.f1].n, F[e.f2].n) > cosSmooth;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const v of V) for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; }
    return { kind: 'ext', V, F, E, lo, hi };
  }

  function cylLocal(base, ax, r, h) {
    const lo = [0, 0, 0];
    const hi = [0, 0, 0];
    cylBox(base, ax, r, h, lo, hi);
    return { kind: 'cyl', base, ax, r, h, lo, hi };
  }

  // Which piece a disc / stud belongs to: the piece whose face it sits on, deepest inside it.
  function pieceFor(G, c, n) {
    if (G.length === 1) return 0;
    const k = Math.abs(n[0]) > 0.5 ? 0 : Math.abs(n[1]) > 0.5 ? 1 : 2;
    let best = 0;
    let bestM = -Infinity;
    G.forEach((g, i) => {
      let m = Infinity;
      for (let a = 0; a < 3; a++) if (a !== k) m = Math.min(m, c[a] - g.lo[a], g.hi[a] - c[a]);
      const face = n[k] > 0 ? g.hi[k] : g.lo[k];
      if (Math.abs(c[k] - face) > 0.06) m -= 10;
      if (m > bestM) { bestM = m; best = i; }
    });
    return best;
  }

  // Geometry of a part: a list of convex pieces in the part's own coordinates, built once.
  function geomOf(def) {
    if (def._g) return def._g;
    let G;
    if (def.pieces) {
      G = def.pieces.map((pc) => Object.assign(
        pc.type === 'cyl' ? cylLocal(pc.base, pc.ax, pc.r, pc.h) : polyGeom(pc.V, pc.faces),
        { color: pc.color || null, join: pc.join || [] }
      ));
    } else if (def.kind !== 'ext') {
      G = [cylLocal([def.w / 2, def.d / 2, 0], [0, 0, 1], def.r, def.h)];
    } else {
      const P = def.profile;
      const m = P.length;
      const V = [];
      for (const q of P) V.push([0, q[0], q[1]]);
      for (const q of P) V.push([def.w, q[0], q[1]]);
      const faces = [P.map((_, i) => i), P.map((_, i) => 2 * m - 1 - i)];
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        faces.push([i, j, m + j, m + i]);
      }
      G = [polyGeom(V, faces)];
    }
    for (const g of G) { g.color = g.color || null; g.join = g.join || []; }
    def._discPiece = (def.discs || []).map((d) => (d.piece != null ? d.piece : pieceFor(G, d.c || (d.poly || d.line)[0], d.n)));
    def._studPiece = def.studs.map((s) => pieceFor(G, s, s[3] || [0, 0, 1]));
    return (def._g = G);
  }

  // Part box in its own coordinates, pieces and stud tips included (camera framing).
  function localBox(def) {
    if (def._box) return def._box;
    if (!def.pieces) {
      const top = def.studs.length ? def.h + STUD_H : def.h;
      return (def._box = { lo: [0, 0, 0], hi: [def.w, def.d, top] });
    }
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const g of geomOf(def)) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], g.lo[k]); hi[k] = Math.max(hi[k], g.hi[k]); }
    for (const s of def.studs) {
      const tip = madd(s, s[3] || [0, 0, 1], STUD_H);
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], tip[k]); hi[k] = Math.max(hi[k], tip[k]); }
    }
    return (def._box = { lo, hi });
  }

  // ------------------------------------------------------------------ placing

  // `up` sends the stud side (local z) to a world axis, then `rot` turns the part about world z.
  const UPS = {
    '+z': [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    '-z': [[1, 0, 0], [0, -1, 0], [0, 0, -1]],
    '-y': [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    '+y': [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
    '+x': [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
    '-x': [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  };
  const RZ = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
    [[0, 1, 0], [-1, 0, 0], [0, 0, 1]],
  ];

  // spec: { id, color, at: [x, y, zPlates] = min corner of the part's grid box (w x d x h, or
  // def.anchor: wheels, balls or a pin can stick out of it), rot 0..3, up, prints }
  LEGO.place = function place(spec) {
    const def = LIB[spec.id];
    if (!def) throw new Error('lego.js: unknown part ' + spec.id);
    const col = spec.rgb ? { rgb: spec.rgb } : COLORS[spec.color];
    if (!col) throw new Error('lego.js: unknown colour ' + spec.color);
    const up = UPS[spec.up || '+z'];
    if (!up) throw new Error('lego.js: unknown up ' + spec.up);
    const M = mulMM(RZ[(spec.rot || 0) & 3], up);
    const lo = [Infinity, Infinity, Infinity];
    const anc = def.anchor || { lo: [0, 0, 0], hi: [def.w, def.d, def.h] };
    for (const x of [anc.lo[0], anc.hi[0]]) {
      for (const y of [anc.lo[1], anc.hi[1]]) {
        for (const z of [anc.lo[2], anc.hi[2]]) {
          const v = mulMV(M, [x, y, z]);
          for (let k = 0; k < 3; k++) if (v[k] < lo[k]) lo[k] = v[k];
        }
      }
    }
    const at = spec.at || ZERO;
    const off = [at[0] - lo[0], at[1] - lo[1], at[2] * PLATE - lo[2]];
    return { def, spec, M, off, rgb: col.rgb, color: spec.color || null };
  };

  // ------------------------------------------------------------------ camera

  // Orthographic. theta turns the viewer around the model (45 = front right), phi lifts it.
  LEGO.camera = function camera(o) {
    const th = ((o.theta == null ? 45 : o.theta) * PI) / 180;
    const ph = ((o.phi == null ? 30 : o.phi) * PI) / 180;
    const dir = [Math.sin(th) * Math.cos(ph), -Math.cos(th) * Math.cos(ph), Math.sin(ph)];
    const right = [Math.cos(th), Math.sin(th), 0];
    const up = cross(right, [-dir[0], -dir[1], -dir[2]]);
    const T = o.target || ZERO;
    const s = o.scale || 60;
    const cx = o.cx || 0;
    const cy = o.cy || 0;
    // Light rides with the camera: tops brightest, left faces next, right faces darkest.
    // o.light = [right, up, toward viewer] weights; a mosaic seen from above wants it mostly frontal.
    const lg = o.light || [-0.45, 0.85, 0.5];
    const L = norm(madd(madd(madd([0, 0, 0], right, lg[0]), up, lg[1]), dir, lg[2]));
    const project = (p) => {
      const dx = p[0] - T[0];
      const dy = p[1] - T[1];
      const dz = p[2] - T[2];
      return [
        cx + (dx * right[0] + dy * right[1]) * s,
        cy - (dx * up[0] + dy * up[1] + dz * up[2]) * s,
        dx * dir[0] + dy * dir[1] + dz * dir[2],
      ];
    };
    return { dir, right, up, L, project, scale: s, target: T, cx, cy };
  };

  // ------------------------------------------------------------------ geometry per frame

  function arcPts(c, A, B, t0, t1, n) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = t0 + ((t1 - t0) * i) / n;
      const co = Math.cos(t);
      const si = Math.sin(t);
      out.push([c[0] + A[0] * co + B[0] * si, c[1] + A[1] * co + B[1] * si]);
    }
    return out;
  }

  // A cylinder seen by the camera: its two end ellipses, the outline and the visible half of the side.
  function cylGeom(cam, C, ax, R, H) {
    const e1 = Math.abs(ax[2]) > 0.9 ? [1, 0, 0] : norm(cross(ax, [0, 0, 1]));
    const e2 = cross(ax, e1);
    const c0 = cam.project(C);
    const c1 = cam.project(madd(C, ax, H));
    const pa = cam.project(madd(C, e1, R));
    const pb = cam.project(madd(C, e2, R));
    const A = [pa[0] - c0[0], pa[1] - c0[1]];
    const B = [pb[0] - c0[0], pb[1] - c0[1]];
    const rpx = Math.max(Math.hypot(A[0], A[1]), Math.hypot(B[0], B[1]));
    const n = Math.max(10, Math.min(64, Math.ceil(rpx * 0.7)));
    const front = dot(ax, cam.dir) >= 0;
    const g = { e1, e2, c0, c1, A, B, n, capC: front ? c1 : c0, capN: front ? ax : [-ax[0], -ax[1], -ax[2]], side: false };
    const hx = c1[0] - c0[0];
    const hy = c1[1] - c0[1];
    const hl = Math.hypot(hx, hy);
    if (hl > 0.25) {
      const nx = -hy / hl;
      const ny = hx / hl;
      const t1 = Math.atan2(B[0] * nx + B[1] * ny, A[0] * nx + A[1] * ny);
      const tm = t1 + PI / 2;
      const cm = Math.cos(tm);
      const sm = Math.sin(tm);
      const along = (A[0] * cm + B[0] * sm) * hx + (A[1] * cm + B[1] * sm) * hy;
      const s0 = along < 0 ? t1 : t1 + PI;
      g.sil = arcPts(c0, A, B, s0, s0 + PI, n).concat(arcPts(c1, A, B, s0 + PI, s0 + 2 * PI, n));
      const nm = [e1[0] * cm + e2[0] * sm, e1[1] * cm + e2[1] * sm, e1[2] * cm + e2[2] * sm];
      g.vis0 = dot(nm, cam.dir) > 0 ? t1 : t1 + PI;
      g.nx = nx;
      g.ny = ny;
      g.side = true;
    } else {
      g.sil = arcPts(g.capC, A, B, 0, 2 * PI, 2 * n);
    }
    return g;
  }

  function cylBox(C, ax, R, H, mn, mx) {
    const T = madd(C, ax, H);
    for (let k = 0; k < 3; k++) {
      const e = R * Math.sqrt(Math.max(0, 1 - ax[k] * ax[k]));
      mn[k] = Math.min(C[k], T[k]) - e;
      mx[k] = Math.max(C[k], T[k]) + e;
    }
  }

  function hull2(P) {
    const pts = P.map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [];
    const hi = [];
    for (const p of pts) {
      while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
      lo.push(p);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop();
      hi.push(p);
    }
    lo.pop();
    hi.pop();
    return lo.concat(hi);
  }

  function rectOf(pts, pad) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pts) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  }

  const depthOf = (mn, mx, cam) => dot([(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2], cam.dir);

  // A stud is hidden when another part's body sits over it. With many bodies the candidates
  // come from a grid index of their footprints instead of the whole list.
  function coverIndex(bodies) {
    if (bodies.length < 200) return null;
    const cells = new Map();
    for (const b of bodies) {
      for (let x = Math.floor(b.min[0]); x < Math.ceil(b.max[0]); x++) {
        for (let y = Math.floor(b.min[1]); y < Math.ceil(b.max[1]); y++) {
          const k = x * 65536 + y;
          const list = cells.get(k);
          if (list) list.push(b);
          else cells.set(k, [b]);
        }
      }
    }
    return cells;
  }

  function covered(q, self, bodies, index) {
    if (index) bodies = index.get(Math.floor(q[0]) * 65536 + Math.floor(q[1])) || [];
    for (const b of bodies) {
      if (b === self || (self.group && b.group === self.group)) continue;
      if (
        q[0] > b.min[0] + 0.02 && q[0] < b.max[0] - 0.02 &&
        q[1] > b.min[1] + 0.02 && q[1] < b.max[1] - 0.02 &&
        q[2] > b.min[2] - 0.001 && q[2] < b.max[2]
      ) return true;
    }
    return false;
  }

  // Prints are given in the part's own coordinates: a disc { c, n, r } or { c, n, rx, ry },
  // a filled polygon { poly: [[x, y, z]...], n } or a stroke { line: [[x, y, z]...], n, w }.
  function worldPrint(p, off, d) {
    const N = mulMV(p.M, d.n);
    const at = (v) => add(mulMV(p.M, v), off);
    if (d.poly) return { kind: 'poly', N, pts: d.poly.map(at), color: d.color };
    if (d.line) return { kind: 'line', N, pts: d.line.map(at), color: d.color, w: d.w || 0.04 };
    return { kind: d.kind || 'disc', N, C: at(d.c), rx: d.rx || d.r, ry: d.ry || d.r, color: d.color };
  }

  function prep(items, cam, pad, cull) {
    const bodies = [];
    for (const it of items) {
      const p = it.part;
      if (cull && !it.base) {
        const mv0 = it.move || ZERO;
        const a = cam.project([p.off[0] + mv0[0], p.off[1] + mv0[1], p.off[2] + mv0[2]]);
        if (a[0] < cull[0] || a[0] > cull[2] || a[1] < cull[1] || a[1] > cull[3]) continue;
      }
      const G = geomOf(p.def);
      const mv = it.move || ZERO;
      const off = [p.off[0] + mv[0], p.off[1] + mv[1], p.off[2] + mv[2]];
      const pale = it.pale || 0;
      const group = [];
      const allPrints = (p.def.discs || []).map((d, i) => [p.def._discPiece[i], d]).concat((p.spec.prints || []).map((d) => [0, d]));
      G.forEach((g, gi) => {
        // a piece may have its own fixed colour (black tyres, a red pin)
        const rgb = g.color && COLORS[g.color] ? COLORS[g.color].rgb : p.rgb;
        const o = {
          type: 'body', part: p, off, rgb, pale, halo: it.halo || 0, base: it.base ? 0 : 1,
          alpha: it.alpha == null ? 1 : it.alpha, edge: edgeTone(rgb, pale), group, piece: gi,
        };
        const mn = [Infinity, Infinity, Infinity];
        const mx = [-Infinity, -Infinity, -Infinity];
        if (g.kind === 'ext') {
          const Wv = g.V.map((v) => add(mulMV(p.M, v), off));
          for (const w of Wv) {
            for (let k = 0; k < 3; k++) {
              if (w[k] < mn[k]) mn[k] = w[k];
              if (w[k] > mx[k]) mx[k] = w[k];
            }
          }
          o.P = Wv.map(cam.project);
          o.E = g.E;
          o.faces = g.F.map((f) => {
            const n = mulMV(p.M, f.n);
            const vis = dot(n, cam.dir) > 1e-6;
            return { idx: f.idx, vis, fill: vis ? tone(rgb, lightOf(cam, n), pale) : null };
          });
          o.hull = hull2(o.P);
        } else {
          const ax = mulMV(p.M, g.ax);
          const C = add(mulMV(p.M, g.base), off);
          o.cyl = cylGeom(cam, C, ax, g.r, g.h);
          cylBox(C, ax, g.r, g.h, mn, mx);
          o.hull = o.cyl.sil;
        }
        o.min = mn;
        o.max = mx;
        o.prints = allPrints.filter(([pi]) => pi === gi).map(([, d]) => worldPrint(p, off, d));
        // printed lines (whiskers) may reach past the part, keep them inside its screen box
        const reach = o.hull.slice();
        for (const d of o.prints) if (d.pts) for (const q of d.pts) reach.push(cam.project(q));
        o.rect = rectOf(reach, pad);
        o.depth = depthOf(mn, mx, cam);
        group.push(o);
        bodies.push(o);
      });
      // the yellow outline goes around every piece of the part, drawn once before the part
      if (group.length > 1) for (const o of group) o.groupHulls = group.map((g) => g.hull);
    }
    const objs = bodies.slice();
    const index = coverIndex(bodies);
    for (const b of bodies) {
      const p = b.part;
      p.def.studs.forEach((s, si) => {
        if (p.def._studPiece[si] !== b.piece) return;
        // a stud points up the part unless it carries its own axis (studs on the side)
        const ax = mulMV(p.M, s[3] || [0, 0, 1]);
        if (dot(ax, cam.dir) < -0.02) return;
        const C = add(mulMV(p.M, s), b.off);
        if (cull) {
          const a = cam.project(C);
          if (a[0] < cull[0] || a[0] > cull[2] || a[1] < cull[1] || a[1] > cull[3]) return;
        }
        if (covered(madd(C, ax, 0.1), b, bodies, index)) return;
        const mn = [0, 0, 0];
        const mx = [0, 0, 0];
        cylBox(C, ax, STUD_R, STUD_H, mn, mx);
        const cyl = cylGeom(cam, C, ax, STUD_R, STUD_H);
        // a multi-piece part outlines its studs together with its pieces (see drawHalo)
        if (b.groupHulls) (b.group.studSils = b.group.studSils || []).push(cyl.sil);
        objs.push({
          type: 'stud', owner: b, rgb: b.rgb, pale: b.pale, halo: b.halo, alpha: b.alpha, edge: b.edge, base: 1,
          cyl, min: mn, max: mx, rect: rectOf(cyl.sil, pad), depth: depthOf(mn, mx, cam), prints: [],
        });
      });
    }
    return objs;
  }

  // ------------------------------------------------------------------ painter's order

  // 1: draw a first, -1: draw b first, 0: no constraint. Uses a separating axis of the two boxes.
  function before(a, b, cam) {
    let v = 0;
    for (let k = 0; k < 3; k++) {
      const d = cam.dir[k];
      if (Math.abs(d) < 1e-9) continue;
      let s;
      if (a.max[k] <= b.min[k] + EPS) s = d > 0 ? 1 : -1;
      else if (b.max[k] <= a.min[k] + EPS) s = d > 0 ? -1 : 1;
      else continue;
      if (v === 0) v = s;
      else if (v !== s) return 0;
    }
    if (v !== 0) return v;
    return a.depth <= b.depth ? 1 : -1;
  }

  function sortObjs(objs, cam) {
    const n = objs.length;
    const succ = [];
    for (let i = 0; i < n; i++) succ.push([]);
    const indeg = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const a = objs[i];
      for (let j = i + 1; j < n; j++) {
        const b = objs[j];
        if (a.rect[2] < b.rect[0] || b.rect[2] < a.rect[0] || a.rect[3] < b.rect[1] || b.rect[3] < a.rect[1]) continue;
        const r = before(a, b, cam);
        if (r > 0) {
          succ[i].push(j);
          indeg[j]++;
        } else if (r < 0) {
          succ[j].push(i);
          indeg[i]++;
        }
      }
    }
    const done = new Uint8Array(n);
    const out = [];
    for (let c = 0; c < n; c++) {
      let best = -1;
      for (let i = 0; i < n; i++) {
        if (!done[i] && indeg[i] <= 0 && (best < 0 || objs[i].depth < objs[best].depth)) best = i;
      }
      if (best < 0) {
        for (let i = 0; i < n; i++) if (!done[i] && (best < 0 || objs[i].depth < objs[best].depth)) best = i;
      }
      done[best] = 1;
      out.push(objs[best]);
      for (const j of succ[best]) indeg[j]--;
    }
    return out;
  }

  // ------------------------------------------------------------------ drawing

  function ptsPath(ctx, pts) {
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  }

  function ellPath(ctx, c, A, B, n) {
    for (let i = 0; i <= n; i++) {
      const t = (2 * PI * i) / n;
      const x = c[0] + A[0] * Math.cos(t) + B[0] * Math.sin(t);
      const y = c[1] + A[1] * Math.cos(t) + B[1] * Math.sin(t);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.closePath();
  }

  function drawHalo(ctx, o, lw) {
    ctx.save();
    ctx.globalAlpha *= o.halo;
    if (o.type === 'stud') {
      // only the part of a stud that sticks out past its own brick
      ctx.beginPath();
      ctx.rect(-1e5, -1e5, 2e5, 2e5);
      for (const h of o.owner.groupHulls || [o.owner.hull]) ptsPath(ctx, h);
      ctx.clip('evenodd');
    }
    ctx.beginPath();
    const sils = o.type === 'stud' ? [o.cyl.sil] : (o.groupHulls || [o.hull]).concat((o.groupHulls && o.group.studSils) || []);
    for (const h of sils) ptsPath(ctx, h);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = HALO;
    ctx.lineWidth = lw * 4.6;
    ctx.stroke();
    if (o.type !== 'stud' && o.groupHulls) {
      // no yellow lines where pieces meet: cover the inside of every piece and stud again (the
      // part is painted right after, so the cover ends up under the part itself)
      ctx.globalAlpha = 1;
      for (const h of sils) {
        ctx.beginPath();
        ptsPath(ctx, h);
        ctx.fillStyle = tone(o.part.rgb, 1, o.pale);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // Prints and technic holes on a face.
  function drawPrint(ctx, cam, o, d, lw) {
    if (dot(d.N, cam.dir) < 0.03) return;
    const lit = lightOf(cam, d.N);
    if (d.kind === 'poly' || d.kind === 'line') {
      const P = d.pts.map(cam.project);
      ctx.beginPath();
      ctx.moveTo(P[0][0], P[0][1]);
      for (let i = 1; i < P.length; i++) ctx.lineTo(P[i][0], P[i][1]);
      if (d.kind === 'poly') {
        ctx.closePath();
        ctx.fillStyle = tone(COLORS[d.color].rgb, lit, o.pale);
        ctx.fill();
      } else {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = tone(COLORS[d.color].rgb, 1, o.pale);
        ctx.lineWidth = Math.max(1, d.w * cam.scale);
        ctx.stroke();
      }
      return;
    }
    // e1 runs level across the face (or along x on a top face), e2 up the face
    const e1 = Math.abs(d.N[2]) > 0.9 ? [1, 0, 0] : norm(cross(d.N, [0, 0, 1]));
    const e2 = cross(d.N, e1);
    const c = cam.project(d.C);
    const pa = cam.project(madd(d.C, e1, d.rx));
    const pb = cam.project(madd(d.C, e2, d.ry));
    const A = [pa[0] - c[0], pa[1] - c[1]];
    const B = [pb[0] - c[0], pb[1] - c[1]];
    const n = Math.max(20, Math.min(96, Math.ceil(Math.max(Math.hypot(A[0], A[1]), Math.hypot(B[0], B[1])) * 1.2)));
    if (d.kind === 'hole') {
      ctx.beginPath();
      ellPath(ctx, c, A, B, n);
      ctx.fillStyle = tone(o.rgb, lit * 0.74, o.pale);
      ctx.fill();
      ctx.strokeStyle = o.edge;
      ctx.lineWidth = lw * 0.85;
      ctx.stroke();
      const ci = cam.project(madd(d.C, d.N, -0.22));
      ctx.beginPath();
      ellPath(ctx, ci, [A[0] * 0.72, A[1] * 0.72], [B[0] * 0.72, B[1] * 0.72], n);
      ctx.fillStyle = tone(o.rgb, lit * 0.42, o.pale);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ellPath(ctx, c, A, B, n);
    // a disc without a colour takes the part's own colour (wheel rims on a black tyre)
    ctx.fillStyle = tone(d.color ? COLORS[d.color].rgb : o.part.rgb, lit, o.pale);
    ctx.fill();
  }

  function drawExt(ctx, cam, o, lw, ea) {
    const P = o.P;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const f of o.faces) {
      if (!f.vis) continue;
      ctx.beginPath();
      const ix = f.idx;
      ctx.moveTo(P[ix[0]][0], P[ix[0]][1]);
      for (let i = 1; i < ix.length; i++) ctx.lineTo(P[ix[i]][0], P[ix[i]][1]);
      ctx.closePath();
      ctx.fillStyle = f.fill;
      ctx.fill();
      // seal the hairline gaps between facets of the same part
      ctx.lineWidth = 1;
      ctx.strokeStyle = f.fill;
      ctx.stroke();
    }
    for (const d of o.prints) drawPrint(ctx, cam, o, d, lw);
    ctx.beginPath();
    for (const e of o.E) {
      const v1 = o.faces[e.f1].vis;
      const v2 = e.f2 >= 0 && o.faces[e.f2].vis;
      if (!v1 && !v2) continue;
      if (v1 && v2 && e.smooth) continue;
      ctx.moveTo(P[e.a][0], P[e.a][1]);
      ctx.lineTo(P[e.b][0], P[e.b][1]);
    }
    ctx.globalAlpha *= ea;
    ctx.strokeStyle = o.edge;
    ctx.lineWidth = lw;
    ctx.stroke();
  }

  function drawCyl(ctx, cam, o, lw, ea) {
    const g = o.cyl;
    ctx.lineJoin = 'round';
    if (g.side) {
      const st = [];
      let qmin = Infinity;
      let qmax = -Infinity;
      for (let k = 0; k <= 10; k++) {
        const t = g.vis0 + (PI * k) / 10;
        const co = Math.cos(t);
        const si = Math.sin(t);
        const q = (g.A[0] * co + g.B[0] * si) * g.nx + (g.A[1] * co + g.B[1] * si) * g.ny;
        const nrm = [g.e1[0] * co + g.e2[0] * si, g.e1[1] * co + g.e2[1] * si, g.e1[2] * co + g.e2[2] * si];
        st.push([q, lightOf(cam, nrm)]);
        if (q < qmin) qmin = q;
        if (q > qmax) qmax = q;
      }
      const c0 = g.c0;
      const gr = ctx.createLinearGradient(c0[0] + g.nx * qmin, c0[1] + g.ny * qmin, c0[0] + g.nx * qmax, c0[1] + g.ny * qmax);
      const span = qmax - qmin || 1;
      for (const [q, b] of st) gr.addColorStop((q - qmin) / span, tone(o.rgb, b, o.pale));
      ctx.beginPath();
      ptsPath(ctx, g.sil);
      ctx.fillStyle = gr;
      ctx.fill();
    }
    ctx.beginPath();
    ellPath(ctx, g.capC, g.A, g.B, 2 * g.n);
    ctx.fillStyle = tone(o.rgb, lightOf(cam, g.capN), o.pale);
    ctx.fill();
    for (const d of o.prints) drawPrint(ctx, cam, o, d, lw);
    ctx.globalAlpha *= ea;
    ctx.strokeStyle = o.edge;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ptsPath(ctx, g.sil);
    ctx.stroke();
    ctx.beginPath();
    ellPath(ctx, g.capC, g.A, g.B, 2 * g.n);
    ctx.stroke();
  }

  // Draw a list of items ({ part, move, pale, halo, alpha, base }) back to front.
  // opt.fast skips the exact painter's order: items marked `base` first, then everything by depth.
  // That is right for flat scenes like mosaics and fast enough for thousands of parts.
  // opt.edgeAlpha fades the dark edges (1 = booklet look).
  LEGO.draw = function draw(ctx, items, cam, opt) {
    const o0 = opt || {};
    const lw = o0.lineWidth || Math.max(1, cam.scale * 0.02);
    const ea = o0.edgeAlpha == null ? 1 : o0.edgeAlpha;
    // opt.cull [x0, y0, x1, y1]: small parts and studs outside this screen box are skipped
    const prepped = prep(items, cam, lw * 2.5, o0.cull);
    const objs = o0.fast ? prepped.sort((a, b) => a.base - b.base || a.depth - b.depth) : sortObjs(prepped, cam);
    // a part made of several pieces gets its outline (around each piece) once, right before the
    // first of its pieces is painted, so parts behind it do not cover the outline
    const haloDone = new Set();
    for (const o of objs) {
      ctx.save();
      if (o.alpha < 1) ctx.globalAlpha = o.alpha;
      if (o.halo > 0 && !(o.groupHulls && haloDone.has(o.group)) && !(o.type === 'stud' && o.owner.groupHulls)) {
        drawHalo(ctx, o, lw);
        if (o.groupHulls) haloDone.add(o.group);
      }
      if (o.cyl) drawCyl(ctx, cam, o, lw, ea);
      else drawExt(ctx, cam, o, lw, ea);
      ctx.restore();
    }
    return objs.length;
  };

  // ------------------------------------------------------------------ layout helpers

  // World box of placed parts, studs included.
  LEGO.bounds = function bounds(parts) {
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (const p of parts) {
      const bx = localBox(p.def);
      for (const x of [bx.lo[0], bx.hi[0]]) {
        for (const y of [bx.lo[1], bx.hi[1]]) {
          for (const z of [bx.lo[2], bx.hi[2]]) {
            const v = add(mulMV(p.M, [x, y, z]), p.off);
            for (let k = 0; k < 3; k++) {
              if (v[k] < mn[k]) mn[k] = v[k];
              if (v[k] > mx[k]) mx[k] = v[k];
            }
          }
        }
      }
    }
    return { min: mn, max: mx, center: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2] };
  };

  // Screen size of a world box at scale 1.
  LEGO.extent = function extent(b, theta, phi) {
    const cam = LEGO.camera({ theta, phi, scale: 1, target: b.center });
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const x of [b.min[0], b.max[0]]) {
      for (const y of [b.min[1], b.max[1]]) {
        for (const z of [b.min[2], b.max[2]]) {
          const p = cam.project([x, y, z]);
          if (p[0] < x0) x0 = p[0];
          if (p[0] > x1) x1 = p[0];
          if (p[1] < y0) y0 = p[1];
          if (p[1] > y1) y1 = p[1];
        }
      }
    }
    return { w: x1 - x0, h: y1 - y0, x0, x1, y0, y1 };
  };

  // One part on its own, centred on (cx, cy): parts lists, inventories.
  LEGO.drawPart = function drawPart(ctx, spec, cx, cy, scale, opt) {
    const o = opt || {};
    const part = LEGO.place(Object.assign({}, spec, { at: [0, 0, 0] }));
    const b = LEGO.bounds([part]);
    const cam = LEGO.camera({ theta: o.theta, phi: o.phi, scale, cx, cy, target: b.center });
    LEGO.draw(ctx, [{ part, pale: o.pale || 0 }], cam, { lineWidth: o.lineWidth || Math.max(1, scale * 0.028) });
  };

  LEGO.partSize = function partSize(spec, theta, phi) {
    const part = LEGO.place(Object.assign({}, spec, { at: [0, 0, 0] }));
    return LEGO.extent(LEGO.bounds([part]), theta, phi);
  };

  // Booklet arrow: red, white rim, pointing at (x1, y1).
  LEGO.arrow = function arrow(ctx, x0, y0, x1, y1, o) {
    const opt = o || {};
    const w = opt.width || 12;
    const head = opt.head || w * 2.1;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const L = Math.hypot(dx, dy);
    if (L < 1) return;
    const ux = dx / L;
    const uy = dy / L;
    const px = -uy;
    const py = ux;
    const bx = x1 - ux * head * 1.5;
    const by = y1 - uy * head * 1.5;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0 + (px * w) / 2, y0 + (py * w) / 2);
    ctx.lineTo(bx + (px * w) / 2, by + (py * w) / 2);
    ctx.lineTo(bx + px * head, by + py * head);
    ctx.lineTo(x1, y1);
    ctx.lineTo(bx - px * head, by - py * head);
    ctx.lineTo(bx - (px * w) / 2, by - (py * w) / 2);
    ctx.lineTo(x0 - (px * w) / 2, y0 - (py * w) / 2);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = w * 0.8;
    ctx.stroke();
    ctx.fillStyle = opt.color || '#D7192A';
    ctx.fill();
    ctx.restore();
  };
})(typeof window !== 'undefined' ? window : globalThis);
