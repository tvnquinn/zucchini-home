// Host-only audio: never touches the simulation, saves or rewards.
const BASE = globalThis.zucchiniRelease?.audioBase ?? "../../assets/audio/";
async function audioBytes(file) {
  const count = globalThis.zucchiniRelease?.audioChunks?.[file];
  if (!count) {
    const response = await fetch(BASE + file);
    if (!response.ok) throw new Error("Audio unavailable");
    return response.arrayBuffer();
  }
  const parts = await Promise.all(Array.from({ length: count }, async (_, i) => {
    const response = await fetch(BASE + `${file}.part${i}`);
    if (!response.ok) throw new Error("Audio unavailable");
    return new Uint8Array(await response.arrayBuffer());
  }));
  const data = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { data.set(part, offset); offset += part.length; }
  return data.buffer;
}
const KEY = "zucchini-audio";
const MUSIC_FILE = "music/room_lofi_01.mp3";
const TAIL = 6, CROSS = 3, FADE_IN = 1.5, FADE_OUT = 0.8, CLIP_FADE = 0.15;
const LOOP_TARGET = -64, ONESHOT_TARGET = -58, AMBIENT_TARGET = -62, AMBIENT_FADE = 2.5;
const RAIN_FILE = "sfx/rain_window_loop.mp3", RAIN_LUFS = -40.6;

const SFX = {
  paw_walk: { lufs: -45.2, target: LOOP_TARGET, loop: [0.8, 6.4] },
  paw_run: { lufs: -50.3, target: LOOP_TARGET, loop: [0, 0] },
  settle: { lufs: -49.7, target: ONESHOT_TARGET },
  wake_stretch_shake: { lufs: -47.1, target: ONESHOT_TARGET },
  sniff: { lufs: -52.5, target: ONESHOT_TARGET },
  drink: { lufs: -40.6, target: ONESHOT_TARGET },
  eat: { lufs: -38.9, target: ONESHOT_TARGET },
  happy_huff: { lufs: -57.0, target: ONESHOT_TARGET },
  sneeze: { lufs: -28.5, target: ONESHOT_TARGET },
  bath_splash: { lufs: -39.2, target: ONESHOT_TARGET },
  ball_bounce: { lufs: -29.2, target: ONESHOT_TARGET },
  boof_single: { lufs: -40.7, target: ONESHOT_TARGET },
  boof_double: { lufs: -38.9, target: ONESHOT_TARGET },
  bird_chirp: { lufs: -36.5, target: ONESHOT_TARGET },
  brush_stroke: { lufs: -53.0, target: ONESHOT_TARGET },
  treat_catch: { lufs: -35.9, target: ONESHOT_TARGET },
  grass_kick: { lufs: -37.7, target: ONESHOT_TARGET },
  leash_jingle: { lufs: -31.8, target: ONESHOT_TARGET },
  needle_drop: { lufs: -30.2, target: ONESHOT_TARGET },
  door_knock: { lufs: -32.6, target: ONESHOT_TARGET },
  play_growl: { lufs: -26.5, target: ONESHOT_TARGET },
};
const CLIP_SOUND = {
  walk: "paw_walk", run: "paw_run", sleep: "settle", couch_enter: "settle", deluxe_sleep: "settle",
  wake: "wake_stretch_shake", sniff: "sniff", sniff_plant: "sniff", drink: "drink", eat: "eat",
  happy: "happy_huff", treat_reaction: "happy_huff", sneeze: "sneeze",
  bath_time: "bath_splash", fetch: "ball_bounce",
  sploot_enter: "settle", sploot_exit: "wake_stretch_shake", stairs_up: "paw_walk", stairs_down: "paw_walk", potty_circle: "paw_walk",
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const unit = (v, fallback) => (Number.isFinite(Number(v)) ? clamp(Number(v), 0, 1) : fallback);

function loadVolumes() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { music: unit(saved.music, 0.3), effects: unit(saved.effects, 0.35) };
  } catch { return { music: 0.3, effects: 0.35 }; }
}

