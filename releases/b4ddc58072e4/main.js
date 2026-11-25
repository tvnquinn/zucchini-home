// Browser host for the Zucchini core: clocks, Canvas drawing and dev input.
// The simulation itself lives in WASM (core/); this file never decides behaviour.
import createModule from "./zucchini.mjs";
import { openStorage, readStorage, commitStorage, readPreviousStorage } from "./storage.js";
import { createAudio } from "./audio.js";
import { PLACE_FACINGS, placeLayoutKey, readPlaceLayouts, resolvePlaceLayout } from "./places_layout.js";

const buildRelease = globalThis.zucchiniRelease;
const GEN = buildRelease?.generatedBase ?? "../../assets/generated/";
const DESTINATIONS = buildRelease?.destinationsBase ?? "../../assets/destinations/";

// New destination art is optional: an interrupted image download cannot prevent
// the existing game or its save from loading. The indexed art remains the fallback.
async function loadDestinationArt() {
  try {
    if (typeof Image !== "function") return null;
    const response = await fetch(DESTINATIONS + "destinations.json");
    if (!response.ok) return null;
    const manifest = await response.json();
    if (manifest.schema !== 1) return null;
    const loadImage = async (name) => {
      const result = await fetch(DESTINATIONS + name);
      if (!result.ok) throw new Error("Artwork unavailable");
      const url = URL.createObjectURL(new Blob([await result.arrayBuffer()], { type: "image/png" }));
      try {
        const image = new Image();
        await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
        return image;
      } finally { URL.revokeObjectURL(url); }
    };
    const [park, treat] = await Promise.all([loadImage(manifest.scenes.park.image), loadImage(manifest.treat.image)]);
    return { manifest, park, treat: { ...manifest.treat.frames.SE, image: treat, id: "treat_jar", render_scale: 1 } };
  } catch { return null; }
}


// The hosted atlas is losslessly run-length encoded in small, cacheable parts.
// Standalone and source builds keep the original binary format.
async function loadAtlas() {
  if (!buildRelease?.atlasParts) {
    const response = await fetch(GEN + "atlas.bin");
    if (!response.ok) fail("Could not load the artwork. Reload to try again.");
    return new Uint8Array(await response.arrayBuffer());
  }
  const parts = await Promise.all(Array.from({ length: buildRelease.atlasParts }, async (_, i) => {
    const response = await fetch(GEN + `atlas-${i}.rle`);
    if (!response.ok) fail("Could not load the artwork. Reload to try again.");
    return new Uint8Array(await response.arrayBuffer());
  }));
  const indices = new Uint8Array(buildRelease.atlasLength);
  let offset = 0;
  for (const part of parts) {
    if (part.length % 2) fail("The artwork download was incomplete. Reload to try again.");
    for (let i = 0; i < part.length; i += 2) {
      const count = part[i];
      if (!count || offset + count > indices.length) fail("The artwork download was incomplete. Reload to try again.");
      indices.fill(part[i + 1], offset, offset + count);
      offset += count;
    }
  }
  if (offset !== indices.length) fail("The artwork download was incomplete. Reload to try again.");
  return indices;
}
const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d");
const hud = document.getElementById("hud");
const errorBox = document.getElementById("error");
const params = new URLSearchParams(location.search);
let debug = params.has("debug");
// Read-only art review never commits or interrupts another tab’s focus session.
const artPreview = params.get("preview") === "art";

const KIND = { room: 0, fixture: 1, item: 2, shadow: 3, dog: 4, foreground: 5, parkGround: 6, parkProp: 7 };
const CAMERA_MS = 700;
let renderScale = 1;  // the canvas is the design viewport times this; every camera already includes it
const phone = matchMedia("(max-width: 520px)");
const forcedHour = params.get("hour") && Number.isFinite(Number(params.get("hour"))) ? Number(params.get("hour")) : null;

// Day and night follow the local clock (tables.daynight). Phases cross-fade over blend_minutes centred on each boundary.
function dayLook(dn, palette, homeBg, hour) {
  const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const colour = (index) => rgbOf(index == null ? homeBg : palette[index]);
  const starts = dn.phases.map((p) => { const [h, m] = p.start.split(":"); return h * 60 + Number(m); });
  const n = starts.length, now = ((hour * 60) % 1440 + 1440) % 1440, half = dn.blend_minutes / 2;
  const i = starts.reduce((best, s, k) => (s <= now ? k : best), n - 1);
  const since = (now - starts[i] + 1440) % 1440, until = (starts[(i + 1) % n] - now + 1440) % 1440;
  let a = i, b = i, t = 0;
  if (since < half) { a = (i + n - 1) % n; t = 0.5 + since / dn.blend_minutes; }
  else if (until < half) { b = (i + 1) % n; t = 0.5 - until / dn.blend_minutes; }
  const [A, B] = [dn.phases[a], dn.phases[b]];
  const mixed = (x, y) => x + (y - x) * t;
  const mixedColour = (x, y) => colour(x).map((v, k) => Math.round(mixed(v, colour(y)[k])));
  const overlay = (key) => {
    const alpha = mixed(A[key].alpha, B[key].alpha);
    return alpha < 0.004 ? null : `rgba(${mixedColour(A[key].colour, B[key].colour)},${+alpha.toFixed(3)})`;
  };
  const [r, g, bl] = mixedColour(A.outside, B.outside);
  return {
    dark: 0.3 * r + 0.59 * g + 0.11 * bl < 120,
    from: A.id, to: B.id, t, phase: (t < 0.5 ? A : B).id,
    windows: A.window === B.window || t === 0 ? [[A.window, 1]] : [[A.window, 1], [B.window, t]],
    outside: `rgb(${r},${g},${bl})`, balcony: overlay("balcony"), room: overlay("room"), lamps: mixed(A.lamps, B.lamps),
  };
}
globalThis.zucchiniDayLook = dayLook;
// Test overrides skip the network (weather) or the real date (date). Neither is ever saved.
const CONDITIONS = ["sunny", "cloudy", "rain"];
const forcedWeather = CONDITIONS.includes(params.get("weather")) ? params.get("weather") : null;
const forcedDate = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") ?? "") ? params.get("date") : null;
const WEATHER_KEY = "zucchini-weather";  // its own key: the weather is never part of the game save
// Local day of year 1-366 and the device's UTC offset in minutes (east positive), passed to the core with the clock.
function localDate() {
  const d = new Date();
  const [y, m, day] = forcedDate ? forcedDate.split("-").map(Number) : [d.getFullYear(), d.getMonth() + 1, d.getDate()];
  return { doy: Math.round((Date.UTC(y, m - 1, day) - Date.UTC(y, 0, 0)) / 86400000), offset: -d.getTimezoneOffset(), key: `${y}-${m}-${day}` };
}
function conditionOf(weather, code) {
  for (const name of weather.conditions) if ((weather.wmo[name] ?? []).some(([lo, hi]) => code >= lo && code <= hi)) return name;
  return weather.default;
}
function weatherUrl(weather) {
  const { latitude, longitude } = weather.location;
  return `${weather.provider.url}?latitude=${latitude}&longitude=${longitude}&current=${weather.request.current}`;
}
function storedWeather(weather) {
  try {
    const v = JSON.parse(localStorage.getItem(WEATHER_KEY));
    if (weather.conditions.includes(v?.condition)) return v.condition;
  } catch {}
  return weather.default;
}
const GOLDEN_KEY = "zucchini-golden";  // the day golden hour last happened, so a reload does not repeat it
const localHour = () => forcedHour ?? ((d) => d.getHours() + d.getMinutes() / 60)(new Date());

function fail(msg) {
  errorBox.textContent = msg;
  hud.textContent = "";
  throw new Error(msg);
}

async function load() {
  const [tables, atlas, blob, mod, destinationArt] = await Promise.all([
    fetch(GEN + "tables.json").then((r) => (r.ok ? r.json() : fail("missing tables.json: run `make`"))),
    fetch(GEN + "atlas.json").then((r) => (r.ok ? r.json() : fail("missing atlas.json: run `make`"))),
    loadAtlas(),
    createModule(),
    loadDestinationArt(),
  ]);
  const wasmHash = (mod._zz_content_hash() >>> 0).toString(16).toUpperCase().padStart(8, "0");
  if (tables.content_hash !== wasmHash || atlas.content_hash !== wasmHash) {
    fail(`content mismatch: wasm ${wasmHash}, tables ${tables.content_hash}, atlas ${atlas.content_hash}. Run \`make\`.`);
  }
  const indices = blob;
  if (indices.length !== atlas.w * atlas.h) fail("Artwork size does not match this build. Reload to try again.");
  if (destinationArt) {
    const treatItem = tables.items.find((item) => item.id === "treat_jar");
    if (treatItem) {
      treatItem.title = "Treat bowl";
      treatItem.description = "Tap the bowl for a treat. Free, with a short wait between treats.";
    }
  }
  return { tables, atlas, image: atlasImage(atlas, indices), indices, mod, destinationArt };
}

// Indexed atlas -> RGBA canvas once. Index 0 is transparent. A future global
// palette change (day/night) would rebuild this canvas, per the plan's note on
// RGB565/RGBA caches.
function atlasImage(atlas, indices) {
  const rgb = atlas.palette.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
  const img = new ImageData(atlas.w, atlas.h);
  for (let i = 0; i < indices.length; i++) {
    const k = indices[i];
    if (k === 0) continue;
    const [r, g, b] = rgb[k];
    const offset = i * 4;
    img.data[offset] = r; img.data[offset + 1] = g; img.data[offset + 2] = b; img.data[offset + 3] = 255;
  }
  const c = document.createElement("canvas");
  c.width = atlas.w;
  c.height = atlas.h;
  c.getContext("2d").putImageData(img, 0, 0);
  return c;
}

