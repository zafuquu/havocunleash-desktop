/**
 * GEP renderer host — runs inside a hidden BrowserWindow with nodeIntegration.
 *
 * The downloaded GEP package (packages/gep/<ver>/extracted/index.js) is built
 * for an Electron RENDERER (window.require + message pump). Running it here
 * gives the full GepPackage API — exactly what the original HAVOC runtime gets
 * through ow-electron's PackageManager, which is unavailable without the
 * Overwolf client, so we emulate the PM contract ourselves:
 *
 *   package.init()           -> GepPackage (own tsyringe DI container inside)
 *   package.start(services)  -> services = the PM-provided object
 *                               { ipc, logger, sentry, analytics }.
 *   We implement `ipc` (the package IPC service): the package invokes ALL
 *   app-facing events via ipc.invokeMessage(event, isEvent, ...args)
 *   (GepApiEvents: new-info-update / new-game-event / game-detected /
 *   game-exit / elevated-privileges-required / error) and registers the app
 *   API (setRequiredFeatures / getFeatures / getInfo) as listeners ON it —
 *   our shim receives the events and can invoke the API listeners.
 *
 * Internals (reverse-engineered from the 315.3.4 bundle):
 *   GepPackage.start -> initializeRegistries(services) [registers ipc/sentry/
 *   logger/analytics instances + OweGepRegistry/MonitorRegistry/GamesHandlers]
 *   -> GameStatusService.init() -> GamesService.start(). All real work happens
 *   in OweGamesService's CONSTRUCTOR: game detection via the PM's shared
 *   utility service when present (our shim omits it) else the plugin's own
 *   process monitor, which loads ow-electron-gep-plugin.node through
 *   GepPluginLoader.load() = window.require(path.join(__dirname, plugin)).
 *   webpack mangles __dirname in an http:// page, so we remap ANY require
 *   ending in the plugin filename to the extracted package dir. The package
 *   also reads the Overwolf app uid from the --uid command-line switch
 *   (normally injected by the PM) — we inject it before start().
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

// ---------------------------------------------------------------------------
// Plugin path remap: GepPluginLoader.load() does
//   window.require(path.join(__dirname, "ow-electron-gep-plugin.node"))
// and webpack mangles __dirname in an http:// renderer ("/", mocked). Catch
// ANY require whose id ends in the plugin file name; point it at the extracted
// package dir. Everything else passes through unchanged.
// ---------------------------------------------------------------------------
const realRequire = window.require;
// gameId fallback for the raw addon connect(). The PM's shared utility
// service normally supplies options.gameId to the plugin service; our shim
// omits it, so the package called plugin.gep.connect(undefined, pid, ...)
// and the addon rejected it ("Expected first argument to be game id
// (number)") — live 2026-10-17 harness. Map the DETECTED PROCESS NAME to
// the known game id (production ground truth: the real runtime polls
// VALORANT-Win64-Shipping and connects 21640). Unknown processes pass
// through untouched — never invent an id for a game we do not track.
const GAME_ID_BY_PROCESS = {
  "valorant-win64-shipping": 21640,
};
const wrapAddonModule = (mod) => {
  try {
    const gep = mod && mod.gep;
    if (gep && typeof gep.connect === "function" && !gep.__huGameIdWrapped) {
      const orig = gep.connect.bind(gep);
      gep.connect = (gameId, pid, processName, options) => {
        let gid = gameId;
        if (typeof gid !== "number" || !Number.isFinite(gid)) {
          const mapped = GAME_ID_BY_PROCESS[String(processName || "").toLowerCase()];
          if (mapped != null) {
            gid = mapped;
            log(`addon connect: gameId was ${String(gameId)} -> ${gid} (pid=${pid} process=${processName})`);
          } else {
            log(`addon connect: gameId ${String(gameId)} unmapped, passing through (pid=${pid} process=${processName})`);
          }
        }
        return orig(gid, pid, processName, options);
      };
      gep.__huGameIdWrapped = true;
    }
  } catch (err) {
    log(`addon connect wrap failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return mod;
};
window.require = (id) => {
  if (typeof id === "string" && id.endsWith("ow-electron-gep-plugin.node")) {
    const remapped = path.join(gepDir, "ow-electron-gep-plugin.node");
    log(`plugin require remapped: ${id} -> ${remapped}`);
    return wrapAddonModule(realRequire(remapped));
  }
  return realRequire(id);
};

// ---------------------------------------------------------------------------
// Game status fetch interception: the package fetches
//   https://game-events-status.overwolf.com/gamestatus_prod.json
// through the page's global fetch. From http://127.0.0.1 that cross-origin
// request fails (CORS), GameStatusService returns null, and
// gameStatusDisabled() returns true for EVERY game — which silently skips
// plugin injection AND the game-detected event (info updates still flow,
// which is exactly the half-broken state observed live on 2026-10-16).
// Try the real fetch first; on any failure fall back to a permissive local
// status list for the game we capture.
// ---------------------------------------------------------------------------
const realFetch = window.fetch.bind(window);
const SYNTHETIC_GAME_STATUS = [
  {
    game_id: 21640, // VALORANT
    state: 1,
    disabled: false,
    disabled_electron: false,
    is_vgep: false,
    min_gep_version: "1.1.1",
    min_gep_version_electron: "1.1.1",
    vgep_prefix: "",
  },
];
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : String((input && input.url) || "");
  if (url.includes("game-events-status.overwolf.com")) {
    // Serve SYNCHRONOUSLY: even when the live fetch succeeds (CORS allows it),
    // gameStatusDisabled() runs ~1s after boot — before init()'s network round
    // trip resolves — and a null status disables injection + game-detected.
    // Determinism beats freshness here; re-runs re-fetch on provider restart.
    log("game status: serving synthetic status (instant)");
    return new Response(JSON.stringify(SYNTHETIC_GAME_STATUS), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input, init);
};

// --uid switch: OweGamesService reads the Overwolf app uid via
// CommandLineUtil.getSwitchValueSafe('uid') — normally injected by the PM.
if (!process.argv.some((a) => a === "--uid" || (typeof a === "string" && a.startsWith("--uid=")))) {
  const uid = process.env.OVERWOLF_APP_UID || "mkcfiniehcpkhplpahgeepbdpjophjei";
  process.argv.push("--uid", uid);
  log(`injected --uid ${uid}`);
}

// ---------------------------------------------------------------------------
// Package IPC shim — we ARE the PackageManager's app bridge. The package's
// GepIpcService calls ipc.invokeMessage(event, isEvent, ...args) to emit app
// events and registers 'setRequiredFeatures'/'getFeatures'/'getInfo' listeners
// on the same object (registerApi).
// ---------------------------------------------------------------------------
const EventEmitter = realRequire("events");
// Proven Valorant set — the EXACT handler auto-default the package sets on
// session start (onRequiredFeaturesChanged: ["game_info","me","match_info",
// "kill","death","gep_internal"]). The previous narrower set (3 features)
// REPLACED those defaults via setRequiredFeatures, so kill/death EVENTS
// (killfeed -> site KillBanner/ace tracking) could never arrive. Do not
// request the full getFeatures() list (can be rejected wholesale), but the
// handler's own default set is proven-good.
const VALORANT_FEATURES = ["game_info", "match_info", "me", "kill", "death", "gep_internal"];

// Async API call plumbing: package handlers reply via ipcService.send(callback,
// payload) where `callback` is the first handler argument — we mint a token per
// call and resolve the matching promise when the reply arrives.
let cbSeq = 0;
const pendingReplies = new Map();

class PackageIpcShim extends EventEmitter {
  /** package -> app event pipe. Returning true = "not vetoed" (gameLaunch). */
  invokeMessage(event, isEvent, ...args) {
    try {
      forwardGepEvent(event, args);
    } catch (err) {
      log(`forward failed (${event}): ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  /** app -> package API call: invoke the listeners the package registered. */
  emitApiCall(name, ...args) {
    const handlers = this.listeners(name);
    for (const handler of handlers) {
      try {
        handler({}, ...args);
      } catch (err) {
        log(`api call failed (${name}): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    }
    return handlers.length;
  }

  /** PM contract: GepPackageV2IpcService does packageIpc.registerApi(this._api).
   *  The real PM would proxy these to the parent; nothing in our parent calls
   *  them (V2 consumers use .api directly), so capture and return it. */
  registerApi(api) {
    this.api = api;
    log("registerApi: captured package V2 api");
    return api;
  }

  /** PM contract: async API handlers reply with send(callbackToken, payload). */
  send(callback, payload) {
    const key = callback == null ? "" : String(callback);
    const resolve = pendingReplies.get(key);
    if (resolve) {
      pendingReplies.delete(key);
      resolve(payload);
      return true;
    }
    log(`ipc.send (no waiter): cb=${key} payload=${JSON.stringify(payload ?? null).slice(0, 200)}`);
    return true;
  }
}

