// Fetch distance: swipe to throw the ball down the beach, tap as it drops for a mid-air catch. Six throws.
const THROWS = 6, BALL0 = [60, 300], HOME = [95, 290], SPAN = 330, IDLE_MS = 8000, CATCH_BONUS = 15;
const TEACH_THROWS = 2, HINT_WAIT = 3000, HINT_LOOP = 1200;
const MIN_CYCLE = 4600, PX_PER_FT = 5, WIND_PX = 13, TROT = 150;
const inPoly = (poly, x, y) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
const dry = (s, x, y) => inPoly(s.floor, x, y) && y >= 128 + x * .145 + 8 && x >= 8 && x <= 472 && y <= 312;
const lerp = (a, b, k) => a + (b - a) * k;
const west = (face) => face === "SW" || face === "NW";

function go(s, phase) { s.phase = phase; s.t = 0; }
function pop(s, text, x, y, color = "#fff") { s.pops.push({ text, x: Math.max(70, Math.min(410, x)), y: Math.max(40, y), age: 0, color }); }

// Direction and power from a swipe; null when it is too short or points down and back.
export function swipeVector(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len < 20 || dy > len * .25) return null;
  return { dx: dx / len, dy: dy / len, power: Math.min(1, Math.max(.25, len / 220)) };
}

// Landing point: start + direction * power * span + wind, pulled back along the throw until it is dry sand on the floor.
export function landingPoint(s, v, wind) {
  const rx = BALL0[0] + v.dx * v.power * SPAN + wind * WIND_PX, ry = BALL0[1] + v.dy * v.power * SPAN;
  for (let k = 1; k > 0; k -= .01) {
    const x = lerp(BALL0[0], rx, k), y = lerp(BALL0[1], ry, k);
    if (dry(s, x, y)) return [x, y];
  }
  return [...BALL0];
}

// Teaching state: the swipe hint (ready phase) and the landing ring state, kept as flags so tests can read them.
const hintOn = (s) => s.phase === "ready" && !s.drag && (s.swiped < TEACH_THROWS || s.idle > HINT_WAIT);
function ringState(s) {
  if (s.phase !== "flight") return "none";
  if (catchable(s)) return "catch";
  return s.throws <= TEACH_THROWS && s.t / s.fl.dur > .4 ? "ready" : "small";
}

function throwBall(s, v) {
  const to = landingPoint(s, v, s.wind), dist = Math.hypot(to[0] - BALL0[0], to[1] - BALL0[1]);
  s.throws++;
  s.fl = { to, dur: 1200 + 400 * v.power, peak: 60 + 30 * v.power, feet: Math.round(dist / PX_PER_FT), from: [...HOME] };
  s.ball = { x: BALL0[0], y: BALL0[1], h: 0 };
  s.caught = false; s.cycle = 0; s.idle = 0; s.drag = null;
  go(s, "flight");
  s.hint = false; s.ringState = "small";
}

function ballAt(s, u) {
  const f = s.fl, h = 4 * f.peak * u * (1 - u);
  s.ball = { x: lerp(BALL0[0], f.to[0], u), y: lerp(BALL0[1], f.to[1], u), h };
}

function land(s) {
  const f = s.fl;
  s.feet += f.feet; s.longest = Math.max(s.longest, f.feet);
  s.landings.push({ x: f.to[0], y: f.to[1], feet: f.feet, caught: s.caught });
  pop(s, `${f.feet} ft`, f.to[0], f.to[1] - 30, "#fff3a6");
}

function pickWindDay(s) { s.wind = Math.round(s.env.rng() * 6 - 3); }

function walkHome(s, dt) {
  const d = s.dog, dx = HOME[0] - d.x, dy = HOME[1] - d.y, dist = Math.hypot(dx, dy), step = TROT * dt / 1000;
  d.face = dx < 0 ? (dy < 0 ? "NW" : "SW") : (dy < 0 ? "NE" : "SE");
  if (dist <= step) { d.x = HOME[0]; d.y = HOME[1]; return true; }
  d.x += dx / dist * step; d.y += dy / dist * step; return false;
}

