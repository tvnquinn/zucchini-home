// Agility run: Zucchini runs the course twice (8 obstacles a lap, 16 in all) and taps time each one. A clean pass is quick; a wobbly
// pass is slower but never a fall. The score is the total course time in tenths of a second, so lower is better.
// Five obstacles come from the destination art (jump, weave, tunnel, ramp, hoop). Three are drawn here in code and exist only in this game:
// a teeter-totter (the plank tips as she crosses the middle), a pause table (she hops up, sits for a count of three, hops off) and a double bar jump.
const HOOP_LIFT = 7;
const LEAPS = { jump: 24, hoop: HOOP_LIFT, double: 34 }, DURATION = { jump: 1100, hoop: 1100, weave: 1550, tunnel: 950, ramp: 950, teeter: 1500, double: 1500 };
const WOB_LIFT = { double: .6 }; // a wobbly leap keeps this share of its height (half by default); the double must still clear its bars
// Pause table, in ms: crouch, sniff, hop up, sit, hop down, land. A wobbly pass sniffs first and climbs slower.
const TABLE = { clean: [150, 0, 380, 1000, 380, 150], wobbly: [150, 450, 600, 1000, 400, 150] }, TABLE_TOP = 17, TIP_MS = 250;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const CROUCH = .18, LANDING = .15, RAMP_UP = .38, RAMP_DOWN = .62, RAMP_LIFT = 27;
const LAPS = 2, RUN_SPEED = .11, WOBBLY = 1.6, SHAKE_MS = 700, AUTO_MS = 3000, GRACE_MS = 250, FINISH_MS = 1600, POP_MS = 900;
const METER = { w: 120, h: 12 };
const lerp = (a, b, k) => a + (b - a) * k;

// ---------------------------------------------------------------- the three new obstacles, drawn as isometric pixel art
// a runs along her path, b across it, h is height. Each piece is painted far to near into a pixel map, then cached as runs of one colour.
const OUT = "#2b2233", SHADOW = "rgba(24,56,20,.28)", WOOD = ["#e0b27a", "#b98448", "#946334"], BLUE = ["#4a90d9", "#2f69a8", "#255488"], RED = ["#e0503f", "#b83a2c", "#962e23"], WHITE = ["#f6f2ea", "#cfc8bb", "#aaa397"], YEL = ["#f4c430", "#c99a1c", "#a67d14"];
const iso = (a, b, h) => [b - a, -(a + b) / 2 - h];
const key = (x, y) => (y + 512) * 1024 + x + 512;
function fillPoly(pts, put) {
  let y0 = Infinity, y1 = -Infinity;
  for (const q of pts) { y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    const yc = y + .5, xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= yc) !== (by <= yc)) xs.push(ax + (yc - ay) / (by - ay) * (bx - ax));
    }
    xs.sort((m, n) => m - n);
    for (let j = 0; j + 1 < xs.length; j += 2) for (let x = Math.round(xs[j]); x < Math.round(xs[j + 1]); x++) put(x, y);
  }
}
class Art {
  px = new Map();
  // faces: [points, colour] painted in order; the union gets a 1 px dark outline unless outline is false.
  shape(faces, outline = true) {
    const mine = new Map();
    for (const [pts, col] of faces) fillPoly(pts, (x, y) => mine.set(key(x, y), col));
    if (outline) for (const k of mine.keys()) for (const d of [1, -1, 1024, -1024]) if (!mine.has(k + d)) this.px.set(k + d, OUT);
    for (const [k, col] of mine) this.px.set(k, col);
  }
  // A box with its near faces: front (a low), side (b low) and top; cols is [top, front, side].
  box(a0, a1, b0, b1, h0, h1, cols, outline = true) {
    this.shape([
      [[iso(a0, b0, h0), iso(a0, b1, h0), iso(a0, b1, h1), iso(a0, b0, h1)], cols[1]],
      [[iso(a0, b0, h0), iso(a1, b0, h0), iso(a1, b0, h1), iso(a0, b0, h1)], cols[2]],
      [[iso(a0, b0, h1), iso(a1, b0, h1), iso(a1, b1, h1), iso(a0, b1, h1)], cols[0]],
    ], outline);
  }
  ground(a, b) { fillPoly([iso(-a, -b, 0), iso(a, -b, 0), iso(a, b, 0), iso(-a, b, 0)], (x, y) => this.px.set(key(x, y), SHADOW)); }
  runs() {
    const rows = new Map();
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [k, col] of this.px) {
      const x = k % 1024 - 512, y = Math.floor(k / 1024) - 512;
      (rows.get(y) ?? rows.set(y, []).get(y)).push([x, col]);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1);
    }
    const rects = [];
    for (const [y, row] of rows) {
      row.sort((m, n) => m[0] - n[0]);
      for (let i = 0; i < row.length;) {
        let j = i + 1;
        while (j < row.length && row[j][0] === row[j - 1][0] + 1 && row[j][1] === row[i][1]) j++;
        rects.push([row[i][1], row[i][0], y, j - i, 1]);
        i = j;
      }
    }
    return { rects, ox: x0, oy: y0, w: x1 - x0, h: y1 - y0 };
  }
}

