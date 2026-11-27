// Walk antics for the neighborhood outing: a leash, and a small director that every 20 to 40 seconds starts one short scene
// (a tug, a car at the curb, a squirrel, a dog friend...). Each antic is a list of timed steps. Nothing bad ever happens to her.
// outings.js calls in through a few small hooks; this module imports nothing and stores nothing (main.js owns localStorage).
const FRIENDS = [{ id: "mochi", name: "Mochi" }, { id: "biscuit", name: "Biscuit" }, { id: "juno", name: "Juno" }];
export const FRIEND_KEY = "zucchini-dog-friends";
export const readFriends = storage => {
  try { const v = JSON.parse(storage.getItem(FRIEND_KEY)); return Array.isArray(v) ? v.filter(id => FRIENDS.some(f => f.id === id)) : []; } catch { return []; }
};
export const writeFriends = (storage, ids) => { try { storage.setItem(FRIEND_KEY, JSON.stringify([...new Set(ids)])); } catch {} };

const PROMPT_MS = 8000, GAP_MIN = 20000, GAP_SPAN = 20000;
const lerp = (a, b, k) => a + (b - a) * k;
const ease = k => k * k * (3 - 2 * k);
const inside = (x, y, p) => {
  let yes = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [ax, ay] = p[i], [bx, by] = p[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) yes = !yes;
  }
  return yes;
};

export function newAntics(now, rng = Math.random) {
  const s = { rng, last: null, clock: now, env: { weather: "sunny", month: 1, dark: false, damp: false }, friends: new Set(), onMeet: null,
    leash: { ax: null, taut: 0, target: 0 }, history: [] };
  s.nextAt = now + GAP_MIN + rng() * GAP_SPAN;
  return s;
}
export function setAnticEnv(v, env) { if (v.antics) Object.assign(v.antics.env, env); }

// ---------------------------------------------------------------- helpers

const rnd = (v, lo, hi) => lo + (hi - lo) * v.antics.rng();
const pick = (v, list) => list[Math.floor(v.antics.rng() * list.length) % list.length];
const placed = (v, object) => v.placements.filter(p => p.object === object);
const spotNear = (v, x, y) => { const n = v.grid.nearest([x, y]); return n < 0 ? [...v.pos] : [...v.grid.nodes[n]]; };
const onFloor = (v, x, y) => inside(x, y, v.scene.editing.floor);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function face(v, x, y) {
  const dx = x - v.pos[0], dy = y - v.pos[1];
  v.facing = dy < -10 ? (dx >= 0 ? "NE" : "NW") : (dx >= 0 ? "SE" : "SW");
}
function freeSpot(v, minFar = 60) {
  for (let i = 0; i < 8; i++) {
    const p = spotNear(v, rnd(v, 45, 435), rnd(v, 150, 290));
    if (dist(p, v.pos) >= minFar) return p;
  }
  return spotNear(v, rnd(v, 45, 435), rnd(v, 150, 290));
}
// The bottom edge of the floor at x: where the curb is.
function curbY(v, x) {
  let y = 150;
  for (let t = 150; t < 330; t++) if (onFloor(v, x, t)) y = t;
  return y;
}
function pose(v, clip, facing, { frame = null, lift = 0, fast = false } = {}) {
  v.clip = clip; v.frame = frame; v.lift = lift; v.fast = fast;
  if (facing) v.facing = facing;
}
function follow(v, dt, speed) {  // the same path walking as stepOuting, in px per ms
  let remaining = Math.max(0, Math.min(200, dt)) * speed;
  while (v.path.length && remaining > 0) {
    const p = v.path[0], dx = p[0] - v.pos[0], dy = p[1] - v.pos[1], d = Math.hypot(dx, dy);
    if (d > 0) v.facing = dy < -2 ? (dx >= 0 ? "NE" : "NW") : (dx >= 0 ? "SE" : "SW");
    if (d <= remaining) { v.pos = [...p]; v.path.shift(); remaining -= d; }
    else { v.pos[0] += dx / d * remaining; v.pos[1] += dy / d * remaining; remaining = 0; }
  }
  return !v.path.length;
}
const startWalk = (v, target, fast = false) => { v.path = v.grid.route(v.pos, target); v.fast = fast; v.clip = fast ? "run" : "walk"; v.frame = null; v.lift = 0; };
const walkStep = (target, { fast = false, notice = null } = {}) => ({
  enter: (v, a) => { if (notice) v.notice = notice; startWalk(v, typeof target === "function" ? target(v, a) : target, fast); },
  run: (v, a, k, now, dt) => { follow(v, dt, fast ? .095 : .06); },
  done: v => !v.path.length,
});
const ask = (a, now, labels, onChoose) => { a.choice = null; a.prompt = { labels, until: now + PROMPT_MS, onChoose }; };
const answered = a => a.choice !== null || !a.prompt;
const bubble = (v, a, now, text, ms = 900) => a.bubbles.push({ x: v.pos[0], y: v.pos[1] - v.lift - 50, text, until: now + ms });
// A short hop on each boof.
const hop = (t, period) => 3.5 * Math.abs(Math.sin(t / period * Math.PI)) ** 2;