export function createAudio() {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  const volumes = loadVolumes();
  let ctx = null, musicBus = null, effectsBus = null;
  const buffers = new Map(), loading = new Map();
  let session = null, wantClip = "", active = null, rainWanted = false, rain = null;

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(volumes)); } catch {} };

  function ensure() {
    if (!Ctor) return false;
    if (!ctx) {
      try {
        ctx = new Ctor();
        musicBus = ctx.createGain(); effectsBus = ctx.createGain();
        musicBus.gain.value = volumes.music; effectsBus.gain.value = volumes.effects;
        musicBus.connect(ctx.destination); effectsBus.connect(ctx.destination);
      } catch { ctx = null; return false; }
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return true;
  }

  function load(file) {
    if (buffers.has(file)) return Promise.resolve(buffers.get(file));
    if (!loading.has(file)) {
      loading.set(file, (async () => {
        try {
          const buf = await ctx.decodeAudioData(await audioBytes(file));
          buffers.set(file, buf);
          return buf;
        } catch { return null; }
        finally { loading.delete(file); }
      })());
    }
    return loading.get(file);
  }

  function stopClip() {
    if (!active) return;
    const { src, gain } = active; active = null;
    const t = ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + CLIP_FADE);
    try { src.stop(t + CLIP_FADE + 0.02); } catch {}
  }

  // One-shot effects asked for by routines and gestures (treat catch, leash, birds, boof, brush, needle drop).
  function playSfx(name) {
    const def = SFX[name], buf = buffers.get(`sfx/${name}.mp3`);
    if (!ctx || !def || def.loop) return;
    if (!buf) { load(`sfx/${name}.mp3`).then((b) => { if (b) playSfx(name); }); return; }
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buf;
    gain.gain.value = 10 ** (clamp(def.target - def.lufs, -30, 12) / 20);
    src.connect(gain); gain.connect(effectsBus);
    src.start(0);
  }

  function playClipSound(name) {
    const key = CLIP_SOUND[name], def = SFX[key], buf = buffers.get(`sfx/${key}.mp3`);
    if (!def || !buf) return;
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buf;
    if (def.loop) { src.loop = true; src.loopStart = def.loop[0]; src.loopEnd = def.loop[1] || buf.duration; }
    gain.gain.value = 10 ** (clamp(def.target - def.lufs, -30, 12) / 20);
    src.connect(gain); gain.connect(effectsBus);
    src.start(0, def.loop ? def.loop[0] : 0);
    active = { src, gain };
    src.onended = () => { if (active && active.src === src) active = null; };
  }

  function applyClip() {
    if (!ctx) return;
    stopClip();
    const key = CLIP_SOUND[wantClip];
    if (!key) return;
    const name = wantClip, file = `sfx/${key}.mp3`;
    if (buffers.has(file)) playClipSound(name);
    else load(file).then(() => { if (wantClip === name && !active) playClipSound(name); });
  }

  function queueSegment(s, buf, when, first) {
    const seg = buf.duration - TAIL;
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buf; src.connect(gain); gain.connect(s.gain);
    if (!first) {
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(1, when + CROSS);
    }
    gain.gain.setValueAtTime(1, Math.max(when + CROSS, when + seg - CROSS));
    gain.gain.linearRampToValueAtTime(0, when + seg);
    src.start(when, 0, seg);
    s.sources.add(src);
    src.onended = () => {
      s.sources.delete(src);
      if (s.dead || s.sources.size >= 2) return;
      queueSegment(s, buf, s.next, false);
      s.next += seg - CROSS;
    };
    return seg;
  }

  async function playMusic() {
    if (!ensure()) return;
    const buf = await load(MUSIC_FILE);
    if (!buf || session) return;
    const t = ctx.currentTime + 0.05, s = { gain: ctx.createGain(), sources: new Set(), dead: false, next: 0 };
    s.gain.gain.setValueAtTime(0, t);
    s.gain.gain.linearRampToValueAtTime(1, t + FADE_IN);
    s.gain.connect(musicBus);
    session = s;
    const seg = buf.duration - TAIL;
    queueSegment(s, buf, t, true);
    s.next = t + seg - CROSS;
    queueSegment(s, buf, s.next, false);
    s.next += seg - CROSS;
  }

  function pauseMusic() {
    const s = session; if (!s) return;
    session = null; s.dead = true;
    const t = ctx.currentTime;
    s.gain.gain.cancelScheduledValues(t);
    s.gain.gain.setValueAtTime(s.gain.gain.value, t);
    s.gain.gain.linearRampToValueAtTime(0, t + FADE_OUT);
    setTimeout(() => { for (const src of s.sources) try { src.stop(); } catch {} s.gain.disconnect(); }, FADE_OUT * 1000 + 100);
  }

  // Rain on the window: a soft loop on the effects bus while it rains, faded in and out.
  async function applyRain() {
    if (!ctx) return;
    if (rainWanted && !rain) {
      const buf = await load(RAIN_FILE);
      if (!buf || !rainWanted || rain) return;
      const src = ctx.createBufferSource(), gain = ctx.createGain(), t = ctx.currentTime;
      src.buffer = buf; src.loop = true;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(10 ** ((AMBIENT_TARGET - RAIN_LUFS) / 20), t + AMBIENT_FADE);
      src.connect(gain); gain.connect(effectsBus); src.start(t);
      rain = { src, gain };
    } else if (!rainWanted && rain) {
      const { src, gain } = rain, t = ctx.currentTime; rain = null;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + AMBIENT_FADE);
      try { src.stop(t + AMBIENT_FADE + 0.05); } catch {}
    }
  }

  function setBus(bus, v) { if (bus) bus.gain.setTargetAtTime(v, ctx.currentTime, 0.02); }

  return {
    get musicPlaying() { return !!session; },
    get musicVolume() { return volumes.music; },
    get effectsVolume() { return volumes.effects; },
    unlock() {
      if (!ensure()) return;
      if (wantClip && !active) applyClip();
      applyRain();
    },
    setRain(on) {
      if (!!on === rainWanted) return;
      rainWanted = !!on;
      applyRain();
    },
    play(name) { if (ctx || ensure()) playSfx(name); },
    onClip(name) {
      if (name === wantClip) return;
      wantClip = name;
      applyClip();
    },
    setMusicVolume(v) { volumes.music = unit(v, volumes.music); setBus(musicBus, volumes.music); save(); },
    setEffectsVolume(v) { volumes.effects = unit(v, volumes.effects); setBus(effectsBus, volumes.effects); save(); },
    async toggleMusic() {
      if (!Ctor) return false;
      if (session) pauseMusic(); else await playMusic();
      return !!session;
    },
  };
}

