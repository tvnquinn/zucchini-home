// Zoomies dash: Zucchini runs down a side-scrolling sidewalk and taps hop over leaf piles, puddles, sticks, snails, a hydrant and a
// sleeping cat. A bump is never a fall: she stops for a moment, reacts, hops over by herself and runs a little slower for a while.
const W = 480;
const ROUND_MS = 45000, DOGX = 110, GROUND = 250, DOG_SCALE = 0.7;
const HOP_MS = 620, HOP_LIFT = 46, BUFFER_MS = 120;
const BUMP_MS = 700, SLOW = 0.6, RECOVER_MS = 2000, AUTO_PAUSE = 130, AUTO_SPEED = 0.22;
const V0 = 0.16, V1 = 0.30, MIN_GAP_MS = 900, GAP_SPAN_MS = 1300, PX_PER_M = 40, MAX_SCORE = 2000;
const speedAt = (t) => V0 + (V1 - V0) * Math.min(1, t / ROUND_MS);

// w and h are the hit box in px (she clears it when her lift is above h while overlapping); react is her clip when she bumps it.
const KINDS = {
  leaf_pile: { actor: "leaf_pile", scale: 0.9, w: 36, h: 14, react: "happy", weight: 3 },
  puddle: { actor: "puddle", scale: 0.9, w: 40, h: 5, react: "happy", weight: 3 },
  stick: { actor: "stick_side", scale: 0.9, w: 44, h: 6, react: "sniff", weight: 3 },
  snail: { actor: "snail", scale: 1.6, w: 22, h: 13, react: "sniff", weight: 2 },
  hydrant: { object: "hydrant", w: 18, h: 28, react: "boof", weight: 2 },
  cat: { w: 30, h: 14, react: "boof", weight: 2 },
};
const KIND_IDS = Object.keys(KINDS);

// ---------------------------------------------------------------- the sidewalk, drawn in layers that tile seamlessly

const R = (c, col, x, y, w, h) => { c.fillStyle = col; c.fillRect(x, y, w, h); };
function blob(c, col, cx, cy, rx, ry) {
  c.fillStyle = col;
  for (let dy = -ry; dy <= ry; dy++) { const h = Math.round(rx * Math.sqrt(1 - (dy / ry) ** 2)); c.fillRect(cx - h, cy + dy, h * 2 + 1, 1); }
}
// Calls fn(x) once per visible copy of a tile of the given period, scrolled left by off.
const tile = (off, period, fn) => { const o = ((off % period) + period) % period; for (let x = -o - period; x < W; x += period) fn(x); };
const hash = (n) => { n = Math.imul(n ^ 61, 0x45d9f3b); n ^= n >>> 15; return (n >>> 0) % 1000 / 1000; };

const HOUSES = [  // x is local to a 720 px period
  { x: 10, w: 104, h: 62, wall: "#e8c9a0", roof: "#8a5a4a", door: "#c98f3a" },
  { x: 130, w: 112, h: 74, wall: "#a9bd8f", roof: "#5a6a5a", door: "#6f4a2d" },
  { x: 262, w: 92, h: 58, wall: "#d9a7a0", roof: "#6b4e57", door: "#8a3f3a" },
  { x: 372, w: 116, h: 70, wall: "#f1e3c2", roof: "#7a5040", door: "#5a6f8a" },
  { x: 508, w: 96, h: 60, wall: "#9db7d6", roof: "#5f5a72", door: "#f1e3c2" },
  { x: 618, w: 92, h: 66, wall: "#e6b8a0", roof: "#6a5a4a", door: "#53607f" },
];
function house(c, hs, x) {
  const base = 146, top = base - hs.h, rh = 18, cx = Math.round(x + hs.w / 2);
  R(c, hs.wall, x, top, hs.w, hs.h);
  R(c, "#00000018", x + hs.w - 7, top, 7, hs.h);
  for (let i = 0; i < rh; i++) { const half = Math.round((i + 1) / rh * (hs.w / 2 + 5)); R(c, i > rh - 4 ? "#00000028" : hs.roof, cx - half, top - rh + i, half * 2, 1); }
  R(c, "#8a5a4a", x + hs.w - 26, top - rh + 3, 7, 12);
  const cols = hs.w > 100 ? 3 : 2, step = hs.w / cols;
  for (let i = 0; i < cols; i++) {
    const wx = Math.round(x + step * i + step / 2 - 6);
    for (const wy of [top + 8, top + 30]) if (wy + 16 < base - 6) {
      R(c, "#f4efe6", wx - 1, wy - 1, 14, 18); R(c, "#a9cfe0", wx, wy, 12, 16); R(c, "#d6ecf5", wx + 1, wy + 1, 4, 6); R(c, "#f4efe6", wx, wy + 7, 12, 1); R(c, "#d9d0c0", wx - 2, wy + 17, 16, 2);
    }
  }
  R(c, hs.door, cx - 5, base - 20, 10, 20); R(c, "#f1e3c2", cx + 2, base - 10, 2, 2);
  R(c, "#d9d0c0", cx - 8, base - 2, 16, 2);
}
const CLOUDS = [[60, 24], [250, 50], [380, 18]];