export const fetchDistance = {
  id: "fetch", title: "Fetch distance", scenes: ["beach"], how: "Swipe up and out to throw. Tap as the ball drops for a catch.", unit: "ft", lower: false, maxScore: 999,
  create(env) {
    const s = { env, floor: env.scene("beach").editing.floor, phase: "ready", t: 0, idle: 0, cycle: 0, throws: 0, swiped: 0, hint: true, ringState: "none", feet: 0, catches: 0, longest: 0, wind: 0, landings: [], pops: [],
      dog: { x: HOME[0], y: HOME[1], face: "SE", clip: "idle", lift: 0, frame: null, fast: false }, ball: { x: BALL0[0], y: BALL0[1], h: 0 }, carrying: false, drag: null, fl: null, caught: false, nudged: false };
    pickWindDay(s);
    return s;
  },
  step(s, dt) {
    s.t += dt; s.cycle += dt;
    for (const p of s.pops) p.age += dt;
    s.pops = s.pops.filter((p) => p.age < 1600);
    const d = s.dog;
    s.hint = hintOn(s); if (s.phase !== "flight") s.ringState = "none";
    d.lift = 0; d.frame = null; d.fast = false;
    if (s.phase === "ready") {
      d.clip = "idle"; d.face = "SE"; s.idle += dt;
      if (s.idle > IDLE_MS - 600) { d.clip = "boof"; if (!s.nudged) { s.nudged = true; pop(s, "Zucchini nudges the ball", 140, 262, "#fff"); } }
      if (s.idle >= IDLE_MS) { s.nudged = false; s.drag = null; throwBall(s, { dx: .94, dy: -.34, power: .5 }); }
    } else if (s.phase === "flight") {
      const f = s.fl, u = Math.min(1, s.t / f.dur);
      ballAt(s, u);
      // She starts a beat late and arrives a little before the ball does.
      const k = Math.min(1, Math.max(0, (s.t - 100) / (f.dur * .9 - 100)));
      d.x = lerp(f.from[0], f.to[0], k); d.y = lerp(f.from[1], f.to[1], k);
      d.face = f.to[0] >= f.from[0] ? (f.to[1] < f.from[1] ? "NE" : "SE") : (f.to[1] < f.from[1] ? "NW" : "SW");
      d.clip = k < 1 ? "run" : "idle"; d.fast = true;
      if (u >= 1) { land(s); go(s, "bounce"); }
      else s.ringState = ringState(s);
    } else if (s.phase === "leap") {
      const k = Math.min(1, s.t / 450);
      d.clip = "couch_enter"; d.frame = 1; d.lift = 22 * Math.sin(Math.PI * k) + 6 * (1 - k);
      if (s.t >= 450) { s.carrying = true; go(s, "back"); }
    } else if (s.phase === "bounce") {
      const k = Math.min(1, s.t / 450), f = s.fl;
      s.ball = { x: f.to[0] + 6 * k, y: f.to[1] + 2 * k, h: 14 * Math.abs(Math.sin(Math.PI * k)) * (1 - k) };
      d.clip = "idle"; d.fast = false;
      if (s.t >= 450) go(s, "pick");
    } else if (s.phase === "pick") {
      d.clip = "fetch";
      if (s.t >= 500) { s.carrying = true; go(s, "back"); }
    } else if (s.phase === "back") {
      d.clip = "walk"; d.fast = true;
      if (walkHome(s, dt)) {
        // A short throw still takes a moment: she prances at your feet before dropping it.
        if (s.cycle < MIN_CYCLE) { d.clip = "happy"; d.fast = false; return; }
        s.carrying = false; s.dropFrom = [d.x + (west(d.face) ? -14 : 14), d.y - 13]; go(s, "drop");
      }
    } else if (s.phase === "drop") {
      const k = Math.min(1, s.t / 300);
      d.clip = "idle"; d.face = "SE";
      s.ball = { x: lerp(s.dropFrom[0], BALL0[0], k), y: lerp(s.dropFrom[1] + 13, BALL0[1], k), h: 10 * Math.sin(Math.PI * k) + (1 - k) * 13 };
      if (s.t >= 300) { s.ball = { x: BALL0[0], y: BALL0[1], h: 0 }; if (s.throws < THROWS) pickWindDay(s); s.idle = 0; go(s, "ready"); }
    }
  },
  draw(ctx, s, now) {
    const env = s.env, d = s.dog;
    env.drawBackground(ctx, "beach");
    const layers = env.placements("beach").map((p) => ({ z: p.y, draw: () => env.drawObject(ctx, "beach", p) }));
    layers.push({ z: d.y, draw: () => {
      env.drawDog(ctx, { x: d.x, y: d.y, clip: d.clip, facing: d.face, frame: d.frame, lift: d.lift, scale: .7, fast: d.fast, now });
      if (s.carrying) ball(ctx, d.x + (west(d.face) ? -14 : 14), d.y - 13 - d.lift);
    } });
    if (!s.carrying) {
      const b = s.ball;
      layers.push({ z: b.y, draw: () => {
        ctx.fillStyle = `rgba(58,36,26,${.28 / (1 + b.h / 50)})`;
        ctx.beginPath(); ctx.ellipse(b.x, b.y, 5 * (1 - Math.min(.4, b.h / 200)), 2, 0, 0, Math.PI * 2); ctx.fill();
        ball(ctx, b.x, b.y - b.h);
      } });
    }
    layers.sort((a, b) => a.z - b.z);
    for (const l of layers) l.draw();
    const rs = ringState(s);
    if (rs !== "none") {
      const [rx, ry] = s.fl.to, pulse = 1 + .18 * Math.sin(now / 80), go_ = rs === "catch";
      ctx.strokeStyle = go_ ? "#7be07b" : "rgba(255,255,255,.9)"; ctx.lineWidth = go_ ? 4 : 2;
      ctx.beginPath(); ctx.ellipse(rx, ry, go_ ? 16 * pulse : 9, go_ ? 8 * pulse : 4.5, 0, 0, Math.PI * 2); ctx.stroke();
      if (go_) label(ctx, "Tap!", rx, ry - 22, "#9cf59c", 22);
      else if (rs === "ready") label(ctx, "Get ready to tap", rx, ry - 16, "#fff", 12);
    }
    if (s.drag) {
      ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = 3; ctx.setLineDash([5, 5]);
      ctx.beginPath(); ctx.moveTo(s.drag.x0, s.drag.y0); ctx.lineTo(s.drag.x, s.drag.y); ctx.stroke(); ctx.setLineDash([]);
      const v = swipeVector(s.drag.x - s.drag.x0, s.drag.y - s.drag.y0), pw = v ? v.power : 0;
      ctx.fillStyle = "rgba(30,50,70,.7)"; ctx.fillRect(28, 310, 64, 8);
      ctx.fillStyle = pw >= .95 ? "#ffd27a" : "#9cf59c"; ctx.fillRect(30, 312, 60 * pw, 4);
      if (s.throws < TEACH_THROWS) label(ctx, "Longer swipe, longer throw", 190, 304, "#fff", 12);
    } else if (s.hint) drawHint(ctx, now);
    if (s.throws === 0 && s.phase === "ready" || s.throws === 1 && s.phase !== "ready") label(ctx, "Wind pushes the ball", 250, 40, "#cfe8ff", 11);
    drawWind(ctx, s);
    ctx.font = "bold 12px system-ui"; ctx.textAlign = "center";
    for (const p of s.pops) {
      const a = Math.min(1, (1600 - p.age) / 400);
      ctx.globalAlpha = a; ctx.fillStyle = "rgba(40,28,20,.85)"; ctx.fillText(p.text, p.x + 1, p.y - p.age / 40 + 1);
      ctx.fillStyle = p.color; ctx.fillText(p.text, p.x, p.y - p.age / 40); ctx.globalAlpha = 1;
    }
  },
  pointer(s, kind, x, y, now) {
    if (s.phase === "flight") { if (kind === "down" && catchable(s)) catchBall(s); return; }
    if (s.phase !== "ready") return;
    if (kind === "down") { s.idle = 0; s.nudged = false; s.drag = { x0: x, y0: y, x, y }; s.hint = false; }
    else if (kind === "move" && s.drag) { s.drag.x = x; s.drag.y = y; }
    else if (kind === "up" && s.drag) {
      const v = swipeVector(x - s.drag.x0, y - s.drag.y0);
      s.drag = null;
      if (v) { s.swiped++; throwBall(s, v); } else { pop(s, "Swipe up and out to throw", 150, 262, "#fff"); s.hint = hintOn(s); }
    }
  },
  done(s) { return s.throws >= THROWS && s.phase === "ready"; },
  score(s) { return Math.min(999, s.feet + s.catches * CATCH_BONUS); },
  hud(s) { return `Throw ${Math.min(THROWS, s.throws + (s.phase === "ready" ? 1 : 0))} of ${THROWS} · ${fetchDistance.score(s)} ft`; },
  summary(s) { return `${s.catches} ${s.catches === 1 ? "catch" : "catches"} · longest ${s.longest} ft`; },
};

