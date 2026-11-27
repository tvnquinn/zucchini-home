// Squirrel patrol: squirrels dart between the park's trees and shrubs. Tap each one before it slips out of sight.
const TOTAL = 24, HIT = 24, TAPPED = 450, BOOF = 900;
const HIDERS = ["oak", "maple", "birch", "shrub"], TREES = ["oak", "maple", "birch"];
const DOG = { x: 240, y: 298, scale: 0.75 };
const lerp = (a, b, p) => a + (b - a) * p;
const live = q => q.state === "run" || q.state === "sit";

// One hiding spot per side of each tree and shrub: it starts behind the object and ends a few px out from it.
function makeSpots(env) {
  const spots = [];
  for (const p of env.placements("park")) {
    if (!HIDERS.includes(p.object)) continue;
    const bw = env.objectBox("park", p)[2], tree = TREES.includes(p.object);
    for (const side of [-1, 1]) {
      const from = p.x + side * (tree ? 2 : bw / 2 - 8), x = p.x + side * (tree ? 16 : bw / 2 + 4), y = p.y + 2;
      if (x < 16 || x > 464 || y < 60 || y > 300) continue;
      if (y > 235 && Math.abs(x - DOG.x) < 45) continue; // behind her
      spots.push({ id: `${p.placementId}${side < 0 ? "L" : "R"}`, p, tree, side, from, x, y });
    }
  }
  return spots;
}

// distance from point (px, py) to segment a-b
function segDist(a, b, px, py) {
  const dx = b.x - a.x, dy = b.y - a.y, k = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(a.x + k * dx - px, a.y + k * dy - py);
}
// a point on the run: the straight line plus a sideways bend that peaks mid-way
function pathAt(q, u) {
  const { a, b, bend } = q, dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, w = bend * 4 * u * (1 - u);
  return { x: a.x + dx * u - dy / d * w, y: a.y + dy * u + dx / d * w };
}
function pathLen(q) {
  let len = 0, p = pathAt(q, 0);
  for (let i = 1; i <= 16; i++) { const n = pathAt(q, i / 16); len += Math.hypot(n.x - p.x, n.y - p.y); p = n; }
  return len;
}
const clear = (q, from) => { for (let i = from; i <= 16; i++) { const p = pathAt(q, i / 16); if (Math.hypot(p.x - DOG.x, p.y - 280) < 50) return false; } return true; };