// Teeter-totter: a plank on a fulcrum. tilt is -1 (entry end down) to 1 (far end down).
const TEETER = { L: 44, w: 10, H: 9, T: 3 };
const plankH = (a, tilt) => TEETER.H - tilt * a * TEETER.H / TEETER.L;
function drawTeeter(tilt) {
  const { L, w, H, T } = TEETER, art = new Art(), h = (a) => plankH(a, tilt);
  art.ground(L + 3, w + 3);
  art.box(-7, 7, -w + 2, w - 2, 0, H, WOOD);
  art.shape([
    [[iso(-L, -w, h(-L)), iso(L, -w, h(L)), iso(L, -w, h(L) + T), iso(-L, -w, h(-L) + T)], BLUE[1]],
    [[iso(-L, -w, h(-L)), iso(-L, w, h(-L)), iso(-L, w, h(-L) + T), iso(-L, -w, h(-L) + T)], BLUE[2]],
    [[iso(-L, -w, h(-L) + T), iso(L, -w, h(L) + T), iso(L, w, h(L) + T), iso(-L, w, h(-L) + T)], BLUE[0]],
  ]);
  for (const [a0, a1] of [[-L, -L + 11], [L - 11, L]]) {
    art.shape([[[iso(a0, -w, h(a0) + T), iso(a1, -w, h(a1) + T), iso(a1, w, h(a1) + T), iso(a0, w, h(a0) + T)], YEL[0]]], false);
    art.shape([[[iso(a0, -w, h(a0)), iso(a1, -w, h(a1)), iso(a1, -w, h(a1) + T), iso(a0, -w, h(a0) + T)], YEL[1]]], false);
  }
  return art.runs();
}

// Pause table: a low square table with a white-edged blue top on yellow legs.
function drawTable() {
  const art = new Art(), A = 18, top = TABLE_TOP;
  art.ground(A + 3, A + 3);
  for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) art.box(a * 15 - 1.5, a * 15 + 1.5, b * 15 - 1.5, b * 15 + 1.5, 0, top - 3, YEL);
  art.box(-A, A, -A, A, top - 3, top, [WHITE[0], BLUE[1], BLUE[2]]);
  art.shape([[[iso(-A + 3, -A + 3, top), iso(A - 3, -A + 3, top), iso(A - 3, A - 3, top), iso(-A + 3, A - 3, top)], BLUE[0]]], false);
  return art.runs();
}

