// Bath scrub: rub Zucchini to build bubbles, then let go when she starts to wiggle for a "Perfect rinse" (bubbles count double).
// Keep rubbing and she gives a happy shake: that scrub's bubbles pop, banked ones stay. Nothing bad ever happens.
const ROUND_MS = 45000, WIGGLE_AT = 0.7, SHAKE_MS = 900, SETTLE_MS = 450, PX_PER_BUBBLE = 16;
const BOX = [150, 105, 180, 120];                 // generous hit box around her upper body: x, y, w, h
const FEET = [240, 262];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const inBox = (x, y) => x >= BOX[0] && x <= BOX[0] + BOX[2] && y >= BOX[1] && y <= BOX[1] + BOX[3];

const C = { wall: "#e8e0d1", grout: "#d5cbbb", band: "#8fa3b0", bandDark: "#5a6b78", floor: "#a67353", floorDark: "#80543a",
  enamel: "#fdfaf5", enamelShade: "#ddd2c6", enamelDark: "#c4b5a8", gold: "#c4993e", goldLight: "#e5b65b", water: "#a9cfd8", waterDark: "#7fb3c4",
  bubble: "#ffffff", bubbleBlue: "#cfe8f2", ink: "#3a3340" };

export const bathScrub = {
  id: "bath", title: "Bath scrub", scenes: [], how: "Rub her to make bubbles. Stop when she wiggles.", unit: "bubbles", lower: false, maxScore: 2000,
  create(env) {
    return { env, t: 0, banked: 0, pending: 0, wiggle: 0, sens: 1, down: false, last: null, acc: 0, lastScrubT: -1e9,
      perfect: 0, shakes: 0, shakeT: 0, settleT: 0, bubbles: [], drops: [], splats: [], banner: null, over: false };
  },
  step(s, dt) {
    if (s.over) return;
    s.t += dt;
    for (const b of s.bubbles) { b.life -= dt; b.x += b.vx * dt; b.y += b.vy * dt; }
    s.bubbles = s.bubbles.filter(b => b.life > 0);
    for (const d of s.drops) { d.life -= dt; d.x += d.vx * dt; d.y += d.vy * dt; d.vy += 0.0006 * dt; }
    s.drops = s.drops.filter(d => d.life > 0 && d.x > -5 && d.x < 485 && d.y < 325);
    for (const p of s.splats) p.life -= dt;
    s.splats = s.splats.filter(p => p.life > 0);
    if (s.banner && (s.banner.life -= dt) <= 0) s.banner = null;
    if (s.shakeT > 0) {
      s.shakeT -= dt;
      if (s.drops.length < 70) for (let i = 0; i < 2; i++) {
        const a = s.env.rng() * Math.PI * 2, v = 0.08 + s.env.rng() * 0.18;
        s.drops.push({ x: FEET[0] + (s.env.rng() - 0.5) * 70, y: FEET[1] - 80 + (s.env.rng() - 0.5) * 40, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.1, life: 500 + s.env.rng() * 400 });
      }
      if (s.shakeT <= 0) { s.settleT = SETTLE_MS; s.wiggle = 0; s.pending = 0; }
    } else if (s.settleT > 0) s.settleT -= dt;
    else if (s.t - s.lastScrubT > 250) s.wiggle = Math.max(0, s.wiggle - 0.00012 * dt);   // slow decay while not rubbing
    if (s.t >= ROUND_MS) { s.banked += s.pending; s.pending = 0; s.over = true; }
  },
  pointer(s, kind, x, y) {
    if (s.over || s.shakeT > 0 || s.settleT > 0) { if (kind === "up") s.down = false; return; }
    const env = s.env;
    if (kind === "down") {
      s.down = true; s.last = [x, y]; s.acc = 0;
      if (!s.pending) s.sens = 0.6 + env.rng() * 0.9;   // a new scrub: she is ticklish by a random amount
    } else if (kind === "move" && s.down && s.last) {
      const [px, py] = s.last, d = Math.min(60, Math.hypot(x - px, y - py));
      s.last = [x, y];
      if (!inBox(x, y) || d <= 0) return;
      s.lastScrubT = s.t; s.acc += d; s.wiggle = Math.min(1, s.wiggle + d * 0.0011 * s.sens);
      while (s.acc >= PX_PER_BUBBLE) {
        s.acc -= PX_PER_BUBBLE; s.pending++;
        if (s.bubbles.length < 140) s.bubbles.push({ x: x + (env.rng() - 0.5) * 18, y: y + (env.rng() - 0.5) * 18, r: 2 + Math.floor(env.rng() * 4),
          vx: (env.rng() - 0.5) * 0.008, vy: -0.004 - env.rng() * 0.012, life: 1500 + env.rng() * 1500, blue: env.rng() < 0.4 });
      }
      if (s.wiggle >= 1) {   // a big happy shake: this scrub's bubbles pop
        s.shakes++; s.shakeT = SHAKE_MS; s.pending = 0; s.down = false; s.bubbles = s.bubbles.slice(-30);
        for (let i = 0; i < 5; i++) s.splats.push({ x: 40 + env.rng() * 400, y: 30 + env.rng() * 220, r: 6 + env.rng() * 8, life: 2200 });
      }
    } else if (kind === "up" && s.down) {
      s.down = false;
      if (s.pending > 0) {
        const perfect = s.wiggle >= WIGGLE_AT;
        s.banked += s.pending * (perfect ? 2 : 1); s.pending = 0;
        if (perfect) { s.perfect++; s.wiggle = 0; s.banner = { text: "Perfect rinse!", life: 1300, max: 1300 }; }
      }
    }
  },
  draw(ctx, s, now) {
    const t = s.t, wig = s.wiggle >= WIGGLE_AT && s.shakeT <= 0, shaking = s.shakeT > 0;
    ctx.imageSmoothingEnabled = false;
    // wall tiles
    ctx.fillStyle = C.wall; ctx.fillRect(0, 0, 480, 270);
    ctx.fillStyle = C.grout;
    for (let y = 0; y < 270; y += 20) ctx.fillRect(0, y, 480, 1);
    for (let y = 0, r = 0; y < 270; y += 20, r++) for (let x = (r % 2) * 15; x < 480; x += 30) ctx.fillRect(x, y, 1, 20);
    ctx.fillStyle = C.band; ctx.fillRect(0, 60, 480, 12); ctx.fillStyle = C.bandDark; ctx.fillRect(0, 72, 480, 2);
    // floor strip
    ctx.fillStyle = C.floor; ctx.fillRect(0, 270, 480, 50);
    ctx.fillStyle = C.floorDark; ctx.fillRect(0, 270, 480, 3);
    for (let x = 20; x < 480; x += 60) ctx.fillRect(x, 273, 1, 47);
    // tub back: inner wall and water
    ctx.fillStyle = C.enamelShade; ctx.fillRect(80, 172, 320, 56);
    ctx.fillStyle = C.enamelDark; ctx.fillRect(80, 172, 320, 3);
    ctx.fillStyle = C.water; ctx.fillRect(92, 196, 296, 32);
    ctx.fillStyle = C.waterDark; ctx.fillRect(92, 196, 296, 2);
    // Zucchini
    const amp = shaking ? 7 : wig ? 1.6 : 0, wob = Math.sin(now * (shaking ? 0.09 : 0.06));
    const jx = amp * wob, jy = amp * 0.25 * Math.sin(now * 0.11);
    s.env.drawDog(ctx, { x: FEET[0] + jx, y: FEET[1] + jy, clip: "bath_time", facing: "SE", scale: 2.2, now, shadow: false });
    // bubbles clinging to her
    for (const b of s.bubbles) {
      const k = Math.min(1, b.life / 400);
      ctx.globalAlpha = k;
      ctx.fillStyle = b.blue ? C.bubbleBlue : C.bubble; ctx.beginPath(); ctx.arc(b.x + jx * 0.5, b.y, b.r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.bubble; ctx.fillRect(Math.round(b.x - b.r * 0.5 + jx * 0.5), Math.round(b.y - b.r * 0.5), Math.max(1, Math.round(b.r / 3)), Math.max(1, Math.round(b.r / 3)));
    }
    ctx.globalAlpha = 1;
    // tub front over her lower body
    ctx.globalAlpha = 0.55; ctx.fillStyle = C.water; ctx.fillRect(92, 218, 296, 8); ctx.globalAlpha = 1;
    ctx.fillStyle = C.enamel; ctx.fillRect(80, 226, 320, 60);
    ctx.fillStyle = C.enamelShade; ctx.fillRect(80, 270, 320, 16);
    ctx.fillStyle = C.enamelDark; ctx.fillRect(80, 284, 320, 2);
    ctx.fillStyle = C.enamel; ctx.fillRect(74, 218, 332, 10);                     // rim
    ctx.fillStyle = C.enamelDark; ctx.fillRect(74, 227, 332, 2);
    ctx.fillStyle = C.gold;
    for (const fx of [96, 366]) { ctx.fillRect(fx, 286, 18, 10); ctx.fillStyle = C.goldLight; ctx.fillRect(fx, 286, 18, 3); ctx.fillStyle = C.gold; }
    // a tap at the back
    ctx.fillStyle = C.gold; ctx.fillRect(228, 150, 24, 8); ctx.fillRect(236, 158, 8, 14); ctx.fillStyle = C.goldLight; ctx.fillRect(228, 150, 24, 2);
    // wiggle cues: ears flick and a "!" bubble
    if (wig) {
      const f = Math.floor(now / 90) % 2;
      ctx.fillStyle = C.ink;
      ctx.fillRect(FEET[0] - 38 + jx, FEET[1] - 128 - f * 3, 8, 2); ctx.fillRect(FEET[0] + 30 + jx, FEET[1] - 128 - (1 - f) * 3, 8, 2);
      ctx.fillStyle = C.enamel; ctx.beginPath(); ctx.arc(FEET[0] + 62, FEET[1] - 150, 13, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.ink; ctx.fillRect(FEET[0] + 61, FEET[1] - 158, 3, 10); ctx.fillRect(FEET[0] + 61, FEET[1] - 144, 3, 3);
    }
    // droplets and splats on the screen
    ctx.fillStyle = C.bubbleBlue;
    for (const d of s.drops) { ctx.beginPath(); ctx.arc(d.x, d.y, 2.5, 0, Math.PI * 2); ctx.fill(); }
    for (const p of s.splats) {
      ctx.globalAlpha = Math.min(0.7, p.life / 1200); ctx.fillStyle = C.bubbleBlue;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = C.bubble; ctx.fillRect(Math.round(p.x - p.r / 2), Math.round(p.y - p.r / 2), 3, 3);
    }
    ctx.globalAlpha = 1;
    // wiggle meter
    ctx.fillStyle = C.ink; ctx.fillRect(14, 14, 84, 12);
    ctx.fillStyle = C.enamel; ctx.fillRect(16, 16, 80, 8);
    ctx.fillStyle = s.wiggle >= WIGGLE_AT ? C.goldLight : C.waterDark; ctx.fillRect(16, 16, Math.round(80 * s.wiggle), 8);
    ctx.fillStyle = C.ink; ctx.fillRect(16 + 56, 14, 2, 12);
    if (s.banner) {
      const k = 1 - s.banner.life / s.banner.max;
      ctx.globalAlpha = Math.min(1, s.banner.life / 300); ctx.font = "bold 20px monospace"; ctx.textAlign = "center";
      ctx.fillStyle = C.ink; ctx.fillText(s.banner.text, 241, 61 - k * 20); ctx.fillStyle = C.enamel; ctx.fillText(s.banner.text, 240, 60 - k * 20);
      ctx.globalAlpha = 1; ctx.textAlign = "left";
    }
  },
  done(s) { return s.over; },
  score(s) { return clamp(Math.floor(s.banked), 0, 2000); },
  hud(s) {
    const left = Math.max(0, Math.ceil((ROUND_MS - s.t) / 1000));
    return `${bathScrub.score(s)}${s.pending ? ` +${s.pending}` : ""} bubbles · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  },
  summary(s) { return `${s.perfect} perfect rinse${s.perfect === 1 ? "" : "s"} · ${s.shakes} shake${s.shakes === 1 ? "" : "s"}`; },
};
