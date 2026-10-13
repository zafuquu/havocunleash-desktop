/**
 * GEP renderer host — runs inside a hidden BrowserWindow with nodeIntegration.
 *
 * The downloaded GEP package (packages/gep/<ver>/extracted/index.js) is built
 * for an Electron RENDERER: it loads the native plugin via window.require and
 * needs a live message pump for the native callbacks. Running it here gives
 * the full GepPackage API (getFeatures / setRequiredFeatures / getInfo /
 * game-detected / new-info-update / new-game-event) — exactly what the
 * original HAVOC runtime uses.
 */
const { ipcRenderer } = require("electron");
const path = require("path");

// gepDir arrives either via the ?gepDir= query (file:// mode) or injected by
// the host main process as window.__GEP_DIR__ (data-URL mode).
const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
const gepDir = params.get("gepDir") || (typeof window !== "undefined" && window.__GEP_DIR__) || "";
const log = (msg) => {
  try { ipcRenderer.send("gep-log", String(msg).slice(0, 500)); } catch { /* ignore */ }
};
const jsonSafe = (value) => {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "object") {
    try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
  }
  return String(value);
};
const send = (kind, payload) => {
  try { ipcRenderer.send("gep-event", { kind, payload: payload ?? null }); } catch { /* ignore */ }
};

/** Valorant-relevant features (same filter as the parent's addon mode). */
const FEATURE_RE = /kill|death|match|round|score|spike|agent|ability|ult|roster|team|health|weapon|money|phase|map/i;

async function setFeatures(gep, gameId) {
  try {
    const all = await gep.getFeatures(gameId);
    const wanted = Array.isArray(all) ? all.filter((f) => FEATURE_RE.test(f)) : [];
    const features = wanted.length > 0 ? wanted : (Array.isArray(all) ? all : undefined);
    await gep.setRequiredFeatures(gameId, features);
    send("features-set", { gameId, features: features ?? null });
    log(`features set for ${gameId}: ${(features ?? []).length}`);
    return true;
  } catch (err) {
    send("gep-error", `setRequiredFeatures failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function dumpInfo(gep, gameId) {
  try {
    const info = await gep.getInfo(gameId);
    if (info != null) send("info-dump", info);
  } catch { /* ignore */ }
}

function boot() {
  if (!gepDir) throw new Error("no gepDir query parameter");
  process.chdir(gepDir);
  log(`renderer boot, gepDir=${gepDir}`);
  const mod = require(path.join(gepDir, "index.js"));
  const gep = mod.init();
  log(`GepPackage created: type=${typeof gep} keys=[${Object.keys(gep ?? {}).join(",")}] proto=[${Object.getOwnPropertyNames(Object.getPrototypeOf(gep ?? {})).join(",")}]`);

  gep.on("game-detected", async (_ev, gameId) => {
    log(`game-detected: ${gameId}`);
    send("game-detected", { gameId });
    // Features can take a few seconds to become available after detection.
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      if (await setFeatures(gep, gameId)) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    dumpInfo(gep, gameId);
  });
  // Event kinds + payload shapes MUST match the parent's protocol:
  //   info-update -> gep-capture case "info-update" with payload {gameId,...item}
  //   game-event  -> case "game-event" with the same shape. (The bare-addon
  //   mode spreads the GEP item into the payload the same way.)
  gep.on("new-info-update", (_ev, gameId, data) => send("info-update", { gameId, ...jsonSafe(data) }));
  gep.on("new-game-event", (_ev, gameId, data) => send("game-event", { gameId, ...jsonSafe(data) }));
  gep.on("game-exit", (_ev, gameId) => send("game-exit", { gameId }));
  gep.on("elevated-privileges-required", () => send("elevated-privileges-required", {}));
  gep.on("error", (err) => send("gep-error", err instanceof Error ? err.message : String(err)));
  log("renderer ready — waiting for game detection");
}

try {
  boot();
} catch (err) {
  log(`boot failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
}