// Double bar jump: two bar jumps a stride apart (the far bar a little higher), striped bars between wooden uprights.
function drawDouble() {
  const art = new Art(), B = 26;
  art.ground(22, B + 3);
  for (const [a, bar] of [[12, 23], [-12, 18]]) {
    art.box(a - 1.5, a + 1.5, B - 1.5, B + 1.5, 0, 28, WOOD);
    const seg = (b0, b1, col) => {
      art.shape([[[iso(a - 1.5, b0, bar), iso(a - 1.5, b1, bar), iso(a - 1.5, b1, bar + 3), iso(a - 1.5, b0, bar + 3)], col[0]]], false);
      art.shape([[[iso(a - 1.5, b0, bar + 3), iso(a + 1.5, b0, bar + 3), iso(a + 1.5, b1, bar + 3), iso(a - 1.5, b1, bar + 3)], col[1]]], false);
    };
    art.shape([[[iso(a - 1.5, -B, bar), iso(a - 1.5, B, bar), iso(a - 1.5, B, bar + 3), iso(a - 1.5, -B, bar + 3)], WHITE[0]], [[iso(a - 1.5, -B, bar + 3), iso(a + 1.5, -B, bar + 3), iso(a + 1.5, B, bar + 3), iso(a - 1.5, B, bar + 3)], WHITE[1]]]);
    for (let b = -B; b < B; b += 10) seg(b, Math.min(B, b + 5), [RED[0], RED[1]]);
    art.box(a - 1.5, a + 1.5, -B - 1.5, -B + 1.5, 0, 28, WOOD);
  }
  return art.runs();
}
const ART = {}, NEW_ART = { teeter: (t) => drawTeeter(t), table: drawTable, double: drawDouble };
// Cached art for a new obstacle; the teeter is drawn at 7 tilt steps.
export function artFor(name, tilt = -1) {
  const q = name === "teeter" ? Math.round((tilt + 1) * 3) : 0, k = name + q;
  return ART[k] ??= NEW_ART[name](q / 3 - 1);
}
// Where the new obstacles sit on the open grass (the course runs hoop, teeter, table, double, back to the jump).
const EXTRA = [
  { object: "teeter", x: 318, y: 282, scale: .94, facing: "NW", custom: true },
  { object: "table", x: 245, y: 236, scale: .94, facing: "SW", custom: true },
  { object: "double", x: 160, y: 278, scale: .94, facing: "NW", custom: true },
];
const boxOf = (env, p) => { if (!p.custom) return env.objectBox("agility", p); const a = artFor(p.object); return [p.x + a.ox, p.y + a.oy, a.w, a.h]; };
const TEE_PAD = TEETER.L + 8;
function customPoints(p) {
  if (p.object === "teeter") return { start: [p.x + TEE_PAD, p.y + TEE_PAD / 2], exit: [p.x - TEE_PAD, p.y - TEE_PAD / 2], geo: { kind: "teeter", y: p.y, x: p.x, face: "NW" } };
  if (p.object === "table") return { start: [p.x + 34, p.y + 12], exit: [p.x - 34, p.y + 14], geo: { kind: "table", y: p.y, top: [p.x, p.y], face: "SW" } };
  return { start: [p.x + 36, p.y + 18], exit: [p.x - 36, p.y - 18], geo: { kind: "double", y: p.y, face: "NW" } };
}

// Offsets measured on the sprites, relative to the placement at scale .94, for the facing in `at`; the mirrored facing negates dx.
const MEASURED = {
  weave: { at: ["SE", "SW"], S: [-38, -5], E: [31, -33], n: [.371, .928], amp: 8 },
  tunnel: { at: ["NE", "NW"], pts: [[-26, 16], [-27, -8], [33, -18], [50, -27]] },
  ramp: { at: ["SW", "SE"], pts: [[-48, -8], [-38, -12], [-5, -52], [18, 0], [30, 6]] },
  hoop: { at: ["SE", "SW"], pts: [[-21, -20], [25, 4]] },
};
const faceSeg = (dx, dy) => (dy < -2 ? (dx >= 0 ? "NE" : "NW") : side(dx));