// Each layer fills its own band; far ones scroll slower. draw(c, off) takes the whole-pixel scroll offset.
const LAYERS = [
  { name: "sky", factor: 0.1, period: 480, draw(c, off) {
    for (const [y0, y1, col] of [[0, 40, "#7fb8e6"], [40, 80, "#96c6ee"], [80, 130, "#b5d8f2"], [130, 190, "#cfe6f4"]]) R(c, col, 0, y0, W, y1 - y0);
    tile(off, 480, (x) => { for (const [cx, cy] of CLOUDS) { R(c, "#ffffff", x + cx, cy + 4, 44, 7); R(c, "#ffffff", x + cx + 8, cy, 26, 6); R(c, "#ffffff", x + cx + 18, cy - 3, 12, 4); R(c, "#dfeaf5", x + cx + 2, cy + 9, 40, 2); } });
  } },
  { name: "houses", factor: 0.25, period: 720, draw(c, off) {
    R(c, "#a3c46f", 0, 138, W, 20); R(c, "#8fb35e", 0, 150, W, 8);
    tile(off, 720, (x) => { for (const hs of HOUSES) house(c, hs, x + hs.x); });
  } },
  { name: "hedge", factor: 0.5, period: 480, draw(c, off) {
    tile(off, 480, (x) => {
      for (const tx of [40, 200, 330, 440]) {
        R(c, "#7a5a3a", x + tx - 2, 132, 5, 28);
        blob(c, "#4f7f3a", x + tx, 122, 18, 16); blob(c, "#6a9a44", x + tx - 3, 119, 14, 12); blob(c, "#86b05a", x + tx - 5, 115, 8, 6);
        for (const [dx, dy] of [[-8, 118], [6, 112], [4, 124], [-2, 108]]) R(c, "#f6e9e4", x + tx + dx, dy, 3, 3);
      }
      for (let i = 0; i < 60; i++) { const b = Math.floor(hash(i) * 5); R(c, "#3f6f33", x + i * 8, 150 - b, 8, 26 + b); if (i % 3 === 0) R(c, "#6fa04a", x + i * 8 + 2, 152 - b, 3, 2); }
    });
  } },
  { name: "fence", factor: 0.8, period: 96, draw(c, off) {
    R(c, "#6f9a48", 0, 174, W, 18);
    tile(off, 96, (x) => {
      R(c, "#d9d0c0", x, 178, 96, 3); R(c, "#d9d0c0", x, 186, 96, 3);
      for (let i = 0; i < 8; i++) { const px = x + i * 12 + 2; R(c, "#f4efe6", px, 168, 7, 23); R(c, "#f4efe6", px + 2, 166, 3, 2); R(c, "#d9d0c0", px + 5, 168, 2, 23); }
    });
  } },
  { name: "grass", factor: 0.9, period: 64, draw(c, off) {
    R(c, "#86b05a", 0, 192, W, 12);
    tile(off, 64, (x) => {
      for (const [dx, dy] of [[8, 195], [34, 199]]) R(c, "#6f9a48", x + dx, dy, 2, 3);
      for (const [dx, dy] of [[20, 197], [50, 194]]) R(c, "#9cc46b", x + dx, dy, 2, 2);
      R(c, "#6f9a48", x + 4, 202, 20, 2); R(c, "#6f9a48", x + 40, 202, 14, 2);
    });
  } },
  { name: "walk", factor: 1, period: 192, draw(c, off) {
    R(c, "#dcb9a0", 0, 204, W, 68); R(c, "#ead0ba", 0, 204, W, 2);
    R(c, "#e6cdb9", 0, 272, W, 3); R(c, "#b99b88", 0, 275, W, 7);
    R(c, "#47444d", 0, 282, W, 4); R(c, "#55525c", 0, 286, W, 34);
    tile(off, 192, (x) => {
      for (let i = 0; i < 6; i++) {
        const sx = x + i * 32, h1 = hash(i * 7 + 1), h2 = hash(i * 7 + 2);
        if (i % 2) R(c, "#d6b39a", sx, 206, 32, 66);
        R(c, "#c9a58c", sx, 206, 2, 66);
        R(c, "#d0ad94", sx + 4 + Math.floor(h1 * 20), 214 + Math.floor(h2 * 50), 3, 2);
        R(c, "#e6c9b2", sx + 6 + Math.floor(h2 * 18), 210 + Math.floor(h1 * 54), 2, 2);
      }
      for (let i = 0; i < 3; i++) R(c, "#a2867a", x + i * 64, 275, 2, 7);
      for (let i = 0; i < 24; i++) R(c, "#625e69", x + Math.floor(hash(i + 40) * 190), 288 + Math.floor(hash(i + 90) * 30), 3, 2);
      for (let i = 0; i < 2; i++) R(c, "#e8d9a0", x + i * 96, 303, 48, 3);
    });
  } },
];
const drawBackground = (c, dist) => { for (const l of LAYERS) l.draw(c, Math.round(dist * l.factor)); };