// An actor is a sprite that is not her: frame name(s), a position, and an optional path it walks at speed px/ms.
function actor(a, props) { const ac = { x: 0, y: 0, flip: false, path: [], speed: 0, ms: 160, alpha: 1, ...props }; a.actors.push(ac); return ac; }
function moveActor(ac, dt) {
  let remaining = Math.max(0, Math.min(200, dt)) * ac.speed;
  while (ac.path.length && remaining > 0) {
    const p = ac.path[0], dx = p[0] - ac.x, dy = p[1] - ac.y, d = Math.hypot(dx, dy);
    if (d > 0.001) ac.flip = dx < 0;
    if (d <= remaining) { ac.x = p[0]; ac.y = p[1]; ac.path.shift(); remaining -= d; }
    else { ac.x += dx / d * remaining; ac.y += dy / d * remaining; remaining = 0; }
  }
}
// A route along the sidewalk for an actor, from beyond the screen edge to a spot (and the reverse): the grid avoids props.
function routeFromEdge(v, left, to) {
  const edge = spotNear(v, left ? 14 : 466, to[1]);
  return [[left ? -24 : 504, edge[1]], edge, ...v.grid.route(edge, to)];
}
const routeToEdge = (v, from, left) => {
  const edge = spotNear(v, left ? 14 : 466, from[1]);
  return [...v.grid.route(from, edge), [left ? -24 : 504, edge[1]]];
};

// ---------------------------------------------------------------- the antics