// Where she waits before an obstacle and where she lands after it (same geometry as the neighborhood outings).
function points(env, p) {
  if (p.custom) return customPoints(p);
  const w = env.objectBox("agility", p)[2], m = MEASURED[p.object], i = m ? m.at.indexOf(p.facing) : -1;
  if (i >= 0) {
    const k = (p.scale ?? .94) / .94, mir = i ? -1 : 1, at = ([x, y]) => [p.x + x * k * mir, p.y + y * k];
    if (m.S) {
      const S = at(m.S), E = at(m.E);
      return { start: S, exit: E, geo: { kind: "weave", S, E, n: [m.n[0] * mir, m.n[1]], amp: m.amp * k, y: p.y, face: mir > 0 ? "NE" : "NW" } };
    }
    const pts = m.pts.map(at);
    if (p.object === "hoop") return { start: pts[0], exit: pts[1], geo: { kind: "hoop", y: p.y } };
    const cum = [0];
    for (let j = 1; j < pts.length; j++) cum.push(cum[j - 1] + Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]));
    return { start: pts[0], exit: pts[pts.length - 1], geo: { kind: p.object, pts, cum, y: p.y, face: p.object === "tunnel" ? (mir > 0 ? "NE" : "NW") : faceSeg(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) } };
  }
  if (LEAPS[p.object]) {
    const dx = ["SE", "NW"].includes(p.facing) ? 26 : -26;
    return { start: [p.x - dx, p.y - 19], exit: [p.x + dx, p.y + 7] };
  }
  return { start: [p.x - Math.max(18, w * .35), p.y + 16], exit: [p.x + Math.max(20, w * .38), p.y + 10] };
}
const side = (dx) => (dx >= 0 ? "SE" : "SW");

// Her draw order against the obstacle (null: by y). The weave puts her behind it while on the far side of a pole.
const LAT = (u) => 8 * Math.sin(4 * Math.PI * u - Math.PI / 2) * Math.min(1, 4 * u, 4 * (1 - u));
const zAt = (g, k) => !g ? null : ["ramp", "teeter", "table", "double"].includes(g.kind) ? g.y + 1 : g.kind === "weave" ? g.y + (LAT(k) < 0 ? -1 : 1) : g.kind === "hoop" ? g.y + (k < .5 ? -1 : 1) : null;

function nextTarget(s) {
  const o = s.course[s.index];
  s.phase = "run"; s.target = o.start; s.clip = "run"; s.frame = null; s.lift = 0; s.hide = false; s.z = zAt(o.geo, 0); s.dots = null;
  if (o.p.object === "teeter") s.tip = -1; // the plank rests with its entry end down until she steps on
}

function startMeter(s, now) {
  const i = s.index, last = s.course.length - 1, w = lerp(.30, .16, i / last);
  s.phase = "meter"; s.clip = "idle"; s.frame = null; s.meterAt = s.t;
  s.meter = { zone: [0, 0], pos: 0, sweep: lerp(1100, 600, i / last) };
  const lo = s.env.rng() * (1 - w);
  s.meter.zone = [lo, lo + w];
}

function startTraverse(s, clean) {
  const o = s.course[s.index];
  s.phase = "traverse"; s.clean = clean; s.trav = { at: s.t, from: [...s.pos], to: o.exit, dur: o.p.object === "table" ? sum(TABLE[clean ? "clean" : "wobbly"]) : DURATION[o.p.object] * (clean ? 1 : WOBBLY) };
  if (clean) s.cleanCount++;
  s.pop = { text: clean ? "Clean!" : "Wobbly!", at: s.t };
  s.facing = o.geo?.face ?? side(o.exit[0] - s.pos[0]);
}

function finishObstacle(s) {
  s.index++; s.lift = 0; s.hide = false; s.frame = null;
  if (s.index >= s.course.length) { s.phase = "finish"; s.finishAt = s.t; s.final = s.t; s.clip = "happy"; return; }
  if (!s.clean && LEAPS[s.course[s.index - 1].p.object]) { s.phase = "shake"; s.shakeAt = s.t; s.clip = "sneeze"; return; }
  nextTarget(s);
}