// ---------------------------------------------------------------- obstacles

function drawCat(c, x, y) {
  blob(c, "#6f4a2d", x, y - 7, 16, 7); blob(c, "#e0a060", x, y - 7, 15, 6);
  R(c, "#b9783f", x - 6, y - 12, 2, 5); R(c, "#b9783f", x, y - 13, 2, 6); R(c, "#b9783f", x + 6, y - 12, 2, 5);
  R(c, "#f4e2c4", x - 8, y - 4, 14, 3);
  R(c, "#d08e4f", x + 8, y - 3, 10, 3); R(c, "#6f4a2d", x + 8, y, 10, 1); R(c, "#d08e4f", x + 15, y - 7, 3, 5);
  blob(c, "#6f4a2d", x - 13, y - 8, 7, 6); blob(c, "#e0a060", x - 13, y - 8, 6, 5);
  R(c, "#6f4a2d", x - 18, y - 16, 3, 4); R(c, "#6f4a2d", x - 11, y - 16, 3, 4); R(c, "#e8a0a0", x - 17, y - 15, 1, 2); R(c, "#e8a0a0", x - 10, y - 15, 1, 2);
  R(c, "#6f4a2d", x - 16, y - 9, 3, 1); R(c, "#6f4a2d", x - 10, y - 9, 3, 1); R(c, "#e8a0a0", x - 14, y - 6, 2, 1);
}
function drawObstacle(c, env, o, x) {
  const k = KINDS[o.type];
  if (k.actor) env.drawActor(c, k.actor, x, GROUND, { scale: k.scale });
  else if (k.object) env.drawObject(c, "neighborhood", { object: k.object, x, y: GROUND, scale: 0.86, facing: "SE" });
  else drawCat(c, x, GROUND);
}
function drawZ(c, x, y, size) {
  R(c, "#ffffff", x, y, size, 1);
  for (let i = 1; i < size - 1; i++) R(c, "#ffffff", x + size - 1 - i, y + i, 1, 1);
  R(c, "#ffffff", x, y + size - 1, size, 1);
}