const ANTICS = [
  // She plants her feet and pulls toward a smell. Let her sniff (a find roll in outings.js) or keep walking.
  { id: "tug", eligible: () => true, steps: (v) => {
    const spot = freeSpot(v, 40);
    return [
      { dur: 700, enter: (v, a) => { face(v, ...spot); pose(v, "sniff", v.facing); v.notice = "Zucchini catches a whiff of something."; } },
      { enter: (v, a, now) => {
        pose(v, "sniff_plant", v.facing); v.notice = "She plants her feet and pulls. Something smells amazing!";
        a.taut = 1; a.base = [...v.pos]; ask(a, now, ["Let her sniff", "Keep walking"]);
      }, run: (v, a, k, now) => {
        const d = Math.hypot(spot[0] - a.base[0], spot[1] - a.base[1]) || 1, strain = 1.5 + Math.sin(now / 110);
        v.pos = [a.base[0] + (spot[0] - a.base[0]) / d * strain, a.base[1] + (spot[1] - a.base[1]) / d * strain * .5];
      }, done: (v, a) => answered(a) },
      { enter: (v, a, now) => {
        v.pos = [...a.base];
        if (a.choice === 0) endAntic(v, now, { target: spot, action: { kind: "pose", clip: "sniff", label: "Zucchini sniffs the good smell.", find: true }, notice: "Off to the smell!" });
        else endAntic(v, now, { target: freeSpot(v), action: null, notice: "Zucchini grumbles and trots along." });
      } },
    ];
  } },

  // A car at the curb: she trots to the curb, lunges at it, and the taut leash stops her at the edge of the sidewalk.
  { id: "lunge", eligible: v => curbSpots(v).length > 0, steps: (v) => {
    const c = pick(v, curbSpots(v)), dir = v.antics.rng() < .5 ? "ne" : "sw", color = pick(v, ["red", "teal", "mustard"]);
    const slope = (curbY(v, c.x + 20) - curbY(v, c.x - 20)) / 40, len = Math.hypot(1, slope), n = [-slope / len, 1 / len];  // normal, pointing at the road
    const lane = x => 374.8 - .304 * x + 30, startX = dir === "ne" ? 130 : 560, endX = dir === "ne" ? 560 : 130;  // along the road, which only shows right of x=230
    let stage, stop, car;
    const passed = () => dir === "ne" ? car.x > stop[0] + 90 : car.x < stop[0] - 90;
    return [
      { enter: (v, a) => { v.notice = "Zucchini trots along the curb."; stage = spotNear(v, c.x - n[0] * 34, c.y - n[1] * 34); startWalk(v, stage); },
        run: (v, a, k, now, dt) => { follow(v, dt, .06); }, done: v => !v.path.length },
      { dur: 600, enter: (v, a) => {
        stage = [...v.pos]; stop = [...stage];
        while (onFloor(v, stop[0] + n[0] * 4, stop[1] + n[1] * 4)) { stop[0] += n[0]; stop[1] += n[1]; }  // the leash stops her within 4px of the edge
        face(v, stop[0] + n[0] * 20, stop[1] + n[1] * 20); pose(v, "listen", v.facing); v.notice = "A car is coming!";
        car = actor(a, { frame: `car_${color}_${dir}`, x: startX, y: lane(startX), speed: .13, kind: "car" });
        car.path = [[endX, lane(endX)]];
      } },
      { done: () => dir === "ne" ? car.x >= stop[0] - 120 : car.x <= stop[0] + 120 },
      { dur: 380, enter: (v, a, now) => {
        pose(v, "run", null, { fast: true }); face(v, car.x, car.y); if (v.facing[0] === "N") v.facing = "S" + v.facing[1];
        a.taut = 1; v.notice = "Zucchini lunges at the car, but the leash holds. Safe at the curb.";
      }, run: (v, a, k) => { const e = 1 - (1 - k) ** 3; v.pos = [lerp(stage[0], stop[0], e), lerp(stage[1], stop[1], e)]; } },
      { enter: (v, a, now) => { pose(v, "listen", v.facing); ask(a, now, ["Call her back"]); },
        done: (v, a) => a.choice !== null || passed() },
      { dur: 900, enter: (v, a) => {
        a.taut = 0; pose(v, "walk", null); v.notice = a.choice !== null ? "She trots back to you." : "The car is gone. Zucchini trots back on her own."; a.prompt = null;
      }, run: (v, a, k) => { const e = ease(k); v.pos = [lerp(stop[0], stage[0], e), lerp(stop[1], stage[1], e)]; face(v, stage[0], stage[1]); } },
      { dur: 1500, enter: (v, a) => { pose(v, "sit", "SE"); v.notice = "Good girl. She sits."; } },
      { done: () => car.path.length === 0 },
    ];
  } },

  // She flops into a sploot and refuses to move. A treat gets her going.
  { id: "brake", eligible: () => true, steps: () => [
    { dur: 800, enter: (v) => { pose(v, "idle"); v.notice = "Zucchini slows down..."; } },
    { dur: 700, enter: (v) => { pose(v, "sploot_enter", null, { frame: 0 }); }, run: (v, a, k) => { v.frame = Math.min(3, Math.floor(k * 4)); } },
    { enter: (v, a, now) => { pose(v, "sploot"); v.notice = "She flops down. She is not going anywhere."; ask(a, now, ["Coax her with a treat"]); },
      done: (v, a) => answered(a) },
    { dur: 1400, enter: (v, a, now) => {
      if (a.choice === 0) { pose(v, "treat_reaction", "SE"); v.notice = "A treat! Zucchini perks right up."; a.treated = true; }
      else v.notice = "She thinks it over...";
    } },
    { dur: 700, enter: (v, a) => { if (a.treated) { pose(v, "happy"); v.notice = "Happy girl. The walk goes on."; } else { pose(v, "sploot_exit", null, { frame: 0 }); v.notice = "Fine. Zucchini gets up on her own."; } },
      run: (v, a, k) => { if (!a.treated) v.frame = Math.min(3, Math.floor(k * 4)); } },
    { enter: (v, a, now) => endAntic(v, now, { target: freeSpot(v), action: null }) },
  ] },

  // A squirrel runs to a street tree and up the trunk; she stands at the trunk and boofs.
  { id: "squirrel", eligible: v => placed(v, "street_tree").length > 0 && !!v.scene.actors, steps: (v) => {
    const tree = pick(v, placed(v, "street_tree")), base = [tree.x, tree.y + 4];
    const fromLeft = tree.x > 240 ? true : tree.x < 120 ? false : v.antics.rng() < .5;
    const sx = fromLeft ? tree.x - rnd(v, 130, 190) : tree.x + rnd(v, 130, 190);
    let sq;
    const stand = [tree.x, tree.y + 16];
    return [
      { dur: 500, enter: (v, a) => {
        pose(v, "listen"); v.notice = "A squirrel!";
        sq = actor(a, { frames: ["squirrel_run1", "squirrel_run2"], ms: 90, x: Math.max(-14, Math.min(494, sx)), y: base[1] + 2, speed: .13, path: [[base[0], base[1] + 2]], kind: "squirrel" });
        // Once at the trunk it climbs: in front of the tree at first, then behind the crown, then gone.
        sq.update = (ac, dt) => {
          if (!ac.mode && !ac.path.length) { ac.mode = "climb"; ac.frames = null; ac.frame = "squirrel_climb"; ac.flip = false; ac.y0 = ac.y; ac.age = 0; }
          if (ac.mode === "climb") { ac.age += dt; ac.y = ac.y0 - ac.age * .07; ac.z = ac.y > tree.y - 30 ? tree.y + 2 : tree.y - 2; if (ac.y < tree.y - 40) ac.alpha = 0; }
        };
      }, run: (v, a, k) => { face(v, sq.x, sq.y); } },
      { enter: (v, a) => { startWalk(v, stand, true); v.notice = "Zucchini is after it!"; },
        run: (v, a, k, now, dt) => { follow(v, dt, .095); }, done: v => !v.path.length },
      { dur: 2600, enter: (v, a, now) => { pose(v, "boof", "NE"); v.notice = "Boof! Boof! She tells the tree off."; a.boofs = 0; },
        run: (v, a, k, now) => {
          const t = now - a.t0;
          for (const at of [250, 1500]) if (t >= at && a.boofs === (at === 250 ? 0 : 1)) { a.boofs++; bubble(v, a, now, "Boof!", 800); a.hopAt = now; }
          v.lift = a.hopAt && now - a.hopAt < 260 ? hop(now - a.hopAt, 260) : 0;
        } },
      { dur: 900, enter: (v, a) => { pose(v, "listen", "NE"); v.notice = "Zucchini watches the branches."; } },
    ];
  } },

  // Another dog walks up the sidewalk; nose to nose, then it moves on. The first hello learns its name.
  { id: "friend", eligible: v => !!v.scene.actors, steps: (v) => {
    const met = v.antics.friends, unmet = FRIENDS.filter(f => !met.has(f.id));
    const f = unmet.length && v.antics.rng() < .75 ? pick(v, unmet) : pick(v, FRIENDS), known = met.has(f.id);
    const left = v.antics.rng() < .5, meet = spotNear(v, rnd(v, 190, 320), 214);
    let dog, friendSpot, her;
    const learn = (v, a) => {
      if (known || a.learned) return; a.learned = true; v.antics.friends.add(f.id); v.antics.onMeet?.(f.id, [...v.antics.friends]);
      v.notice = `This is ${f.name}.`;
    };
    return [
      walkStep(() => meet, { notice: "Zucchini trots along the sidewalk." }),
      { dur: 400, enter: (v, a, now) => {
        her = [...v.pos]; friendSpot = spotNear(v, her[0] + (left ? -1 : 1) * (28 + 16 * actorScale(`dog_${f.id}_stand`)), her[1]);  // bigger dogs stand further off, nose to nose
        face(v, ...friendSpot); pose(v, "listen", v.facing);
        v.notice = known ? `${f.name} is coming!` : "A friendly dog is coming!";
        dog = actor(a, { frames: [`dog_${f.id}_walk1`, `dog_${f.id}_walk2`], ms: 200, speed: .05, kind: "friend", path: routeFromEdge(v, left, friendSpot) });
        dog.x = dog.path[0][0]; dog.y = dog.path[0][1]; dog.path.shift(); dog.flip = !left ? true : false;
        if (!known) ask(a, now, ["Say hi"], (v, a) => { if (a.greeting) learn(v, a); });
      } },
      { run: (v, a, k, now, dt) => { face(v, dog.x, dog.y); }, done: () => !dog.path.length },
      { dur: 3000, enter: (v, a, now) => {
        a.greeting = true; dog.frames = null; dog.frame = `dog_${f.id}_stand`; dog.flip = !left; pose(v, "happy", left ? "SW" : "SE");
        if (a.choice === 0) learn(v, a); else v.notice = known ? `${f.name} says hello!` : "A friendly dog says hello.";
      }, run: (v, a, k, now) => { dog.y = friendSpot[1] + (Math.floor(now / 180) % 2 ? 0 : -1); } },
      { enter: (v, a) => {
        dog.frames = [`dog_${f.id}_walk1`, `dog_${f.id}_walk2`]; dog.y = friendSpot[1];
        dog.path = routeToEdge(v, [dog.x, dog.y], !left); dog.speed = .05; v.notice = `${known || a.learned ? f.name : "The dog"} trots on. Bye!`; pose(v, "happy", left ? "SW" : "SE");
      }, run: (v, a, k, now) => { if (now - a.t0 > 1400) pose(v, "sit", v.facing); }, done: () => !dog.path.length },
    ];
  } },

  // She sniffs the hydrant or a tree, circles, and leaves a pee-mail (no squat; an envelope floats up).
  { id: "peemail", eligible: v => placed(v, "hydrant").length + placed(v, "street_tree").length > 0, steps: (v) => {
    const p = pick(v, [...placed(v, "hydrant"), ...placed(v, "street_tree")]), name = p.object === "hydrant" ? "hydrant" : "tree";
    const spot = spotNear(v, p.x, p.y + 10);
    let ring;
    return [
      walkStep(spot, { notice: `Zucchini has found a very interesting ${name}.` }),
      { dur: 1800, enter: (v, a) => { face(v, p.x, p.y); pose(v, "sniff", v.facing); v.notice = `She reads the ${name} carefully.`; } },
      { dur: 2200, enter: (v, a) => { ring = [...v.pos]; pose(v, "walk"); v.notice = "She circles to find the perfect spot."; },
        run: (v, a, k) => {
          const th = k * Math.PI * 2, x = ring[0] + Math.sin(th) * 9, y = ring[1] + (1 - Math.cos(th)) * 3.5;
          if (v.grid.clear(x, y)) v.pos = [x, y]; face(v, ring[0] + Math.cos(th) * 20, ring[1] + Math.sin(th) * 10);
        } },
      { dur: 2000, enter: (v, a, now) => {
        v.pos = [...ring]; face(v, p.x, p.y); pose(v, "happy", v.facing); v.notice = "Zucchini leaves a pee-mail.";
        a.fx.push({ kind: "mail", x: p.x, y: p.y - 28 * p.scale, born: now, life: 1900 });
      } },
    ];
  } },

  // A stick wider than she is. Help her turn it lengthwise (or she works it out herself).
  { id: "stick", eligible: v => !!v.scene.actors, steps: (v) => [
    { dur: 1000, enter: (v, a) => { a.carry = "stick_side"; pose(v, "happy", "SE"); v.notice = "Zucchini found a stick! It is a little wide."; } },
    walkStep(v => freeSpot(v), { notice: "She trots off, very proud of it." }),
    { enter: (v, a, now) => { pose(v, "idle"); v.notice = "The stick is wider than she is. Hmm."; ask(a, now, ["Help her turn it"]); },
      done: (v, a) => answered(a) },
    { dur: 1100, enter: (v, a) => { a.carry = "stick_along"; pose(v, "happy"); v.notice = a.choice === 0 ? "You turn the stick lengthwise. Zucchini trots on!" : "Zucchini works it out herself."; } },
    walkStep(v => freeSpot(v), {}),
    { dur: 1200, enter: (v, a) => { pose(v, "happy"); } },
  ] },

  // Rain: a puddle appears and she splashes. Drawn splash particles.
  { id: "puddle", eligible: v => v.antics.env.weather === "rain" && !!v.scene.actors, steps: (v) => {
    let spot, pud;
    return [
      { dur: 700, enter: (v, a, now) => {
        spot = freeSpot(v, 50); pose(v, "listen"); v.notice = "Rain! A puddle on the sidewalk.";
        pud = actor(a, { frame: "puddle", x: spot[0], y: spot[1] + 1, z: spot[1] - 1, kind: "puddle", alpha: 0 });
      }, run: (v, a, k) => { pud.alpha = k; } },
      walkStep(() => [spot[0] - 36, spot[1] + 3], { fast: true }),
      { dur: 3300, enter: (v, a) => { v.path = []; v.notice = "Splish splash!"; a.last = 0; a.from = [...v.pos]; face(v, spot[0], spot[1]); },
        run: (v, a, k, now, dt) => {
          const t = now - a.t0, x = Math.min(1, t / 700), cyc = (t % 520) / 520;
          v.pos = [lerp(a.from[0], spot[0] - 12, ease(x)), lerp(a.from[1], spot[1] + 3, ease(x))];
          pose(v, "happy", "SE"); v.lift = 7 * Math.sin(cyc * Math.PI);
          const n = Math.floor(t / 520);
          if (t > 600 && n !== a.last) { a.last = n; splash(a, v.pos[0] + 8, v.pos[1] - 1, v.antics.rng, 9, ["#cfe6f0", "#8db7cc", "#f2fafc"]); }
        } },
      { dur: 800, enter: (v, a) => { pose(v, "happy"); v.notice = "Zucchini shakes off, delighted."; } },
      { dur: 600, run: (v, a, k) => { pud.alpha = 1 - k; } },
    ];
  } },

  // After rain (damp, not raining): she inspects a snail.
  { id: "snail", eligible: v => v.antics.env.weather !== "rain" && v.antics.env.damp && !!v.scene.actors, steps: (v) => {
    let spot, sn;
    return [
      { dur: 600, enter: (v, a) => {
        spot = freeSpot(v, 50); pose(v, "idle"); v.notice = "Something small is on the damp sidewalk.";
        sn = actor(a, { frame: "snail", x: spot[0] + 14, y: spot[1] + 2, kind: "snail" });
      } },
      walkStep(() => [spot[0] - 12, spot[1]], {}),
      { dur: 3200, enter: (v, a) => { face(v, sn.x, sn.y); pose(v, "sniff", "SE"); v.notice = "Zucchini inspects a snail. It is very slow."; }, run: (v, a, k, now, dt) => { sn.x += dt * .0025; } },
      { dur: 900, enter: (v, a) => { pose(v, "happy"); v.notice = "She lets it be."; } },
    ];
  } },

  // Autumn: a leaf pile. She crouches, leaps (the agility frames) and lands in it; leaves fly.
  { id: "leaves", eligible: v => v.antics.env.month >= 9 && v.antics.env.month <= 11 && !!v.scene.actors && !!leafSpot(v), steps: (v) => {
    const { pile, start } = leafSpot(v) ?? { pile: spotNear(v, 300, 230), start: spotNear(v, 262, 221) };
    let pl;
    return [
      { dur: 600, enter: (v, a) => { pose(v, "listen"); v.notice = "A big pile of leaves!"; pl = actor(a, { frame: "leaf_pile", x: pile[0], y: pile[1] + 4, z: pile[1] + 4, kind: "pile" }); } },
      walkStep(() => start, { fast: true }),
      { dur: 380, enter: (v, a) => { v.pos = [...start]; face(v, pile[0], pile[1]); v.facing = "SE"; pose(v, "couch_enter", "SE", { frame: 0 }); } },
      { dur: 800, enter: (v, a) => { v.notice = "Zucchini leaps!"; a.burst = false; },
        run: (v, a, k, now) => {
          const u = k, e = 1 - (1 - u) ** 2;
          v.pos = [lerp(start[0], pile[0], e), lerp(start[1], pile[1], e)]; v.lift = 22 * 4 * u * (1 - u);
          v.clip = u < .5 ? "couch_enter" : "couch_exit"; v.frame = u < .5 ? 1 : 0;
          if (u > .9 && !a.burst) { a.burst = true; leafBurst(a, pile, v.antics.rng, 16, now); }
        } },
      { dur: 2200, enter: (v, a, now) => { v.pos = [...pile]; v.lift = 0; pose(v, "happy", "SE"); v.notice = "Wheee! Leaves everywhere."; leafBurst(a, pile, v.antics.rng, 8, now); } },
      { dur: 600, enter: (v, a) => { pose(v, "idle"); } },
    ];
  } },

  // The mail carrier walks to the mailbox; she faces them and boofs.
  { id: "carrier", eligible: v => !v.antics.env.dark && placed(v, "mailbox").length > 0 && !!v.scene.actors, steps: (v) => {
    const mb = placed(v, "mailbox")[0], stop = spotNear(v, mb.x + 26, mb.y + 4);
    let cr, back;
    return [
      { enter: (v, a, now) => {
        pose(v, "listen"); v.notice = "Someone is coming up the sidewalk.";
        const path = routeFromEdge(v, true, stop); back = routeToEdge(v, stop, true);
        cr = actor(a, { frames: ["carrier_walk1", "carrier_walk2"], ms: 230, speed: .04, kind: "carrier", path });
        cr.x = path[0][0]; cr.y = path[0][1]; cr.path.shift();
      }, run: (v, a) => { face(v, cr.x, cr.y); }, done: () => !cr.path.length },
      { dur: 2600, enter: (v, a, now) => {
        cr.frames = null; cr.frame = "carrier_walk1"; pose(v, "boof", v.facing); v.notice = "Boof! It is the mail carrier."; a.boofs = 0;
      }, run: (v, a, k, now) => {
        const t = now - a.t0;
        for (const at of [300, 1500]) if (t >= at && a.boofs === (at === 300 ? 0 : 1)) { a.boofs++; bubble(v, a, now, "Boof!", 800); a.hopAt = now; }
        v.lift = a.hopAt && now - a.hopAt < 260 ? hop(now - a.hopAt, 260) : 0;
      } },
      { enter: (v, a) => { pose(v, "listen", v.facing); cr.frames = ["carrier_walk1", "carrier_walk2"]; cr.path = back; v.notice = "The mail carrier waves and walks on."; }, done: () => !cr.path.length },
      { dur: 700, enter: (v, a) => { pose(v, "sit", "SE"); } },
    ];
  } },

  // Night: she sits by the lamp looking up while moths flutter around the lamp head.
  { id: "moths", eligible: v => v.antics.env.dark && placed(v, "lamp").length > 0, steps: (v) => {
    const lamp = placed(v, "lamp")[0], spot = spotNear(v, lamp.x - 22, lamp.y - 4);
    return [
      walkStep(spot, { notice: "The lamp is glowing. Something is fluttering around it." }),
      { dur: 6500, enter: (v, a, now) => {
        face(v, lamp.x, lamp.y - 40); v.facing = "SE"; pose(v, "sit", "SE"); v.notice = "Zucchini sits by the lamp and watches the moths.";
        a.moths = { x: lamp.x, y: lamp.y - 50 * lamp.scale / .88, n: 6, born: now };
      } },
      { dur: 600, enter: (v, a) => { pose(v, "idle"); a.moths = null; } },
    ];
  } },
];