export const squirrelPatrol = {
  id: "squirrel", title: "Squirrel patrol", scenes: ["park"], how: "Tap the squirrels as they dash between trees, before Zucchini spots them.", unit: "squirrels", lower: false, maxScore: TOTAL,
  create(env) {
    return { env, t: 0, spots: makeSpots(env), sq: [], pops: [], next: 600, spawned: 0, caught: 0, missed: 0, streak: 0, boof: null };
  },
  step(s, dt) {
    s.t += dt;
    const prog = s.spawned / TOTAL, rng = s.env.rng;
    for (const q of s.sq) {
      q.age += dt;
      if (q.state === "run") {
        const ox = q.x;
        q.dist = Math.min(q.len, q.dist + lerp(85, 165, prog) * dt / 1000);
        if (q.pauseAt !== null && q.dist >= q.pauseAt) { q.state = "sit"; q.sit = 450 + 450 * rng(); q.pauseAt = null; }
        const p = pathAt(q, q.dist / q.len);
        q.x = p.x; q.y = p.y; q.lift = 3 * Math.abs(Math.sin((q.dist + 6) / 18 * Math.PI)); // one bound per 18 px run cycle, highest in the stretch
        if (q.x !== ox) q.flip = q.x < ox;
        if (q.dist >= q.len) { q.state = "gone"; s.missed++; s.streak = 0; s.boof = { t: 0, side: q.x < DOG.x ? -1 : 1 }; }
      } else if (q.state === "sit") {
        q.lift = 0;
        if ((q.sit -= dt) <= 0) q.state = "run";
      }
    }
    s.sq = s.sq.filter(q => q.state !== "gone" && (q.state !== "tapped" || q.age < TAPPED));
    for (const p of s.pops) p.age += dt;
    s.pops = s.pops.filter(p => p.age < 800);
    if (s.boof && (s.boof.t += dt) >= BOOF) s.boof = null;
    if (s.spawned >= TOTAL) return;
    s.next -= dt;
    const cap = s.spawned < 8 ? 1 : s.spawned < 16 ? 2 : 3, lv = s.sq.filter(live);
    if (s.next <= 0 && lv.length < cap) {
      const pairs = [];
      for (const a of s.spots) {
        if (lv.some(q => q.start === a)) continue;
        for (const b of s.spots) {
          if (b.p === a.p) continue;
          const A = { x: a.from, y: a.y }, B = { x: b.from, y: b.y }, len = Math.hypot(B.x - A.x, B.y - A.y);
          if (len >= 90 && len <= 320 && segDist(A, B, DOG.x, 280) >= 50) pairs.push({ a, b, A, B });
        }
      }
      if (!pairs.length) { s.next = 200; return; }
      const { a, b, A, B } = pairs[Math.floor(rng() * pairs.length)];
      const q = { start: a, end: b, a: A, b: B, bend: (rng() * 2 - 1) * 25, state: "run", age: 0, dist: 0, lift: 0, x: A.x, y: A.y, flip: B.x < A.x, pauseAt: null, sit: 0 };
      if (!clear(q, 0)) q.bend = 0;
      q.len = pathLen(q);
      if (rng() < 0.55) q.pauseAt = q.len * (0.3 + 0.4 * rng());
      s.sq.push(q); s.spawned++;
      s.next = lerp(1400, 650, s.spawned / TOTAL) * (0.8 + 0.4 * rng());
    }
  },
  pointer(s, kind, x, y) {
    if (kind !== "down") return;
    let best = null, bd = HIT;
    for (const q of s.sq.filter(live)) {
      const d = Math.hypot(q.x - x, q.y - 7 - q.lift - y);
      if (d <= bd) { bd = d; best = q; }
    }
    if (!best) return;
    best.state = "tapped"; best.age = 0; best.lift = 0;
    s.caught++; s.streak++;
    s.pops.push({ x: best.x, y: best.y - 22, age: 0, text: "+1" });
    if (s.streak >= 3) s.pops.push({ x: Math.max(50, Math.min(430, best.x)), y: best.y - 38, age: 0, text: `${s.streak} in a row!` });
  },
  draw(ctx, s, now) {
    const env = s.env, b = s.boof;
    env.drawBackground(ctx, "park");
    const layers = env.placements("park").map(p => ({ z: p.y, draw: () => env.drawObject(ctx, "park", p) }));
    for (const q of s.sq) {
      // behind its tree as it leaves and as it arrives, in front of everything else by its ground y
      const z = q.dist < 10 ? q.start.p.y - .5 : q.len - q.dist < 10 ? q.end.p.y - .5 : q.y;
      layers.push({ z, draw: () => {
        const alpha = q.state === "tapped" ? 1 - q.age / TAPPED : 1;
        ctx.fillStyle = `rgba(58,36,26,${.22 * alpha})`;
        ctx.beginPath(); ctx.ellipse(q.x, q.y, 9, 2.5, 0, 0, Math.PI * 2); ctx.fill();
        paintSquirrel(ctx, q.state === "run" ? `run${Math.floor(q.dist / 6) % 3 + 1}` : "sit", q.x, q.y - q.lift, q.flip, alpha);
      } });
    }
    layers.push({ z: DOG.y, draw: () => env.drawDog(ctx, { x: DOG.x, y: DOG.y, scale: DOG.scale, clip: b ? "boof" : "sit", facing: b && b.side < 0 ? "SW" : "SE", now }) });
    layers.sort((a, c) => a.z - c.z).forEach(l => l.draw());
    ctx.textAlign = "center"; ctx.font = "bold 11px system-ui, sans-serif";
    for (const p of s.pops) {
      ctx.globalAlpha = Math.min(1, (800 - p.age) / 300);
      const y = p.y - p.age * .03;
      ctx.fillStyle = "#3a241a"; ctx.fillText(p.text, p.x + 1, y + 1);
      ctx.fillStyle = "#fff6d8"; ctx.fillText(p.text, p.x, y);
    }
    ctx.globalAlpha = 1;
  },
  done: s => s.spawned >= TOTAL && !s.sq.some(live),
  score: s => Math.min(TOTAL, s.caught),
  hud: s => `${s.caught} caught · ${Math.max(0, TOTAL - s.caught - s.missed)} to go`,
  summary(s) {
    const n = s.caught + s.missed;
    return n ? `You beat her to ${s.caught} of ${n} squirrels.` : "No squirrels showed up.";
  },
};