// ---------------------------------------------------------------- game

const LEAVES = ["#d8793a", "#c24f3d", "#e9b64d", "#a8602f", "#d9a03f"];

function pickKind(env) {
  let r = env.rng() * KIND_IDS.reduce((n, id) => n + KINDS[id].weight, 0);
  for (const id of KIND_IDS) { r -= KINDS[id].weight; if (r < 0) return id; }
  return KIND_IDS[0];
}
// Edge to edge, every gap is at least MIN_GAP_MS at the speed she will have when she gets there.
function spawn(s) {
  const k = KINDS[s.pending], wx = s.nextEdge + k.w / 2;
  s.obs.push({ type: s.pending, wx, w: k.w, h: k.h, gap: s.gapPx, gapSp: s.gapSp, done: false, hit: false });
  s.pending = pickKind(s.env);
  // The gap to the next one is sized for the speed at which she will reach it (a little further on, so a little faster).
  const edge = wx + k.w / 2, reach = (edge - s.dist) / Math.max(0.1, s.v) + 1500;
  s.gapSp = speedAt(Math.min(ROUND_MS, s.t + reach));
  s.gapPx = Math.ceil(s.gapSp * (MIN_GAP_MS + s.env.rng() * GAP_SPAN_MS));
  s.nextEdge = edge + s.gapPx;
}
const startHop = (s, auto) => { s.hop = { t: 0, auto, buffered: false }; };
function burst(s, o) {
  const n = { leaf_pile: 16, puddle: 12, hydrant: 6, cat: 6 }[o.type] ?? 0, r = s.env.rng;
  for (let i = 0; i < n; i++) {
    const col = o.type === "leaf_pile" ? LEAVES[i % 5] : o.type === "puddle" ? (i % 2 ? "#8db7cc" : "#d9e8ee") : "#fffaf0";
    s.parts.push({ wx: o.wx + (r() - 0.5) * 20, y: GROUND - 6, vx: (r() - 0.35) * 0.22, vy: -0.12 - r() * 0.2, t: 0, col, size: o.type === "leaf_pile" ? 3 : 2 });
  }
}