// Curb stops and leaf-pile spots: places a scene can use, computed from the live floor and grid.
function curbSpots(v) {
  const out = [];
  for (let x = 300; x <= 460; x += 4) {  // where the road shows well, clear of the lamp, hydrant, mailbox and trees
    const y = curbY(v, x), slope = (curbY(v, x + 20) - curbY(v, x - 20)) / 40, len = Math.hypot(1, slope);
    const stage = spotNear(v, x + slope / len * 34, y - 34 / len);
    if (v.placements.some(p => !p.mountedOn && (Math.abs(p.x - x) < 26 && Math.abs(p.y - y) < 30 || dist([p.x, p.y], stage) < 30))) continue;
    out.push({ x, y });
  }
  return out;
}
function leafSpot(v) {
  for (let i = 0; i < 12; i++) {
    const pile = spotNear(v, rnd(v, 150, 400), rnd(v, 170, 270)), start = [pile[0] - 36, pile[1] - 9];
    if (v.grid.clear(start[0], start[1]) && v.grid.clear(pile[0], pile[1])) return { pile, start };
  }
  return null;
}
function splash(a, x, y, rng, n, colors) {
  for (let i = 0; i < n; i++) a.fx.push({ kind: "drop", x, y, vx: (rng() - .5) * 80, vy: -(60 + rng() * 70), life: 520, born: 0, color: colors[i % colors.length], age: 0 });
}
function leafBurst(a, at, rng, n, now) {
  const leaf = ["#d8793a", "#c24f3d", "#e9b64d", "#a8602f", "#d9a03f"];
  for (let i = 0; i < n; i++) a.fx.push({ kind: "leaf", x: at[0] + (rng() - .5) * 16, y: at[1] - 4, vx: (rng() - .5) * 90, vy: -(70 + rng() * 80), life: 1400 + rng() * 500, color: leaf[i % 5], age: 0 });
}