let activeIpc = null;

function forwardGepEvent(event, args) {
  const gameId = args[0];
  switch (event) {
    case "new-info-update":
      send("info-update", { gameId, ...jsonSafe(args[1]) });
      return;
    case "new-game-event":
      send("game-event", { gameId, ...jsonSafe(args[1]) });
      return;
    case "game-detected":
      log(`game-detected: gameId=${gameId} name=${args[1] ?? "?"}`);
      send("game-detected", { gameId });
      requestFeatures(gameId);
      return;
    case "game-exit":
      send("game-exit", { gameId });
      return;
    case "elevated-privileges-required":
      send("elevated-privileges-required", {});
      return;
    case "error":
      send("gep-error", `package: ${args.slice(1).map(String).join(" ")}`);
      return;
    default:
      // Reply events (getFeatures/getInfo responses) land here for diagnosis.
      log(`ipc event ${event} args=${JSON.stringify(args).slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Feature registration + initial state dump (mid-match start renders a board).
// API handlers are async and reply through send(callback, payload), so drive
// them with promise-based apiCall() and retry until the game handler attaches.
// ---------------------------------------------------------------------------
let featuresRequestedFor = null;

function apiCall(name, ...args) {
  if (!activeIpc) return Promise.resolve({ success: false, error: "no ipc" });
  const cb = `cb-${++cbSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingReplies.delete(cb)) {
        log(`api ${name} timed out`);
        resolve({ success: false, error: "timeout" });
      }
    }, 8_000);
    pendingReplies.set(cb, (payload) => {
      clearTimeout(timer);
      log(`api ${name} reply: ${JSON.stringify(payload ?? null).slice(0, 300)}`);
      resolve(payload ?? { success: true });
    });
    const n = activeIpc.emitApiCall(name, cb, ...args);
    if (n === 0) {
      clearTimeout(timer);
      pendingReplies.delete(cb);
      resolve({ success: false, error: "no handler registered" });
    }
  });
}

