// Agility run: Zucchini runs the course twice (10 obstacles) and taps time each one. A clean pass is quick; a wobbly
// pass is slower but never a fall. The score is the total course time in tenths of a second, so lower is better.
const HOOP_LIFT = 12;
const LEAPS = { jump: 24, hoop: HOOP_LIFT }, DURATION = { jump: 1100, hoop: 1100, weave: 1550, tunnel: 950, ramp: 950 };
const CROUCH = .18, LANDING = .15, RAMP_UP = .38, RAMP_DOWN = .62, RAMP_LIFT = 27;
const LAPS = 2, RUN_SPEED = .11, WOBBLY = 1.6, SHAKE_MS = 700, AUTO_MS = 3000, GRACE_MS = 250, FINISH_MS = 1600, POP_MS = 900;
const METER = { w: 120, h: 12 };
const lerp = (a, b, k) => a + (b - a) * k;

// Offsets measured on the sprites, relative to the placement at scale .94, for the facing in `at`; the mirrored facing negates dx.
const MEASURED = {
  weave: { at: ["SE", "SW"], S: [-38, -5], E: [31, -33], n: [.371, .928], amp: 8 },
  tunnel: { at: ["NE", "NW"], pts: [[-26, 16], [-27, -8], [35, -27], [49, -37]] },
  ramp: { at: ["SW", "SE"], pts: [[-48, -8], [-38, -12], [-5, -52], [18, 0], [30, 6]] },
  hoop: { at: ["SE", "SW"], pts: [[-21, -20], [25, 4]] },
};
const faceSeg = (dx, dy) => (dy < -2 ? (dx >= 0 ? "NE" : "NW") : side(dx));

// Where she waits before an obstacle and where she lands after it (same geometry as the neighborhood outings).
function points(env, p) {
  const w = env.objectBox("agility", p)[2], m = MEASURED[p.object], i = m ? m.at.indexOf(p.facing) : -1;
  if (i >= 0) {
    const k = (p.scale ?? .94) / .94, mir = i ? -1 : 1, at = ([x, y]) => [p.x + x * k * mir, p.y + y * k];
    if (m.S) {
      const S = at(m.S), E = at(m.E);
      return { start: S, exit: E, geo: { kind: "weave", S, E, n: [m.n[0] * mir, m.n[1]], amp: m.amp * k, y: p.y, face: mir > 0 ? "SE" : "SW" } };
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
const zAt = (g, k) => !g ? null : g.kind === "ramp" ? g.y + 1 : g.kind === "weave" ? g.y + (LAT(k) < 0 ? -1 : 1) : g.kind === "hoop" ? g.y + (k < .5 ? -1 : 1) : null;

function nextTarget(s) {
  const o = s.course[s.index];
  s.phase = "run"; s.target = o.start; s.clip = "run"; s.frame = null; s.lift = 0; s.hide = false; s.z = zAt(o.geo, 0);
}

function startMeter(s, now) {
  const i = s.index, w = lerp(.30, .16, i / 9);
  s.phase = "meter"; s.clip = "idle"; s.frame = null; s.meterAt = s.t;
  s.meter = { zone: [0, 0], pos: 0, sweep: lerp(1100, 600, i / 9) };
  const lo = s.env.rng() * (1 - w);
  s.meter.zone = [lo, lo + w];
}

function startTraverse(s, clean) {
  const o = s.course[s.index];
  s.phase = "traverse"; s.clean = clean; s.trav = { at: s.t, from: [...s.pos], to: o.exit, dur: DURATION[o.p.object] * (clean ? 1 : WOBBLY) };
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

function stepTraverse(s) {
  const o = s.course[s.index], a = s.trav, obj = o.p.object, g = o.geo, k = Math.min(1, (s.t - a.at) / a.dur), leap = LEAPS[obj];
  let travel = k;
  s.hide = false; s.lift = 0; s.frame = null; s.z = zAt(g, k);
  if (g && g.kind !== "hoop") {
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
    travel = g ? u : 1 - (1 - u) ** 2;
    s.lift = leap * (s.clean ? 1 : .5) * 4 * u * (1 - u);
    if (g) s.z = g.y + (u < .5 ? -1 : 1);
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
    const objs = sc.course_order.map((name) => all.find((p) => p.object === name)).filter(Boolean);
    const course = [];
    for (let lap = 0; lap < LAPS; lap++) for (const p of objs) course.push({ p, ...points(env, p) });
    const s = { env, course, scene: sc, objs, index: 0, t: 0, final: 0, cleanCount: 0, pos: [sc.dog[0], sc.dog[1]], facing: "SE", clip: "run", frame: null, lift: 0, hide: false, z: null, phase: "run", target: null, meter: null, pop: null, clean: false };
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
      else env.drawObject(ctx, "agility", it.p);
    }
    ctx.textAlign = "center";
    if (s.index < s.course.length) {
      const p = s.course[s.index].p, b = env.objectBox("agility", p), by = Math.max(12, b[1] - 9);
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
