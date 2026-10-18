/**
 * Havoc GEP provider child.
 *
 * Runs under @overwolf/ow-electron's electron.exe (NOT plain node/electron):
 * ow-electron augments `app.overwolf` with the Overwolf Package Manager, which
 * downloads/updates the GEP (Game Events Provider) package exactly like the
 * original HAVOC `havoc-game-data-runtime.exe` does.
 *
 * Protocol (stdout, NDJSON, v1 — mirrors the audited original):
 *   {"type":"ready","protocolVersion":1}
 *   {"type":"event","kind":"info-update","payload":{...gep.InfoUpdate}}
 *   {"type":"event","kind":"game-event","payload":{...gep.GameEvent}}
 *   {"type":"event","kind":"game-detected","payload":{"gameId":N}}
 *   {"type":"event","kind":"game-exit","payload":{"gameId":N}}
 *   {"type":"event","kind":"elevated-privileges-required","payload":{}}
 *   {"type":"event","kind":"gep-error","payload":"..."}
 *   {"type":"event","kind":"info-dump","payload":{...getInfo() result}}
 *   {"type":"failure","reason":"..."}
 */
"use strict";

const { app } = require("electron");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const PROTOCOL_VERSION = 1;

/** GEP features relevant to the Valorant HUD (intersected with what the game supports). */
const FEATURE_RE = /^(game_info|match_info|kill|death|assist|roster|team|score|scoreboard|observing|spike)/i;

/**
 * Overwolf's documented Valorant feature set (ValoSpectra ships exactly this,
 * see Spectra-Client setRequiredFeaturesValorant). These three features carry
 * every fact the HUD needs — roster_*, scoreboard_*, kill_feed, round_phase,
 * round_number, match_score, scene, map, game_mode, match_id, player_*.
 *
 * Requesting the full getFeatures() list instead can make GEP reject the whole
 * registration (one unsupported name fails the call), which shows up as a HUD
 * that never receives data. Prefer the known-good set and only fall back to a
 * filtered discovery list when the game reports something narrower.
 */
const VALORANT_FEATURES = ["game_info", "match_info", "me"];

// ---------------------------------------------------------------------------
// Transport: stdout by default. When launched with `--session <file>` (the
// original's elevated-launch design) the parent cannot read our stdout, so we
// connect BACK to its named pipe and authenticate with the session token.
// ---------------------------------------------------------------------------
let transport = process.stdout;
let transportQueue = [];
let transportOpen = true; // stdout mode is open immediately; session mode queues until the pipe connects.

function writeLine(msg) {
  try {
    transport.write(JSON.stringify(msg) + "\n");
  } catch {
    /* parent gone — child will exit shortly */
  }
}

function send(msg) {
  if (transportOpen) {
    writeLine(msg);
    return;
  }
  transportQueue.push(msg);
  // Bounded queue: drop stale messages if the parent never connects.
  if (transportQueue.length > 500) transportQueue.shift();
}