// ---------------------------------------------------------------- director and runner

const eligibleIds = v => ANTICS.filter(d => d.id !== v.antics.last && d.eligible(v)).map(d => d.id);
export const anticIds = () => ANTICS.map(d => d.id);
export function eligibleAntics(v) { return eligibleIds(v); }

export function startAntic(v, id, now) {
  const def = ANTICS.find(d => d.id === id);
  if (!def || !v.antics) return false;
  const a = { id, def, steps: [], i: -1, t0: now, actors: [], fx: [], bubbles: [], prompt: null, choice: null, started: now, taut: 0 };
  v.antic = a; v.antics.last = id; v.antics.clock = now;
  v.path = []; v.action = null; v.wanderAt = Infinity; v.restUntil = 0; v.ball = null; v.hideDog = false;
  a.steps = def.steps(v);
  advance(v, a, now);
  return true;
}
function advance(v, a, now) {
  a.i++;
  if (a.i >= a.steps.length) { endAntic(v, now); return; }
  a.t0 = now;
  a.steps[a.i].enter?.(v, a, now);
}
// Ends the antic. A handoff walks her on with the normal outing machinery (a path and an action such as the find-roll sniff).
export function endAntic(v, now, handoff = null) {
  const a = v.antic, s = v.antics;
  if (!a) return;
  v.antic = null; a.prompt = null;
  s.history.push({ id: a.id, start: a.started, end: now, finished: a.i >= a.steps.length - 1 || !!handoff });
  s.leash.target = 0; s.nextAt = now + GAP_MIN + s.rng() * GAP_SPAN;
  v.clip = "idle"; v.frame = null; v.lift = 0; v.fast = false; v.hideDog = false; v.restUntil = now + 1200; v.wanderAt = now + 3500;
  if (handoff) {
    startWalk(v, handoff.target, false);
    v.action = handoff.action; v.restUntil = 0; v.wanderAt = Infinity; if (handoff.notice) v.notice = handoff.notice;
    if (!v.path.length && v.action) { /* already there: the normal pose runs on the next step */ }
  }
}
export function stepAntic(v, dt, now) {
  const a = v.antic, s = v.antics;
  s.clock = now;
  if (a.prompt && now >= a.prompt.until) a.prompt = null;
  const step = a.steps[a.i], k = step.dur ? Math.min(1, (now - a.t0) / step.dur) : 0;
  step.run?.(v, a, k, now, dt);
  for (const ac of a.actors) { moveActor(ac, dt); ac.update?.(ac, dt); }
  for (const f of a.fx) { f.age = (f.age ?? 0) + dt; if (f.kind !== "mail") { f.x += f.vx * dt / 1000; f.y += f.vy * dt / 1000; f.vy += 260 * dt / 1000; if (f.kind === "leaf") f.vx *= .99; } }
  a.fx = a.fx.filter(f => f.kind === "mail" ? now - f.born < f.life : f.age < f.life);
  a.bubbles = a.bubbles.filter(b => now < b.until);
  updateLeash(v, a.taut, dt);
  if (v.antic !== a) return;
  if (step.done ? step.done(v, a, now, k) : k >= 1) advance(v, a, now);
}
// Called at the end of a normal stepOuting: the leash follows her, and the director may start something.
export function directAntics(v, dt, now) {
  const s = v.antics;
  s.clock = now;
  updateLeash(v, 0, dt);
  if (v.antic || v.action || v.path.length || now < v.restUntil || now < s.nextAt) return;
  const ids = eligibleIds(v);
  if (!ids.length) { s.nextAt = now + 5000; return; }
  startAntic(v, pick(v, ids), now);
}
// A tap on the scene or the main button during an antic ends it cleanly; the tap then does its usual thing.
export function interruptAntic(v) { if (v.antic) endAntic(v, v.antics.clock); }
export function anticPrompt(v) { const p = v.antic?.prompt; return p ? { labels: p.labels, until: p.until } : null; }
export function anticChoose(v, i) {
  const a = v.antic, p = a?.prompt;
  if (!p || !(i >= 0 && i < p.labels.length)) return false;
  a.choice = i; a.prompt = null; p.onChoose?.(v, a, i);
  return true;
}
export function anticState(v) {
  const a = v.antic;
  return a ? { id: a.id, step: a.i, prompt: a.prompt ? [...a.prompt.labels] : null, actors: a.actors.map(x => x.kind) } : null;
}

