// Squirrel patrol: squirrels peek out beside the park's trees and shrubs. Tap each one before Zucchini spots it.
const ROUND = 45000, HIT = 26, SLIDE = 220, SCAMPER = 450, BOOF = 900, SCALE = 1.3;
const HIDERS = ["oak", "maple", "birch", "shrub"], TREES = ["oak", "maple", "birch"];
const DOG = { x: 240, y: 298, scale: 0.75 };
const lerp = (a, b, p) => a + (b - a) * p;
const ease = k => 1 - (1 - k) * (1 - k);
const live = q => q.state === "slide" || q.state === "hold";

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

export const squirrelPatrol = {
  id: "squirrel", title: "Squirrel patrol", scenes: ["park", "neighborhood"], how: "Tap each squirrel before Zucchini spots it.", unit: "squirrels", lower: false, maxScore: 300,
  create(env) {
    return { env, t: 0, spots: makeSpots(env), sq: [], pops: [], next: 600, caught: 0, missed: 0, streak: 0, boof: null };
  },
  step(s, dt) {
    s.t += dt;
    const prog = Math.min(1, s.t / ROUND);
    for (const q of s.sq) {
      q.age += dt;
      if (q.state === "slide") {
        q.x = lerp(q.spot.from, q.spot.x, ease(Math.min(1, q.age / SLIDE)));
        if (q.age >= SLIDE) { q.state = "hold"; q.age = 0; q.x = q.spot.x; }
      } else if (q.state === "hold" && q.age >= q.window) {
        q.state = "spotted"; q.age = 0; s.missed++; s.streak = 0; s.boof = { t: 0, side: q.x < DOG.x ? -1 : 1 };
      }
    }
    s.sq = s.sq.filter(q => live(q) || q.age < SCAMPER);
    for (const p of s.pops) p.age += dt;
    s.pops = s.pops.filter(p => p.age < 800);
    if (s.boof && (s.boof.t += dt) >= BOOF) s.boof = null;
    if (s.t >= ROUND) return;
    s.next -= dt;
    const cap = prog < .35 ? 1 : prog < .7 ? 2 : 3;
    if (s.next <= 0 && s.sq.filter(live).length < cap) {
      // a spot that is not in use (fading squirrels count) and not crowding another
      const free = s.spots.filter(sp => !s.sq.some(q => q.spot === sp || Math.hypot(q.spot.x - sp.x, q.spot.y - sp.y) < 30));
      if (free.length) {
        const spot = free[Math.floor(s.env.rng() * free.length)];
        s.sq.push({ spot, state: "slide", age: 0, x: spot.from, y: spot.y, window: lerp(1800, 750, prog) });
        s.next = lerp(1300, 550, prog) * (0.8 + 0.4 * s.env.rng());
      }
    }
  },
  pointer(s, kind, x, y) {
    if (kind !== "down" || s.t >= ROUND) return;
    let best = null, bd = HIT;
    for (const q of s.sq.filter(live)) {
      const d = Math.hypot(q.x - x, q.y - 8 - y);
      if (d <= bd) { bd = d; best = q; }
    }
    if (!best) return;
    best.state = "tapped"; best.age = 0;
    s.caught++; s.streak++;
    s.pops.push({ x: best.x, y: best.y - 22, age: 0, text: "+1" });
    if (s.streak >= 3) s.pops.push({ x: Math.max(50, Math.min(430, best.x)), y: best.y - 38, age: 0, text: `${s.streak} in a row!` });
  },
  draw(ctx, s, now) {
    const env = s.env, b = s.boof;
    env.drawBackground(ctx, "park");
    // depth sort: a sliding squirrel is behind its tree, then steps in front
    const layers = env.placements("park").map(p => ({ z: p.y, draw: () => env.drawObject(ctx, "park", p) }));
    for (const q of s.sq) layers.push({ z: q.spot.p.y + (q.state === "slide" ? -.5 : 1.5), draw: () => drawSquirrel(ctx, env, q, now) });
    layers.push({ z: DOG.y, draw: () => env.drawDog(ctx, { x: DOG.x, y: DOG.y, scale: DOG.scale, clip: b ? "boof" : "sit", facing: b && b.side < 0 ? "SW" : "SE", now }) });
    layers.sort((a, c) => a.z - c.z).forEach(l => l.draw());
    // alert rings fill as she gets closer to spotting each squirrel
    for (const q of s.sq.filter(live)) {
      const k = q.state === "slide" ? 0 : Math.min(1, q.age / q.window), cy = q.y - 9;
      ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath(); ctx.arc(q.x, cy, 16, 0, Math.PI * 2); ctx.stroke();
      if (k > 0) { ctx.strokeStyle = k > .66 ? "#e8553c" : "#f2b632"; ctx.beginPath(); ctx.arc(q.x, cy, 16, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2); ctx.stroke(); }
    }
    ctx.textAlign = "center"; ctx.font = "bold 11px system-ui, sans-serif";
    for (const p of s.pops) {
      ctx.globalAlpha = Math.min(1, (800 - p.age) / 300);
      const y = p.y - p.age * .03;
      ctx.fillStyle = "#3a241a"; ctx.fillText(p.text, p.x + 1, y + 1);
      ctx.fillStyle = "#fff6d8"; ctx.fillText(p.text, p.x, y);
    }
    ctx.globalAlpha = 1;
  },
  done: s => s.t >= ROUND,
  score: s => Math.min(300, s.caught),
  hud(s) {
    const left = Math.max(0, Math.ceil((ROUND - s.t) / 1000));
    return `${s.caught} ${s.caught === 1 ? "squirrel" : "squirrels"} · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  },
  summary(s) {
    const n = s.caught + s.missed;
    return n ? `You beat her to ${s.caught} of ${n} squirrels.` : "No squirrels showed up.";
  },
};

function drawSquirrel(ctx, env, q, now) {
  const { spot } = q, k = Math.min(1, q.age / SCAMPER), run = Math.floor(now / 90) % 2 ? "squirrel_run1" : "squirrel_run2";
  // the sprite faces right, so flip it when it comes out on the left
  let x = q.x, y = q.y, alpha = 1, name = q.state === "hold" ? "squirrel_run1" : run, flip = spot.side < 0;
  if (q.state === "tapped" || q.state === "spotted") {
    alpha = 1 - k;
    if (q.state === "tapped" && spot.tree) { name = "squirrel_climb"; flip = false; x = lerp(q.x, spot.p.x, ease(k)); y = q.y - k * 34; }
    else { name = run; x = q.x + spot.side * k * 70; }
  }
  ctx.fillStyle = `rgba(58,36,26,${.22 * alpha})`;
  ctx.beginPath(); ctx.ellipse(x, q.y, 11 * SCALE, 3.4, 0, 0, Math.PI * 2); ctx.fill();
  env.drawActor(ctx, name, x, y, { flip, alpha, scale: SCALE });
}
