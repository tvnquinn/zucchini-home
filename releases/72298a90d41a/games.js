// The games shelf and runner. Each game is a small module (game_<id>.js, see docs/GAMES_PLAN.md); this file gives
// it an env (scene art, placed objects, small actors, Zucchini), a shelf, a canvas view with a card and a countdown,
// and keeps best scores on this device. Games never touch coins or the core save.
import { squirrelPatrol } from "./game_squirrel.js";
import { agilityRun } from "./game_agility.js";
import { fetchDistance } from "./game_fetch.js";
import { zoomiesDash } from "./game_zoomies.js";
import { bathScrub } from "./game_bath.js";
import { placeBox, resolvePlaceLayout } from "./places_layout.js";
import { actorScale } from "./antics.js";
export const GAMES = [squirrelPatrol, agilityRun, fetchDistance, zoomiesDash, bathScrub];

const W = 480, H = 320, COUNTDOWN_MS = 2400, STEP_MS = 600, BAR = 52;
export const GAMES_KEY = "zucchini-games";

// ---------------------------------------------------------------- best scores

export function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));  // the Thursday of this week decides the year
  const year = d.getUTCFullYear(), week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 864e5 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
const record = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
const scores = (v) => Object.fromEntries(Object.entries(record(v)).filter(([, n]) => Number.isFinite(n) && n >= 0).map(([k, n]) => [k, Math.round(n)]));
export function readGames(storage, now = new Date()) {
  let raw = {};
  try { raw = record(JSON.parse(storage.getItem(GAMES_KEY) ?? "{}")); } catch {}
  const key = isoWeek(now), week = record(raw.week);
  return { v: 1, best: scores(raw.best), week: { key, best: week.key === key ? scores(week.best) : {} }, plays: scores(raw.plays) };
}
// Records a finished round. Returns whether it is a new best (a first play counts unless it scored nothing).
export function saveScore(storage, game, score, now = new Date()) {
  const data = readGames(storage, now), s = Math.max(0, Math.min(game.maxScore, Math.round(score)));
  const better = (old) => old === undefined || (game.lower ? s < old : s > old);
  const isNew = better(data.best[game.id]) && (data.best[game.id] !== undefined || game.lower || s > 0);
  if (better(data.best[game.id])) data.best[game.id] = s;
  if (better(data.week.best[game.id])) data.week.best[game.id] = s;
  data.plays[game.id] = (data.plays[game.id] ?? 0) + 1;
  try { storage.setItem(GAMES_KEY, JSON.stringify(data)); } catch {}
  return { score: s, isNew };
}
export const showScore = (game, score) => game.format ? game.format(score) : game.unit ? `${score} ${game.unit}` : String(score);

// ---------------------------------------------------------------- env