// ---------------------------------------------------------------- leash

const COLLAR = { default: [43, 40], sploot: [42, 57], sploot_enter: [42, 50], sploot_exit: [42, 50], sniff: [46, 47], sniff_plant: [46, 48], sit: [44, 38], boof: [44, 38] };
function updateLeash(v, taut, dt) {
  const L = v.antics.leash;
  L.target = taut;
  L.taut += (L.target - L.taut) * Math.min(1, dt * .012);
  if (Math.abs(L.taut - L.target) < .01) L.taut = L.target;
  const want = Math.max(10, Math.min(470, v.pos[0] - 28));
  L.ax = L.ax === null ? want : L.ax + (want - L.ax) * Math.min(1, dt * .004);
}
function collarPoint(v) {
  const sc = v.scene.dog[2] * .8, back = v.facing === "NE" || v.facing === "NW", left = v.facing === "SW" || v.facing === "NW";
  const c = COLLAR[v.clip] ?? COLLAR.default, cell = [back ? 36 : c[0], c[1]];
  return [v.pos[0] + (cell[0] - 36) * sc * (left ? -1 : 1), v.pos[1] - v.lift + (cell[1] - 71) * sc];
}
export function drawLeash(ctx, v, now) {
  const L = v.antics.leash, [cx, cy] = collarPoint(v), ax = L.ax ?? cx, ay = 322;
  const d = Math.hypot(ax - cx, ay - cy), slack = 1 - L.taut;
  const sag = Math.min(34, 5 + d * .22) * slack, shake = L.taut > .9 ? Math.sin(now / 45) * .6 : 0;
  const mx = (cx + ax) / 2 + shake, my = (cy + ay) / 2 + sag;
  const n = Math.max(8, Math.ceil(d * 1.2)), pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([u * u * cx + 2 * u * t * mx + t * t * ax, u * u * cy + 2 * u * t * my + t * t * ay]);
  }
  ctx.fillStyle = "#3e2818";
  for (const [x, y] of pts) ctx.fillRect(Math.round(x), Math.round(y) + 1, 1, 1);
  ctx.fillStyle = "#c95a4b";
  for (const [x, y] of pts) ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
  // collar: a short band with a tag
  ctx.fillStyle = "#3e2818"; ctx.fillRect(Math.round(cx) - 3, Math.round(cy) - 1, 6, 3);
  ctx.fillStyle = "#c95a4b"; ctx.fillRect(Math.round(cx) - 2, Math.round(cy), 4, 1);
  ctx.fillStyle = "#e7bb62"; ctx.fillRect(Math.round(cx), Math.round(cy) + 1, 1, 1);
}