let pixelScale = 1;
function fitCanvas(tables) {
  const { w, h } = tables.viewport;
  const column = document.getElementById("home-column");
  // Measure the actual safe-area-aware column, not the viewport's full width.
  const split = innerWidth >= 1000 || (innerWidth >= 640 && innerHeight <= 540 && innerWidth > innerHeight);
  const available = column.clientWidth || (split ? Math.floor((innerWidth - 50) * 0.62) : innerWidth - (innerWidth <= 520 ? 16 : 32));
  const maxHeight = split ? Math.max(160, innerHeight - 130) : Infinity;
  const width = Math.max(1, Math.floor(Math.min(available, maxHeight * w / h)));
  pixelScale = Math.max(0.5, Math.min(3, width * (globalThis.devicePixelRatio || 1) / tables.canvas.w));
  const bw = Math.round(tables.canvas.w * pixelScale), bh = Math.round(tables.canvas.h * pixelScale);
  if (canvas.width !== bw) canvas.width = bw;  // assigning clears the canvas
  if (canvas.height !== bh) canvas.height = bh;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${width * h / w}px`;
  document.getElementById("scene").style.width = `${width}px`;
  document.getElementById("scene").style.setProperty("--scale", width / w);

  return Math.round(width / w * 100) / 100;
}

const STEP_MS = 50;
// Draws moving things between the last two simulation steps; the logic snapshot is left alone.
function smoothSnapshot(snap, prev, acc) {
  if (!prev) return snap;
  const alpha = Math.min(1, Math.max(0, acc / STEP_MS)), pi = prev.items;
  const items = snap.items.map((it, i) => {
    if (it.kind !== KIND.dog && it.kind !== KIND.shadow && it.kind !== KIND.item) return it;
    const same = (q) => q.kind === it.kind && (it.kind !== KIND.item || (q.index === it.index && q.placement === it.placement && q.slot === it.slot));
    const q = pi[i] && same(pi[i]) ? pi[i] : pi.find(same);
    if (!q || Math.abs(it.x - q.x) + Math.abs(it.y - q.y) > 24 || (it.x === q.x && it.y === q.y)) return it;
    return { ...it, x: q.x + (it.x - q.x) * alpha, y: q.y + (it.y - q.y) * alpha };
  });
  return { ...snap, items };
}

function readSnapshot(mod, L) {
  const base = mod._zz_snapshot();
  const u8 = mod.HEAPU8, view = new DataView(u8.buffer);
  const count = view.getUint32(base, true);
  const items = [];
  for (let i = 0; i < count; i++) {
    const p = base + L.items + i * L.size;
    items.push({
      kind: u8[p], index: u8[p + 1], slot: u8[p + 2], frame: u8[p + 3], flip: u8[p + 4], placement: u8[p + 5],
      x: view.getInt16(p + L.x, true), y: view.getInt16(p + L.y, true),
    });
  }
  return {
    items,
    sequence: mod._zz_info(11),
    sequenceStep: mod._zz_info(30),
    clipMs: mod._zz_info(31),
    home: u8[base + L.home],
    activity: u8[base + L.activity],
    choice: view.getInt8(base + L.choice),
    errors: view.getUint32(base + L.errors, true),
    dogX: view.getInt32(base + L.dogX, true) / 256,
    dogY: view.getInt32(base + L.dogX + 4, true) / 256,
    dream: u8[base + L.dream],  // 0 none, else 1 + index into the atlas's dream icons
    dreamMs: view.getUint32(base + L.dreamMs, true),
    dreamLen: view.getUint32(base + L.dreamLen, true),
  };
}

function blit(image, rect, x, y, anchor, flip, scale = 1) {
  const [sx, sy, w, h] = rect;
  if (!flip) {
    ctx.drawImage(image, sx, sy, w, h, x - anchor[0] * scale, y - anchor[1] * scale, w * scale, h * scale);
    return;
  }
  ctx.save();
  ctx.translate(x, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(image, sx, sy, w, h, -(w - anchor[0]) * scale, y - anchor[1] * scale, w * scale, h * scale);
  ctx.restore();
}

// True when the piece's own art covers the point (within a pixel), so a tap on floor showing around a sprite is not the piece. Wall-plane art falls back to its box.
function artAt(app, placed, pt) {
  const g = placed.region;
  if (g.image || g.projection || !app.indices) { const b = placed.box; return pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3]; }
  const s = g.render_scale ?? 1, [sx, sy, w, h] = g.rect;
  const u = Math.floor((pt[0] - (placed.x - g.anchor[0] * s)) / s), v = Math.floor((pt[1] - (placed.y - g.anchor[1] * s)) / s);
  for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
    const a = u + du, b = v + dv;
    if (a >= 0 && b >= 0 && a < w && b < h && app.indices[(sy + b) * app.atlas.w + sx + a]) return true;
  }
  return false;
}
function drawRegion(image,region,x,y,flip=false,scale=1) {
  if (!region.projection) { blit(region.image ?? image,region.rect,x,y,region.anchor,flip,scale); return; }
  const [sx,sy,w,h]=region.rect;
  ctx.save();ctx.transform(...region.projection.matrix);
  if(region.projection.flip){ctx.translate(w,0);ctx.scale(-1,1);}
  ctx.drawImage(image,sx,sy,w,h,0,0,w,h);ctx.restore();
}

// Glides to the newly purchased footprint; otherwise sits exactly on the background's own camera.
function glide(c, now) {
  const t = Math.min(1, (now - c.start) / CAMERA_MS), e = 1 - (1 - t) ** 3;
  return {
    scale: c.from.scale + (c.target.scale - c.from.scale) * e,
    offset: [0, 1].map((i) => c.from.offset[i] + (c.target.offset[i] - c.from.offset[i]) * e),
  };
}
function cameraFor(app, mask, now) {  // mask is an ownership mask, or "park" for the outing
  const target = mask === "park" ? app.destinationArt?.manifest.parkCamera ?? app.atlas.park.camera : app.atlas.homes[mask].camera;
  // The new full-bleed landscape is registered to this exact camera and the core grid.
  if (mask === "park" && app.destinationArt && app.cam?.mask !== mask)
    app.cam = { mask, from: target, target, start: now - CAMERA_MS };
  if (!app.cam) app.cam = { mask, from: target, target, start: now - CAMERA_MS };
  else if (app.cam.mask !== mask) app.cam = { mask, from: glide(app.cam, now), target, start: now };
  return { target, ...glide(app.cam, now) };
}

// Backgrounds, foregrounds and sprites all live in world-screen space under one camera.
function applyWorld(origin, cam) {
  ctx.translate(origin[0] * renderScale + cam.offset[0], origin[1] * renderScale + cam.offset[1]);
  ctx.scale(cam.scale, cam.scale);
  ctx.translate(-origin[0], -origin[1]);
}

// Screen bounds [x0, y0, x1, y1] of a drawn region in world-screen pixels (wall pieces are sheared, so use their corners).
function boundsOf(region, x, y) {
  const [, , w, h] = region.rect, s = region.render_scale ?? 1;
  if (!region.projection) return [x - region.anchor[0] * s, y - region.anchor[1] * s, x - region.anchor[0] * s + w * s, y - region.anchor[1] * s + h * s];
  const [a, b, c, d, e, f] = region.projection.matrix;
  const pts = [[0, 0], [w, 0], [w, h], [0, h]].map(([u, v]) => [a * u + c * v + e, b * u + d * v + f]);
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

// A wall mount with its span moved along the wall by the piece's current offset.
function slid(app, placement) {
  const wm = app.tables.placements[placement].wall_mount;
  if (!wm) return wm;
  const along = app.offset(placement, wm.wall === "x" ? 1 : 0);
  return { ...wm, span: wm.span.map((v) => v + along) };
}

// Bird perches on a railing feeder: world-screen point on top of the wall mount.
function feederTop(app, wm) {
  const { origin, tile_w, tile_h } = app.tables.floor, u = (wm.span[0] + wm.span[1]) / 2;
  const [gx, gy] = wm.wall === "x" ? [wm.plane, u] : [u, wm.plane];
  return [origin[0] + (gx - gy) * tile_w / 2, origin[1] + (gx + gy) * tile_h / 2 - wm.top_px];
}

// Furniture states and composite poses are presentation only. Every composite
// contains both Zucchini and her furniture, registered to its floor contact.
function furnitureRegion(entry, state, facing = entry.default_facing ?? "SE") {
  const view = state ? entry.states?.[state]?.[facing] : facing !== entry.default_facing ? entry.rotations?.[facing] : null;
  return view ? { ...view, id: entry.id } : entry;
}
function compositePose(atlas, snap, review, sequenceName) {
  const dog = snap.items.find((d) => d.kind === KIND.dog);
  const clip = dog && atlas.clips[dog.index]?.name;
  const coversReview = review?.kind.startsWith("covers-");
  const coversStep = coversReview ? { "covers-tuck": 1, "covers-sleep": 2, "covers-emerge": 3 }[review.kind] : sequenceName === "under_covers" ? snap.sequenceStep : -1;
  if (dog && coversStep >= 1 && coversStep <= 3) {
    const bed = snap.items.find((d) => d.kind === KIND.item && atlas.items[d.index]?.id === "bedroom_bedding")
      ?? snap.items.find((d) => d.kind === KIND.fixture && atlas.fixtures[d.index]?.id === "bedroom_basic_bed");
    const state = coversStep === 1 ? (coversReview || (snap.clipMs ?? 0) < 950 ? "covers_tuck" : "covers_sleep")
      : coversStep === 3 ? "covers_emerge" : dog.frame % 2 ? "covers_breathe" : "covers_sleep";
    const region = bed && (bed.kind === KIND.item ? atlas.items : atlas.fixtures)[bed.index];
    if (region?.states?.[state]) return { kind: bed.kind, index: bed.index, state, facing: review?.facing };
  }
  const hammock = review?.kind === "balcony_hammock" || (clip === "outdoor_lounge" && sequenceName === "hammock_nap");
  const id = clip === "couch_nap" ? "couch" : clip === "bath_time" ? "bathtub" : hammock ? "balcony_hammock" : null;
  if (!id) return null;
  const index = atlas.items.findIndex((it) => it.id === id);
  const state = id === "couch" ? (review?.kind === "couch-sit" ? "sit" : dog.frame % 2 ? "nap_breathe" : "nap") : id === "balcony_hammock" ? (dog.frame % 2 ? "nap_breathe" : "nap") : ["wet", "soap", "rinse", "clean"][dog.frame % 4];
  return index >= 0 && atlas.items[index].states?.[state] && snap.items.some((d) => d.kind === KIND.item && d.index === index)
    ? { kind: KIND.item, index, state, facing: review?.facing } : null;
}

function compositeMatches(composite, d) {
  return !!composite && d.kind === composite.kind && d.index === composite.index;
}

function poseReviewSnapshot(app, snap, now) {
  const review = app.poseReview;
  if (!review?.kind || ["tv", "balcony_grill"].includes(review.kind)) return snap;
  const name = review.kind.startsWith("covers-") ? "sleep" : review.kind.startsWith("couch") ? "couch_nap" : review.kind === "bathtub" ? "bath_time" : review.kind === "balcony_hammock" ? "outdoor_lounge" : "sploot";
  const index = app.atlas.clips.findIndex((clip) => clip.name === name), clip = app.atlas.clips[index];
  const source = clip.slots.find((slot) => slot.facing === review.facing) ? review.facing : { NW: "NE", SW: "SE" }[review.facing] ?? "SE";
  const slot = Math.max(0, clip.slots.findIndex((s) => s.facing === source));
  const [fx, fy] = app.tables.spawn, floor = app.tables.floor;
  const ground = review.kind === "sploot" ? { x: floor.origin[0] + (fx - fy) * floor.tile_w / 2, y: floor.origin[1] + (fx + fy) * floor.tile_h / 2 } : {};
  return { ...snap, items: snap.items.map((d) => d.kind === KIND.dog ? { ...d, ...ground, index, slot, flip: source !== review.facing, frame: Math.floor(now / 450) % clip.slots[slot].frames.length } : d.kind === KIND.shadow ? { ...d, ...ground } : d) };
}
globalThis.zucchiniFurnitureRegion = furnitureRegion;
globalThis.zucchiniCompositePose = compositePose;

function grillSteam(region, x, y, now) {
  const scale = region.render_scale ?? 1;
  for (let i = 0; i < 3; i++) {
    const t = (now / 1800 + i / 3) % 1;
    const px = x + (i - 1) * 6 * scale + Math.sin(t * 6 + i) * 2;
    const py = y - region.rect[3] * .43 * scale - t * 23 * scale;
    ctx.globalAlpha = (1 - t) * .65;
    ctx.fillStyle = "#fdfaf5";
    ctx.fillRect(Math.round(px), Math.round(py), 2 * scale, 4 * scale);
    ctx.fillRect(Math.round(px + 1), Math.round(py - 3 * scale), 2 * scale, 3 * scale);
  }
  ctx.globalAlpha = 1;
}

// Opacity of the dream bubble: it fades in at the start of its slot and out at the end, so a change crosses through nothing.
function dreamAlpha(ms, length, fade) {
  if (!length) return 0;
  const t = Math.min(ms, length - ms) / fade;
  return Math.max(0, Math.min(1, t)) * 0.92;
}

// A quiet thought bubble above her head while she sleeps through focus. Silent and still; the icon is the core's choice.
function drawDream(app, snap, dog) {
  const dreams = app.atlas.dreams;
  if (!snap.dream || !dog || !dreams?.icons[snap.dream - 1]) return;
  const alpha = dreamAlpha(snap.dreamMs, snap.dreamLen, dreams.fade_ms);
  if (alpha <= 0) return;
  const sc = app.atlas.dog_scale ?? 1, side = dog.flip ? -1 : 1;
  const tipX = Math.round(dog.x + side * 15 * sc), tipY = Math.round(dog.y - 33 * sc);  // the tail tip rests just behind her ear
  const bubble = dreams.bubble, at = dreams.icon_at;
  const left = tipX - bubble.anchor[0], top = tipY - bubble.anchor[1];
  ctx.save();
  ctx.globalAlpha = alpha;
  blit(app.image, bubble.rect, tipX, tipY, bubble.anchor, false);
  ctx.drawImage(app.image, ...dreams.icons[snap.dream - 1].rect, left + at[0], top + at[1], 16, 16);
  ctx.restore();
  app.dreamShown = { id: snap.dream, alpha, box: [left, top, left + bubble.rect[2], top + bubble.rect[3]] };
}

function hopLift(app, snap) {  // a clip's hop lifts the dog sprite, not her shadow
  const dog = snap.items.find((d) => d.kind === KIND.dog), hop = dog && app.tables.clips[dog.index].hop;
  return hop ? hop.height_px * Math.sin(Math.PI * ((snap.clipMs ?? 0) % hop.period_ms) / hop.period_ms) : 0;
}

function draw(app, snap, cam, now = 0) {
  const { atlas, image } = app;
  const origin = app.tables.floor.origin;
  ctx.imageSmoothingEnabled = false;
  const look = app.look, glows = [];
  app.nowMs = now;
  const regions = app.regions = { dog: null, note: null, items: {}, placed: [], birds: [] };
  snap = poseReviewSnapshot(app, snap, now);
  const composite = compositePose(atlas, snap, app.poseReview, app.tables.sequences[snap.sequence]?.id);
  // Composite furniture already contains her pixels, but dreams still need
  // the simulation's head anchor during a normal focus nap.
  let dogDraw = composite && !app.poseReview ? snap.items.find((d) => d.kind === KIND.dog) : null;
  app.dreamShown = null;
  const lift = app.hopLift = hopLift(app, snap);
  for (const d of snap.items) {
    if (composite && (d.kind === KIND.dog || d.kind === KIND.shadow || (compositeMatches(composite, d) && d.slot === 2))) continue;
    ctx.save();
    applyWorld(origin, cam);
    if (d.kind === KIND.room) {
      const { rect: r, offset } = atlas.homes[d.index];
      ctx.drawImage(image, r[0], r[1], r[2], r[3], offset[0], offset[1], r[2], r[3]);
      balconyPuddles(app, snap, now);
    } else if (d.kind === KIND.foreground) {
      const front = atlas.home_fronts[d.index];
      if (front) ctx.drawImage(image, front.rect[0], front.rect[1], front.rect[2], front.rect[3], front.offset[0], front.offset[1], front.rect[2], front.rect[3]);
    } else if (d.kind === KIND.fixture) {
      const source = atlas.fixtures[d.index];
      const f = compositeMatches(composite, d) ? furnitureRegion(source, composite.state, composite.facing) : source;
      drawGlass(app, f, d.x, d.y);
      if (compositeMatches(composite, d)) regions.dog = boundsOf(f, d.x, d.y);
    } else if (d.kind === KIND.item) {
      const source = atlas.items[d.index], row = app.tables.items[d.index], base = app.tables.placements[d.placement];
      const state = compositeMatches(composite, d) ? composite.state : row.id === "tv" ? (app.tvOn ? "on" : "off") : row.id === "balcony_grill" ? (app.grillOpen ? "open" : "closed") : null;
      const reviewFacing = compositeMatches(composite, d) ? composite.facing : app.poseReview?.kind === row.id ? app.poseReview.facing : undefined;
      const facing = reviewFacing ?? app.facings?.[row.id];
      const it = row.id === "treat_jar" && app.destinationArt ? app.destinationArt.treat : state || facing ? furnitureRegion(source, state, facing) : source;
      // Wall pieces are drawn from baked wall-plane matrices, so a moved piece shifts by how far the core moved its anchor.
      const sh = it.projection && base ? [d.x - base.anchor_x, d.y - base.anchor_y] : [0, 0];
      const bounds = () => { const b = boundsOf(it, d.x, d.y); return [b[0] + sh[0], b[1] + sh[1], b[2] + sh[0], b[3] + sh[1]]; };
      if (sh[0] || sh[1]) ctx.translate(sh[0], sh[1]);
      drawGlass(app, d.slot > 0 && !state && it.parts ? it.parts[d.slot] : it, d.x, d.y);
      if (row.id === "balcony_grill" && app.grillOpen) grillSteam(it, d.x, d.y, now);
      if (compositeMatches(composite, d)) regions.dog = bounds();
      if (d.slot === 0) regions.placed.push({ placement: d.placement, index: d.index, box: bounds(), region: it, x: d.x, y: d.y, sh });
      if (d.slot === 0 && (app.tapItems.has(d.index) || ["record_player", "tv", "balcony_grill"].includes(row.id))) regions.items[row.id] = { index: d.index, box: bounds() };
      if (row.id === "bird_feeder") regions.feeder = slid(app, row.placement);
      if (row.ambient === "lamp_glow") glows.push([d.x, d.y - it.rect[3] * 0.68, 34, 24]);
      if (app.tables.daynight.string_lights.items.includes(row.id)) stringGlows(app, slid(app, row.placement), glows);
    } else if (d.kind === KIND.shadow) {
      blit(image, atlas.shadow.rect, d.x, d.y, atlas.shadow.anchor, false, atlas.dog_scale ?? 1);
    } else if (d.kind === KIND.dog) {
      const slot = atlas.clips[d.index].slots[d.slot];
      const sc = atlas.dog_scale ?? 1;
      blit(image, slot.frames[d.frame], d.x, d.y - lift, atlas.dog_anchor, d.flip, sc);
      regions.dog = [d.x - 20 * sc, d.y - 42 * sc, d.x + 20 * sc, d.y + 3 * sc];
      dogDraw = d;
    }
    ctx.restore();
  }
  ctx.save();
  applyWorld(origin, cam);
  if (regions.feeder && app.birds > 0 && atlas.bird) {  // one or two small birds on the feeder roof, hopping now and then
    const [fx, fy] = feederTop(app, regions.feeder), { bird_shoo_ms: total, bird_shoo_rise_px: rise, bird_shoo_drift_px: drift } = app.tables.interactions;
    const t = app.shoo ? 1 - app.shoo / total : 0;  // 0 perched, 1 gone: shooed birds rise, drift away and fade
    ctx.globalAlpha = 1 - t;
    for (let i = 0; i < app.birds; i++) {
      const x = fx + (i ? 7 : -5) + (i ? 1 : -1) * t * drift, y = fy + 4 - t * rise;
      blit(image, atlas.bird.frames[Math.floor(now / (app.shoo ? 110 : 450) + i) % 2], x, y, atlas.bird.anchor, i === 1);
      if (!app.shoo) regions.birds.push([x - atlas.bird.anchor[0], y - atlas.bird.anchor[1], x - atlas.bird.anchor[0] + atlas.bird.frames[0][2], y - atlas.bird.anchor[1] + atlas.bird.frames[0][3]]);
    }
    ctx.globalAlpha = 1;
  }
  const player = regions.items.record_player;
  if (player) {  // a small music note above the player: tap it to play or pause the room music
    const cx = (player.box[0] + player.box[2]) / 2, cy = player.box[1] - 9 - (app.musicOn ? Math.sin(now / 280) * 1.5 : 0);
    regions.note = [cx - 9, cy - 9, cx + 9, cy + 9];
    ctx.fillStyle = "#fffaf3"; ctx.strokeStyle = "#c7ab8a"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = app.musicOn ? "#203653" : "#88756c";
    ctx.fillRect(cx - 3, cy - 4, 1, 7); ctx.fillRect(cx - 3, cy - 4, 5, 1); ctx.fillRect(cx + 1, cy - 4, 1, 5);
    ctx.fillRect(cx - 5, cy + 2, 3, 2); ctx.fillRect(cx - 1, cy + 1, 3, 2);
    if (!app.musicOn) { ctx.strokeStyle = "#88756c"; ctx.beginPath(); ctx.moveTo(cx - 6, cy + 6); ctx.lineTo(cx + 6, cy - 6); ctx.stroke(); }
  }
  drawDream(app, snap, dogDraw);
  for (const t of app.tufts) {  // fur tufts from the brush fade as they drift down
    ctx.globalAlpha = Math.max(0, t.life / 900);
    ctx.fillStyle = t.colour; ctx.fillRect(t.x, t.y, 2, 2);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  // Evening light goes over the finished scene: balcony dimming first, then the lamps' glow, then a faint warm room tint.
  ctx.save();
  applyWorld(origin, cam);
  const balcony = app.tables.rooms.findIndex((r) => r.id === "balcony");
  if (atlas.balcony_overlay && balcony >= 0 && snap.home >> balcony & 1) {
    if (look.balcony) {
      ctx.fillStyle = look.balcony;
      pathOf(atlas.balcony_overlay); ctx.fill();
    }
    skyOnBalcony(app, atlas.balcony_overlay);
  }
  if (look.lamps > 0.01) {
    for (const [x, y, rx, ry] of glows)
      for (const [k, alpha] of [[1, 0.05], [0.7, 0.07], [0.4, 0.09]]) {
        ctx.fillStyle = `rgba(255,206,109,${+(alpha * look.lamps).toFixed(3)})`;
        ctx.beginPath(); ctx.ellipse(x, y, rx * k, ry * k, 0, 0, Math.PI * 2); ctx.fill();
      }
  }
  ctx.restore();
  if (look.room) { ctx.fillStyle = look.room; ctx.fillRect(0, 0, app.tables.canvas.w, app.tables.canvas.h); }
}

// The park outing: ground, props, her and the ball under the park camera. Outside light dims all of it; no room lights or lamp glow.
function drawPark(app, snap, cam) {
  const { atlas, image } = app, park = atlas.park, origin = app.tables.floor.origin;
  ctx.imageSmoothingEnabled = false;
  const regions = app.regions = { dog: null, note: null, items: {}, placed: [], props: [] };
  const art = app.destinationArt, scene = art?.manifest.scenes.park;
  if (scene) {
    ctx.drawImage(art.park, ...scene.background, 0, 0, app.tables.canvas.w, app.tables.canvas.h);
    for (const p of (app.parkPlacements ?? scene.placements).filter(p => p.decorative)) {
      const f = scene.objects[p.object].frames[p.facing], sc = p.scale * renderScale;
      blit(art.park, f.rect, p.x * renderScale, p.y * renderScale, f.anchor, false, sc);
    }
  }
  for (const d of snap.items) {
    ctx.save();
    applyWorld(origin, cam);
    if (d.kind === KIND.parkGround) {
      if (!scene) {
        const [x, y, w, h] = park.ground.rect;
        ctx.drawImage(image, x, y, w, h, park.ground.offset[0], park.ground.offset[1], w, h);
      }
    } else if (d.kind === KIND.parkProp) {
      const old = park.props[d.index];
      const object = scene?.objects[art.manifest.parkProps[old.id]];
      const placement = app.parkPlacements?.find(p => p.nativeId === old.id);
      const p = object?.frames[placement?.facing ?? "SE"] ?? old;
      blit(object ? art.park : image, p.rect, d.x, d.y, p.anchor);
      regions.props.push({ index: d.index, box: [d.x - p.anchor[0], d.y - p.anchor[1], d.x - p.anchor[0] + p.rect[2], d.y - p.anchor[1] + p.rect[3]] });
    } else if (d.kind === KIND.item) {
      const it = atlas.items[d.index];
      blit(image, it.rect, d.x, d.y, it.anchor, false, it.render_scale ?? 1);
    } else if (d.kind === KIND.dog) {
      const sc = atlas.dog_scale ?? 1;
      blit(image, atlas.clips[d.index].slots[d.slot].frames[d.frame], d.x, d.y, atlas.dog_anchor, d.flip, sc);
      regions.dog = [d.x - 20 * sc, d.y - 42 * sc, d.x + 20 * sc, d.y + 3 * sc];
    }
    ctx.restore();
  }
}
// Dims what the park drew (source-atop touches only painted pixels), then paints the sky behind it.
function finishPark(app) {
  ctx.save();
  ctx.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);
  if (app.look.balcony) { ctx.globalCompositeOperation = "source-atop"; ctx.fillStyle = app.look.balcony; ctx.fillRect(0, 0, app.tables.canvas.w, app.tables.canvas.h); }
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = outsideFill(app); ctx.fillRect(0, 0, app.tables.canvas.w, app.tables.canvas.h);
  ctx.restore();
}

// A window or bay window swaps its glass for the dusk or night sky, cross-fading between phases.
function drawGlass(app, region, x, y) {
  const variants = app.atlas.window_variants?.[region.id];
  for (const [name, alpha] of variants ? app.look.windows : [["day", 1]]) {
    ctx.globalAlpha = alpha;
    drawRegion(app.image, name === "day" || !variants[name] ? region : { ...region, rect: variants[name] }, x, y, false, region.render_scale ?? 1);
  }
  ctx.globalAlpha = 1;
  if (variants) skyOnGlass(app, region, x, y);
}

// Weather and golden hour are drawn in code with palette colours, over the glass and the balcony only.
const rgba = (app, colour, alpha) => `rgba(${[1, 3, 5].map((i) => parseInt(app.atlas.palette[colour].slice(i, i + 2), 16))},${+alpha.toFixed(3)})`;
function quadOf(region, x, y, inset) {
  const [, , w, h] = region.rect, s = region.render_scale ?? 1;
  let pts;
  if (!region.projection) { const x0 = x - region.anchor[0] * s, y0 = y - region.anchor[1] * s; pts = [[x0, y0], [x0 + w * s, y0], [x0 + w * s, y0 + h * s], [x0, y0 + h * s]]; }
  else { const [a, b, c, d, e, f] = region.projection.matrix; pts = [[0, 0], [w, 0], [w, h], [0, h]].map(([u, v]) => [a * u + c * v + e, b * u + d * v + f]); }
  const cx = pts.reduce((t, p) => t + p[0], 0) / 4, cy = pts.reduce((t, p) => t + p[1], 0) / 4;
  return pts.map(([px, py]) => [px + Math.sign(cx - px) * inset, py + Math.sign(cy - py) * inset]);
}
function pathOf(points) { ctx.beginPath(); points.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.closePath(); }
// Raindrops sliding slowly down the glass; each drop's place is fixed by its number, so the rain is steady frame to frame.
function glassDrops(app, points, now) {
  const st = app.tables.weather.visual.rain.drops;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
  const count = Math.max(4, Math.round(st.per_1000_px2 * w * h / 1000));
  ctx.save(); pathOf(points); ctx.clip();
  for (let i = 0; i < count; i++) {
    const u = (i * 0.6180339 + 0.13) % 1, v = (i * 0.7548776 + 0.31) % 1, speed = st.speed_px_s * (0.6 + 0.8 * ((i * 0.381966) % 1));
    const px = Math.round(x0 + u * w), py = Math.round(y0 - 3 + ((v * (h + 3) + now * speed / 1000) % (h + 3)));
    ctx.fillStyle = rgba(app, st.colour, st.alpha * 0.4); ctx.fillRect(px, py - 2, 1, 2);  // a faint wet trail above
    ctx.fillStyle = rgba(app, st.colour, st.alpha); ctx.fillRect(px, py, 1, 2);
  }
  ctx.restore();
}
// Puddles on the open balcony floor with rings spreading out of them, drawn before the furniture so pieces stand over them.
function balconyPuddles(app, snap, now) {
  const sky = app.sky, rain = app.tables.weather.visual.rain;
  const room = app.tables.rooms.find((r) => r.id === "balcony");
  if (!sky || sky.condition !== "rain" || !room || !(snap.home >> app.tables.rooms.indexOf(room) & 1)) return;
  const { origin, tile_w, tile_h } = app.tables.floor, [bx, by, bw, bh] = room.bounds;
  const blocked = new Set(app.tables.static_blocked.map(([cx, cy]) => `${cx},${cy}`)), free = [];
  for (const d of snap.items) {  // keep puddles on open floor, out from under furniture
    if (d.kind !== KIND.item || d.slot !== 0) continue;
    const pl = app.tables.placements[d.placement];
    if (!pl || pl.wall_mount || pl.mount) continue;
    const ox = app.offset(d.placement, 0), oy = app.offset(d.placement, 1);
    for (let cy = pl.y + oy - 1; cy < pl.y + oy + pl.h; cy++) for (let cx = pl.x + ox - 1; cx < pl.x + ox + pl.w; cx++) blocked.add(`${cx},${cy}`);
  }
  for (let cy = by; cy < by + bh; cy++) for (let cx = bx; cx < bx + bw; cx++) if (!blocked.has(`${cx},${cy}`)) free.push([cx, cy]);
  const { puddles: pd, ripples: rp } = rain;
  for (let i = 0; i < Math.min(pd.count, free.length); i++) {
    const [cx, cy] = free[Math.floor(((i * 0.6180339 + 0.21) % 1) * free.length)];
    const x = origin[0] + (cx - cy) * tile_w / 2, y = origin[1] + (cx + cy + 1) * tile_h / 2;
    ctx.fillStyle = rgba(app, pd.colour, pd.alpha);
    ctx.beginPath(); ctx.ellipse(x, y, pd.rx, pd.ry, 0, 0, Math.PI * 2); ctx.fill();
    const t = ((now + i * rp.period_ms * 0.37) % rp.period_ms) / rp.period_ms;  // each puddle's ring is out of step with the others
    ctx.strokeStyle = rgba(app, rp.colour, rp.alpha * (1 - t)); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(x, y, 1 + rp.radius * t, (1 + rp.radius * t) / 2, 0, 0, Math.PI * 2); ctx.stroke();
  }
}
function skyOnGlass(app, region, x, y) {
  const sky = app.sky, vis = app.tables.weather.visual;
  if (!sky || !app.look) return;
  const quad = quadOf(region, x, y, 2), day = (app.look.windows.find(([n]) => n === "day") ?? [0, 0])[1];
  const tint = (o, k = 1) => { if (o.alpha * k < 0.004) return; ctx.fillStyle = rgba(app, o.colour, o.alpha * k); pathOf(quad); ctx.fill(); };
  if (sky.condition === "rain") { tint(vis.rain.window); glassDrops(app, quad, app.nowMs ?? 0); }
  else if (sky.condition === "sunny") tint(vis.sunny.window, day);
  if (sky.golden > 0) tint(vis.golden.window, sky.golden);
}
// The background around the house follows the weather: warmer when sunny, greyer when cloudy, blue-grey in rain, amber at golden hour.
function outsideFill(app) {
  const sky = app.sky, base = app.look.outside;
  if (!sky || !app.tables.weather) return base;
  const vis = app.tables.weather.visual, day = (app.look.windows.find(([n]) => n === "day") ?? [0, 0])[1];
  let rgb = base.match(/\d+/g).map(Number);
  const mix = (o, k) => { if (!o) return; const a = o.alpha * k, c = [1, 3, 5].map((i) => parseInt(app.atlas.palette[o.colour].slice(i, i + 2), 16)); rgb = rgb.map((v, i) => Math.round(v + (c[i] - v) * a)); };
  mix(vis[sky.condition]?.outside, 0.4 + 0.6 * day);
  if (sky.golden > 0) mix(vis.golden.outside, sky.golden);
  return `rgb(${rgb.join(",")})`;
}
// The balcony floor, railings and slab: a cool wash in rain, amber at golden hour.
function skyOnBalcony(app, outline) {
  const sky = app.sky, vis = app.tables.weather.visual;
  if (!sky) return;
  const tint = (o, k = 1) => { if (o.alpha * k < 0.004) return; ctx.fillStyle = rgba(app, o.colour, o.alpha * k); pathOf(outline); ctx.fill(); };
  if (sky.condition === "rain") tint(vis.rain.balcony);
  if (sky.golden > 0) tint(vis.golden.balcony, sky.golden);
}

// String lights: a few small glows along the wall mount, hanging in a gentle sag.
function stringGlows(app, wm, glows) {
  if (!wm) return;
  const { origin, tile_w, tile_h } = app.tables.floor, [a, b] = wm.span, bulbs = 7;
  for (let k = 0; k < bulbs; k++) {
    const s = (k + 0.5) / bulbs, u = a + (b - a) * s, z = wm.top_px - (wm.top_px - wm.bottom_px) * 0.75 * Math.sin(Math.PI * s);
    const [gx, gy] = wm.wall === "x" ? [wm.plane, u] : [u, wm.plane];
    glows.push([origin[0] + (gx - gy) * tile_w / 2, origin[1] + (gx + gy) * tile_h / 2 - z, 13, 10]);
  }
}

function drawStatus(app, snap) {
  const dog = snap.items.find((d) => d.kind === KIND.dog);
  const name = dog ? app.tables.clips[dog.index].name : "idle";
  const activity = { idle:"settling in", idle_back:"watching the room", walk:"exploring", run:"having a little zoom",
    sleep:"sleeping", couch_enter:"hopping up", couch_exit:"hopping down", couch_nap:"napping on her couch",
    sit:"sitting quietly", sniff:"sniffing around", wake:"stretching", drink:"having a drink", eat:"checking her bowl",
    happy:"feeling happy", fetch:"playing with her ball", sniff_plant:"sniffing her plant", watch_tv:"watching TV",
    pick_toy:"choosing a toy", deluxe_sleep:"enjoying her cozy bed", bath_time:"having a bath", window_watch:"watching outside",
    outdoor_lounge:"lounging outside", treat_reaction:"delighted", sneeze:"having a tiny sneeze", listen:"perking up",
    sploot:"in a sploot", sploot_enter:"flopping down", sploot_exit:"getting up", stairs_up:"climbing up", stairs_down:"climbing down",
    groom_lean:"enjoying the brush", boof:"boofing", potty_circle:"circling the grass", potty_squat:"taking a moment", grass_kick:"kicking the grass",
    lie_listen:"listening to the music" }[name] || "resting";
  ctx.fillStyle = app.look.dark ? "#efe8de" : "#5c3b24";
  ctx.font = `${11 * renderScale}px ui-monospace, Menlo, monospace`;
  ctx.textAlign = "left";
  const covers = app.tables.sequences[snap.sequence]?.id === "under_covers";
  const coversActivity = covers ? { 1: "tucking herself in", 2: "sleeping under the covers", 3: "peeking out from the covers" }[snap.sequenceStep] : null;
  const reviewName = { "covers-tuck": "getting under the covers", "covers-sleep": "sleeping under the covers", "covers-emerge": "coming out of the covers", "couch-sit": "sitting on her couch", "couch-nap": "sleeping on her couch", bathtub: "in her bathtub", balcony_hammock: "in her hammock", sploot: "sploot", tv: "TV", balcony_grill: "grill" }[app.poseReview?.kind];
  ctx.fillText(reviewName ? `Pose review · ${reviewName}` : `Zucchini is ${coversActivity ?? activity}`, 10 * renderScale, app.tables.canvas.h - 12 * renderScale);
  return app.poseReview ? null : coversActivity ? (snap.sequenceStep === 3 ? "wake" : "sleep") : name;
}

// Arrange mode overlay: the floor grid, the selected piece's outline and a ghost of the drag target tinted by the core's verdict.
function drawEdit(app, snap, cam, edit, hostOf) {
  const { floor, rooms, placements } = app.tables, { origin, tile_w, tile_h } = floor;
  const iso = (x, y) => [origin[0] + (x - y) * tile_w / 2, origin[1] + (x + y) * tile_h / 2];
  const poly = (cells, fill, stroke) => {
    for (const [x, y] of cells) {
      ctx.beginPath();
      [iso(x, y), iso(x + 1, y), iso(x + 1, y + 1), iso(x, y + 1)].forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.6; ctx.stroke(); }
    }
  };
  ctx.save();
  applyWorld(origin, cam);
  const grid = [];
  rooms.forEach((r, i) => { if (snap.home >> i & 1) { const [bx, by, bw, bh] = r.bounds; for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) grid.push([x, y]); } });
  poly(grid, null, "rgba(60,48,51,0.2)");
  const pieces = (app.regions?.placed ?? []).filter((r) => hostOf(r.placement) === edit.sel);
  if (edit.sel != null) {
    ctx.strokeStyle = "#203653"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
    for (const r of pieces) ctx.strokeRect(r.box[0] - 1, r.box[1] - 1, r.box[2] - r.box[0] + 2, r.box[3] - r.box[1] + 2);
    ctx.setLineDash([]);
  }
  const d = edit.drag;
  if (d) {
    const pl = placements[d.placement], ddx = d.to[0] - d.from[0], ddy = d.to[1] - d.from[1];
    const [sx, sy] = [(ddx - ddy) * tile_w / 2, (ddx + ddy) * tile_h / 2];
    const tint = d.valid ? "rgba(46,160,67,0.4)" : "rgba(214,69,65,0.45)";
    if (!pl.wall_mount) {
      const cells = [];
      for (let y = 0; y < pl.h; y++) for (let x = 0; x < pl.w; x++) cells.push([pl.x + d.to[0] + x, pl.y + d.to[1] + y]);
      poly(cells, tint, null);
    }
    ctx.globalAlpha = 0.6;
    for (const r of pieces) {
      ctx.save();
      if (r.region.projection) { ctx.translate(r.sh[0] + sx, r.sh[1] + sy); drawRegion(app.image, r.region, r.x, r.y); }
      else drawRegion(app.image, r.region, r.x + sx, r.y + sy, false, r.region.render_scale ?? 1);
      ctx.restore();
      if (pl.wall_mount) { ctx.fillStyle = tint; ctx.fillRect(r.box[0] + sx, r.box[1] + sy, r.box[2] - r.box[0], r.box[3] - r.box[1]); }
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawDebug(app, snap, cam) {
  const { floor, static_blocked, points } = app.tables;
  ctx.save();
  applyWorld(floor.origin, cam);
  const iso = (x, y) => [floor.origin[0] + (x - y) * floor.tile_w / 2, floor.origin[1] + (x + y) * floor.tile_h / 2];
  const cell = (x, y, fill) => {
    const pts = [iso(x, y), iso(x + 1, y), iso(x + 1, y + 1), iso(x, y + 1)];
    ctx.beginPath();
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  for (const [x, y] of static_blocked) cell(x, y, "rgba(255,80,80,0.35)");
  ctx.fillStyle = "#7fe0ff";
  for (const p of points.filter((p) => snap.home >> p.room & 1)) {
    const [px, py] = iso(p.at[0], p.at[1]);
    ctx.fillRect(px - 1, py - 1, 3 / ctx.getTransform().a, 3 / ctx.getTransform().a);
  }
  const [dx, dy] = iso(snap.dogX, snap.dogY);
  ctx.fillStyle = "#ffe066";
  ctx.fillRect(dx - 1, dy - 1, 3 / ctx.getTransform().a, 3 / ctx.getTransform().a);
  ctx.restore();
}

const $ = (id) => document.getElementById(id);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const K = { start: 0, cancel: 1, finish: 2, buy: 3, add: 4, edit: 5, complete: 6, remove: 7, activity: 8, place: 9, store: 10, interact: 12, move: 13, reset: 14, goPark: 15, leavePark: 16, workout: 17, pin: 18, dreaded: 19 };
const LONG_PRESS_MS = 300;
const moveTarget = (item, dx, dy) => (item | ((dx & 255) << 8) | ((dy & 255) << 16)) >>> 0;
// Workout files: one JSON object per line with a stable external id, a type and a local end time. The limits keep one import bounded.
const WORKOUT_FILE = { bytes: 256 * 1024, lines: 1000, line: 512, id: 100 };
const WORKOUT_TEMPLATE = { run: "run", pickleball: "pickleball_tennis", tennis: "pickleball_tennis", gym: "gym" };
const WORKOUT_NAME = { run: ["run", "runs"], pickleball_tennis: ["pickleball/tennis", "pickleball/tennis"], gym: ["gym", "gym"] };
// "2026-11-23T07:45[:00]" read as a wall clock (anything after the seconds is ignored) -> minutes since 1970, or 0 when it is not a real date and time.
function localMinutes(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(text);
  if (!m) return 0;
  const [y, mo, d, h, mi] = m.slice(1).map(Number), day = new Date(Date.UTC(y, mo - 1, d));
  if (y < 2000 || y > 2200 || h > 23 || mi > 59 || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return 0;
  return day.getTime() / 60000 + h * 60 + mi;
}
function parseWorkouts(text) {
  const entries = [], skipped = [], lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    const skip = (reason) => skipped.push({ line: i + 1, reason });
    if (encoder.encode(raw).length > WORKOUT_FILE.line) return skip(`longer than ${WORKOUT_FILE.line} bytes`);
    let row;
    try { row = JSON.parse(raw); } catch { return skip("not valid JSON"); }
    if (!row || typeof row !== "object" || Array.isArray(row)) return skip("not a JSON object");
    const id = String(row.external_id ?? row.id ?? "").trim(), type = String(row.type ?? "").trim().toLowerCase();
    if (!id || id.length > WORKOUT_FILE.id || /[\x00-\x1f\x7f]/.test(id)) return skip("missing or invalid id");
    if (encoder.encode(id).length > 160) return skip("id longer than 160 bytes");
    if (!Object.prototype.hasOwnProperty.call(WORKOUT_TEMPLATE, type)) return skip(`unknown type "${type.slice(0, 20)}"`);
    const at = localMinutes(String(row.local_end ?? row.ended_at ?? ""));
    if (!at) return skip("missing or invalid local end time");
    entries.push({ id, at, template: WORKOUT_TEMPLATE[type] });
  });
  entries.sort((a, b) => a.at - b.at);  // oldest first, so the ledger bound gives the same result for any line order
  return { entries, skipped, lines: lines.length };
}
const loadErrors = ["", "This save is corrupt or incomplete.", "This save uses an unsupported version.", "This save belongs to a different content version. Keep it for a compatible build."];

async function main() {
  const app = await load();
  const { mod } = app;
  renderScale = app.tables.render_scale ?? 1;
  const L = {
    size: mod._zz_layout(0), items: mod._zz_layout(1), x: mod._zz_layout(2), y: mod._zz_layout(3),
    activity: mod._zz_layout(4), choice: mod._zz_layout(5), errors: mod._zz_layout(6), dogX: mod._zz_layout(7), home: mod._zz_layout(8),
    dream: mod._zz_layout(9), dreamMs: mod._zz_layout(10), dreamLen: mod._zz_layout(11),
  };
  Promise.resolve(globalThis.navigator?.storage?.persist?.()).catch(() => {});
  const seed = Number(params.get("seed") ?? Math.floor(Math.random() * 2 ** 31));
  mod._zz_init(seed >>> 0, 0);
  let db, revision = 0, durable = null, busy = false, blocked = true, retry = null, pendingImport = null;
  let focusDeadline = null, durableDeadline = null, updateVersion = null, durableFacings = {};
  app.facings = {};
  let viewOnly = artPreview;
  const items = app.tables.items, itemIndex = (id) => items.findIndex((it) => it.id === id);
  const ballIndex = itemIndex("ball"), brushIndex = itemIndex("brush"), playerIndex = itemIndex("record_player");
  app.tapItems = new Set(app.tables.sequences.filter((q) => q.trigger === 1).map((q) => q.required_item));
  app.tufts = []; app.birds = 0; app.musicOn = false;
  app.tvOn = false; app.grillOpen = false;
  app.poseReview = null;
  $("pose-review").value = "";
  $("pose-review-banner").hidden = true;
  const updatePoseReview = () => {
    app.poseReview = development && $("pose-review").value ? { kind: $("pose-review").value, facing: $("pose-facing").value || "SE" } : null;
    $("pose-review-banner").hidden = !app.poseReview;
    $("pose-hint").textContent = app.poseReview ? "Movement is paused for pose review. Choose Resume play, tap the scene, or start a routine to continue." : "Furnish everything first, then choose a pose. The review does not change saved progress.";
  };
  const stopPoseReview = () => { $("pose-review").value = ""; updatePoseReview(); };
  $("resume-play").addEventListener("click", stopPoseReview);
  app.offset = (placement, axis) => mod._zz_offset(placement, axis);
  const interactions = app.tables.interactions;
  let clock = performance.now(), last = clock;
  const info = (n) => mod._zz_info(n) >>> 0;
  const development = info(6) === 1;
  const refreshParkLayout = () => {
    const park = app.destinationArt?.manifest.scenes.park;
    if (park) app.parkPlacements = resolvePlaceLayout(park, readPlaceLayouts(localStorage, development).park);
  };
  refreshParkLayout();
  addEventListener("storage", e => { if (e.key === placeLayoutKey(development)) refreshParkLayout(); });
  $("pose-review").addEventListener("change", updatePoseReview);
  $("pose-facing").addEventListener("change", updatePoseReview);
  const active = () => info(2) === 1;
  const out = () => info(21) === 1;  // she is on a park outing
  const duration = app.tables.focus_minutes * 60000;
  const validDeadline = (value) => Number.isSafeInteger(value) && value > 0;
  // The deadline travels with the save's generation. Older saves without it
  // retain their historical interruption behaviour; imported backups do too.
  const catchUpFocus = () => {
    if (!active() || !validDeadline(focusDeadline)) return;
    const elapsed = Math.min(duration, Math.max(0, duration - (focusDeadline - Date.now())));
    const delta = elapsed - info(3);
    if (delta > 0) mod._zz_elapse_focus(delta);
  };
  const bytes = () => {
    const n = mod._zz_save();
    if (!n) throw new Error("Could not encode this save.");
    return mod.HEAPU8.slice(mod._zz_buffer(), mod._zz_buffer() + n);
  };
  const restore = (data, interrupt = false) => {
    const input = new Uint8Array(data);
    if (input.length > 16384) return 1;
    mod.HEAPU8.set(input, mod._zz_buffer());
    return mod._zz_load(input.length, interrupt ? 1 : 0);
  };
  const titleOf = (i) => {
    const p = mod._zz_task(i, 3);
    let end = p;
    while (mod.HEAPU8[end] && end < p + 160) end++;
    return decoder.decode(mod.HEAPU8.subarray(p, end));
  };
  const tasks = () => Array.from({ length: info(5) }, (_, i) => ({
    id: mod._zz_task(i, 0), done: !!mod._zz_task(i, 1), linked: mod._zz_task(i, 2), title: titleOf(i), reward: mod._zz_task(i, 4), type: mod._zz_task(i, 5), dreaded: !!mod._zz_task(i, 6),
  }));
  let homeControls = [], shopControls = [], shopRoom = 0, selectedRoom = null;
  // Arrange mode: pieces are selected and dragged on the real scene; the core decides what is legal.
  const edit = { on: false, sel: null, drag: null, undo: [] };
  const arrangeBtn = $("arrange");  // kept by reference: the room row is rebuilt on every render
  const focusDone = (earned) => `Focus complete · +${earned} coins`;
  const say = (text) => { $("message").textContent = text; };
  // The invitation is spent when she comes home, by any route; the outing itself is never saved.
  const goPark = async () => {
    if (!info(24)) return;
    refreshParkLayout();
    if (await run(K.goPark, 0, "", "Off to the park. Tap the grass to throw the ball, or a tree to have her sniff it.")) { clearRoomSelection(); animateTo({ z: 1, x: 0, y: 0 }); }
  };
  const comeHome = async (text) => { if (await run(K.leavePark, 0, "", text)) animateTo({ z: 1, x: 0, y: 0 }); };
  const leavePark = () => comeHome("Back home. Zucchini is waiting by the door.");
  function syncClock(now = performance.now()) {
    // Only monotonic host time advances focus. Animation catch-up stays capped.
    if (busy) return;
    const elapsed = Math.max(0, Math.floor(now - clock));
    clock += elapsed;
    if (!blocked && !pendingImport && active()) {
      mod._zz_elapse_focus(Math.min(elapsed, duration));
      catchUpFocus();
    }
  }
  function refresh() {
    const locked = busy || blocked || !!pendingImport || viewOnly;
    $("save-state").textContent = viewOnly ? "View only" : busy ? "Saving…" : blocked ? "Save needs attention" : "Saved on this device";
    $("update-build").disabled = busy || !!pendingImport;
    $("focus").disabled = locked;
    $("focus").textContent = active() ? "Cancel focus" : info(2) === 4 ? "Restart focus" : "Start focus";
    $("coins").textContent = `${info(1)} coins`;
    $("shop").disabled = busy;
    $("menu-toggle").disabled = busy;
    for (const [el, unavailable] of homeControls) el.disabled = locked || unavailable();
    for (const [el, unavailable] of shopControls) el.disabled = locked || out() || unavailable();
    $("furnish").disabled = locked || out();
    arrangeBtn.disabled = (locked || out()) && !edit.on;
    $("arrange-drawer").disabled = locked || out();
    $("park-home").hidden = !out();
    $("park-home").disabled = locked;
    const turns = rotationChoices(edit.sel);
    $("arrange-rotate").disabled = locked || active() || out() || !edit.on || !!edit.drag || turns.length < 2 || (edit.sel != null && !mod._zz_item(app.tables.placements[edit.sel].item,1));
    $("arrange-rotate").textContent = turns.length === 2 ? "Rotate 180°" : "Rotate 90°";
    $("arrange-undo").disabled = locked || !edit.undo.length;
    $("arrange-reset").disabled = locked || active();  // the core refuses a reset that would move her rest spot mid-focus
    $("add-task").disabled = locked || info(5) >= 64;
    $("task-title").disabled = locked;
    $("task-dreaded").disabled = locked;
    $("focus-task").disabled = locked || active();
    $("import").disabled = viewOnly || busy || !!pendingImport || !db;
    $("import-workouts").disabled = locked || !db;
    $("export").disabled = viewOnly || !durable;
    $("fast-forward").disabled = locked || !active();
    document.querySelectorAll(".task button, .task input").forEach((el) => { el.disabled = locked || el.dataset.locked === "true"; });
  }
  function renderTasks() {
    renderHome();
    const list = tasks();
    $("task-list").replaceChildren();
    $("task-count").textContent = `${list.length} / 64 tasks`;
    $("empty-tasks").hidden = list.length > 0;
    const selected = $("focus-task").value;
    $("focus-task").replaceChildren(new Option("Just focus", "0"));
    for (const t of list) {
      const li = document.createElement("li"); li.className = `task${t.done ? " done" : ""}`;
      const complete = document.createElement("button"); complete.className = "complete";
      complete.textContent = t.done ? "✓" : "○";
      complete.setAttribute("aria-label", t.done ? `Completed: ${t.title}` : `Complete: ${t.title}`);
      complete.dataset.locked = String(t.done || !!t.linked);
      complete.addEventListener("click", () => run(K.complete, t.id, "", `Task complete · +${t.reward} coins`));
      const copy = document.createElement("div"); copy.className = "task-copy";
      const title = document.createElement("span"); title.className = "title"; title.textContent = t.title;
      const note = document.createElement("small");
      const activity = t.type !== 0;
      const status = t.linked
        ? (t.done ? (activity ? "Completed with focus · activity reward included" : "Completed with focus")
          : activity ? `Linked to this focus · +${t.reward} coins activity reward included` : "Linked to this focus · completes with the timer")
        : t.done ? "Completed" : `+${t.reward} coins on completion`;
      note.textContent = t.dreaded ? `${status} · dreaded` : status;
      copy.append(title, note);
      const dread = document.createElement("button"); dread.className = "dreaded-toggle"; dread.textContent = "Dreaded";
      dread.setAttribute("aria-pressed", String(t.dreaded)); dread.setAttribute("aria-label", `Dreaded: ${t.title}`);
      dread.addEventListener("click", () => run(K.dreaded, t.id, "", t.dreaded ? "No longer dreaded." : "Marked as dreaded.", t.dreaded ? 0 : 1));
      const edit = document.createElement("button"); edit.textContent = "Edit"; edit.setAttribute("aria-label", `Edit: ${t.title}`);
      const remove = document.createElement("button"); remove.textContent = "Remove"; remove.setAttribute("aria-label", `Remove: ${t.title}`);
      remove.addEventListener("click", () => run(K.remove, t.id, "", "Task removed."));
      edit.addEventListener("click", () => {
        const input = document.createElement("input"); input.className = "edit-input"; input.value = t.title; input.setAttribute("aria-label", "Edit task title");
        const save = document.createElement("button"); save.textContent = "Save";
        const cancel = document.createElement("button"); cancel.textContent = "Cancel";
        const submit = async () => { if (await run(K.edit, t.id, input.value, "Task updated.")) renderTasks(); };
        save.addEventListener("click", submit);
        cancel.addEventListener("click", renderTasks);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } if (e.key === "Escape") renderTasks(); });
        li.replaceChildren(input, save, cancel); input.focus(); input.select();
      });
      li.append(complete, copy, edit, remove, ...(t.done ? [] : [dread])); $("task-list").append(li);
      if (!t.done && !t.linked) $("focus-task").add(new Option(t.title, String(t.id)));
    }
    if ([...$("focus-task").options].some((o) => o.value === selected)) $("focus-task").value = selected;
    refresh();
  }
  // One card per activity: its add button, the unlock it earns ("???" until revealed) and a pin toggle. Pinned ones are quick buttons, the rest sit under More.
  function renderActivities(button) {
    const pinned = mod._zz_stat(1, 0) >>> 0, max = app.tables.pinned_max, unlocks = app.tables.unlocks;
    $("activity-templates").replaceChildren(); $("activity-more-list").replaceChildren();
    app.tables.task_types.forEach((t, index) => {
      if (!index) return;
      const isPinned = !!(pinned & (1 << index));
      const card = document.createElement("div"); card.className = "activity"; card.dataset.template = t.id;
      const add = button(`${t.title} · +${t.reward}`, () => run(K.activity, index, "", `${t.title} added.`), () => info(5) >= 64);
      const unlock = document.createElement("small"); unlock.className = "unlock";
      const u = unlocks.findIndex((e) => e.activity === index);
      if (u >= 0) {
        unlock.textContent = mod._zz_unlock(u, 3) ? unlocks[u].title : "???";
        if (mod._zz_unlock(u, 0) && mod._zz_unlock(u, 3)) {
          const tag = document.createElement("span"); tag.className = "soon"; tag.textContent = unlocks[u].scene ? "ready" : "coming soon";
          unlock.append(tag);
        }
      }
      const pin = button(isPinned ? "Unpin" : "Pin", () => pinActivity(index, !isPinned, max));
      pin.className = "pin"; pin.setAttribute("aria-label", `${isPinned ? "Unpin" : "Pin"}: ${t.title}`);
      card.append(add, unlock, pin);
      $(isPinned ? "activity-templates" : "activity-more-list").append(card);
    });
    $("activity-more").hidden = !$("activity-more-list").children.length;
  }
  async function pinActivity(index, on, max) {
    const title = app.tables.task_types[index].title;
    $("pin-note").textContent = "";
    if (await run(K.pin, index, "", on ? `${title} pinned.` : `${title} unpinned.`, on ? 1 : 0, true)) return;
    $("pin-note").textContent = lastResult === 4 ? `You can pin up to ${max} activities. Unpin one first.` : "That change is no longer available.";
  }
  function renderHome() {
    homeControls = [];
    const button = (text, fn, unavailable = () => false) => {
      const b = document.createElement("button"); b.textContent = text; b.addEventListener("click", fn);
      homeControls.push([b, unavailable]); return b;
    };
    renderActivities(button);
    $("rooms").replaceChildren($("shop"), arrangeBtn);
    $("room-view").replaceChildren();
    const whole = button("Whole home", () => focusRoom(null), out);
    whole.dataset.room = "all";
    $("room-view").append(whole);
    $("shop-rooms").replaceChildren();
    app.tables.rooms.forEach((room, index) => {
      const unlocked = !!(info(10) & (1 << index));
      const b = button(unlocked ? room.title : `${room.title} · ${app.tables.items[room.unlock_item].price}`, () => unlocked ? focusRoom(index) : openShop(index), out);
      b.dataset.room = String(index);
      b.setAttribute("aria-label", unlocked ? `View ${room.title}` : `Unlock ${room.title} in shop`);
      $("room-view").append(b);
      const shopTab = document.createElement("button");
      shopTab.textContent = room.title;
      shopTab.dataset.room = String(index);
      shopTab.addEventListener("click", () => openShop(index));
      $("shop-rooms").append(shopTab);
    });
    syncRoomButtons();
    $("routine-buttons").replaceChildren();
    const picked = $("routine-select").value;
    $("routine-select").replaceChildren();
    if (out()) {
      $("routine-buttons").append(button("Head home", leavePark));
      $("routine-select").add(new Option("Head home", "home"));
    } else {
      app.tables.sequences.forEach((seq, index) => {
        if (!seq.free || !mod._zz_sequence(index)) return;
        $("routine-buttons").append(button(seq.title, () => run(K.interact, index, "", "A little time for Zucchini."), active));
        $("routine-select").add(new Option(seq.title, String(index)));
      });
      if (info(24)) {  // an invitation from a Run is banked
        $("routine-buttons").append(button("Go to the park", goPark, () => edit.on));
        $("routine-select").add(new Option("Go to the park", "park"));
      }
    }
    if ([...$("routine-select").options].some((o) => o.value === picked)) $("routine-select").value = picked;
    homeControls.push([$("routine-select"), () => active() && !out()], [$("routine-go"), () => (active() && !out()) || !$("routine-select").options.length]);
    $("routines").hidden = !$("routine-buttons").children.length;
    renderShop();
  }
  function setDrawer(open, focus = true) {
    $("shop-panel").classList.toggle("open", open);
    $("shop-panel").setAttribute("role", open ? "dialog" : "region");
    $("shop-panel").setAttribute("aria-modal", String(open));
    $("shop-backdrop").hidden = !open;
    $("menu-toggle").setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("drawer-open", open);
    if (focus) (open ? $("close-shop") : $("menu-toggle")).focus();
  }
  function closeShop() {
    $("shop-panel").hidden = true;
    if ($("shop-panel").classList.contains("open")) setDrawer(false);
  }
  function openShop(room = shopRoom) {
    shopRoom = room;
    $("shop-panel").hidden = false;
    renderShop();
    refresh();
    if (phone.matches) setDrawer(true);
    else $("shop-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  // Buys everything affordable, rooms first, repeating as purchases satisfy requirements.
  async function furnish() {
    const items = app.tables.items;
    const order = [...items.keys()].sort((a, b) => (items[b].unlock_room >= 0) - (items[a].unlock_room >= 0));
    for (let changed = true; changed;) {
      changed = false;
      for (const i of order) {
        if (!items[i].active || mod._zz_item(i, 0) || !mod._zz_item(i, 2) || info(1) < items[i].price) continue;
        if (!await run(K.buy, i, "", "")) return;
        changed = true;
      }
    }
    say("Furnished with everything the sample coins allow.");
  }
  // Storing a piece also stores whatever is mounted on it; say which, read before the command runs.
  function storedNote(index) {
    const items = app.tables.items, group = [index];
    for (let i = 0; i < group.length; i++)
      items.forEach((it, j) => { if (it.requires_item === group[i] && mod._zz_item(j, 1) && !group.includes(j)) group.push(j); });
    const names = group.slice(1).map((j) => items[j].title.toLowerCase());
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
    return names.length ? `${items[index].title} stored, with the ${list}.` : `${items[index].title} stored safely.`;
  }
  function renderShop() {
    shopControls = [];
    const button = (text, fn, unavailable = () => false) => {
      const b = document.createElement("button"); b.textContent = text; b.addEventListener("click", fn);
      shopControls.push([b, unavailable]); return b;
    };
    $("shop-heading").textContent = `${app.tables.rooms[shopRoom].title} shop`;
    for (const tab of $("shop-rooms").children)
      tab.setAttribute("aria-pressed", String(Number(tab.dataset.room) === shopRoom));
    $("shop-grid").replaceChildren();
    app.tables.items.forEach((item, index) => {
      if (!item.active) return;
      if ((item.unlock_room >= 0 ? item.unlock_room : item.required_room) !== shopRoom) return;
      const owned = !!mod._zz_item(index, 0), placed = !!mod._zz_item(index, 1), available = !!mod._zz_item(index, 2), roomOpen = !!mod._zz_item(index, 3);
      const blocker = available ? "" : roomOpen ? `Place the ${app.tables.items[item.requires_item].title.toLowerCase()} first` : `Unlock the ${app.tables.rooms[item.required_room].title.toLowerCase()} first`;
      const card = document.createElement("article"); card.className = "shop-card"; card.dataset.item = item.id;
      const art = document.createElement("canvas"); art.width = 80; art.height = 64;
      art.setAttribute("aria-label", item.title); art.setAttribute("role", "img");
      // A room card previews the home with that room added.
      const region = item.id === "treat_jar" && app.destinationArt ? app.destinationArt.treat : item.unlock_room >= 0 ? app.atlas.homes[1 | (1 << item.unlock_room)] : app.atlas.items[index];
      if (region.rect) {
        const [x,y,w,h] = region.rect, scale = Math.min(76/w,60/h);
        const ac = art.getContext("2d"); ac.imageSmoothingEnabled = false;
        ac.drawImage(region.image ?? app.image,x,y,w,h,(80-w*scale)/2,(64-h*scale)/2,w*scale,h*scale);
      }
      const title = document.createElement("strong"); title.textContent = item.title;
      const note = document.createElement("small");
      const roomName = app.tables.rooms[item.required_room].title;
      note.textContent = owned ? (item.unlock_room >= 0 ? "Part of your home" : placed ? `At home · ${roomName}` : `Owned · stored${blocker ? ` · ${blocker}` : ""}`) : `${item.price} coins${blocker ? ` · ${blocker}` : ""}`;
      const description = document.createElement("p"); description.textContent = item.description;
      const actions = document.createElement("div"); actions.className = "shop-actions";
      if (!owned) actions.append(button(`Buy · ${item.price}`, () => run(K.buy,index,"",`${item.title} is home.`), () => !available || info(1)<item.price));
      else if (item.unlock_room < 0) {
        actions.append(button(placed ? "Store" : "Place", () => run(placed ? K.store : K.place,index,"", placed ? storedNote(index) : `${item.title} placed at home.`), () => !placed && !available));
        const seq = app.tables.sequences.findIndex((q) => q.required_item === index && q.free && !!mod._zz_sequence(app.tables.sequences.indexOf(q)));
        if (seq >= 0) actions.append(button("Enjoy", () => run(K.interact,seq,"",`Enjoying ${item.title.toLowerCase()}.`), active));
      }
      card.append(art,title,note,description,actions); $("shop-grid").append(card);
    });
  }
  function saveFailure(error, action) {
    errorBox.textContent = error.message || String(error);
    blocked = true;
    const conflict = error.name === "SaveConflict";
    retry = conflict ? () => location.reload() : action;
    $("recovery").textContent = conflict ? "Reload saved progress" : "Retry save";
    $("recovery").hidden = false;
    say(conflict ? "Another tab has newer progress. Reload to use it." : "Progress has not been saved. Retry to continue.");
  }
  async function commit(data, deadline = focusDeadline, facings = app.facings) {
    revision = await commitStorage(db, revision, data, durable, deadline, durableDeadline, facings, durableFacings);
    durable = data;
    app.facings = durableFacings = {...facings};
    durableDeadline = focusDeadline = deadline;
  }
  // A staged state that cannot be read back blocks input, so no command can run twice.
  function reload(data) {
    if (!restore(data)) return true;
    blocked = true; $("recovery").hidden = true;
    errorBox.textContent = "This progress could not be reloaded. Reload the page; your last saved progress is kept.";
    return false;
  }
  let lastResult = 0;  // the core's answer to the last command that it refused, 0 when none was
  async function run(kind, target = 0, title = "", success = "", at = 0, quiet = false) {
    lastResult = 0;
    if (busy || blocked || pendingImport || viewOnly) return false;
    if ([K.start, K.cancel, K.interact, K.place, K.store, K.move, K.reset, K.goPark, K.leavePark].includes(kind)) stopPoseReview();
    const text = title.trim(), titleBytes = encoder.encode(text);
    if ([K.add, K.edit].includes(kind) && (!text || titleBytes.length > 160 || /[\x00-\x1f\x7f]/.test(text))) {
      errorBox.textContent = "Use a short task title on one line."; return false;
    }
    if (titleBytes.length > 160) { errorBox.textContent = "That title is too long."; return false; }  // the WASM title buffer holds 160 bytes
    syncClock();
    const coinsBefore = info(1);
    // Completion wins if a cancel or another input arrives at the deadline.
    if (active() && info(3) >= duration && kind !== K.finish) {
      if (!await run(K.finish, 0, "", focusDone)) return false;
      if (kind === K.cancel) return true;
    }
    const before = bytes();
    mod.HEAPU8.fill(0, mod._zz_title(), mod._zz_title() + 161);
    mod.HEAPU8.set(titleBytes, mod._zz_title());
    const result = mod._zz_command(info(0) + 1, kind, target, at);
    if (result !== 0) {
      lastResult = result;
      if (!quiet) errorBox.textContent = ["", "Already saved.", "This action is no longer available.", "A few more coins for this purchase.", "This list is full. Remove a task to add another.", "That workout is older than the history Zucchini keeps."][result];
      return false;
    }
    const next = bytes();
    const nextDeadline = active() ? (kind === K.start ? Date.now() + duration - info(3) : focusDeadline) : null;
    // Freeze staged state while storage commits. No success is exposed early.
    if (!reload(next) || !reload(before)) return false;
    busy = true; refresh();
    try {
      await commit(next, nextDeadline, kind === K.reset ? {} : app.facings);
      if (!reload(next)) return false;
      if (kind === K.buy && app.tables.items[target].unlock_room >= 0) { clearRoomSelection(); animateTo({ z: 1, x: 0, y: 0 }); }
      errorBox.textContent = "";
      say(typeof success === "function" ? success(info(1) - coinsBefore) : success); renderTasks(); return true;
    } catch (e) {
      if (!reload(before)) return false;
      saveFailure(e, async () => {
        blocked = false; $("recovery").hidden = true;
        await run(kind, target, title, success, at, quiet);
      });
      return false;
    } finally { busy = false; refresh(); }
  }
  $("task-help").textContent = `${app.tables.focus_minutes} minutes of focus earns ${app.tables.focus_reward} coins; a small task earns ${app.tables.task_reward}. Activities have their own rewards, with no daily limit. Link a task to focus: it completes with the timer, and a linked activity adds its reward to the session reward.`;
  $("focus").addEventListener("click", () => active()
    ? run(K.cancel, 0, "", "Focus cancelled · no coins awarded.")
    : run(K.start, Number($("focus-task").value), "", "A little quiet time. Zucchini is sleeping while you focus."));
  $("routine-go").addEventListener("click", () => {
    const pick = $("routine-select").value;
    if (pick === "park") return goPark();
    if (pick === "home") return leavePark();
    return run(K.interact, Number(pick), "", "A little time for Zucchini.");
  });
  $("shop").addEventListener("click", () => openShop());
  $("menu-toggle").addEventListener("click", () => openShop());
  $("close-shop").addEventListener("click", closeShop);
  $("shop-backdrop").addEventListener("click", closeShop);
  $("furnish").addEventListener("click", furnish);
  $("edit-pins").addEventListener("click", () => {  // pin buttons stay hidden until the owner edits pins
    const on = $("edit-pins").getAttribute("aria-pressed") !== "true";
    $("edit-pins").setAttribute("aria-pressed", String(on)); $("edit-pins").textContent = on ? "Done" : "Edit pins";
    $("app").classList.toggle("editing-pins", on); if (on) $("activity-more").open = true;
  });
  $("task-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (await run(K.add, 0, $("task-title").value, "Task added.", $("task-dreaded").checked ? 1 : 0)) { $("task-title").value = ""; $("task-dreaded").checked = false; }
  });
  $("recovery").addEventListener("click", async () => { if (!busy && retry) await retry(); });
  function download(data, name) {
    const url = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("export").addEventListener("click", () => download(durable, "zucchini-home-save.zucchini"));
  $("import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file || busy || pendingImport) return;
    if (file.size > 16384) { errorBox.textContent = "Save files must be at most 16 KiB."; return; }
    syncClock();
    const data = new Uint8Array(await file.arrayBuffer());
    // Recheck after reading: a timer completion may have started saving.
    if (busy) { errorBox.textContent = "Please choose the save again after saving finishes."; return; }
    syncClock();
    const current = bytes();
    const result = restore(data, true);
    if (result) { errorBox.textContent = loadErrors[result]; return; }
    pendingImport = bytes();
    $("import-preview").textContent = `Restore ${info(1)} coins, ${info(5)} tasks, and ${info(4) ? "the navy couch" : "no purchased couch"}? This replaces current progress. A previous copy is retained.`;
    restore(current);
    $("confirm-import").hidden = $("cancel-import").hidden = false;
    refresh();
  });
  $("cancel-import").addEventListener("click", () => {
    pendingImport = null; $("confirm-import").hidden = $("cancel-import").hidden = true;
    $("import-preview").textContent = "Current progress kept."; refresh();
  });
  $("confirm-import").addEventListener("click", async () => {
    if (!pendingImport || busy) return;
    const data = pendingImport;
    busy = true; refresh();
    try {
      await commit(data, null, {}); restore(data);
      pendingImport = null; blocked = false; retry = null; $("recovery").hidden = true;
      $("confirm-import").hidden = $("cancel-import").hidden = true;
      $("import-preview").textContent = "Progress restored.";
      errorBox.textContent = ""; say("Welcome home. Your progress is restored."); renderTasks();
    } catch (e) { errorBox.textContent = e.message; }
    finally { busy = false; clock = performance.now(); refresh(); }
  });
  $("import-workouts").addEventListener("click", () => $("workouts-file").click());
  $("workouts-file").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file || busy || blocked || pendingImport || viewOnly) return;
    const fail = (text) => { $("workout-summary").textContent = text; $("workout-detail").textContent = ""; };
    if (file.size > WORKOUT_FILE.bytes) return fail("Workout files must be at most 256 KiB.");
    const { entries, skipped, lines } = parseWorkouts(decoder.decode(await file.arrayBuffer()));
    if (lines > WORKOUT_FILE.lines) return fail(`A workout file can have at most ${WORKOUT_FILE.lines} lines. Split it and import the parts.`);
    const types = app.tables.task_types, counts = {}, held = { counted: 0, old: 0, full: 0 };
    let stopped = false;
    for (const entry of entries) {
      if (await run(K.workout, types.findIndex((t) => t.id === entry.template), entry.id, "", entry.at, true)) counts[entry.template] = (counts[entry.template] ?? 0) + 1;
      else if (lastResult === 1) held.counted++;
      else if (lastResult === 5) held.old++;
      else if (lastResult === 4) held.full++;
      else { stopped = true; break; }
    }
    errorBox.textContent = stopped ? errorBox.textContent : "";
    const done = Object.values(counts).reduce((a, b) => a + b, 0);
    const kinds = Object.entries(counts).map(([id, n]) => `${n} ${WORKOUT_NAME[id][n === 1 ? 0 : 1]}`).join(", ");
    const skippedAll = skipped.length + held.old;
    $("workout-summary").textContent = `Imported ${done} workout${done === 1 ? "" : "s"}${kinds ? `: ${kinds}` : ""}. ${held.counted} already counted, ${skippedAll} skipped.${held.full ? ` ${held.full} not imported: no room in the task list.` : ""}`
      + (stopped ? " Stopped early because progress could not be saved; choose the file again to finish. Nothing is counted twice." : "");
    const why = skipped.slice(0, 5).map((q) => `line ${q.line}: ${q.reason}`);
    if (skipped.length > 5) why.push(`and ${skipped.length - 5} more`);
    if (held.old) why.push(`${held.old} older than the history Zucchini keeps`);
    if (held.full) why.push(`${held.full} with no room in the task list`);
    $("workout-detail").textContent = why.length ? `Skipped: ${why.join("; ")}.` : "";
    say($("workout-summary").textContent);
  });
  $("park-home").addEventListener("click", leavePark);
  $("fast-forward").addEventListener("click", () => {
    if (!development || busy || blocked || !active()) return;
    mod._zz_dev_advance();
  });
  $("dev").hidden = !development;
  $("arrange-bar").hidden = true;
  $("hud").hidden = !debug;
  let scale = fitCanvas(app.tables);
  const refit = () => { scale = fitCanvas(app.tables); };
  const watchDpr = () => matchMedia(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`).addEventListener?.("change", () => { refit(); watchDpr(); }, { once: true });
  watchDpr();
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(refit).observe($("home-column"));
  addEventListener("resize", () => {
    refit();
    if (!$("shop-panel").hidden) setDrawer(phone.matches, false);
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && app.poseReview) { stopPoseReview(); return; }
    if (e.key === "Escape" && edit.on) { setEdit(false); return; }
    if (e.key === "Escape" && $("shop-panel").classList.contains("open")) { closeShop(); return; }
    if (e.target.matches("input, select, textarea")) return;
    if (e.key === "d") { debug = !debug; $("hud").hidden = !debug; }
  });
  // The viewer's zoom (1-3x) and pan sit on top of the camera, in canvas pixels. Nothing persists.
  const view = { z: 1, x: 0, y: 0 }, pointers = new Map();
  let viewAnim = null, lastCam = null, pinch = null, multi = false, lastTap = null, toggledAt = -1e9;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function syncRoomButtons() {
    for (const button of $("room-view").children) button.setAttribute("aria-pressed", String(button.dataset.room === (selectedRoom == null ? "all" : String(selectedRoom))));
  }
  const clearRoomSelection = () => { selectedRoom = null; syncRoomButtons(); };
  const syncView = () => {
    view.z = clamp(view.z, 1, 3);
    view.x = clamp(view.x, app.tables.canvas.w * (1 - view.z), 0);
    view.y = clamp(view.y, app.tables.canvas.h * (1 - view.z), 0);
    $("reset-view").hidden = view.z === 1 && view.x === 0 && view.y === 0;
    canvas.classList.toggle("zoomed", view.z > 1);
  };
  const canvasPoint = (clientX, clientY) => {
    const r = canvas.getBoundingClientRect();
    return [(clientX - r.left) * app.tables.canvas.w / r.width, (clientY - r.top) * app.tables.canvas.h / r.height];
  };
  // Client point -> world-screen point (the space sprites and backgrounds are placed in), and back.
  const toWorld = (clientX, clientY) => {
    if (!lastCam) return null;
    const [cx, cy] = canvasPoint(clientX, clientY), [ox, oy] = app.tables.floor.origin;
    return [ox + ((cx - view.x) / view.z - ox * renderScale - lastCam.offset[0]) / lastCam.scale,
      oy + ((cy - view.y) / view.z - oy * renderScale - lastCam.offset[1]) / lastCam.scale];
  };
  const toClient = (wx, wy) => {
    const r = canvas.getBoundingClientRect(), [ox, oy] = app.tables.floor.origin;
    const cx = (ox * renderScale + lastCam.offset[0] + lastCam.scale * (wx - ox)) * view.z + view.x;
    const cy = (oy * renderScale + lastCam.offset[1] + lastCam.scale * (wy - oy)) * view.z + view.y;
    return [r.left + cx * r.width / app.tables.canvas.w, r.top + cy * r.height / app.tables.canvas.h];
  };
  globalThis.zucchiniView = { state: () => ({ ...view }), toWorld, toClient, regions: () => app.regions, hop: () => app.hopLift, dream: () => app.dreamShown && { ...app.dreamShown }, edit: () => ({ on: edit.on, sel: edit.sel, undo: edit.undo.length, drag: edit.drag && { ...edit.drag } }) };
  const zoomAt = (cx, cy, z) => {
    const k = clamp(z, 1, 3) / view.z;
    view.x = cx - (cx - view.x) * k; view.y = cy - (cy - view.y) * k; view.z *= k;
    syncView();
  };
  const animateTo = (to) => { viewAnim = { from: { ...view }, to, start: performance.now() }; };
  function focusRoom(index) {
    if (out()) return;
    if (index == null) { clearRoomSelection(); animateTo({ z: 1, x: 0, y: 0 }); return; }
    const { w, h } = app.tables.canvas;
    const { origin: [ox, oy], tile_w, tile_h } = app.tables.floor;
    const [x, y, rw, rh] = app.tables.rooms[index].bounds;
    const cam = app.atlas.homes[info(10)].camera;
    const corners = [[x,y],[x+rw,y],[x,y+rh],[x+rw,y+rh]].map(([tx,ty]) => [
      ox * renderScale + cam.offset[0] + (tx-ty) * tile_w / 2 * cam.scale,
      oy * renderScale + cam.offset[1] + (tx+ty) * tile_h / 2 * cam.scale
    ]);
    const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
    const loX = Math.min(...xs), hiX = Math.max(...xs);
    const wall = index === 3 ? 18 : 80;
    const loY = Math.min(...ys) - wall * cam.scale, hiY = Math.max(...ys);
    const z = clamp(Math.min(w / (hiX-loX+40), h / (hiY-loY+40)), 1, 3);
    selectedRoom = index; syncRoomButtons();
    animateTo({ z, x: w/2 - (loX+hiX)/2*z, y: h/2 - (loY+hiY)/2*z });
  }
  const stepView = (now) => {
    if (!viewAnim) return;
    const { from, to, start } = viewAnim, t = Math.min(1, (now - start) / 250), e = 1 - (1 - t) ** 3;
    for (const k of ["z", "x", "y"]) view[k] = from[k] + (to[k] - from[k]) * e;
    if (t === 1) viewAnim = null;
    syncView();
  };
  const toggleZoom = (cx, cy) => {
    clearRoomSelection();
    toggledAt = performance.now();
    animateTo(view.z > 1 ? { z: 1, x: 0, y: 0 } : { z: 2, x: -cx, y: -cy });
  };
  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };
  $("reset-view").addEventListener("click", () => { clearRoomSelection(); animateTo({ z: 1, x: 0, y: 0 }); });
  canvas.addEventListener("wheel", (e) => {
    if (view.z === 1 && e.deltaY > 0 && !e.ctrlKey) return;  // already fully out: let the page scroll
    e.preventDefault(); viewAnim = null; clearRoomSelection();
    const [cx, cy] = canvasPoint(e.clientX, e.clientY);
    zoomAt(cx, cy, view.z * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : e.ctrlKey ? 0.01 : 0.0015)));
  }, { passive: false });
  // ---- play: taps and gestures on things in the scene. Taps never fight panning: a tap is a short press with no movement.
  const inBox = (pt, box, pad = 0) => !!box && !!pt && pt[0] >= box[0] - pad && pt[0] <= box[2] + pad && pt[1] >= box[1] - pad && pt[1] <= box[3] + pad;
  const canPlay = () => !busy && !blocked && !pendingImport && !viewOnly;
  const brushed = () => brushIndex >= 0 && !!mod._zz_item(brushIndex, 1);
  const play = (what, a = 0, b = 0) => mod._zz_play(what, a, b);
  function toFloor(wx, wy) {  // world-screen point -> floor tile coordinates
    const { origin, tile_w, tile_h } = app.tables.floor, u = (wx - origin[0]) / (tile_w / 2), v = (wy - origin[1]) / (tile_h / 2);
    return [(u + v) / 2, (v - u) / 2];
  }
  function tufts(wx, wy) {
    for (let i = 0; i < 3; i++)
      app.tufts.push({ x: wx + (Math.random() - 0.5) * 18, y: wy + (Math.random() - 0.5) * 10, vx: (Math.random() - 0.5) * 22, vy: 6 + Math.random() * 10, life: 900, colour: ["#efe8de", "#d6a066", "#fdfaf5"][i % 3] });
  }
  function stroke(wx, wy) { if (canPlay() && !active() && play(2)) tufts(wx, wy); }
  async function toggleMusic() {
    await audio.toggleMusic(); syncMusic();
    if (audio.musicPlaying) audio.play("needle_drop");
  }
  // Returns true when the tap did something, so it is not also counted as a double-tap zoom.
  function handleTap(clientX, clientY) {
    if (edit.on || !canPlay() || !app.regions) return false;
    const pt = toWorld(clientX, clientY);
    if (!pt) return false;
    if (app.poseReview && !["tv", "balcony_grill"].includes(app.poseReview.kind)) { stopPoseReview(); return true; }
    if (out()) {  // park: a tree or bush sends her to sniff it, any other ground is where the ball goes
      const { props, grid } = app.tables.park, hit = [...(app.regions.props ?? [])].reverse().find((r) => props[r.index].sniff && inBox(pt, r.box, 2));
      if (hit) { if (play(11, hit.index)) say(`Zucchini goes to sniff the ${props[hit.index].kind}.`); return true; }
      const [fx, fy] = toFloor(...pt);
      if (fx < 0 || fy < 0 || fx >= grid.w || fy >= grid.h) return false;
      if (play(10, Math.round(fx * 256), Math.round(fy * 256))) say("Fetch!");
      return true;
    }
    if (play(4)) return true;  // the first tap after a welcome home
    if (info(15)) {  // fetch game: a floor tap throws the ball there
      const [fx, fy] = toFloor(...pt);
      if (play(8, Math.round(fx * 256), Math.round(fy * 256))) say("Fetch!");
      return true;
    }
    if (inBox(pt, app.regions.note, 3)) { toggleMusic(); return true; }
    if (inBox(pt, app.regions.items.tv?.box, 3)) {
      app.tvOn = !app.tvOn; say(app.tvOn ? "TV on." : "TV off."); return true;
    }
    if (inBox(pt, app.regions.items.balcony_grill?.box, 3)) {
      app.grillOpen = !app.grillOpen; say(app.grillOpen ? "Grill open · steam rises from the grate." : "Grill closed."); return true;
    }
    if (!active()) {
      for (const [id, r] of Object.entries(app.regions.items))
        if (app.tapItems.has(r.index) && inBox(pt, r.box, 3)) { if (play(1, r.index)) say(id === "treat_jar" ? "Treat time." : "Walk time."); return true; }
      if (inBox(pt, app.regions.dog, 3)) { play(0); return true; }
      if (app.regions.birds?.some((box) => inBox(pt, box, 4))) { if (play(17)) say("The birds fly off."); return true; }
      const routineFor = (item) => app.tables.sequences.findIndex((q, i) => q.required_item === item && q.free && !!mod._zz_sequence(i));
      const piece = pieceAt(pt, (p) => app.tables.placements[p].layer !== 0 || routineFor(itemOfPlacement(p)) >= 0, (r) => artAt(app, r, pt));  // rugs without a routine are floor
      if (piece != null) {  // a routine she can do now, else she goes to sniff it
        const item = itemOfPlacement(piece), title = app.tables.items[item].title.toLowerCase();
        const seq = routineFor(item);
        if (seq >= 0) { run(K.interact, seq, "", `Enjoying ${title}.`); return true; }
        if (play(16, piece)) { say(`Zucchini goes to sniff the ${title}.`); return true; }
        say("She can't get there."); return false;
      }
      const [fx, fy] = toFloor(...pt);
      if (play(15, Math.round(fx * 256), Math.round(fy * 256))) { say("Zucchini trots over."); return true; }
      if (fx >= 0 && fy >= 0 && fx < app.tables.floor.w && fy < app.tables.floor.h) say("She can't get there.");
    }
    return false;
  }
  // ---- arrange mode
  const hostOf = (placement) => {
    const pl = app.tables.placements[placement];
    return pl.mount ? app.tables.placements.findIndex((q) => q.room === pl.room && q.id === pl.mount.on) : placement;
  };
  const movablePlacement = (placement) => placement >= 0 && app.tables.placements[placement].movable;
  function pieceAt(pt, accept = movablePlacement, hit = (r) => inBox(pt, r.box, 2)) {  // the accepted piece whose sprite centre is nearest the point, standing in for its host when mounted
    let best = null, near = Infinity;
    for (const r of app.regions?.placed ?? []) {
      const target = hostOf(r.placement);
      if (target < 0 || !accept(target) || !hit(r)) continue;
      const d = Math.hypot(pt[0] - (r.box[0] + r.box[2]) / 2, pt[1] - (r.box[1] + r.box[3]) / 2);
      if (d <= near) { near = d; best = target; }
    }
    return best;
  }
  const itemOfPlacement = (placement) => app.tables.placements[placement].item;
  const nameOf = (placement) => app.tables.items[itemOfPlacement(placement)].title.toLowerCase();
  function rotationChoices(placement) {
    if (placement == null || placement < 0) return [];
    const pl = app.tables.placements[placement];
    if (!pl?.movable || pl.wall_mount || pl.mount || pl.layer === 2) return [];
    const entry = app.atlas.items[pl.item];
    if (!entry?.rotations || entry.projection || entry.parts) return [];
    const base = entry.default_facing ?? "SE";
    const allowed = pl.w === pl.h ? PLACE_FACINGS : [base, PLACE_FACINGS[(PLACE_FACINGS.indexOf(base)+2)%4]];
    return allowed.filter(f => entry.rotations[f]);
  }
  function validFacings(value) {
    const out = {};
    if (!value || typeof value !== "object") return out;
    for (const item of app.tables.items) {
      const facing = value[item.id];
      if (facing && rotationChoices(item.placement).includes(facing)) out[item.id]=facing;
    }
    return out;
  }
  async function saveFacings(facings, onSuccess) {
    if (!canPlay() || active() || out()) return false;
    syncClock();busy=true;refresh();
    try {
      await commit(bytes(), focusDeadline, facings);
      errorBox.textContent="";onSuccess?.();return true;
    } catch(e) {
      saveFailure(e, async()=>{blocked=false;$("recovery").hidden=true;await saveFacings(facings,onSuccess);});
      return false;
    } finally {busy=false;refresh();}
  }
  async function saveFacing(placement, next, onSuccess) {
    if (!rotationChoices(placement).includes(next) || !mod._zz_item(itemOfPlacement(placement),1)) return false;
    const item=app.tables.items[itemOfPlacement(placement)], base=app.atlas.items[itemOfPlacement(placement)].default_facing ?? "SE";
    const facings={...app.facings};
    if(next===base)delete facings[item.id];else facings[item.id]=next;
    return saveFacings(facings,()=>{onSuccess?.();say(`Turned the ${nameOf(placement)}.`);});
  }
  async function rotateSelection() {
    const placement=edit.sel, choices=rotationChoices(placement);
    if(!edit.on||choices.length<2)return;
    const index=itemOfPlacement(placement), item=app.tables.items[index], previous=app.facings[item.id]??app.atlas.items[index].default_facing??"SE";
    const next=choices[(choices.indexOf(previous)+1)%choices.length];
    await saveFacing(placement,next,()=>edit.undo.push({rotation:true,placement,previous}));
  }
  function select(placement) {
    edit.sel = placement;
    say(placement == null ? "Arrange mode · tap a piece, then drag or rotate it." : `${app.tables.items[itemOfPlacement(placement)].title} selected · drag it to a new spot${rotationChoices(placement).length>1?" or rotate it":""}.`);
    refresh();
  }
  function startDrag(p) {
    const start = toWorld(p.cx0, p.cy0);
    if (!start || p.hit == null || !canPlay()) return;
    p.dragging = true; edit.sel = p.hit;
    const from = [app.offset(p.hit, 0), app.offset(p.hit, 1)];
    edit.drag = { placement: p.hit, start, from, to: from, valid: true };
    updateDrag(p);refresh();
  }
  function cancelDrag() { if (edit.drag) { for (const q of pointers.values()) q.dragging = false; edit.drag = null; } }
  function updateDrag(p) {
    const d = edit.drag, wp = toWorld(p.cx, p.cy);
    if (!d || !wp) return;
    const [ax, ay] = toFloor(...d.start), [bx, by] = toFloor(...wp);
    let dx = Math.round(bx - ax), dy = Math.round(by - ay);
    const wm = app.tables.placements[d.placement].wall_mount;
    if (wm) { if (wm.wall === "x") dx = 0; else dy = 0; }  // wall pieces only slide along their wall
    d.to = [d.from[0] + dx, d.from[1] + dy];
    d.valid = !!mod._zz_can_move(itemOfPlacement(d.placement), d.to[0], d.to[1]);
  }
  async function finishDrag(cancelled) {
    const d = edit.drag; edit.drag = null;refresh();
    if (!d || cancelled || (d.to[0] === d.from[0] && d.to[1] === d.from[1])) return;
    if (!d.valid) { say("That spot is blocked or would trap a path."); return; }
    const item = itemOfPlacement(d.placement);
    await run(K.move, moveTarget(item, ...d.to), "", () => {
      edit.undo.push({ item, placement: d.placement, from: d.from });
      return `Moved the ${nameOf(d.placement)}.`;
    });
  }
  async function undoMove() {
    const last = edit.undo.at(-1);
    if (!last) return;
    if(last.rotation){await saveFacing(last.placement,last.previous,()=>edit.undo.pop());return;}
    await run(K.move, moveTarget(last.item, ...last.from), "", () => {
      edit.undo.pop(); return `Put the ${nameOf(last.placement)} back.`;
    });
  }
  function setEdit(on) {
    if (edit.on === on) return;
    if (on) stopPoseReview();
    edit.on = on; edit.sel = null; cancelDrag(); edit.undo = [];
    canvas.classList.toggle("arranging", on);
    $("arrange-bar").hidden = !on;
    arrangeBtn.textContent = on ? "Done arranging" : "Arrange";
    if (on) { closeShop(); say("Arrange mode · tap a piece, then drag or rotate it. On touch, press and hold to drag."); }
    else say("Layout saved.");
    refresh();
  }
  arrangeBtn.addEventListener("click", () => setEdit(!edit.on));
  $("arrange-drawer").addEventListener("click", () => setEdit(true));
  $("arrange-done").addEventListener("click", () => setEdit(false));
  $("arrange-rotate").addEventListener("click", rotateSelection);
  $("arrange-undo").addEventListener("click", undoMove);
  $("arrange-reset").addEventListener("click", async () => {
    const resetDone=()=>{edit.undo=[];edit.sel=null;return "Every piece is back in its first spot.";};
    const moved=app.tables.placements.some((p,i)=>p.movable&&(app.offset(i,0)||app.offset(i,1)));
    if(moved)await run(K.reset,0,"",resetDone);
    else if(Object.keys(app.facings).length)await saveFacings({},()=>say(resetDone()));
    else {say(resetDone());refresh();}
  });
  let brushHold = null;  // a touch that began on her with a brush at home: stop the page scrolling under the strokes
  canvas.addEventListener("touchmove", (e) => { if ((brushHold && performance.now() - brushHold > 250) || edit.drag) e.preventDefault(); }, { passive: false });
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    viewAnim = null;
    const [x, y] = canvasPoint(e.clientX, e.clientY);
    const wp = toWorld(e.clientX, e.clientY);
    const onDog = !edit.on && brushed() && !active() && !!wp && inBox(wp, app.regions?.dog, 6);
    const hit = edit.on && wp ? pieceAt(wp) : null;
    const p = { x, y, sx: x, sy: y, cx: e.clientX, cy: e.clientY, cx0: e.clientX, cy0: e.clientY, moved: false, onDog, travel: 0, hit, t0: performance.now(), dragging: false, noDrag: false };
    pointers.set(e.pointerId, p);
    if (hit != null && e.pointerType !== "mouse") setTimeout(() => { if (pointers.get(e.pointerId) === p && !p.noDrag && !p.dragging && !multi) startDrag(p); }, LONG_PRESS_MS);
    brushHold = onDog && e.pointerType !== "mouse" ? performance.now() : null;
    canvas.setPointerCapture?.(e.pointerId);
    if (pointers.size >= 2) { multi = true; pinch = pinchState(); cancelDrag(); clearRoomSelection(); }
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const [x, y] = canvasPoint(e.clientX, e.clientY), dx = x - p.x, dy = y - p.y;
    p.x = x; p.y = y; p.cx = e.clientX; p.cy = e.clientY;
    if (edit.on && p.hit != null && !p.dragging && !p.noDrag && !multi) {
      const far = Math.hypot(x - p.sx, y - p.sy);
      if (e.pointerType === "mouse") { if (far > 4) startDrag(p); }
      else if (performance.now() - p.t0 >= LONG_PRESS_MS) startDrag(p);
      else if (far > 10) p.noDrag = true;  // the finger moved first: it is a scroll or a pan, not a drag
    }
    if (p.dragging) { updateDrag(p); p.moved = true; return; }
    if (Math.hypot(x - p.sx, y - p.sy) > 10) p.moved = true;
    if (!edit.on && !multi && p.moved && pointers.size === 1 && brushed() && !active()) {  // dragging across her brushes her
      const wp = toWorld(e.clientX, e.clientY);
      p.travel += Math.hypot(dx, dy);
      if (wp && inBox(wp, app.regions?.dog, 4) && p.travel >= 24) { p.travel = 0; stroke(wp[0], wp[1]); }
    }
    if (pointers.size >= 2) {
      const n = pinchState();
      view.x += n.x - pinch.x; view.y += n.y - pinch.y;
      zoomAt(n.x, n.y, view.z * n.d / pinch.d); pinch = n;
    } else if (view.z > 1 && !p.onDog && !multi) { if (p.moved) clearRoomSelection(); view.x += dx; view.y += dy; syncView(); }
  });
  const release = (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    pointers.delete(e.pointerId);
    if (pointers.size >= 2) pinch = pinchState();
    else pinch = null;
    if (p.dragging) { finishDrag(e.type === "pointercancel"); if (!pointers.size) multi = false; return; }
    const tapped = !multi && !p.moved && e.type !== "pointercancel";
    if (edit.on && tapped && p.hit != null) { select(p.hit); if (!pointers.size) multi = false; return; }
    if (edit.on && tapped && p.hit == null && edit.sel != null) select(null);
    const single = tapped && e.pointerType !== "mouse";
    if (!pointers.size) { multi = false; brushHold = null; }
    if (tapped && handleTap(p.cx, p.cy)) { lastTap = null; return; }
    if (!single) return;
    const now = performance.now();
    if (lastTap && now - lastTap.t < 300 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) { lastTap = null; toggleZoom(p.x, p.y); }
    else lastTap = { t: now, x: p.x, y: p.y };
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("dblclick", (e) => {
    if (performance.now() - toggledAt < 500) return;  // a touch double-tap already toggled
    toggleZoom(...canvasPoint(e.clientX, e.clientY));
  });
  syncView();
  async function initializeStorage() {
    busy = true; refresh();
    try {
      db = await openStorage(development ? "zucchini-home-dev" : "zucchini-home");
      let saved = await readStorage(db); revision = saved.revision;
      let previousName = false;
      if (!saved.current) {
        const previous = await readPreviousStorage(development);
        if (previous.current) { saved = previous; previousName = true; }
      }
      if (saved.current) {
        let data = saved.current, deadline = saved.focusDeadline, facings = saved.facings;
        let result = restore(data, !viewOnly && !validDeadline(deadline));
        let recovered = false;
        if (result === 1 && saved.previous) {
          data = saved.previous; deadline = saved.previousFocusDeadline; facings = saved.previousFacings;
          result = restore(data, !viewOnly && !validDeadline(deadline));
          recovered = !result;
        }
        if (result) {
          // Preserve unsupported/corrupt saves and allow raw export. Never reset.
          durable = saved.current; durableDeadline = saved.focusDeadline ?? null;
          throw new Error(loadErrors[result] + " Export this copy before restoring another save.");
        }
        durable = data; durableDeadline = validDeadline(deadline) ? deadline : null;
        app.facings = durableFacings = validFacings(facings);
        focusDeadline = active() && validDeadline(deadline) ? deadline : null;
        catchUpFocus();
        say(recovered ? "Recovered the previous save. The newest copy was damaged."
          : active() ? "Welcome back. Your focus is still running."
          : info(2) === 4 ? "Your older focus was interrupted · no coins awarded. Restart whenever you’re ready."
          : "Welcome back. Your progress is saved.");
      } else { durable = null; durableDeadline = focusDeadline = null; app.facings = durableFacings = {}; }
      blocked = false;
      renderTasks();
      if (viewOnly) {
        say(artPreview ? "Art preview · your focus keeps running in the original tab. Controls are paused here."
          : "Zucchini Home is open in another tab, so this one is view-only. It takes over when that tab closes.");
      } else if (!saved.current) {
        await commit(bytes()); say(development ? "Trial home · sample coins are ready. Open the shop and explore." : "Welcome home. Start a focus session or add your first task.");
      } else {
        // Persist the recovered state and its deadline before enabling input.
        await commit(bytes());
      }
      if (previousName && !viewOnly) say(info(2) === 4
        ? "Welcome to Zucchini Home. Your progress is restored; unfinished focus was interrupted without coins."
        : "Welcome to Zucchini Home. Your saved progress has been restored.");
      errorBox.textContent = ""; $("recovery").hidden = true;
    } catch (e) {
      saveFailure(e, initializeStorage);
      // A valid import can recover a save that this build cannot decode.
      $("import").disabled = !db;
    } finally { busy = false; clock = performance.now(); refresh(); if (blocked && db && !viewOnly) $("import").disabled = false; }
    if (!blocked && !viewOnly && active() && info(3) >= duration) await run(K.finish, 0, "", focusDone);
  }
  // One tab owns the save. Without this, opening a second tab interrupts the first tab's focus session.
  const lockName = development ? "zucchini-home-dev-owner" : "zucchini-home-owner";
  if (!artPreview && globalThis.navigator?.locks) {
    viewOnly = !await new Promise((resolve) => navigator.locks.request(lockName, { ifAvailable: true }, (lock) => {
      resolve(!!lock);
      return lock ? new Promise(() => {}) : undefined;
    }).catch(() => resolve(true)));
    if (viewOnly) navigator.locks.request(lockName, () => { location.reload(); return new Promise(() => {}); });
  }
  await initializeStorage();
  // Welcome home: after a long enough break she waits at the door. The time of the last visit lives in this browser only, never in the save.
  const SEEN = "zucchini-last-seen";
  const readSeen = () => { try { return Number(localStorage.getItem(SEEN)) || 0; } catch { return 0; } };
  const markSeen = () => { try { localStorage.setItem(SEEN, String(Date.now())); } catch {} };
  const maybeWelcome = () => {
    const away = Date.now() - readSeen();
    if (readSeen() && away > interactions.welcome_gap_minutes * 60000 && canPlay() && !active()) play(3);
  };
  maybeWelcome(); markSeen();
  addEventListener("pagehide", markSeen);
  $("build-version").textContent = buildRelease ? `Build ${buildRelease.version}` : "Local build";
  async function checkForUpdate() {
    if (!buildRelease) return;
    try {
      const response = await fetch(`${buildRelease.updateURL}?check=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) return;
      const latest = (await response.json()).version;
      if (typeof latest === "string" && /^[a-f0-9]{12}$/.test(latest) && latest !== buildRelease.version) {
        updateVersion = latest;
        $("update-build").hidden = false;
        refresh();
      }
    } catch { /* Offline users keep the last working build. */ }
  }
  $("update-build").addEventListener("click", () => {
    if (!updateVersion || busy || pendingImport) return;
    const next = new URL(location.href);
    next.searchParams.set("revision", updateVersion);
    location.href = next.href;
  });
  void checkForUpdate();
  if (buildRelease) setInterval(checkForUpdate, 5 * 60000);
  let ending = false, soundSerial = info(12), wasFetching = false, lastFrame = performance.now(), lastSeenAt = lastFrame, clockSentAt = -Infinity;
  // Her hidden inclinations follow the local time of day; the core keeps no clock, so the host passes the minute.
  // The weather and the date go in with it. Core weather numbers follow tables.weather.conditions.
  const sendClock = (now) => {
    if (now - clockSentAt <= 5000) return;
    clockSentAt = now;
    const date = localDate();
    rememberGolden();
    play(9, Math.round(localHour() * 60) % 1440);
    play(13, date.doy, date.offset);
    play(12, Math.max(0, weather.conditions.indexOf(app.weatherNow)));
  };
  // Weather: fetched on load and about hourly; a failure keeps the last known condition. ?weather= skips the network.
  const readGolden = () => { try { const v = JSON.parse(localStorage.getItem(GOLDEN_KEY)); return v?.key === localDate().key && Number.isInteger(v.doy) ? v.doy : 0; } catch { return 0; } };
  play(14, readGolden());
  const rememberGolden = () => {
    const doy = info(29);
    if (doy && doy !== readGolden()) try { localStorage.setItem(GOLDEN_KEY, JSON.stringify({ key: localDate().key, doy })); } catch {}
  };
  const weather = app.tables.weather;
  app.weatherNow = forcedWeather ?? storedWeather(weather);
  let weatherAt = -Infinity, weatherBusy = false;
  const refreshWeather = (now) => {
    if (forcedWeather || weatherBusy || now - weatherAt < weather.refresh_minutes * 60000) return;
    weatherBusy = true; weatherAt = now;
    Promise.resolve().then(() => fetch(weatherUrl(weather))).then((r) => (r.ok ? r.json() : Promise.reject(new Error("weather " + r.status)))).then((j) => {
      const code = j?.current?.weather_code;
      if (!Number.isInteger(code)) throw new Error("weather response has no weather_code");
      app.weatherNow = conditionOf(weather, code);
      play(12, weather.conditions.indexOf(app.weatherNow));
      try { localStorage.setItem(WEATHER_KEY, JSON.stringify({ condition: app.weatherNow, fetchedAt: Date.now() })); } catch {}
    }).catch(() => { weatherAt = now - (weather.refresh_minutes - 5) * 60000; }).finally(() => { weatherBusy = false; });
  };
  sendClock(lastFrame);
  if (development && params.has("furnished") && !blocked && !viewOnly) await furnish();
  const motion = { prev: null, cur: null, acc: 0 };
  function frame(now) {
    syncClock(now);
    refreshWeather(now);
    sendClock(now);
    const elapsed = Math.max(0, Math.round(now - last)); last = now;
    const steps = (!busy && !app.poseReview) ? mod._zz_advance(elapsed) : 0;
    if (!busy && !app.poseReview) motion.acc += Math.min(elapsed, 250) - steps * STEP_MS;
    if (!busy && !blocked && !pendingImport && active() && info(3) >= duration)
      void run(K.finish, 0, "", focusDone);
    const snap = readSnapshot(mod, L);
    if (steps === 1) { motion.prev = motion.cur; motion.cur = snap; }
    else if (steps > 1) { motion.prev = null; motion.cur = snap; }
    else if (!motion.cur) motion.cur = snap;
    const shown = smoothSnapshot(snap, motion.prev, motion.acc);
    app.birds = info(17); app.shoo = info(32);
    app.sky = { condition: weather.conditions[info(26)] ?? weather.default, golden: info(27) / 1000 };
    audio.setRain(app.sky.condition === "rain");
    if (info(12) !== soundSerial) {  // a routine step or event asked for a sound
      soundSerial = info(12);
      const name = app.tables.sounds[info(13) - 1];
      if (name) audio.play(name);
    }
    const playerPlaced = playerIndex >= 0 && !!mod._zz_item(playerIndex, 1);
    $("music-toggle").hidden = playerPlaced;  // the record player's note replaces the button; volume stays
    const fetching = info(15) === 1, offer = info(14) > 0 && ballIndex >= 0 && !!mod._zz_item(ballIndex, 1) && !active();
    $("fetch").hidden = !fetching && !offer;
    $("fetch").textContent = fetching ? "End fetch" : "Play fetch";
    $("fetch").disabled = busy || blocked || viewOnly;
    if (fetching !== wasFetching) { wasFetching = fetching; if (!fetching && !active() && !out()) say("That was fun."); }
    const dt = Math.min(100, now - lastFrame); lastFrame = now;
    for (const t of app.tufts) { t.life -= dt; t.x += t.vx * dt / 1000; t.y += t.vy * dt / 1000; }
    app.tufts = app.tufts.filter((t) => t.life > 0);
    if (now - lastSeenAt > 20000) { lastSeenAt = now; markSeen(); }
    if (!app.look || now - app.lookAt >= 1000) {
      app.look = dayLook(app.tables.daynight, app.atlas.palette, app.atlas.home_bg, localHour());
      app.lookAt = now;
      $("scene").classList.toggle("dark", app.look.dark);
    }
    stepView(now);
    ctx.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const outing = out();
    if (outing) ctx.clearRect(0, 0, app.tables.canvas.w, app.tables.canvas.h);  // the sky is painted behind the park once it has been dimmed
    else { ctx.fillStyle = outsideFill(app); ctx.fillRect(0, 0, app.tables.canvas.w, app.tables.canvas.h); }
    const cam = lastCam = cameraFor(app, outing ? "park" : snap.home, now);
    ctx.save();
    if (view.z !== 1) { ctx.translate(view.x, view.y); ctx.scale(view.z, view.z); }
    if (outing) drawPark(app, shown, cam);
    else {
      draw(app, shown, cam, now);
      if (edit.on) drawEdit(app, shown, cam, edit, hostOf);
      if (debug) drawDebug(app, shown, cam);
    }
    ctx.restore();
    if (outing) finishPark(app);
    if (outing && info(22) && !ending && !busy && !blocked && !pendingImport && !viewOnly) {  // the time is up: coming home is a command, so the invitation is spent durably
      ending = true;
      comeHome("The walk is over. Zucchini is home.").finally(() => { ending = false; });
    }
    audio.onClip(drawStatus(app, snap));
    const remaining = active() ? Math.ceil((duration - info(3)) / 1000) : duration / 1000;
    $("timer").textContent = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
    hud.textContent = `seed ${seed} · content ${app.tables.content_hash} · ${scale}× · ${app.atlas.clips.some((clip) => clip.slots.some((slot) => slot.source === "real")) ? "art pass 1" : "placeholder art"}` + (snap.errors ? ` · snapshot errors ${snap.errors}` : "");
    requestAnimationFrame(frame);
  }
  document.addEventListener("visibilitychange", () => { syncClock(); if (document.hidden) markSeen(); else { maybeWelcome(); void checkForUpdate(); } });
  const audio = createAudio();
  const syncMusic = () => {
    $("music-toggle").textContent = audio.musicPlaying ? "Pause music" : "Play music";
    app.musicOn = audio.musicPlaying; play(5, app.musicOn ? 1 : 0);  // her record-player routine joins free mode only while music plays
  };
  $("music-volume").value = audio.musicVolume;
  $("effects-volume").value = audio.effectsVolume;
  $("music-volume").addEventListener("input", (e) => audio.setMusicVolume(e.target.value));
  $("effects-volume").addEventListener("input", (e) => audio.setEffectsVolume(e.target.value));
  $("music-toggle").addEventListener("click", async () => { await audio.toggleMusic(); syncMusic(); });
  $("fetch").addEventListener("click", () => {
    if (!canPlay()) return;
    if (info(15)) { play(7); say("Fetch is over for now."); }
    else if (play(6)) say("Tap the floor to throw the ball.");
  });
  for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, () => audio.unlock());
  requestAnimationFrame(frame);
}

main().catch((e) => {
  if (!errorBox.textContent) errorBox.textContent = String(e);
  const status = document.getElementById("save-state");
  if (status) status.textContent = "Could not start";
  const restart = document.getElementById("recovery");
  if (restart) { restart.hidden = false; restart.textContent = "Reload app"; restart.addEventListener("click", () => location.reload()); }
});