function createEnv(host, images, rng) {
  const manifest = host.destinationArt.manifest, actors = manifest.scenes.neighborhood?.actors?.frames ?? {};
  const scene = (id) => manifest.scenes[id];
  const image = (id) => images.get(id);
  const frameOf = (id, p) => scene(id)?.objects[p.object]?.frames[p.facing];
  const clip = (name) => host.atlas.clips.find((c) => c.name === name) ?? host.atlas.clips[0];
  // A clip may hold its own slot for a facing (bath_time has all four); otherwise SW/NW mirror SE/NE.
  const slotOf = (name, facing) => {
    const c = clip(name), exact = c.slots.find((s) => s.facing === facing);
    if (exact) return { slot: exact, mirror: false };
    const back = facing === "NE" || facing === "NW";
    return { slot: c.slots.find((s) => s.facing === (back ? "NE" : "SE")) ?? c.slots[0], mirror: facing === "SW" || facing === "NW" };
  };
  return {
    W, H, now: performance.now(), rng,
    scene,
    placements: (id) => resolvePlaceLayout(scene(id), host.placeLayouts()[id]),
    drawBackground(ctx, id) {
      if (image(id)) ctx.drawImage(image(id), ...scene(id).background, 0, 0, W, H);
    },
    drawObject(ctx, id, p) {
      const f = frameOf(id, p);
      if (f && image(id)) ctx.drawImage(image(id), ...f.rect, ...placeBox(scene(id), p));
    },
    objectBox: (id, p) => frameOf(id, p) ? placeBox(scene(id), p) : [p.x, p.y, 0, 0],
    drawActor(ctx, name, x, y, { flip = false, alpha = 1, scale = 1 } = {}) {
      const f = actors[name], art = image("neighborhood");
      if (!f || !art) return;
      const k = actorScale(name) * scale, [rx, ry, w, h] = f.rect, ax = f.anchor[0] * k, ay = f.anchor[1] * k;
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.drawImage(art, rx, ry, w, h, Math.round(x - (flip ? (w - 1) * k - ax : ax)), Math.round(y - ay), Math.round(w * k), Math.round(h * k));
      ctx.globalAlpha = 1;
    },
    actorSize: (name) => actors[name] ? [actors[name].rect[2], actors[name].rect[3]] : [0, 0],
    drawDog(ctx, { x, y, clip: name = "idle", facing = "SE", frame = null, lift = 0, scale = 0.7, fast = false, now = 0, shadow = true, alpha = 1 }) {
      const { slot, mirror } = slotOf(name, facing), n = slot.frames.length;
      const rect = slot.frames[frame == null ? Math.floor(now / (fast ? 115 : 180)) % n : Math.max(0, Math.min(n - 1, frame))];
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      if (shadow) {  // on the ground, not lifted: it shrinks and fades as she rises
        const air = Math.min(1, lift / 60);
        ctx.fillStyle = `rgba(58,36,26,${0.24 * (1 - air * 0.6)})`;
        ctx.beginPath(); ctx.ellipse(x, y, 13 * scale * (1 - air * 0.35), 5 * scale * (1 - air * 0.35), 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.save(); ctx.translate(x, y - lift);
      if (mirror) ctx.scale(-1, 1);
      ctx.drawImage(host.image, ...rect, -36 * scale, -71 * scale, rect[2] * scale, rect[3] * scale);
      ctx.restore(); ctx.globalAlpha = 1;
    },
    clipFrames: (name, facing = "SE") => slotOf(name, facing).slot.frames.length,
  };
}

// ---------------------------------------------------------------- shell

export function createGames(host) {
  const $ = (id) => document.getElementById(id);
  const canvas = $("game-canvas"), ctx = canvas.getContext("2d"), card = $("game-card");
  const images = new Map(), byId = new Map(GAMES.map((g) => [g.id, g]));
  let shelfOpen = false, view = null, opener = null, raf = 0, last = 0, hudText = "";
  // view: { game, env, state, phase: "intro" | "countdown" | "play" | "results", clock, elapsed, pointer }

  const lockScroll = () => document.body.classList.toggle("games-open", shelfOpen || !!view);
  const needsArt = (game) => game.scenes?.length > 0;
  const bestText = (game) => {
    const best = readGames(host.storage).best[game.id];
    return best === undefined ? "Not played yet" : `Best: ${showScore(game, best)}`;
  };
  const el = (tag, className, text) => { const e = document.createElement(tag); e.className = className; if (text !== undefined) e.textContent = text; return e; };

  // -------- shelf
  function renderShelf() {
    const reason = host.blocked();
    $("games-note").textContent = reason ?? ""; $("games-note").hidden = !reason;
    $("games-list").replaceChildren(...GAMES.map((game) => {
      const row = el("div", "game-row"), text = el("div", "game-text"), play = el("button", "game-play", "Play");
      const unavailable = reason ?? (needsArt(game) && !host.destinationArt ? "Art is still loading." : null);
      play.dataset.game = game.id; play.disabled = !!unavailable;
      play.setAttribute("aria-label", `Play ${game.title}`);
      text.append(el("h3", "", game.title), el("p", "game-how", game.how), el("p", "game-best", bestText(game)));
      if (unavailable && !reason) text.append(el("p", "game-best muted", unavailable));
      play.addEventListener("click", () => openGame(game.id));
      row.append(text, play);
      return row;
    }));
  }
  function openShelf(from = null) {
    if (view) return;
    opener = from ?? opener;
    renderShelf();
    shelfOpen = true; $("games-panel").hidden = false; $("games-backdrop").hidden = false; lockScroll();
    $("close-games").focus();
  }
  function closeShelf(focus = true) {
    if (!shelfOpen) return;
    shelfOpen = false; $("games-panel").hidden = true; $("games-backdrop").hidden = true; lockScroll();
    if (focus) opener?.focus?.();
  }

  // -------- card
  const cardIds = ["game-card-title", "game-card-flag", "game-card-score", "game-card-how", "game-card-summary", "game-card-best", "game-card-note"];
  function showCard(parts, startLabel) {
    for (const id of cardIds) { $(id).textContent = parts[id] ?? ""; $(id).hidden = !parts[id]; }
    $("game-start").textContent = startLabel; $("game-back").textContent = "Other games";
    card.hidden = false; $("game-start").focus();
  }
  const cardText = () => card.hidden ? "" : [...cardIds.map((id) => $(id).textContent), $("game-start").textContent, $("game-back").textContent].filter(Boolean).join("\n");

  // -------- game view
  function fit() {
    const dpr = globalThis.devicePixelRatio || 1, vw = innerWidth, vh = innerHeight - BAR;
    const w = Math.max(120, Math.floor(Math.min(vw, vh * 1.5))), h = Math.round(w * 2 / 3);
    canvas.style.width = w + "px"; canvas.style.height = h + "px";
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  async function openGame(id) {
    const game = byId.get(id);
    if (!game || view || host.blocked() || (needsArt(game) && !host.destinationArt)) return;
    try {
      await Promise.all(game.scenes.map(async (s) => { if (!images.has(s)) images.set(s, await host.destinationArt.getScene(s)); }));
    } catch { $("games-note").textContent = "The art could not load. Try again in a moment."; $("games-note").hidden = false; return; }
    if (view || host.blocked()) return;
    view = { game, env: createEnv(host, images, host.rng ?? Math.random), state: null, phase: "intro", clock: 0, elapsed: 0, pointer: null };
    $("game-title").textContent = game.title; $("game-hud").textContent = hudText = "";
    $("game-view").hidden = false; $("games-panel").hidden = true; $("games-backdrop").hidden = true; shelfOpen = false;
    lockScroll(); fit();
    showCard({ "game-card-title": game.title, "game-card-how": game.how, "game-card-best": bestText(game) }, "Start");
    last = 0; if (!raf) raf = requestAnimationFrame(loop);
  }
  function start() {
    if (!view || view.phase === "countdown" || view.phase === "play") return;
    view.env.now = view.clock = performance.now();
    view.state = view.game.create(view.env);
    view.phase = "countdown"; view.elapsed = 0; view.pointer = null;
    card.hidden = true; $("game-close").focus();
  }
  function finish() {
    const { game, state } = view, saved = saveScore(host.storage, game, game.score(state));
    view.phase = "results";
    showCard({
      "game-card-title": game.title, "game-card-flag": saved.isNew ? "New best!" : "",
      "game-card-score": showScore(game, saved.score), "game-card-summary": game.summary?.(state) ?? "", "game-card-best": bestText(game),
      "game-card-note": "Just for fun: games never pay coins.",
    }, "Play again");
  }
  function closeAll(focus = true) {
    if (!view) { closeShelf(focus); return; }
    view = null; $("game-view").hidden = true; card.hidden = true; lockScroll();
    if (focus) opener?.focus?.();
  }
  function backToShelf() {
    if (!view) return;
    view = null; $("game-view").hidden = true; card.hidden = true;
    openShelf();
  }

  function frame(t) {
    const dt = last ? Math.max(0, Math.min(100, t - last)) : 0;
    last = t;
    if (document.hidden) return;
    const v = view, { game, state } = v;
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    ctx.imageSmoothingEnabled = false;
    if (v.phase === "intro") {  // a quiet backdrop behind the card: her scene and Zucchini
      v.env.drawBackground(ctx, game.scenes?.[0]);
      v.env.drawDog(ctx, { x: W / 2, y: H * 0.72, clip: "idle", now: t, scale: 0.9 });
      return;
    }
    // The game's clock only moves while it steps, so a hidden tab or the countdown never skips its timers.
    if (v.phase === "countdown") {
      v.elapsed += dt;
      game.draw(ctx, state, v.clock);
      const n = Math.min(3, Math.floor(v.elapsed / STEP_MS)), label = ["3", "2", "1", "Go!"][n];
      ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
      ctx.font = `bold ${n === 3 ? 64 : 80}px system-ui, sans-serif`; ctx.lineWidth = 8;
      ctx.strokeStyle = "rgba(60,48,51,.85)"; ctx.fillStyle = "#fffaf3";
      ctx.strokeText(label, W / 2, H / 2); ctx.fillText(label, W / 2, H / 2); ctx.restore();
      if (v.elapsed >= COUNTDOWN_MS) v.phase = "play";
    } else if (v.phase === "play") {
      v.clock += dt;
      game.step(state, dt, v.clock);
      game.draw(ctx, state, v.clock);
      const text = game.hud(state);
      if (text !== hudText) $("game-hud").textContent = hudText = text;
      if (game.done(state)) finish();
    } else game.draw(ctx, state, v.clock);
  }
  function loop(t) {
    raf = 0;
    if (!view) return;
    frame(t);
    if (view) raf = requestAnimationFrame(loop);
  }

  // -------- input: one finger at a time, only while a round is running
  function send(kind, e) {
    e.preventDefault?.();
    if (!view || view.phase !== "play") return;
    const id = e.pointerId ?? 0;
    if (kind === "down") { if (view.pointer != null) return; view.pointer = id; canvas.setPointerCapture?.(e.pointerId); }
    else if (view.pointer !== id) return;
    const r = canvas.getBoundingClientRect();
    view.game.pointer(view.state, kind, (e.clientX - r.left) * W / (r.width || W), (e.clientY - r.top) * H / (r.height || H), view.clock);
    if (kind === "up") view.pointer = null;
  }
  canvas.addEventListener("pointerdown", (e) => send("down", e));
  canvas.addEventListener("pointermove", (e) => send("move", e));
  canvas.addEventListener("pointerup", (e) => send("up", e));
  canvas.addEventListener("pointercancel", (e) => send("up", e));
  canvas.addEventListener("contextmenu", (e) => e.preventDefault?.());

  $("close-games").addEventListener("click", () => closeShelf());
  $("games-backdrop").addEventListener("click", () => closeShelf());
  $("game-close").addEventListener("click", () => closeAll());
  $("game-start").addEventListener("click", start);
  $("game-back").addEventListener("click", backToShelf);
  addEventListener("keydown", (e) => { if (e.key === "Escape") { if (view) closeAll(); else closeShelf(); } });
  addEventListener("resize", () => { if (view) fit(); });
  for (const id of ["game-view", "games-panel", "games-backdrop"]) $(id).hidden = true;

  globalThis.zucchiniGames = {
    open: (id) => openGame(id), start, close: () => closeAll(), card: cardText,
    state: () => view?.state ?? null, game: () => view?.game ?? null, phase: () => view?.phase ?? null,
  };
  return { openShelf, close: () => closeAll(false), isOpen: () => shelfOpen || !!view };
}
