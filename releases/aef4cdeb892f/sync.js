// Cross-device sync (docs/SYNC.md): push each committed save to the sync Worker, pull newer ones, and ask which copy to keep on a conflict.
// The sync code is 128 random bits shown as Crockford base32. It only travels in the Authorization header and in a link's #fragment.
import { readSync, writeSync } from "./storage.js";
import { packVisitBackup, unpackVisitBackup } from "./outings.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newSyncCode() {
  let acc = 0, bits = 0, out = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(acc >> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  return out + ALPHABET[(acc << 2) & 31];  // 25 characters carry 125 bits; the 26th carries 3 more and 2 zero bits
}
export function parseSyncCode(text) {
  const code = String(text ?? "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(code) && ALPHABET.indexOf(code[25]) % 4 === 0 ? code : null;
}
export const formatSyncCode = (code) => code.match(/.{1,4}/g).join("-");

const b64 = (bytes) => { let text = ""; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text); };
export function encodeSave({ data, spent, deadline, facings }) {
  return JSON.stringify({ v: 1, save: b64(packVisitBackup(data, spent)), deadline: deadline ?? null, facings: facings ?? {} });
}
export function decodeSave(text) {
  const raw = JSON.parse(text);
  if (raw?.v !== 1 || typeof raw.save !== "string") throw new Error("Unknown save format.");
  const { data, spent } = unpackVisitBackup(Uint8Array.from(atob(raw.save), (c) => c.charCodeAt(0)));
  return { data, spent, deadline: raw.deadline ?? null, facings: raw.facings ?? {} };
}
export function deviceName(agent = globalThis.navigator?.userAgent ?? "") {
  return /iPhone/.test(agent) ? "iPhone" : /iPad/.test(agent) ? "iPad" : /Android/.test(agent) ? "Android" : /Macintosh/.test(agent) ? "Mac" : /Windows/.test(agent) ? "Windows PC" : /Linux/.test(agent) ? "Linux" : "Browser";
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
export function ago(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${plural(Math.floor(minutes / 1440), "day")} ago`;
}

// host: { $, reveal(), url, db, device, ready(), viewOnly(), canApply(), local(), pristine(data), summarize(save|null), apply(save), say(text) }
// local() is the committed generation: { revision, data, spent, deadline, facings }.
export function createSync(host) {
  const { $, url, db } = host;
  let s = null, status = url ? "off" : "unavailable", detail = "", conflict = null, running = null, queued = false, timer = null, muted = false, started = false;
  const endpoint = url.replace(/\/+$/, "") + "/home";
  const persist = () => writeSync(db, s);
  const note = (text) => { $("sync-message").textContent = text; };

  // Unsynced: committed since the last sync AND different from what was synced. A reload re-commits identical bytes, which is not new work.
  function unsynced(local) {
    if (s.syncedData === null) return !host.pristine(local.data);
    return local.revision > s.syncedRevision && encodeSave(local) !== s.syncedData;
  }
  const request = (method, body) => fetch(endpoint, {
    method, cache: "no-store",
    headers: { Authorization: `Bearer ${s.code}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const failure = (response) => Object.assign(new Error(response.status === 401 ? "That sync code was not accepted." : response.status === 429 ? "Syncing too often. Trying again soon." : "The sync server had a problem. Trying again soon."), { http: response.status });

  function render() {
    const on = !!s, ready = status !== "unavailable";
    $("sync-state").textContent = status === "unavailable" ? "Sync isn't set up yet"
      : host.viewOnly() ? "Sync runs in the other tab"
      : status === "syncing" ? "Syncing…"
      : status === "offline" ? "Offline · will sync when you're back"
      : status === "conflict" ? "Needs a choice"
      : status === "error" ? detail
      : on && s.lastSyncedAt ? `Synced ${ago(Date.now() - s.lastSyncedAt)}` : on ? "Syncing…" : "Sync is off";
    $("sync-setup").hidden = on || !ready;
    $("sync-active").hidden = !on;
    $("sync-conflict").hidden = !conflict;
    $("sync-help").hidden = !ready;
    $("sync-on").disabled = $("sync-join").disabled = !ready || host.viewOnly();
    if (!on) { $("sync-code-text").hidden = true; }
    if (conflict) {
      const mine = host.summarize(null), theirs = conflict.summary;
      const describe = (x) => x ? `${plural(x.coins, "coin")}, ${plural(x.tasks, "task")}` : "progress that could not be read";
      $("sync-conflict-mine").textContent = `This device: ${describe(mine)}`;
      $("sync-conflict-theirs").textContent = `Other device (${conflict.remote.device}, ${ago(Date.now() - conflict.remote.updated_at)}): ${describe(theirs)}`;
    }
  }
  const set = (next, text = "") => { status = next; detail = text; render(); };

  function fail(error) {
    if (error?.name === "TypeError") return set("offline");  // fetch rejects with TypeError when there is no network
    set("error", error.message || "Sync could not finish.");
    if (error.http === 401) note("Check the code, or turn sync off and join again.");
    else retryLater(30000);
  }
  function retryLater(ms) { clearTimeout(timer); timer = setTimeout(() => void turn(cycle), ms); }

  async function turn(job) {
    if (!s || !started || running) { if (running) queued = true; return; }
    if (!host.ready() || host.viewOnly() || conflict) return;
    running = (async () => { try { await job(); } catch (error) { if (s) fail(error); } })();
    await running; running = null;
    if (queued) { queued = false; await turn(cycle); }
  }
  async function finish(remoteRevision, local, data) {
    Object.assign(s, { serverRevision: remoteRevision, syncedRevision: local.revision, syncedData: data, lastSyncedAt: Date.now(), joining: false });
    await persist(); set("idle");
  }
  async function push(base) {
    const local = host.local(), data = encodeSave(local);
    const response = await request("PUT", { base, data, device: host.device });
    if (response.ok) { await finish((await response.json()).revision, local, data); return; }
    if (response.status !== 409) throw failure(response);
    const { current } = await response.json();
    if (!current) { s.serverRevision = 0; return push(0); }  // the server lost the home: upload it again
    await reconcile(current);
  }
  async function cycle() {
    if (!s.lastSyncedAt || status !== "idle") set("syncing");
    const response = await request("GET");
    if (response.status === 404) {
      if (s.joining) { s = null; await persist(); set("off"); note("No home found for that code. Check it and try again."); return; }
      s.serverRevision = 0; return push(0);
    }
    if (!response.ok) throw failure(response);
    await reconcile(await response.json());
  }
  async function reconcile(remote) {
    const local = host.local(), dirty = unsynced(local);
    if (remote.revision === s.serverRevision) {
      if (dirty) return push(remote.revision);
      s.lastSyncedAt = Date.now();  // nothing new either way: only a re-committed identical save moves the mark, and that is worth one write
      if (s.syncedRevision !== local.revision) { s.syncedRevision = local.revision; await persist(); }
      return set("idle");
    }
    if (!dirty) return take(remote);
    if (!host.canApply()) return retryLater(3000);  // the choice needs the game quiet: summarizing a save borrows the core
    let save = null;
    try { save = decodeSave(remote.data); } catch {}
    conflict = { remote, save, summary: save && host.summarize(save) };
    set("conflict");
    host.reveal();
  }
  // Apply a newer remote copy; the host keeps its focus deadline, so a timer started elsewhere keeps running.
  async function take(remote) {
    if (!host.canApply()) return retryLater(3000);
    let save;
    try { save = decodeSave(remote.data); } catch { throw new Error("The other device's save could not be read."); }
    muted = true;
    try { await host.apply(save); } finally { muted = false; }
    const local = host.local();
    await finish(remote.revision, local, encodeSave(local));
    host.say(`Updated from your other device (${remote.device}).`);
  }
  async function resolve(mine) {
    if (!conflict || running) return;
    const { remote, save } = conflict;
    if (!mine && !save) { note("That save can't be read here. Keep this device's instead."); return; }
    if (!mine && !host.canApply()) { note("Finish what Zucchini is doing, then choose again."); return; }
    conflict = null; note("");
    running = (async () => { try { await (mine ? push(remote.revision) : take(remote)); } catch (error) { if (s) fail(error); } })();
    await running; running = null;
  }

  function schedulePush() {
    if (!s || !started || muted || host.viewOnly()) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (s?.joining || !s?.serverRevision) void turn(cycle); else void turn(() => { set("syncing"); return push(s.serverRevision); }); }, 2000);
  }
  const pull = () => { if (s && !document.hidden) void turn(cycle); };

  async function begin(code, joining) {
    s = { code, serverRevision: 0, syncedRevision: 0, syncedData: null, lastSyncedAt: 0, joining };
    await persist(); render();
    await turn(cycle);
  }
  async function turnOn() { if (!s) await begin(newSyncCode(), false); note("Sync is on. Use Copy link to set up your other device."); }
  async function join(text) {
    const code = parseSyncCode(text);
    if (!code) { note("That code doesn't look right. It has 26 letters and numbers."); return false; }
    if (s) { note(s.code === code ? "This device already uses that code." : "This device already syncs with another home. Turn sync off first."); return false; }
    $("sync-join-form").hidden = true; $("sync-code-input").value = "";
    note("Joining…"); await begin(code, true);
    if (s) note("");
    return true;
  }
  async function turnOff() {
    clearTimeout(timer); conflict = null; s = null; await writeSync(db, null); set("off");
    $("sync-code-text").hidden = true; note("Sync is off on this device. Your saved home stays on the sync server.");
  }
  async function copyLink() {
    const link = `${location.origin}${location.pathname}#sync=${s.code}`;
    try { await navigator.clipboard.writeText(link); note("Link copied. Open it on your other device."); }
    catch { $("sync-code-text").hidden = false; $("sync-code-text").textContent = link; note("Copy this link and open it on your other device."); }
  }

  $("sync-on").addEventListener("click", () => void turnOn());
  $("sync-join").addEventListener("click", () => { $("sync-join-form").hidden = false; $("sync-code-input").focus(); });
  $("sync-join-cancel").addEventListener("click", () => { $("sync-join-form").hidden = true; });
  $("sync-join-form").addEventListener("submit", (e) => { e.preventDefault(); void join($("sync-code-input").value); });
  $("sync-copy").addEventListener("click", () => void copyLink());
  $("sync-show").addEventListener("click", () => {
    const hidden = !$("sync-code-text").hidden;
    $("sync-code-text").hidden = hidden; $("sync-code-text").textContent = hidden ? "" : formatSyncCode(s.code);
    $("sync-show").textContent = hidden ? "Show code" : "Hide code";
  });
  $("sync-off").addEventListener("click", () => void turnOff());
  $("sync-keep-mine").addEventListener("click", () => void resolve(true));
  $("sync-keep-theirs").addEventListener("click", () => void resolve(false));
  addEventListener("online", pull);
  document.addEventListener("visibilitychange", pull);
  setInterval(() => { render(); pull(); }, 60000);

  return {
    changed: schedulePush,
    pull,
    // Reads the saved settings, joins from a #sync= link when one is open, then does the first pull.
    async start() {
      render();
      if (!url) return;
      s = await readSync(db).catch(() => null);
      started = true;
      render();
      if (s) void turn(cycle);
    },
    async joinFromLink(hash) {
      const text = /^#sync=([^&]*)/.exec(hash)?.[1];
      if (text === undefined) return;
      history.replaceState(null, "", location.pathname + location.search);
      host.reveal();
      if (!url) { note("This link is for syncing devices, but sync isn't set up yet."); return; }
      if (host.viewOnly()) { note("Zucchini is open in another tab. Close it, then open the link again."); return; }
      await join(decodeURIComponent(text));
    },
    state: () => ({ status, conflict: !!conflict, on: !!s, code: s?.code ?? null }),
  };
}