// ---------------------------------------------------------------- drawing

// Sprites are drawn small on the sheet; cars, people and bigger dogs are scaled up to sit right next to her.
const SIZE = [["car_", 2], ["carrier", 2.2], ["dog_juno", 1.7], ["dog_biscuit", 1.4], ["dog_mochi", 1.3]];
export const actorScale = (name) => SIZE.find(([prefix]) => name.startsWith(prefix))?.[1] ?? 1;
function drawFrame(ctx, art, scene, name, x, y, flip = false, alpha = 1, center = false) {
  const f = scene.actors?.frames?.[name];
  if (!f) return;
  const k = actorScale(name), [rx, ry, w, h] = f.rect, ax = (center ? w / 2 : f.anchor[0]) * k, ay = (center ? h / 2 : f.anchor[1]) * k;
  if (alpha < 1) ctx.globalAlpha = Math.max(0, alpha);
  ctx.drawImage(art, rx, ry, w, h, Math.round(x - (flip ? (w - 1) * k - ax : ax)), Math.round(y - ay), Math.round(w * k), Math.round(h * k));
  ctx.globalAlpha = 1;
  return f;
}
const flipped = v => v.facing === "SW" || v.facing === "NW";
// Extra depth-sorted layers: each antic actor, and the stick she carries (drawn right after her).
export function anticLayers(v, art, now) {
  const a = v.antic, out = [];
  if (!a) return out;
  for (const ac of a.actors) {
    if (ac.alpha <= 0) continue;
    const name = ac.frames ? ac.frames[Math.floor(now / ac.ms) % ac.frames.length] : ac.frame;
    if (name.startsWith("dog_") || name.startsWith("squirrel_run") || name.startsWith("carrier")) {
      out.push({ z: ac.z ?? ac.y, draw: ctx => { ctx.fillStyle = `rgba(58,36,26,${.22 * ac.alpha})`; ctx.beginPath(); ctx.ellipse(ac.x, ac.y, 12 * actorScale(name), 3.6 * actorScale(name), 0, 0, Math.PI * 2); ctx.fill(); drawFrame(ctx, art, v.scene, name, ac.x, ac.y, ac.flip, ac.alpha); } });
    } else if (name === "puddle") out.push({ z: ac.z ?? ac.y, draw: ctx => drawFrame(ctx, art, v.scene, name, ac.x, ac.y, false, ac.alpha, true) });
    else out.push({ z: ac.z ?? ac.y, draw: ctx => drawFrame(ctx, art, v.scene, name, ac.x, ac.y, ac.flip, ac.alpha) });
  }
  if (a.carry) {
    const dx = flipped(v) ? -1 : 1, along = a.carry === "stick_along";
    out.push({ z: v.pos[1] + .01, draw: ctx => drawFrame(ctx, art, v.scene, a.carry, v.pos[0] + dx * (along ? 20 : 15), v.pos[1] - v.lift - (along ? 12 : 15), flipped(v), 1, true) });
  }
  return out;
}
const BUBBLE_FONT = "bold 9px system-ui, sans-serif";
function speech(ctx, x, y, text) {
  ctx.font = BUBBLE_FONT; ctx.textAlign = "center";
  const w = text.length * 5 + 9, h = 13, l = Math.round(x - w / 2), t = Math.round(y - h);
  ctx.fillStyle = "#3e2818"; ctx.fillRect(l - 1, t, w + 2, h); ctx.fillRect(l, t - 1, w, h + 2);
  ctx.fillStyle = "#fffaf0"; ctx.fillRect(l, t, w, h);
  ctx.fillStyle = "#3e2818"; ctx.fillRect(Math.round(x) - 2, t + h + 1, 4, 1); ctx.fillRect(Math.round(x) - 1, t + h + 2, 2, 1);
  ctx.fillStyle = "#fffaf0"; ctx.fillRect(Math.round(x) - 2, t + h, 4, 1); ctx.fillRect(Math.round(x) - 1, t + h + 1, 2, 1);
  ctx.fillStyle = "#3e2818"; ctx.fillText(text, Math.round(x), t + 10);
}
// Drawn after the night tint: bubbles, splashes, leaves, the pee-mail envelope, moths and the lamp's glow.
export function drawAnticsTop(ctx, v, now) {
  const a = v.antic;
  if (!a) return;
  for (const f of a.fx) {
    if (f.kind === "mail") {
      const k = (now - f.born) / f.life, x = Math.round(f.x), y = Math.round(f.y - k * 16);
      ctx.globalAlpha = Math.max(0, Math.min(1, 2.2 - k * 2));
      ctx.fillStyle = "#3e2818"; ctx.fillRect(x - 5, y - 4, 10, 8);
      ctx.fillStyle = "#fffaf0"; ctx.fillRect(x - 4, y - 3, 8, 6);
      ctx.fillStyle = "#c95a4b"; ctx.fillRect(x - 3, y - 2, 1, 1); ctx.fillRect(x - 2, y - 1, 1, 1); ctx.fillRect(x - 1, y, 2, 1); ctx.fillRect(x + 1, y - 1, 1, 1); ctx.fillRect(x + 2, y - 2, 1, 1);
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = Math.max(0, Math.min(1, (f.life - f.age) / 300));
      ctx.fillStyle = f.color; ctx.fillRect(Math.round(f.x), Math.round(f.y), f.kind === "leaf" ? 2 : 1, f.kind === "leaf" ? 2 : 1);
      ctx.globalAlpha = 1;
    }
  }
  if (a.moths) {
    const m = a.moths, t = (now - m.born) / 1000;
    for (const [r, alpha] of [[30, .06], [20, .08], [11, .12]]) {  // a soft glow in steps
      ctx.fillStyle = `rgba(255,226,150,${alpha})`; ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = 0; i < m.n; i++) {
      const ph = i * 1.9, r = 9 + (i % 3) * 5, x = m.x + Math.cos(t * (1.3 + i * .21) + ph) * r, y = m.y + Math.sin(t * (1.9 + i * .17) + ph * 1.3) * (r * .7) - 2;
      const bright = Math.floor(now / (70 + i * 13)) % 3;
      ctx.fillStyle = bright === 0 ? "#fffbe8" : bright === 1 ? "#f2e2a8" : "#d6c68a";
      ctx.fillRect(Math.round(x) - 1, Math.round(y), bright === 2 ? 2 : 3, 1);
      if (bright !== 2) { ctx.fillRect(Math.round(x) - 2, Math.round(y) - 1, 2, 1); ctx.fillRect(Math.round(x) + 1, Math.round(y) - 1, 2, 1); }
    }
  }
  for (const b of a.bubbles) speech(ctx, b.x, b.y, b.text);
}