function catchable(s) { return s.phase === "flight" && s.t / s.fl.dur > .72 && s.ball.h >= 2; }  // the last quarter of the drop, about a third of a second

function catchBall(s) {
  s.caught = true; s.catches++;
  land(s);
  s.landings[s.landings.length - 1].caught = true;
  pop(s, `Catch! +${CATCH_BONUS} ft`, s.ball.x, s.ball.y - 66, "#9cf59c");
  go(s, "leap");
}

function ball(ctx, x, y) {
  ctx.fillStyle = "#875b29"; ctx.beginPath(); ctx.arc(x, y - 3, 4.2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#f5d85c"; ctx.beginPath(); ctx.arc(x, y - 4, 3.3, 0, Math.PI * 2); ctx.fill();
}

// Outlined text, readable over sand and water.
function label(ctx, text, x, y, color, size) {
  ctx.font = `bold ${size}px system-ui`; ctx.textAlign = "center"; ctx.lineJoin = "round"; ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(40,28,20,.9)"; ctx.strokeText(text, x, y);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}

// A dotted arrow sweeping up and right from the ball, with a finger dot sliding along it.
function drawHint(ctx, now) {
  const p0 = [BALL0[0] + 6, BALL0[1] - 8], c = [110, 262], p1 = [175, 222];
  const at = (u) => [(1 - u) ** 2 * p0[0] + 2 * (1 - u) * u * c[0] + u * u * p1[0], (1 - u) ** 2 * p0[1] + 2 * (1 - u) * u * c[1] + u * u * p1[1]];
  // a pulsing ring on the ball, so it is clear where the swipe starts
  const pulse = (now % 1000) / 1000;
  ctx.strokeStyle = `rgba(255,255,255,${1 - pulse})`; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(BALL0[0], BALL0[1] - 4, 7 + pulse * 10, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,.95)"; ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.setLineDash([6, 7]);
  ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.quadraticCurveTo(c[0], c[1], p1[0], p1[1]); ctx.stroke(); ctx.setLineDash([]);
  const [ax, ay] = at(.96), ang = Math.atan2(p1[1] - at(.9)[1], p1[0] - at(.9)[0]);
  ctx.beginPath(); ctx.moveTo(p1[0] + 4 * Math.cos(ang), p1[1] + 4 * Math.sin(ang));
  ctx.lineTo(ax + 8 * Math.cos(ang + 2.4), ay + 8 * Math.sin(ang + 2.4)); ctx.moveTo(p1[0] + 4 * Math.cos(ang), p1[1] + 4 * Math.sin(ang));
  ctx.lineTo(ax + 8 * Math.cos(ang - 2.4), ay + 8 * Math.sin(ang - 2.4)); ctx.stroke(); ctx.lineCap = "butt";
  const [hx, hy] = at((now % HINT_LOOP) / HINT_LOOP);
  ctx.fillStyle = "#fff"; ctx.strokeStyle = "rgba(40,28,20,.9)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(hx, hy, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  label(ctx, "Swipe from the ball to throw", 175, 308, "#fff", 12);
}

function drawWind(ctx, s) {
  const w = s.wind, text = w === 0 ? "Wind calm" : `Wind ${w < 0 ? "←" : "→"} ${Math.abs(w)}`;
  ctx.fillStyle = "rgba(30,50,70,.65)"; ctx.fillRect(190, 6, 100, 20);
  ctx.fillStyle = "#fff"; ctx.font = "bold 12px system-ui"; ctx.textAlign = "center"; ctx.fillText(text, 250, 20);
  // A little flag on a pole, flying with the wind.
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(200, 24); ctx.lineTo(200, 10); ctx.stroke();
  const len = w === 0 ? 2 : Math.sign(w) * (4 + Math.abs(w) * 2);
  ctx.fillStyle = "#ff9a8a"; ctx.beginPath(); ctx.moveTo(200, 10); ctx.lineTo(200 + len, 13); ctx.lineTo(200, 16); ctx.fill();
}