// Pixel art for the squirrel, facing right, one character per pixel ("." is clear). Anchor: bottom centre.
const SQ_PALETTE = {"o": "#4a2c1c", "d": "#8c5530", "m": "#b8743c", "l": "#d9975a", "h": "#f0c58a", "c": "#f5e6cc", "e": "#1c120c", "w": "#ffffff", "p": "#e0957f"};
const SQ_FRAMES = {
  run1: [
    "....ooooo...............",
    "..oohhhhhoo.............",
    ".ohhhllllldo............",
    ".ohllmmmmmdo............",
    "ohllmmddmmmdo...o.......",
    "ohlmmdooodmdo..opo......",
    "ohlmmdo..oddo..opmoo....",
    "ohlmmmo...oo..omllllo...",
    "ohlmmmdo.....omlllhllo..",
    ".ohlmmmdooooomllllewllo.",
    "..ohllllllllmlllllelllo.",
    "...ohmmmmmmmmmlllllcccoo",
    "...ommmmmmmmmmllccccloo.",
    "...odmmmmmmmmlcccccoo...",
    "..oodddmmmmmlccccco.....",
    ".oooooddddoooooooddo....",
    "oddo.....o.....oddmo....",
    "ooo.............ooooo...",
  ],
  run2: [
    "....ooooo...............",
    "..oohhhhhoo.............",
    ".ohhhllllldo............",
    ".ohllmmmmmdo............",
    "ohllmmddmmmdo...o.......",
    "ohlmmdooodmdo..opo......",
    "ohlmmdo..oddo..opmoo....",
    "ohlmmmo...oo..omllllo...",
    "ohlmmmdo.....omlllhllo..",
    ".ohlmmmdooooomllllewllo.",
    "..ohllllllllmlllllelllo.",
    "...ohmmmmmmmmmlllllcccoo",
    "...ommmmmmmmmmllccccloo.",
    "...odmmmmmmmmlcccccoo...",
    "..oodddmmmmmlccccco.....",
    "...oodddddooooooddo.....",
    "....oddmo......oddo.....",
    "....oooo.......oooo.....",
  ],
  run3: [
    "....ooooo...............",
    "..oohhhhhoo.............",
    ".ohhhllllldo............",
    ".ohllmmmmmdo............",
    "ohllmmddmmmdo...o.......",
    "ohlmmdooodmdo..opo......",
    "ohlmmdo..oddo..opmoo....",
    "ohlmmmo...oo..omllllo...",
    "ohlmmmdo.....omlllhllo..",
    ".ohlmmmdooooomllllewllo.",
    "..ohllllllllmlllllelllo.",
    "...ohmmmmmmmmmlllllcccoo",
    "...ommmmmmmmmmllccccloo.",
    "...odmmmmmmmmlcccccoo...",
    "..oodddmmmmmlccccco.....",
    "...ooddddddooodddo......",
    "........oddmoddo........",
    "........oooooooo........",
  ],
  sit: [
    "....ooooo...............",
    "..oohhhhhoo.............",
    ".ohhhllllldoo...o.......",
    ".ohllmmmmmdoo..opo......",
    "ohllmmddmmmdo..opmoo....",
    "ohlmmdooodmdo.omllllo...",
    "ohlmmdo..oddoomlllhllo..",
    "ohlmmmo...ooomllllewllo.",
    "ohlmmmdo....mlllllelllo.",
    ".ohlmmmdo...mmlllllcccoo",
    "..ohlmmmdo..mmllccccloo.",
    "...ohllmmmoommmllcccco..",
    "....ohlmmmommmmllcccco..",
    ".....ohlmommmmmllcddo...",
    "......oohommmmmlccddo...",
    "........ommmmmmlccccdo..",
    "........odmmmmmlcccccdo.",
    "........oddmmmmmlcccco..",
    "........oddddmmmlcccdo..",
    "........oodddddoddddo...",
    ".........odddddddmmo....",
    ".........oooooooooo.....",
  ],
};
// One fillRect per run of same-coloured pixels: about a hundred per frame, so no cache is needed.
function paintSquirrel(ctx, frame, x, y, flip, alpha) {
  const rows = SQ_FRAMES[frame], w = rows[0].length, left = Math.round(x - w / 2), top = Math.round(y) - rows.length;
  ctx.globalAlpha = alpha;
  rows.forEach((row, j) => {
    for (let i = 0; i < w;) {
      const ch = row[i];
      let n = 1;
      while (row[i + n] === ch) n++;
      if (ch !== ".") { ctx.fillStyle = SQ_PALETTE[ch]; ctx.fillRect(flip ? left + w - i - n : left + i, top + j, n, 1); }
      i += n;
    }
  });
  ctx.globalAlpha = 1;
}
