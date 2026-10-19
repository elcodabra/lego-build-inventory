/*
 * booklet.js
 * Turns a model (a list of building steps) into a short film on a booklet page: parts list,
 * step number, parts dropping in, new parts outlined in yellow, earlier parts paler, a red
 * arrow for parts that slide in sideways, then a full turn of the finished model.
 *
 *   const film = LEGO.booklet({ title: 'Котик', theta: 35, phi: 28, steps: [[spec, ...], ...] }, 'horizontal');
 *   film.draw(ctx, t);   // film.W x film.H, a pure function of time
 *
 * Formats: 'vertical' 1080 x 1920 (default) and 'horizontal' 1920 x 1080, laid out like a
 * booklet page with the parts list and step number in a column on the left.
 * A spec with `from: [dx, dy, dz]` slides in from that offset instead of dropping from above.
 */
(function (root) {
  'use strict';

  const LEGO = root.LEGO;
  const FONT = 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif';
  const INK = '#1F2328';
  const PALE = 0.45;

  const LAYOUTS = {
    vertical: {
      W: 1080,
      H: 1920,
      area: { x0: 70, x1: 1010, y0: 560, y1: 1780 },
      callout: { x: 60, y: 150, maxW: 960 },
      title: { x: 58, y: 300 },
      footer: { x: 540, y: 1862, align: 'center' },
      badgeY: 64,
    },
    horizontal: {
      W: 1920,
      H: 1080,
      area: { x0: 600, x1: 1860, y0: 120, y1: 1020 },
      callout: { x: 60, y: 60, maxW: 480 },
      title: { x: 72, y: 250 },
      footer: { x: 64, y: 1036, align: 'left' },
      badgeY: 48,
    },
  };

  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const inOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const outCubic = (u) => 1 - Math.pow(1 - u, 3);
  const lerp = (a, b, u) => a + (b - a) * u;

  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function plural(n, forms) {
    const a = n % 100;
    const b = n % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b === 1) return forms[0];
    if (b >= 2 && b <= 4) return forms[1];
    return forms[2];
  }

  LEGO.booklet = function booklet(model, format, lang) {
    const EN = (lang || model.lang) === 'en';
    const T = EN
      ? { parts: (n) => n + ' ' + (n === 1 ? 'part' : 'parts'), steps: (n) => n + ' ' + (n === 1 ? 'step' : 'steps'), footer: 'Drawn with code · Canvas 2D' }
      : { parts: (n) => n + ' ' + plural(n, ['деталь', 'детали', 'деталей']), steps: (n) => n + ' ' + plural(n, ['шаг', 'шага', 'шагов']), footer: 'Нарисовано кодом · Canvas 2D' };
    const L = LAYOUTS[format] || LAYOUTS.vertical;
    const W = L.W;
    const H = L.H;
    const THETA = model.theta == null ? 45 : model.theta;
    const PHI = model.phi == null ? 30 : model.phi;
    const STEPS = model.steps;
    const PLACED = STEPS.map((st) => st.map((spec) => LEGO.place(spec)));
    const ALL = PLACED.flat();
    const COUNT = ALL.length;

    // ---------------------------------------------------------------- timing

    const T0 = 0.55; // first step
    const STEP = model.step || 0.85; // one step
    const FALL = 0.3; // a part falling into place
    const HOP = 0.14; // the little hop after it lands
    const LIFT = 2.6; // how high a part starts, in stud pitches
    const T_BUILD = T0 + STEPS.length * STEP;
    const T_SPIN0 = T_BUILD + 0.45;
    const T_SPIN1 = T_SPIN0 + 3.6;
    const DURATION = T_SPIN1 + 1.5;
    const stepStart = (k) => T0 + k * STEP;

    // ---------------------------------------------------------------- camera

    const AREA = L.area;
    const ACX = (AREA.x0 + AREA.x1) / 2;
    const ACY = (AREA.y0 + AREA.y1) / 2;

    function frameFor(parts, thetas, sMax) {
      const b = LEGO.bounds(parts);
      let s = sMax;
      for (const th of thetas) {
        const e = LEGO.extent(b, th, PHI);
        s = Math.min(s, (AREA.x1 - AREA.x0) / e.w, (AREA.y1 - AREA.y0) / e.h);
      }
      return { target: b.center, scale: s };
    }

    const FRAMES = [];
    {
      const acc = [];
      for (const st of PLACED) {
        acc.push(...st);
        FRAMES.push(frameFor(acc, [THETA], 118));
      }
    }
    const SPIN = [];
    for (let i = 0; i < 24; i++) SPIN.push(THETA + i * 15);
    const FINAL = frameFor(ALL, SPIN, 118);

    const mixFrame = (a, b, u) => ({
      target: [lerp(a.target[0], b.target[0], u), lerp(a.target[1], b.target[1], u), lerp(a.target[2], b.target[2], u)],
      scale: lerp(a.scale, b.scale, u),
    });

    function camAt(t) {
      let fr;
      let theta = THETA;
      if (t < T_BUILD) {
        const k = Math.max(0, Math.min(STEPS.length - 1, Math.floor((t - T0) / STEP)));
        const u = inOut(clamp((t - stepStart(k)) / 0.5));
        fr = mixFrame(FRAMES[Math.max(0, k - 1)], FRAMES[k], t < T0 ? 0 : u);
      } else {
        fr = mixFrame(FRAMES[STEPS.length - 1], FINAL, inOut(clamp((t - T_BUILD) / 0.45)));
        theta = THETA + 360 * inOut(clamp((t - T_SPIN0) / (T_SPIN1 - T_SPIN0)));
      }
      return LEGO.camera({ theta, phi: PHI, scale: fr.scale, cx: ACX, cy: ACY, target: fr.target });
    }

    // ---------------------------------------------------------------- parts in motion

    function partStart(k, i) {
      const stagger = Math.min(0.09, 0.4 / STEPS[k].length);
      return stepStart(k) + 0.08 + i * stagger;
    }

    function itemsAt(t) {
      const items = [];
      const built = t >= T_BUILD;
      const settle = clamp((t - T_BUILD) / 0.4);
      const last = STEPS.length - 1;
      for (let k = 0; k < STEPS.length; k++) {
        if (t < stepStart(k)) break;
        const ended = t - (stepStart(k) + STEP);
        for (let i = 0; i < STEPS[k].length; i++) {
          const spec = STEPS[k][i];
          const t0 = partStart(k, i);
          if (t < t0) continue;
          const u = clamp((t - t0) / FALL);
          let move;
          if (spec.from) {
            const e = outCubic(clamp((t - t0) / (FALL * 1.6)));
            move = spec.from.map((c) => c * (1 - e));
          } else {
            const v = (t - t0 - FALL) / HOP;
            const hop = v > 0 && v < 1 ? 0.07 * Math.sin(Math.PI * v) : 0;
            move = [0, 0, LIFT * (1 - u * u) + hop];
          }
          let pale = 0;
          let halo = 0;
          if (!built) {
            const w = clamp(ended / 0.18);
            halo = 1 - w;
            pale = PALE * w;
          } else if (k === last) {
            halo = 1 - settle;
          } else {
            pale = PALE * (1 - settle);
          }
          items.push({ part: PLACED[k][i], move, alpha: clamp(u / 0.12), pale, halo });
        }
      }
      return items;
    }

    // Booklet arrow beside a part that slides in, below its path and clear of it.
    function arrows(ctx, t, cam) {
      for (let k = 0; k < STEPS.length; k++) {
        const s0 = stepStart(k);
        if (t < s0 || t > s0 + STEP) continue;
        STEPS[k].forEach((spec, i) => {
          if (!spec.from) return;
          const b = LEGO.bounds([PLACED[k][i]]);
          const c = b.center;
          const f = spec.from;
          const a = clamp((t - s0) / 0.12) * (1 - clamp((t - (s0 + STEP - 0.2)) / 0.2));
          const p0 = cam.project([c[0] + f[0], c[1] + f[1], c[2] + f[2]]);
          const p1 = cam.project([c[0] + f[0] * 0.2, c[1] + f[1] * 0.2, c[2] + f[2] * 0.2]);
          const dx = p1[0] - p0[0];
          const dy = p1[1] - p0[1];
          const len = Math.hypot(dx, dy) || 1;
          let nx = -dy / len;
          let ny = dx / len;
          if (ny < 0) {
            nx = -nx;
            ny = -ny;
          }
          const e = LEGO.extent(b, THETA, PHI);
          const off = 0.45 * Math.max(e.w, e.h) * cam.scale + 22;
          ctx.save();
          ctx.globalAlpha = a;
          LEGO.arrow(ctx, p0[0] + nx * off, p0[1] + ny * off, p1[0] + nx * off, p1[1] + ny * off, { width: 13 });
          ctx.restore();
        });
      }
    }

    // ---------------------------------------------------------------- page

    function badge(ctx) {
      const label = model.title;
      ctx.save();
      ctx.font = 'bold 34px ' + FONT;
      const tw = ctx.measureText(label).width;
      const h = 64;
      const w = tw + 104;
      const x = W - 56 - w;
      const y = L.badgeY;
      rrect(ctx, x, y, w, h, h / 2);
      ctx.fillStyle = '#FFD21A';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x + 33, y + h / 2, 22, 0, 2 * Math.PI);
      ctx.fillStyle = INK;
      ctx.fill();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 27px ' + FONT;
      ctx.fillText('1', x + 33, y + h / 2 + 1);
      ctx.textAlign = 'left';
      ctx.fillStyle = INK;
      ctx.font = 'bold 34px ' + FONT;
      ctx.fillText(label, x + 66, y + h / 2 + 1);
      ctx.restore();
    }

    // Parts of each step, grouped like the booklet: one picture per part and colour, with a count,
    // flowed into rows that fit the box.
    const PAD = 28;
    const GAP = 34;
    const LABEL = 50;
    const CALLOUTS = STEPS.map((st) => {
      const groups = [];
      const by = new Map();
      for (const s of st) {
        const key = s.id + '|' + s.color + '|' + (s.up || '');
        if (by.has(key)) {
          by.get(key).n++;
          continue;
        }
        const spec = Object.assign({}, s, { at: [0, 0, 0] });
        const e = LEGO.partSize(spec, THETA, PHI);
        const g = { spec, n: 1, w: e.w, h: e.h };
        by.set(key, g);
        groups.push(g);
      }
      const inner = L.callout.maxW - 2 * PAD;
      const s = Math.min(34, inner / Math.max(...groups.map((g) => g.w)));
      const rows = [];
      let row = null;
      for (const g of groups) {
        const w = g.w * s;
        if (!row || row.w + GAP + w > inner) {
          row = { items: [], w: -GAP, h: 0 };
          rows.push(row);
        }
        row.items.push(g);
        row.w += GAP + w;
        row.h = Math.max(row.h, g.h * s);
      }
      const bw = Math.max(...rows.map((r) => r.w)) + 2 * PAD;
      const bh = rows.reduce((acc, r) => acc + r.h + LABEL, 0) + 2 * PAD - 10;
      return { s, rows, bw, bh };
    });

    function callout(ctx, k, a) {
      const c = CALLOUTS[k];
      const x = L.callout.x;
      const y = L.callout.y;
      const pop = 0.94 + 0.06 * outCubic(a);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(x, y);
      ctx.scale(pop, pop);
      ctx.translate(-x, -y);
      rrect(ctx, x, y, c.bw, c.bh, 16);
      ctx.fillStyle = '#DDE8F5';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#A9C0DD';
      ctx.stroke();
      let ry = y + PAD;
      for (const r of c.rows) {
        let cx = x + PAD;
        for (const g of r.items) {
          const pw = g.w * c.s;
          const ph = g.h * c.s;
          LEGO.drawPart(ctx, g.spec, cx + pw / 2, ry + r.h - ph / 2, c.s, { theta: THETA, phi: PHI });
          ctx.fillStyle = INK;
          ctx.font = 'bold 30px ' + FONT;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(g.n + 'x', cx, ry + r.h + 42);
          cx += pw + GAP;
        }
        ry += r.h + LABEL;
      }
      ctx.restore();
      return y + c.bh * pop;
    }

    function ui(ctx, t) {
      badge(ctx);
      if (t >= T0 && t < T_BUILD + 0.35) {
        const k = Math.min(STEPS.length - 1, Math.floor((t - T0) / STEP));
        const a = clamp((t - stepStart(k)) / 0.14) * (1 - clamp((t - T_BUILD) / 0.3));
        const bottom = callout(ctx, k, a);
        ctx.save();
        ctx.globalAlpha = a;
        ctx.fillStyle = INK;
        ctx.font = 'bold 128px ' + FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(String(k + 1), L.callout.x - 2, bottom + 128);
        ctx.restore();
      }
      const end = clamp((t - (T_SPIN1 - 0.6)) / 0.5);
      if (end > 0) {
        const n = STEPS.length;
        ctx.save();
        ctx.globalAlpha = end;
        ctx.fillStyle = INK;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        // long titles ("Пожарная машина") shrink to fit the frame width
        let size = 112;
        ctx.font = 'bold ' + size + 'px ' + FONT;
        while (size > 56 && ctx.measureText(model.title).width > W - 2 * L.title.x) ctx.font = 'bold ' + (size -= 4) + 'px ' + FONT;
        ctx.fillText(model.title, L.title.x, L.title.y);
        ctx.fillStyle = '#5B6470';
        ctx.font = '40px ' + FONT;
        ctx.fillText(
          T.parts(COUNT) + ' · ' + T.steps(n),
          L.title.x + 4,
          L.title.y + 72
        );
        ctx.restore();
      }
      ctx.save();
      ctx.fillStyle = '#8A919B';
      ctx.font = '26px ' + FONT;
      ctx.textAlign = L.footer.align;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(T.footer, L.footer.x, L.footer.y);
      ctx.restore();
    }

    function draw(ctx, t) {
      ctx.save();
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, W, H);
      const cam = camAt(t);
      LEGO.draw(ctx, itemsAt(t), cam);
      arrows(ctx, t, cam);
      ui(ctx, t);
      ctx.restore();
    }

    // Everything the frame at t depends on, rounded to what can show on screen. Two times with the
    // same signature draw the same picture, so a renderer can reuse the previous frame (the pause
    // after each step and the hold at the end are still). Conservative: any doubt -> different.
    // fine enough that a change smaller than a pixel on a 2000 px frame still counts as a change
    const r3 = (v) => Math.round(v * 1e6);
    function signature(t) {
      const cam = camAt(t);
      const parts = itemsAt(t).map((it) => [r3(it.move[0]), r3(it.move[1]), r3(it.move[2]), r3(it.alpha), r3(it.pale), r3(it.halo)].join(','));
      // arrows and the callout fade in/out on their own clocks: include the time while one shows
      let busy = false;
      for (let k = 0; k < STEPS.length && !busy; k++) {
        const s0 = stepStart(k);
        if (t >= s0 && t <= s0 + STEP && STEPS[k].some((spec) => spec.from)) busy = true;
      }
      const k = Math.min(STEPS.length - 1, Math.max(0, Math.floor((t - T0) / STEP)));
      const callout = t >= T0 && t < T_BUILD + 0.35 ? [k, r3(clamp((t - stepStart(k)) / 0.14) * (1 - clamp((t - T_BUILD) / 0.3)))].join(':') : '-';
      const end = r3(clamp((t - (T_SPIN1 - 0.6)) / 0.5));
      // the spin: exact angle (the last frames of an ease-out differ by far less than a rounding step)
      const spin = t < T_BUILD ? 0 : 360 * inOut(clamp((t - T_SPIN0) / (T_SPIN1 - T_SPIN0)));
      return [r3(cam.scale), cam.target.map(r3).join(','), spin, busy ? 't' + r3(t) : '', callout, end, parts.join(';')].join('|');
    }

    return { W, H, duration: DURATION, draw, signature, parts: COUNT, steps: STEPS.length, title: model.title };
  };

  // A film that opens on the photo of the user's pile (table removed): ~2 s of "here is what you
  // have", then the pile fades and the build starts. `image` is a decoded, drawable image (both
  // the browser and @napi-rs/canvas pass one in); the build itself is the plain booklet, shifted.
  const INTRO = 2.6;
  LEGO.bookletWithPile = function bookletWithPile(model, format, image, lang) {
    const film = LEGO.booklet(model, format, lang);
    if (!image) return film;
    const EN = (lang || model.lang) === 'en';
    const L = LAYOUTS[format] || LAYOUTS.vertical;
    const W = film.W;
    const H = film.H;
    const n = film.parts;
    function pile(ctx, t) {
      ctx.save();
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, W, H);
      // the photo, fitted into the model area, easing in slightly; fades out in the last 0.5 s
      const A = L.area;
      const aw = A.x1 - A.x0;
      const ah = A.y1 - A.y0;
      const k = Math.min(aw / image.width, ah / image.height);
      const zoom = 0.94 + 0.06 * outCubic(clamp(t / 1.2));
      const out = clamp((t - (INTRO - 0.5)) / 0.5);
      const w = image.width * k * zoom;
      const h = image.height * k * zoom;
      ctx.globalAlpha = clamp(t / 0.35) * (1 - out);
      ctx.drawImage(image, A.x0 + (aw - w) / 2, A.y0 + (ah - h) / 2, w, h);
      // caption where the parts list sits during the build
      ctx.globalAlpha = clamp((t - 0.2) / 0.35) * (1 - out);
      ctx.fillStyle = INK;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = 'bold 72px ' + FONT;
      ctx.fillText(EN ? 'My bricks' : 'Мои детали', L.callout.x, L.callout.y + 80);
      ctx.fillStyle = '#5B6470';
      ctx.font = '40px ' + FONT;
      ctx.fillText(EN ? 'Building: ' + model.title + ' · ' + n + ' ' + (n === 1 ? 'part' : 'parts') : 'Из них: ' + model.title + ' · ' + n + ' ' + plural(n, ['деталь', 'детали', 'деталей']), L.callout.x + 2, L.callout.y + 150);
      ctx.restore();
    }
    return {
      W, H, parts: film.parts, steps: film.steps, title: film.title,
      duration: film.duration + INTRO,
      draw(ctx, t) {
        if (t < INTRO) pile(ctx, t);
        else film.draw(ctx, t - INTRO);
      },
      signature(t) {
        // the intro moves all the time except for a short hold: always draw it
        if (t < INTRO) return null;
        return film.signature ? film.signature(t - INTRO) : null;
      },
    };
  };
  LEGO.PILE_INTRO = INTRO;
})(typeof window !== 'undefined' ? window : globalThis);