// She walks the plank; at the middle it tips over TIP_MS, and she steps down off the far end.
function stepTeeter(s, o, k) {
  const g = o.geo, L = TEETER.L, a = lerp(-TEE_PAD, TEE_PAD, k), tipK = Math.min(1, Math.max(0, (k - .5) * s.trav.dur / TIP_MS));
  s.tip = -1 + 2 * tipK * tipK * (3 - 2 * tipK);
  s.pos = [g.x - a, o.p.y - a / 2]; s.facing = g.face; s.clip = "walk";
  s.lift = Math.abs(a) <= L ? Math.max(0, plankH(a, s.tip)) + TEETER.T * Math.min(1, (L - Math.abs(a)) / 4) : 0;
}

// Hop up, sit for the count (dots fill), hop down. A wobbly pass sniffs first. Segments are TABLE ms.
function stepTable(s, o, e) {
  const seg = TABLE[s.clean ? "clean" : "wobbly"], g = o.geo, hop = (u) => 10 * 4 * u * (1 - u);
  let x = e, i = 0;
  while (i < seg.length - 1 && x >= seg[i]) x -= seg[i++];
  const u = seg[i] ? Math.min(1, x / seg[i]) : 1, st = o.start, top = g.top, ex = o.exit;
  s.facing = g.face; s.pos = [...st]; s.clip = "couch_enter"; s.frame = 0; s.lift = 0; s.dots = null;
  if (i === 1) { s.clip = "sniff"; s.frame = null; }
  else if (i === 2) { s.pos = [lerp(st[0], top[0], u), lerp(st[1], top[1], u)]; s.lift = TABLE_TOP * u + hop(u); s.frame = 1; }
  else if (i === 3) { s.pos = [...top]; s.lift = TABLE_TOP; s.clip = "sit"; s.frame = null; s.dots = u * 3; }
  else if (i === 4) { s.pos = [lerp(top[0], ex[0], u), lerp(top[1], ex[1], u)]; s.lift = TABLE_TOP * (1 - u) + hop(u); s.clip = "couch_exit"; }
  else if (i === 5) { s.pos = [...ex]; s.clip = "couch_exit"; s.frame = 1; }
}

function stepTraverse(s) {
  const o = s.course[s.index], a = s.trav, obj = o.p.object, g = o.geo, k = Math.min(1, (s.t - a.at) / a.dur), leap = LEAPS[obj];
  let travel = k;
  s.hide = false; s.lift = 0; s.frame = null; s.z = zAt(g, k);
  if (obj === "teeter" || obj === "table") {
    if (obj === "teeter") stepTeeter(s, o, k); else stepTable(s, o, s.t - a.at);
    if (k >= 1) finishObstacle(s);
    return;
  }
  if (g && g.kind !== "hoop" && g.kind !== "double") {
    s.clip = "run";
    if (g.kind === "weave") {
      const l = LAT(k) * g.amp / 8;
      s.pos = [lerp(g.S[0], g.E[0], k) + g.n[0] * l, lerp(g.S[1], g.E[1], k) + g.n[1] * l];
      s.facing = g.face;
    } else {
      const d = k * g.cum[g.cum.length - 1];
      let i = 1;
      while (i < g.cum.length - 1 && d > g.cum[i]) i++;
      const t = Math.min(1, (d - g.cum[i - 1]) / (g.cum[i] - g.cum[i - 1])), p0 = g.pts[i - 1], p1 = g.pts[i];
      s.pos = [lerp(p0[0], p1[0], t), lerp(p0[1], p1[1], t)];
      if (obj === "tunnel") { s.facing = g.face; s.hide = d > g.cum[1] && d < g.cum[2]; }
      else { s.facing = faceSeg(p1[0] - p0[0], p1[1] - p0[1]); s.clip = d <= g.cum[2] ? "walk" : "run"; }
    }
    if (k >= 1) finishObstacle(s);
    return;
  }
  if (leap) {
    const u = Math.min(1, Math.max(0, (k - CROUCH) / (1 - CROUCH - LANDING)));
    // The hoop's ground midpoint must sit under the hole, so it travels evenly; the jump eases.
    travel = g?.kind === "hoop" ? u : 1 - (1 - u) ** 2;
    s.lift = leap * (s.clean ? 1 : WOB_LIFT[obj] ?? .5) * 4 * u * (1 - u);
    if (g?.kind === "hoop") s.z = g.y + (u < .5 ? -1 : 1);
    const crouch = k < CROUCH, rise = !crouch && u < .5;
    s.clip = crouch || rise ? "couch_enter" : "couch_exit";
    s.frame = crouch ? 0 : rise || u >= 1 ? 1 : 0;
  } else if (obj === "ramp") {
    s.lift = RAMP_LIFT * (k < RAMP_UP ? k / RAMP_UP : k < RAMP_DOWN ? 1 : (1 - k) / (1 - RAMP_DOWN));
    s.clip = k < RAMP_UP ? "walk" : "run";
  } else s.clip = "run";
  s.pos = [lerp(a.from[0], a.to[0], travel), lerp(a.from[1], a.to[1], travel)];
  if (obj === "weave") s.pos[1] += Math.sin(k * Math.PI * 6) * 10;
  s.hide = obj === "tunnel" && k > .28 && k < .72;
  if (k >= 1) finishObstacle(s);
}