export const zoomiesDash = {
  id: "zoomies", title: "Zoomies dash", scenes: ["neighborhood"], how: "Tap to hop over whatever is on the sidewalk.", unit: "m", lower: false, maxScore: MAX_SCORE,
  layers: LAYERS, drawBackground, speedAt,  // exposed for the tests
  create(env) {
    const s = { env, t: 0, dist: 0, v: V0, lift: 0, obs: [], parts: [], zs: [], hop: null, bump: null, recoverFrom: 0, slowed: false,
      cleared: 0, bumped: 0, dives: 0, nextEdge: 520, gapPx: 0, gapSp: V0 };
    s.pending = pickKind(env);
    spawn(s);
    return s;
  },
  step(s, dt) {
    dt = Math.min(dt, ROUND_MS - s.t);
    if (dt <= 0) return;
    s.t += dt;
    if (s.bump) {
      s.bump.t += dt;
      if (s.bump.t >= BUMP_MS) { s.bump = null; startHop(s, true); s.recoverFrom = s.t; s.slowed = true; }
    }
    if (s.hop) {
      s.hop.t += dt;
      if (s.hop.t >= HOP_MS) { const again = s.hop.buffered && !s.hop.auto; s.hop = null; if (again) startHop(s, false); }
    }
    const mult = SLOW + (1 - SLOW) * Math.min(1, (s.t - s.recoverFrom) / RECOVER_MS);
    s.v = s.bump ? 0 : s.hop?.auto ? (s.hop.t < AUTO_PAUSE ? 0 : AUTO_SPEED) : speedAt(s.t) * (s.slowed ? mult : 1);
    s.dist += s.v * dt;
    s.lift = s.hop ? HOP_LIFT * 4 * (s.hop.t / HOP_MS) * (1 - s.hop.t / HOP_MS) : 0;
    while (s.nextEdge - s.dist < 540) spawn(s);
    for (const o of s.obs) {
      if (o.done) continue;
      const x = o.wx - s.dist, left = x - o.w / 2;
      if (x + o.w / 2 < DOGX - 10) { o.done = true; s.cleared++; if (o.type === "cat") s.zs.push({ wx: o.wx, t: 0 }); continue; }
      if (left <= DOGX + 10 && x >= DOGX && s.lift <= o.h && !s.bump) {
        s.dist -= DOGX + 10 - left;  // stop at its edge, not inside it
        o.done = o.hit = true; s.bumped++;
        if (o.type === "leaf_pile") s.dives++;
        s.bump = { o, t: 0 }; s.hop = null; s.lift = 0; s.v = 0;
        burst(s, o);
      }
    }
    for (const p of s.parts) { p.t += dt; p.vy += 0.0007 * dt; p.wx += p.vx * dt; p.y += p.vy * dt; }
    s.parts = s.parts.filter((p) => p.t < 900 && p.y < GROUND + 2);
    for (const z of s.zs) z.t += dt;
    s.zs = s.zs.filter((z) => z.t < 1400);
  },
  draw(c, s, now) {
    const env = s.env, dist = Math.floor(s.dist), bumpOb = s.bump?.o, dive = bumpOb?.type === "leaf_pile";
    drawBackground(c, dist);
    for (const o of s.obs) { const x = Math.round(o.wx - dist); if (x > -60 && x < W + 60 && !(dive && o === bumpOb)) drawObstacle(c, env, o, x); }
    let pose = { clip: "run", frame: null, lift: 0, fast: true }, dx = 0;
    if (s.bump) { pose = { clip: KINDS[bumpOb.type].react, frame: null, lift: 0, fast: false }; if (dive) dx = Math.min(16, s.bump.t * 0.06); }
    else if (s.hop) {
      const u = s.hop.t / HOP_MS;
      pose = { ...(u < 0.5 ? { clip: "couch_enter", frame: 1 } : { clip: "couch_exit", frame: u < 0.93 ? 0 : 1 }), lift: s.lift, fast: false };
    }
    env.drawDog(c, { x: DOGX + dx, y: GROUND, facing: "SE", scale: DOG_SCALE, now, ...pose });
    if (dive) drawObstacle(c, env, bumpOb, Math.round(bumpOb.wx - dist));
    for (const p of s.parts) R(c, p.col, Math.round(p.wx - dist), Math.round(p.y), p.size, p.size);
    for (const z of s.zs) {
      c.globalAlpha = Math.max(0, 1 - z.t / 1400);
      const zx = Math.round(z.wx - dist) - 12;
      drawZ(c, zx, Math.round(GROUND - 24 - z.t * 0.025), 6);
      if (z.t > 300) drawZ(c, zx + 8, Math.round(GROUND - 34 - (z.t - 300) * 0.025), 8);
      c.globalAlpha = 1;
    }
    if (s.t < 2500) {
      c.globalAlpha = Math.min(1, (2500 - s.t) / 500);
      c.fillStyle = "#ffffff"; c.font = "bold 14px system-ui, sans-serif"; c.textAlign = "center"; c.fillText("Tap to hop!", W / 2, 60);
      c.globalAlpha = 1;
    }
  },
  pointer(s, kind) {
    if (kind !== "down" || s.bump || s.t >= ROUND_MS) return;
    if (!s.hop) startHop(s, false);
    else if (!s.hop.auto && s.hop.t >= HOP_MS - BUFFER_MS) s.hop.buffered = true;
  },
  done(s) { return s.t >= ROUND_MS; },
  score(s) { return Math.min(MAX_SCORE, Math.floor(s.dist / PX_PER_M)); },
  hud(s) { const left = Math.ceil((ROUND_MS - s.t) / 1000); return `${zoomiesDash.score(s)} m · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`; },
  summary(s) { return `Cleared ${s.cleared} of ${s.cleared + s.bumped}` + (s.dives ? ` · ${s.dives} leaf pile dive${s.dives > 1 ? "s" : ""}` : ""); },
};