function setupSessionTransport() {
  const sessionArgIdx = process.argv.indexOf("--session");
  const sessionPath = sessionArgIdx >= 0 ? process.argv[sessionArgIdx + 1] : null;
  if (!sessionPath) return;
  let session;
  try {
    session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  } catch (err) {
    process.stderr.write(`session file unreadable: ${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }
  if (!session || typeof session.pipeName !== "string" || typeof session.token !== "string") {
    process.stderr.write("session file missing pipeName/token\n");
    return;
  }
  // UAC elevation does not reliably propagate environment variables, so the
  // parent passes runtime settings through the session file (same reason the
  // original used a session file for its elevated host).
  global.__session = session;
  // Switch to pipe transport: queue messages until the pipe is open.
  transportOpen = false;
  transport = null;
  const socket = net.connect(session.pipeName, () => {
    transport = socket;
    transportOpen = true;
    socket.write(JSON.stringify({ type: "hello", token: session.token }) + "\n");
    const queued = transportQueue;
    transportQueue = [];
    for (const msg of queued) writeLine(msg);
  });
  socket.on("error", (err) => {
    process.stderr.write(`pipe error: ${err.message}\n`);
    process.exit(3);
  });
  socket.on("close", () => process.exit(3));
  // Parent may send a shutdown command over the same pipe.
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line.startsWith("{")) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "shutdown") process.exit(0);
          if (msg.type === "command") handleCommand(msg);
        } catch { /* ignore malformed */ }
      }
      newline = pending.indexOf("\n");
    }
  });
}

/** Executes one parent command over the pipe. */
function handleCommand(msg) {
  const requestId = String(msg.requestId ?? "");
  const name = String(msg.name ?? "");
  if (!requestId) return;
  if (name === "socket-reset") {
    let result;
    try {
      const reset = require("./socket-reset");
      const koffiPath = msg.payload?.koffiPath || global.__session?.koffiPath || process.env.KOFFI_PATH;
      result = reset.attemptValorantSocketReset({
        koffiPath,
        targetProcessId: msg.payload?.targetProcessId ?? null,
      });
    } catch (err) {
      result = {
        aliasesFound: [],
        closeAttempts: [],
        error: null,
        removedRows: [],
        scanStats: null,
        summary: {
          afterRowCount: null,
          beforeRowCount: null,
          closeAttemptCount: 0,
          removedRowCount: 0,
          status: "failed",
          targetProcessId: null,
        },
        failure: err instanceof Error ? err.message : String(err),
      };
    }
    send({ type: "event", kind: "command-result", payload: { requestId, name, result } });
    return;
  }
  if (name === "connect-game") {
    // Parent-detected attach: VALORANT was already running when the provider
    // started, so the process monitor will never fire — connect explicitly.
    const gameId = Number(msg.payload?.gameId);
    const pid = Number(msg.payload?.pid);
    const gname = String(msg.payload?.name ?? "game");
    let error = null;
    try {
      if (!Number.isFinite(gameId) || gameId <= 0) throw new Error("bad gameId");
      const plugin = global.__gepPlugin;
      if (!plugin?.gep?.connect) throw new Error("GEP plugin not initialized");
      global.__debugLog?.(`connect-game: gep.connect(${gameId}, ${pid}, VALORANT, {oop:false})`);
      // oop:false = in-process host. oop:true requires an Electron OOP host
      // (host.js uses Electron's app) that cannot run outside ow-electron's
      // own provider machinery — it rejects with "start-error".
      plugin.gep.connect(gameId, Number.isFinite(pid) ? pid : 0, gname, { oop: false })
        ?.then?.((v) => global.__debugLog?.(`connect resolved: ${JSON.stringify(v)?.slice(0, 120)}`))
        ?.catch?.((err) => global.__debugLog?.(`connect rejected: ${JSON.stringify(err) ?? String(err)}`));
      sendEvent("connect-attempted", { gameId, pid: Number.isFinite(pid) ? pid : 0, name: gname, source: "parent-command" });
      // NOTE: no attachGame() here — getFeatures/setRequiredFeatures belong to
      // the extracted package API, not the raw addon. Events flow through the
      // addon's init callback once the connection is established.
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      global.__debugLog?.(`connect-game failed: ${error}`);
      // Renderer-host mode: the raw addon is not the active transport, so
      // connect-game can only fail — but the PARENT sends it exactly when its
      // own process monitor sees VALORANT with stale data, which is precisely
      // the recovery signal: re-arm the host window so the fresh GepPackage
      // re-detects the game (live 2026-10-18: nothing recovered after
      // game-exit until an app restart).
      if (error.includes("GEP plugin not initialized")) scheduleGepHostRearm("connect-game-no-plugin");
    }
    send({ type: "event", kind: "command-result", payload: { requestId, name, result: null, error } });
    return;
  }
  send({ type: "event", kind: "command-result", payload: { requestId, name, error: `unknown command: ${name || "(none)"}` } });
}


function sendEvent(kind, payload) {
  send({ type: "event", kind, payload: payload ?? null });
}

function sendFailure(reason) {
  send({ type: "failure", reason: String(reason ?? "unknown") });
}

/** Pick the Valorant-relevant features; fall back to everything the game offers. */
async function setFeatures(gep, gameId) {
  // 1) Overwolf's documented Valorant set (what ValoSpectra uses) — proven to
  //    deliver the full fact stream.
  try {
    await gep.setRequiredFeatures(gameId, VALORANT_FEATURES);
    sendEvent("features-set", { gameId, features: VALORANT_FEATURES, source: "valorant-default" });
    return;
  } catch (err) {
    sendEvent(
      "gep-error",
      `setRequiredFeatures(${VALORANT_FEATURES.join(",")}) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // 2) Fallback: discover what this GEP build actually supports and filter it.
  try {
    const all = await gep.getFeatures(gameId);
    const wanted = Array.isArray(all) ? all.filter((f) => FEATURE_RE.test(f)) : [];
    const features = wanted.length > 0 ? wanted : all;
    await gep.setRequiredFeatures(gameId, Array.isArray(features) ? features : undefined);
    sendEvent("features-set", { gameId, features: features ?? null, source: "discovered" });
  } catch (err) {
    sendEvent("gep-error", `setRequiredFeatures failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Feature registration + initial dump for an explicitly attached game. */
function attachGame(gep, gameId) {
  void setFeatures(gep, gameId);
  // Initial state dump so a mid-match start still renders a full board.
  gep
    .getInfo(gameId)
    .then((info) => {
      if (info != null) sendEvent("info-dump", info);
    })
    .catch(() => {});
}

/** Subscribe to live GEP streams for the detected game. */
function bindGame(gep, launchEvent, gameId) {
  try {
    launchEvent.enable();
  } catch (err) {
    sendFailure(`game-detected enable() failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  sendEvent("game-detected", { gameId });
  void setFeatures(gep, gameId);
  // Initial state dump so a mid-match start still renders a full board.
  gep
    .getInfo(gameId)
    .then((info) => {
      if (info != null) sendEvent("info-dump", info);
    })
    .catch(() => {});
}

function bindGepPackage(gep) {
  gep.on("game-detected", (launchEvent, gameId) => bindGame(gep, launchEvent, gameId));
  gep.on("game-exit", (_event, gameId) => sendEvent("game-exit", { gameId }));
  gep.on("elevated-privileges-required", () => sendEvent("elevated-privileges-required", {}));
  gep.on("error", (err) => sendEvent("gep-error", err instanceof Error ? err.message : String(err)));
  gep.on("new-info-update", (_event, gameId, data) => sendEvent("info-update", { gameId, ...data }));
  gep.on("new-game-event", (_event, gameId, data) => sendEvent("game-event", { gameId, ...data }));
}

/**
 * Electron GEP host — hidden renderer running the downloaded GEP package.
 *
 * The native addon alone (main process) delivers no async callbacks: GEP is
 * built for an Electron RENDERER (window.require + message pump). The
 * extracted package's GepPackage exposes the full API there — the exact
 * machinery the original runtime drives.
 */
let gepHostWindow = null;
let gepHostDir = null; // last resolved GEP package dir (re-arm recreates the host)
let rearmTimer = null;
let rearmLastAt = 0;
const REARM_COOLDOWN_MS = 10_000;
const REARM_MAX_PER_WINDOW = 6;
const REARM_WINDOW_MS = 10 * 60_000;
const rearmStamps = [];

/** Cancels a pending re-arm (the package re-detected the game on its own). */
function cancelGepHostRearm() {
  if (rearmTimer) {
    clearTimeout(rearmTimer);
    rearmTimer = null;
    global.__debugLog?.("gep host re-arm cancelled (game re-detected)");
  }
}

/**
 * Recreates the hidden GEP host window — a fresh GepPackage boots, its process
 * monitor re-detects the running (or next) VALORANT, features are re-registered
 * (fresh renderer = fresh requestFeatures guard) and a fresh info dump lands.
 * This is the renderer-host equivalent of what the Overwolf client's
 * PackageManager does on a game relaunch.
 *
 * LIVE DEFECT (2026-10-18): after a game-exit the package went idle and never
 * re-detected the NEW VALORANT instance — the second custom match of the
 * session was completely blank (no match_info -> no roster/round facts ->
 * empty board, scene stuck on buy-round), and the parent's connect-game
 * retries always failed in renderer-host mode ("GEP plugin not initialized"
 * — the raw addon is not the active transport), so nothing recovered without
 * a full app restart.
 */
function scheduleGepHostRearm(reason) {
  if (!gepHostDir) return; // never ran as a renderer host — nothing to re-arm
  if (rearmTimer) return;
  const now = Date.now();
  if (now - rearmLastAt < REARM_COOLDOWN_MS) return;
  while (rearmStamps.length > 0 && now - rearmStamps[0] > REARM_WINDOW_MS) rearmStamps.shift();
  if (rearmStamps.length >= REARM_MAX_PER_WINDOW) {
    global.__debugLog?.(`gep host re-arm budget exhausted (${reason}) — waiting for manual recovery`);
    return;
  }
  rearmStamps.push(now);
  rearmLastAt = now;
  global.__debugLog?.(`gep host re-arm scheduled in 2s: ${reason}`);
  rearmTimer = setTimeout(() => {
    rearmTimer = null;
    try {
      if (gepHostWindow && !gepHostWindow.isDestroyed()) gepHostWindow.destroy();
    } catch { /* already gone */ }
    // The window's closed handler tears down the old http server; give the
    // main loop a beat before rebuilding.
    setTimeout(() => {
      if (startElectronGepHost(gepHostDir)) {
        global.__debugLog?.("gep host re-armed (fresh GepPackage boot)");
        sendEvent("provider-ready", { source: "renderer-host", api: "rearm", reason });
      } else {
        sendEvent("gep-error", "gep host re-arm failed to start the host window");
      }
    }, 700);
  }, 2_000);
}
function startElectronGepHost(gepDir) {
  try {
    global.__debugLog?.("gep host: step 1 (modules)");
    const { BrowserWindow, ipcMain } = require("electron");
    const nodePath = require("node:path");
    if (!ipcMain.listenerCount("gep-event")) {
      ipcMain.on("gep-event", (_event, msg) => {
        try {
          if (msg && typeof msg.kind === "string") {
            // Re-arm hook (renderer-host lifecycle): a game-exit that the
            // package does not recover from on its own schedules a host
            // restart; a game-detected cancels it (self-recovery wins).
            if (msg.kind === "game-exit") scheduleGepHostRearm("game-exit");
            else if (msg.kind === "game-detected") cancelGepHostRearm();
            send({ type: "event", kind: msg.kind, payload: msg.payload ?? null });
          }
        } catch { /* parent gone */ }
      });
      ipcMain.on("gep-log", (_event, line) => {
        global.__debugLog?.(`renderer: ${String(line ?? "").slice(0, 400)}`);
      });
      ipcMain.on("gep-failure", (_event, reason) => {
        // A dead renderer host is as fatal as a dead PackageManager — report a
        // hard failure so the parent stops THIS mode and relaunches the node
        // (bare addon) mode instead of leaving a zombie provider that stays
        // alive but never delivers any event (the 2026-10-16 failure mode).
        global.__debugLog?.(`renderer reported failure: ${String(reason ?? "").slice(0, 400)}`);
        sendFailure(String(reason ?? "renderer host failed"));
      });
    }
    global.__debugLog?.("gep host: step 2 (ipc ready)");
    if (gepHostWindow && !gepHostWindow.isDestroyed()) return true;
    // Resolve the downloaded GEP package dir: explicit arg -> env -> newest
    // extracted package under the data dir.
    let resolvedGepDir = gepDir || process.env.HAVOC_GAME_DATA_OVERWOLF_GEP_DIRECTORY?.trim() || "";
    if (!resolvedGepDir) {
      try {
        const dataDir = process.env.HAVOC_GAME_DATA_DIR?.trim() ||
          path.join(process.env.LOCALAPPDATA || "", "Havoc", "game-data-runtime");
        const root = path.join(dataDir, "packages", "gep");
        const versions = fs.readdirSync(root).sort().reverse();
        for (const v of versions) {
          const candidate = path.join(root, v, "extracted");
          if (fs.existsSync(path.join(candidate, "index.js"))) {
            resolvedGepDir = candidate;
            break;
          }
        }
      } catch { /* no package dir */ }
    }
    if (!resolvedGepDir) {
      sendEvent("gep-error", "gep host: no downloaded GEP package directory found");
      return false;
    }
    // Defensive patch of the extracted GEP package (self-healing across
    // re-extraction): its non-utility game-info lookup compares a LOWERCASED
    // detection name against the mixed-case processName table entries
    // ('VALORANT-Win64-Shipping'), so without the owepm utility service no
    // game could ever resolve ("failed to find game info" — live 2026-10-16).
    try {
      const pkgFile = nodePath.join(resolvedGepDir, "index.js");
      const needle = "p.processName === processName";
      const src = fs.readFileSync(pkgFile, "utf8");
      if (src.includes(needle)) {
        fs.writeFileSync(
          pkgFile,
          src.replace(needle, "p.processName.toLowerCase() === processName /* HAVOC-PATCH: case-insensitive process match */"),
          "utf8",
        );
        global.__debugLog?.("gep package patched: processName match is now case-insensitive");
      }
    } catch (err) {
      global.__debugLog?.(`gep package patch skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    global.__debugLog?.(`gep host: using gepDir=${resolvedGepDir}`);
    gepHostDir = resolvedGepDir; // re-arm recreates the host with the same dir
    gepHostWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false,
        sandbox: false,
      },
    });
    gepHostWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
      global.__debugLog?.(`gep host: did-fail-load ${code} ${desc} ${url}`);
    });
    gepHostWindow.webContents.on("render-process-gone", (_e, details) => {
      global.__debugLog?.(`gep host: render-process-gone ${JSON.stringify(details)}`);
    });
    gepHostWindow.on("closed", () => {
      try { httpServer?.close(); } catch { /* ignore */ }
      httpServer = null;
      gepHostWindow = null;
    });
    // Serve the renderer over a localhost HTTP server. Both file:// and data:
    // navigations failed with ERR_FAILED (-2) under ow-electron's fork, while
    // http:// is the path every ow-electron app uses (ValoSpectra's dev flow).
    const html =
      `<!doctype html><html><body><script src="/gep-renderer.js"></script></body></html>`;
    let httpServer = null;
    try {
      httpServer = require("node:http").createServer((req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          if (url.pathname === "/gep-renderer.js") {
            res.writeHead(200, { "content-type": "text/javascript" });
            res.end(fs.readFileSync(path.join(__dirname, "gep-renderer.js")));
            return;
          }
          res.writeHead(200, { "content-type": "text/html" });
          res.end(html);
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
      });
    } catch (err) {
      global.__debugLog?.(`gep host: http server failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!httpServer) {
      sendEvent("gep-error", "gep host: could not start localhost server");
      return false;
    }
    global.__debugLog?.("gep host: step 3 (window created)");
    httpServer.listen(0, "127.0.0.1", () => {
      const port = httpServer.address()?.port;
      const url = `http://127.0.0.1:${port}/?gepDir=${encodeURIComponent(resolvedGepDir)}`;
      global.__debugLog?.(`gep host: step 4 (loading ${url})`);
      void gepHostWindow
        .loadURL(url)
        .then(() => global.__debugLog?.("gep host: step 5 (renderer loaded)"))
        .catch((err) => {
          // A dead renderer host is as fatal as a dead PackageManager. Report
          // it as a hard failure so the parent stops THIS mode and relaunches
          // in node mode (bare addon) instead of leaving a zombie provider
          // that stays alive but never delivers any event.
          global.__debugLog?.(`gep host: load failed: ${err.message}`);
          sendFailure(`gep host renderer failed to load: ${err.message}`);
        });
    });
    return true;
  } catch (err) {
    global.__debugLog?.(`gep host crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    sendEvent("gep-error", `electron gep host failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Replicate the original's native-provider-host layout: hardlink the running
 * electron.exe into <dataDir>/native-provider-host/node_modules/@overwolf/
 * ow-electron/dist/electron.exe so the GEP addon resolves a conventional
 * node_modules path. Best-effort (falls back to copy on cross-device links).
 */
function prepareNativeProviderHost() {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const dataDir = process.env.HAVOC_GAME_DATA_DIR?.trim() ||
      path.join(process.env.LOCALAPPDATA || "", "Havoc", "game-data-runtime");
    const target = path.join(dataDir, "native-provider-host", "node_modules", "@overwolf", "ow-electron", "dist", "electron.exe");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.unlinkSync(target);
    } catch { /* not present */ }
    try {
      fs.linkSync(process.execPath, target);
    } catch {
      fs.copyFileSync(process.execPath, target);
    }
    sendEvent("native-provider-host-ready", { target });
  } catch (err) {
    sendEvent("gep-error", `native-provider-host preparation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Direct mode (the original flow): the parent downloaded + verified the GEP
 * module and points us at it via HAVOC_GAME_DATA_OVERWOLF_GEP_DIRECTORY.
 *
 * Direct native addon contract (reverse-engineered from Overwolf's GEP plugin,
 * verified live):
 *   plugin.gep.init(callback)                    -> GEP event stream
 *   plugin.processMonitor.initializeProcessMonitor(cb) -> game detection stream
 *   plugin.processMonitor.startProcessMonitor()  -> true
 *   plugin.gep.connect(gameId, pid, name, opts?) -> attach to a detected game
 * The callback receives string-kind events (game_detected, new_info_update,
 * new_game_event, game_exit, provider logs...) — forwarded verbatim to the
 * parent, which normalizes them into runtime facts.
 */
function tryDirectGepInit() {
  // Direct addon is the default (same as the original's "gep.direct-addon").
  // The addon is silent until a game actually launches — breadcrumbs +
  // heartbeat in the debug log prove the pump is alive meanwhile.
  if (process.env.HAVOC_DISABLE_DIRECT_ADDON === "1") {
    global.__debugLog?.("direct addon disabled by env — using package manager path");
    return false;
  }
  let gepDir =
    process.env.HAVOC_GAME_DATA_OVERWOLF_GEP_DIRECTORY?.trim() ||
    (typeof global.__session?.gepDirectory === "string" ? global.__session.gepDirectory.trim() : "");
  global.__activeGepDir = gepDir; // reachable from the whenReady callback
  if (!gepDir) return false;
  try {
    const path = require("node:path");
    const fs = require("node:fs");
    const entry = path.join(gepDir, "ow-electron-gep-plugin.node");
    if (!fs.existsSync(entry)) throw new Error(`GEP addon not found: ${entry}`);
    let version = null;
    try {
      version = JSON.parse(fs.readFileSync(path.join(gepDir, "package.json"), "utf8")).version ?? null;
    } catch { /* version is cosmetic */ }

    // The addon resolves its DLL chain (gep-loader.dll, GEPPlugin64.dll, 64/*)
    // relative to the working directory.
    global.__debugLog?.("chdir to gep dir");
    process.chdir(gepDir);
    global.__debugLog?.("requiring addon");
    const plugin = require(entry);
    global.__gepPlugin = plugin; // reachable from handleCommand (connect-game)
    global.__debugLog?.("addon required");
    try {
      const surface = (obj) => {
        const names = new Set([...Object.keys(obj ?? {}), ...Object.getOwnPropertyNames(Object.getPrototypeOf(obj ?? {}))]);
        return [...names].filter((n) => n !== "constructor").join(",");
      };
      global.__debugLog?.(`addon surface: top=[${surface(plugin)}] gep=[${surface(plugin.gep)}] processMonitor=[${surface(plugin.processMonitor)}]`);
    } catch (e) { global.__debugLog?.(`surface dump failed: ${e.message}`); }

    const jsonSafe = (value) => {
      if (value == null) return null;
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
      if (typeof value === "object") {
        try {
          return JSON.parse(JSON.stringify(value));
        } catch {
          return String(value);
        }
      }
      if (typeof value === "function") return "[function]";
      return String(value);
    };
    const sendArgs = (kind, args) => {
      try {
        send({ type: "event", kind, payload: Array.from(args).map(jsonSafe) });
      } catch { /* parent gone */ }
    };

    // GEP event stream (game_detected / new_info_update / new_game_event / ...).
    global.__debugLog?.("calling gep.init");
    plugin.gep.init((...args) => {
      const kind = typeof args[0] === "string" ? args[0] : "unknown";
      try {
        global.__debugLog?.(`gep-callback kind=${kind} args=${JSON.stringify(args).slice(0, 300)}`);
      } catch { /* ignore */ }
      sendArgs(kind, args);
    });

    // Game detection: track VALORANT (21640 — same ID the original provider
    // used), forward everything, and auto-connect to a detected game.
    const trackedGames = (process.env.HAVOC_GEP_TRACKED_GAMES?.trim() || "21640")
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    global.__debugLog?.("calling initializeProcessMonitor");
    plugin.processMonitor.initializeProcessMonitor((...args) => {
      try {
        global.__debugLog?.(`monitor-callback args=${JSON.stringify(args).slice(0, 400)}`);
      } catch { /* ignore */ }
      sendArgs("monitor", args);
      const numbers = args.filter((a) => typeof a === "number");
      const name = args.find((a) => typeof a === "string" && a.length > 0);
      const gameId = numbers.find((n) => n > 1000);
      if (gameId != null) {
        try {
          plugin.gep.connect(gameId, numbers[1] ?? 0, name ?? "game", { oop: false })
            ?.then?.((v) => global.__debugLog?.(`monitor connect resolved: ${JSON.stringify(v)?.slice(0, 120)}`))
            ?.catch?.((err) => global.__debugLog?.(`monitor connect rejected: ${err instanceof Error ? err.message : String(err)}`));
          sendEvent("connect-attempted", { gameId, pid: numbers[1] ?? 0, name: name ?? null });
        } catch (err) {
          sendEvent("gep-error", `gep.connect(${gameId}) failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }, trackedGames);
    global.__debugLog?.("calling startProcessMonitor");
    const started = plugin.processMonitor.startProcessMonitor();
    global.__debugLog?.("monitor started: " + String(started));
    sendEvent("provider-ready", {
      source: "direct-addon",
      version,
      trackedGames,
      processMonitorStarted: started === true,
    });
    return true;
  } catch (err) {
    sendFailure(`direct GEP init failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function main() {
  // Debug breadcrumbs (the original's provider logged the same lifecycle).
  try {
    const dataDir = process.env.HAVOC_GAME_DATA_DIR?.trim() ||
      path.join(process.env.LOCALAPPDATA || "", "Havoc", "game-data-runtime");
    const runDir = path.join(dataDir, "run");
    fs.mkdirSync(runDir, { recursive: true });
    global.__debugLog = (msg) => {
      try {
        fs.appendFileSync(path.join(runDir, "gep-provider-debug.log"),
          `${new Date().toISOString()} pid=${process.pid} argv=${JSON.stringify(process.argv.slice(1))} :: ${msg}\n`);
      } catch { /* ignore */ }
    };
  } catch { /* ignore */ }
  global.__debugLog?.("main entered");
  const isNodeMode = process.env.ELECTRON_RUN_AS_NODE === "1";
  if (!isNodeMode) {
    try {
      const { app } = require("electron");
      app.disableHardwareAcceleration();
      app.commandLine.appendSwitch("no-sandbox");
      app.commandLine.appendSwitch("disable-gpu");
      global.__debugLog?.("gpu/sandbox disabled for provider app");
    } catch { /* not in electron mode */ }
  }

  // Elevated-launch mode (`--session <file>`): route the protocol through the
  // parent's named pipe BEFORE announcing readiness.
  setupSessionTransport();

  if (isNodeMode) {
    // Plain-Node mode: the addon's async callbacks only fire on a plain Node
    // loop (verified: they never fire in an Electron main process). The
    // original runs the exact same addon in its Bun runtime for this reason.
    global.__debugLog?.("node mode (RUN_AS_NODE): direct addon init");
    if (tryDirectGepInit()) {
      global.__debugLog?.("direct init OK (node mode)");
      let beats = 0;
      setInterval(() => {
        beats += 1;
        global.__debugLog?.(`heartbeat ${beats}`);
      }, 10_000).unref();
    } else {
      sendFailure("direct addon init failed in node mode");
      setTimeout(() => process.exit(1), 250);
    }
    return;
  }


  // Announce the child is up before anything can fail, so the parent can tell
  // "provider dead" apart from "provider starting".
  send({ type: "ready", protocolVersion: PROTOCOL_VERSION });

  global.__debugLog?.("waiting for app ready");
  app.whenReady().then(() => {
    global.__debugLog?.("app ready fired");
    try {
      const surface = (obj) => {
        const names = new Set([...Object.keys(obj ?? {}), ...Object.getOwnPropertyNames(Object.getPrototypeOf(obj ?? {}))]);
        return [...names].filter((n) => n !== "constructor").join(",");
      };
      global.__debugLog?.(`probe: global.overwolf=${typeof global.overwolf} process.overwolf=${typeof process.overwolf}`);
      const electronMod = require("electron");
      global.__debugLog?.(`probe: electron.overwolf=${typeof electronMod.overwolf}`);
      const ow = global.overwolf ?? process.overwolf ?? electronMod.overwolf;
      if (ow?.packages) {
        global.__debugLog?.(`probe: overwolf.packages=[${Object.keys(ow.packages).join(",")}]`);
        const g = ow.packages.gep;
        if (g) global.__debugLog?.(`probe: packages.gep=[${surface(g)}]`);
      }
    } catch (e) { global.__debugLog?.(`probe failed: ${e.message}`); }
    // OFFICIAL PATH FIRST (ValoSpectra's exact flow): ow-electron's
    // PackageManager loads the GEP package with the full API
    // (setRequiredFeatures / game-detected / new-info-update). The bare-addon
    // direct path (below) has no features API, and its attach loses the race
    // against Vanguard — it stayed "initializing" forever in the field.
    global.__debugLog?.("pm path first (electron mode)");
    let pm = null;
    // GEP package dir the parent downloaded + verified (may be null).
    const gepDir = process.env.HAVOC_GAME_DATA_OVERWOLF_GEP_DIRECTORY?.trim() || null;
    try {
      pm = app.overwolf.packages;
      global.__debugLog?.(`package manager available: packages=[${Object.keys(pm).join(",")}]`);
    } catch (err) {
      global.__debugLog?.(`package manager unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (pm) {
      let gepBound = false;
      const tryBind = (source) => {
        if (gepBound) return;
        const gep = pm.gep;
        global.__debugLog?.(`tryBind(${source}): pm.gep=${typeof gep}`);
        if (gep != null) {
          gepBound = true;
          bindGepPackage(gep);
          sendEvent("provider-ready", { packageName: "gep", version: gep.version ?? null, source: "package-manager" });
        }
      };

      pm.on("ready", (_event, packageName) => {
        global.__debugLog?.(`pm ready event: ${packageName}`);
        if (packageName === "gep") tryBind("pm-ready");
      });
      pm.on("failed-to-initialize", (_event, packageName) => {
        global.__debugLog?.(`pm failed-to-initialize: ${packageName}`);
        if (packageName === "gep") sendFailure(`GEP package failed to initialize`);
      });
      pm.on("crashed", (_event, canRecover) => {
        sendEvent("gep-error", `package manager crashed (canRecover=${Boolean(canRecover)})`);
      });

      tryBind("initial");
      // The package manager may need to download + verify the package first.
      const retryTimers = [3_000, 10_000, 20_000, 35_000, 55_000, 80_000, 110_000];
      for (const t of retryTimers) setTimeout(() => tryBind(`retry-${t}`), t);
      if (!gepBound) {
        setTimeout(() => {
          if (gepBound) return;
          // PM never exposed the gep package (it needs Overwolf's own download
          // services). Fall back to the renderer host, which loads the GEP
          // package the parent ALREADY downloaded + verified (full API incl.
          // setRequiredFeatures) — before giving up entirely.
          global.__debugLog?.("pm never bound gep — falling back to renderer host");
          if (startElectronGepHost(gepDir)) {
            global.__debugLog?.("electron gep host started (pm fallback)");
            prepareNativeProviderHost();
            return;
          }
          if (!gepBound) sendFailure("GEP package never became ready (check Overwolf connectivity)");
        }, 120_000);
      }
      // Events flow through the package listeners; nothing else to start.
      // (Starting the direct addon here would create a second machine-wide
      // GEP instance and conflict with the package's own one.)
      return;
    }

    // Fallback 1: renderer host with the downloaded GEP package.
    global.__debugLog?.("pm unavailable — trying startElectronGepHost");
    if (startElectronGepHost(gepDir)) {
      global.__debugLog?.("electron gep host started");
      prepareNativeProviderHost();
      return;
    }

    // Last resort: direct addon. Its callbacks never fire on an Electron main
    // loop (verified) — this only surfaces a visible failure to the parent.
    global.__debugLog?.("calling tryDirectGepInit (last resort)");
    if (tryDirectGepInit()) {
      global.__debugLog?.("direct init OK (callbacks will not fire in electron mode)");
      prepareNativeProviderHost();
      return;
    }

    sendFailure("no usable GEP transport (pm/renderer/direct all unavailable)");
  });

  // No windows: keep the process alive and quiet.
  app.on("window-all-closed", () => {});
  process.on("uncaughtException", (err) => {
    sendFailure(`uncaughtException: ${err instanceof Error ? err.stack : String(err)}`);
  });
}

main();