export const agilityRun = {
  id: "agility", title: "Agility run", scenes: ["agility"], how: "Tap when the needle is in the green for a clean pass.", unit: "", lower: true, maxScore: 3000,
  format: (score) => (score / 10).toFixed(1) + " s",
  create(env) {
    const sc = env.scene("agility"), all = env.placements("agility");
    const objs = [...sc.course_order.map((name) => all.find((p) => p.object === name)).filter(Boolean), ...EXTRA];
    const course = [];
    for (let lap = 0; lap < LAPS; lap++) for (const p of objs) course.push({ p, ...points(env, p) });
    const s = { env, course, scene: sc, objs, index: 0, t: 0, final: 0, cleanCount: 0, pos: [sc.dog[0], sc.dog[1]], facing: "SE", clip: "run", frame: null, lift: 0, hide: false, z: null, phase: "run", tip: -1, dots: null, target: null, meter: null, pop: null, clean: false };
    nextTarget(s);
    return s;
  },
  step(s, dt) {
    dt = Math.max(0, Math.min(100, dt));
    s.t += dt;
    if (s.phase === "run") {
      let left = dt * RUN_SPEED;
      const dx = s.target[0] - s.pos[0], dy = s.target[1] - s.pos[1], d = Math.hypot(dx, dy);
      if (d > 1) s.facing = dy < -2 ? (dx >= 0 ? "NE" : "NW") : side(dx);
      if (d <= left) { s.pos = [...s.target]; startMeter(s); }
      else { s.pos = [s.pos[0] + dx / d * left, s.pos[1] + dy / d * left]; }
    } else if (s.phase === "meter") {
      const m = s.meter, e = s.t - s.meterAt, ph = (e % (2 * m.sweep)) / m.sweep;
      m.pos = ph < 1 ? ph : 2 - ph;
      const o = s.course[s.index];
      s.facing = o.geo?.face ?? side(o.exit[0] - s.pos[0]);
      if (e >= AUTO_MS) startTraverse(s, false);
    } else if (s.phase === "traverse") stepTraverse(s);
    else if (s.phase === "shake") { if (s.t - s.shakeAt >= SHAKE_MS) nextTarget(s); }
  },
  pointer(s, kind) {
    if (kind !== "down" || s.phase !== "meter" || s.t - s.meterAt < GRACE_MS) return;
    const m = s.meter;
    startTraverse(s, m.pos >= m.zone[0] && m.pos <= m.zone[1]);
  },
  draw(ctx, s, now) {
    const env = s.env;
    env.drawBackground(ctx, "agility");
    const items = s.objs.map((p) => ({ y: p.y, p }));
    if (!s.hide) items.push({ y: s.z ?? s.pos[1], dog: true });
    items.sort((a, b) => a.y - b.y); // stable: on a tie the objects, pushed first, draw first
    for (const it of items) {
      if (it.dog) env.drawDog(ctx, { x: s.pos[0], y: s.pos[1], clip: s.clip, facing: s.facing, frame: s.frame, lift: s.lift, z: s.z ?? s.pos[1], scale: .7, fast: s.phase === "run" || s.phase === "traverse", now });
      else if (it.p.custom) {
        const art = artFor(it.p.object, s.tip), ox = it.p.x, oy = it.p.y;
        for (const [col, x, y, w, h] of art.rects) { ctx.fillStyle = col; ctx.fillRect(ox + x, oy + y, w, h); }
      } else env.drawObject(ctx, "agility", it.p);
    }
    if (s.dots != null) { // the pause count: three dots fill while she sits
      for (let i = 0; i < 3; i++) {
        const x = s.pos[0] + (i - 1) * 11, y = s.pos[1] - s.lift - 66, f = Math.max(0, Math.min(1, s.dots - i));
        ctx.fillStyle = "rgba(32,54,83,.85)"; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#e9e2cf"; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
        if (f > 0) { ctx.fillStyle = "#5fbf6a"; ctx.beginPath(); ctx.arc(x, y, 3 * f, 0, Math.PI * 2); ctx.fill(); }
      }
    }
    ctx.textAlign = "center";
    if (s.index < s.course.length) {
      const p = s.course[s.index].p, b = boxOf(env, p), by = Math.max(12, b[1] - 9);
      ctx.fillStyle = "#203653"; ctx.beginPath(); ctx.arc(p.x, by, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "white"; ctx.font = "bold 10px system-ui"; ctx.fillText(String(s.index % s.objs.length + 1), p.x, by + 3);
    }
    if (s.phase === "meter") {
      const m = s.meter, x = Math.max(4, Math.min(480 - METER.w - 4, s.pos[0] - METER.w / 2)), y = Math.max(22, s.pos[1] - 78);
      ctx.fillStyle = "rgba(32,54,83,.85)"; ctx.fillRect(x - 2, y - 2, METER.w + 4, METER.h + 4);
      ctx.fillStyle = "#e9e2cf"; ctx.fillRect(x, y, METER.w, METER.h);
      ctx.fillStyle = "#5fbf6a"; ctx.fillRect(x + m.zone[0] * METER.w, y, (m.zone[1] - m.zone[0]) * METER.w, METER.h);
      ctx.fillStyle = "#203653"; ctx.fillRect(x + m.pos * METER.w - 1.5, y - 4, 3, METER.h + 8);
      ctx.font = "bold 11px system-ui"; ctx.lineWidth = 3; ctx.strokeStyle = "#203653"; ctx.strokeText("Tap!", x + METER.w / 2, y - 7); ctx.fillStyle = "white"; ctx.fillText("Tap!", x + METER.w / 2, y - 7);
    }
    if (s.pop && s.t - s.pop.at < POP_MS) {
      const k = (s.t - s.pop.at) / POP_MS;
      ctx.globalAlpha = 1 - k * k; ctx.fillStyle = s.pop.text === "Clean!" ? "#2f9e44" : "#e8590c";
      ctx.font = "bold 16px system-ui"; ctx.fillText(s.pop.text, Math.max(30, Math.min(450, s.pos[0])), Math.max(16, s.pos[1] - 62 - k * 16));
      ctx.globalAlpha = 1;
    }
  },
  done(s) { return s.phase === "finish" && s.t - s.finishAt >= FINISH_MS; },
  score(s) { return Math.min(3000, Math.round((s.phase === "finish" ? s.final : s.t) / 100)); },
  hud(s) { return `Obstacle ${Math.min(s.index + 1, s.course.length)} of ${s.course.length} · ${(agilityRun.score(s) / 10).toFixed(1)} s`; },
  summary(s) { return `${s.cleanCount} of ${s.course.length} clean passes`; },
};