function requestFeatures(gameId) {
  if (featuresRequestedFor === gameId) return;
  featuresRequestedFor = gameId;
  void (async () => {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      // Evidence log: what features does the handler actually offer for this
      // game? (Answers "is the default set missing kill/roster/round...?" —
      // see DATA-SYNC.md §1.) Failure here is non-fatal: we still try the set.
      const avail = await apiCall("getFeatures", gameId);
      log(`getFeatures(${gameId}): ${JSON.stringify(avail ?? null).slice(0, 600)}`);
      const reply = await apiCall("setRequiredFeatures", gameId, VALORANT_FEATURES);
      if (reply && reply.success) {
        send("features-set", { gameId, features: VALORANT_FEATURES, source: "renderer-host" });
        const info = await apiCall("getInfo", gameId);
        if (info && info.success && info.data != null) send("info-dump", info.data);
        return;
      }
      log(`setRequiredFeatures attempt ${attempt} failed: ${JSON.stringify(reply ?? null)}`);
      if (reply && typeof reply.error === "string" && reply.error.includes("not supported")) return;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  })();
}

function boot() {
  if (!gepDir) throw new Error("no gepDir query parameter");
  process.chdir(gepDir);
  log(`renderer boot, gepDir=${gepDir} pid=${process.pid}`);

  const ipc = new PackageIpcShim();
  activeIpc = ipc;
  // Absorb-any-method shims: package consumers call analytics/sentry methods
  // we cannot fully enumerate (sendAnalytic crashed Valorant game start),
  // so proxy every unknown method to a logged no-op. Logger keeps its explicit
  // levels (return-sensitive) with the same proxy as a safety net.
  const makeNoopShim = (label) =>
    new Proxy(
      {},
      {
        get: (target, prop) => {
          if (typeof prop !== "string") return target[prop];
          if (!(prop in target)) {
            target[prop] = (...args) => {
              log(`${label}.${prop}(${String(args[0] ?? "").slice(0, 120)})`);
              return undefined;
            };
          }
          return target[prop];
        },
      },
    );
  const loggerBase = {
    info: (...a) => log(`pkg: ${a.map(String).join(" ")}`),
    warn: (...a) => log(`pkg-warn: ${a.map(String).join(" ")}`),
    error: (...a) => log(`pkg-error: ${a.map(String).join(" ")}`),
    debug: () => {},
    trace: () => {},
  };
  const loggerShim = new Proxy(loggerBase, {
    get: (target, prop) => {
      if (typeof prop === "string" && !(prop in target)) {
        return (...args) => log(`pkg.${prop}(${String(args[0] ?? "").slice(0, 120)})`);
      }
      return target[prop];
    },
  });
  loggerBase.child = () => loggerShim;

  const services = {
    ipc,
    logger: loggerShim,
    sentry: makeNoopShim("sentry"),
    analytics: makeNoopShim("analytics"),
  };

  const mod = realRequire(path.join(gepDir, "index.js"));
  const gep = mod.init();
  log(`GepPackage created: type=${typeof gep} proto=[${Object.getOwnPropertyNames(Object.getPrototypeOf(gep ?? {})).join(",")}]`);

  log("calling gep.start(services)");
  try {
    gep.start(services);
    log("gep.start() returned — provider armed, waiting for game detection");
  } catch (err) {
    log(`gep.start failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    throw err;
  }
  // Event kinds + payload shapes MUST match the parent's protocol:
  //   info-update -> gep-capture case "info-update" with payload {gameId,...item}
  //   game-event  -> case "game-event" with the same shape — handled by
  //   forwardGepEvent() above (the package pipes everything through
  //   services.ipc.invokeMessage, not EventEmitter.on()).
  send("provider-ready", { source: "renderer-host", api: "package-start" });
}

try {
  boot();
} catch (err) {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log(`boot failed: ${msg}`);
  // Hard failure — same contract as "loadURL failed": parent relaunches the
  // fallback (node/bare addon) mode instead of idling in provider_error.
  try {
    ipcRenderer.send("gep-failure", `renderer boot failed: ${err instanceof Error ? err.message : String(err)}`);
  } catch { /* ignore */ }
}