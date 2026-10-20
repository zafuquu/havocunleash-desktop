/**
 * Electron entry — Havoc Unleash desktop.
 * Orchestrates the full producer pipeline:
 *   register `havoc-desktop://` protocol -> PKCE sign-in -> room access ->
 *   producer ticket -> Socket.IO claim -> publish game snapshots to the
 *   bridge -> website reads Supabase + overlay popout windows.
 */
import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { loadConfig, type AppConfig } from "./config";
import { logger } from "./logger";
import { GameDataRuntimeClient } from "./runtimeClient";
import { ValProjectionSession } from "./projection";
import { HudServer, type ShellControls, type ShellStatus } from "./hudServer";
import { LocalGateway } from "./gateway";
import { getWindowBoundsByTitle, isWin32BridgeAvailable, placeOverlayAboveGame } from "./win32";
import {
  DesktopAuth,
  createPendingContext,
  extractTokenFromDeepLink,
  overlayPopoutUrl,
  type HavocSession,
  type PendingContext,
  type SessionStore,
} from "./auth";
import { TrpcClient, type RealtimeRoom } from "./trpc";
import { ProducerClient, type ProducerRoom } from "./producer";
import { getBuildInfo } from "./buildInfo";
import { createSupportBundle } from "./supportBundle";
import { toGameSnapshot } from "./snapshot";
import { selectDataSource } from "./dataSource";
import { deriveBridgeEvents, initialBridgeEventState } from "./gameEvents";

let cfg: AppConfig;
let client: GameDataRuntimeClient | null = null;
let projection: ValProjectionSession;
let hudServer: HudServer;
let gateway: LocalGateway | null;
let overlayWindow: BrowserWindow | null = null;
let shellWindow: BrowserWindow | null = null;
let runtimeChild: ChildProcess | null = null;
let runtimeRespawnTimer: NodeJS.Timeout | null = null;
let producer: ProducerClient | null = null;
let auth: DesktopAuth | null = null;
let pending: PendingContext | null = null;
let session: HavocSession | null = null;
let activeRoom: ProducerRoom | null = null;
let publishTimer: ReturnType<typeof setTimeout> | null = null;
let lastPublishedPayload = ""; // kept for debugging; publisher no longer dedupes
let overlayRequested = false;
let connectingRoom = false;

const FOLLOW_INTERVAL_MS = 1_000;

/**
 * Crash containment (2026-09-24 incident): an uncaught exception in the main
 * process made Electron show its BLOCKING "A JavaScript error occurred in the
 * main process" dialog. That froze everything — HTTP server, runtime stream and
 * publisher — while the process stayed alive and its window kept showing the
 * last painted frame, so the desktop "looked fine" while the website/OBS went
 * empty. A broadcaster must degrade, never freeze: log the real stack and keep
 * running instead of letting Electron take the thread.
 */
process.on("uncaughtException", (error) => {
  logger.error("app", "uncaught_exception", {
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
  });
});
process.on("unhandledRejection", (reason) => {
  logger.error("app", "unhandled_rejection", {
    error: reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason),
  });
});

const isPackaged = app.isPackaged;

function repoRoot(): string {
  // Bundled layout: apps/desktop/dist/main.js -> repo root (3 levels up).
  // tsc layout:     apps/desktop/dist/main/main.js -> repo root (4 levels up).
  const ups = path.basename(__dirname) === "dist" ? 3 : 4;
  return path.resolve(__dirname, ...Array.from({ length: ups }, () => ".."));
}

function hudPublicDir(): string {
  // Packaged: esbuild copies apps/hud/public -> dist/hud-public, next to main.js.
  return isPackaged ? path.join(__dirname, "hud-public") : path.join(repoRoot(), "apps", "hud", "public");
}

function runtimeServerScript(): string | null {
  const candidates = isPackaged
    ? [
        // asarUnpack places the runtime OUTSIDE the asar (ELECTRON_RUN_AS_NODE
        // cannot execute scripts from inside an asar archive).
        path.join(__dirname, "runtime-server.cjs").replace(".asar", ".asar.unpacked"),
        path.join(__dirname, "runtime-server.cjs"),
      ]
    : [path.join(repoRoot(), "services", "game-data-runtime", "dist", "server.js")];
  for (const script of candidates) {
    try {
      if (fs.existsSync(script)) return script;
    } catch {
      /* continue */
    }
  }
  return null;
}

/* ----------------------------- safeStorage store ----------------------------- */

function createSessionStore(): SessionStore {
  const file = () => path.join(app.getPath("userData"), "session.json");
  return {
    get: (key: string) => {
      const stored = loadFile();
      if (stored && key in stored) {
        try {
          return JSON.parse(safeStorage.decryptString(Buffer.from(stored[key]!, "base64")));
        } catch {
          return null;
        }
      }
      return null;
    },
    set: (key: string, value: unknown) => {
      const map = loadFile();
      map[key] = safeStorage.encryptString(JSON.stringify(value)).toString("base64");
      writeFile(map);
    },
    delete: (key: string) => {
      const map = loadFile();
      delete map[key];
      writeFile(map);
    },
  };

  function loadFile(): Record<string, string> {
    try {
      const raw = readFromDisk();
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  }
  function writeFile(map: Record<string, string>): void {
    try {
      fs.mkdirSync(app.getPath("userData"), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(map));
    } catch {
      /* best-effort */
    }
  }
  function readFromDisk(): string | null {
    try {
      return fs.existsSync(file()) ? fs.readFileSync(file(), "utf8") : null;
    } catch {
      return null;
    }
  }
}

function registerProtocol(): void {
  // Dev: "electron.exe <main.js>" — packaged: the app exe alone.
  const execPath = process.execPath;
  const args = process.defaultApp ? [app.getAppPath()] : [];
  for (const proto of cfg.desktopProtocols) {
    try {
      if (process.defaultApp) {
        app.setAsDefaultProtocolClient(proto, execPath, args);
      } else {
        app.setAsDefaultProtocolClient(proto);
      }
    } catch (error) {
      logger.warn("app", "protocol_register_failed", { protocol: proto, error: String(error) });
    }
    // Self-heal: setAsDefaultProtocolClient has been observed leaving an empty
    // shell\open\command on some machines, which makes the browser silently
    // drop the deep link. reg add is idempotent and fixes it deterministically.
    repairProtocolCommand(proto, execPath, args);
  }
}

function repairProtocolCommand(proto: string, execPath: string, args: string[]): void {
  // Portable electron-builder exes extract to a fresh random temp dir per run.
  // Registering that path poisons the protocol: the dir is deleted on exit and
  // the browser next deep-link invocation silently no-ops. Only a stable
  // install location (win-unpacked / NSIS install) may own the registry.
  const tempRoot = (process.env.TEMP ?? process.env.TMP ?? "").toLowerCase();
  if (tempRoot && execPath.toLowerCase().startsWith(tempRoot)) {
    logger.warn("app", "protocol_register_skipped_portable", { protocol: proto, execPath });
    return;
  }
  const { execFile } = require("node:child_process") as typeof import("node:child_process");
  const base = `HKCU\\Software\\Classes\\${proto}`;
  // Quotes preserved inside the registry value: "C:\...\Havoc Desktop.exe" "%1"
  const command = [execPath, ...args, "%1"].map((part) => `"${part}"`).join(" ");
  const steps: Array<[string, string[]]> = [
    [base, ["/ve", "/d", "URL:Havoc Desktop Protocol"]],
    [base, ["/v", "URL Protocol", "/d", ""]],
    [`${base}\\shell\\open\\command`, ["/ve", "/d", command]],
  ];
  for (const [key, regArgs] of steps) {
    execFile("reg", ["add", key, ...regArgs, "/f"], (error) => {
      if (error) logger.warn("app", "protocol_repair_failed", { key, error: String(error) });
    });
  }
  logger.info("app", "protocol_registered", { protocol: proto, command });
}

function spawnRuntimeIfNeeded(): void {
  // Hybrid capture mode: spawn the proven original capture engine (its GEP
  // self-updates and attaches reliably — the built-in node runtime stays
  // available as a fallback via HAVOC_CAPTURE_EXE="").
  if (cfg.captureExe) {
    if (!fs.existsSync(cfg.captureExe)) {
      logger.error("app", "capture_exe_missing", { captureExe: cfg.captureExe });
      return;
    }
    try {
      runtimeChild = spawn(cfg.captureExe, [], {
        cwd: path.dirname(cfg.captureExe),
        // The original engine manages its own elevation/provider lifecycle.
        env: { ...process.env },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      runtimeChild.stderr?.on("data", (chunk: Buffer) => {
        const text = String(chunk).trim();
        if (text) logger.warn("app", "capture_engine_stderr", { text: text.slice(0, 400) });
      });
      runtimeChild.on("error", (error) =>
        logger.error("app", "capture_engine_error", { error: String(error) }),
      );
      runtimeChild.on("exit", (code, signal) => {
        logger.error("app", "capture_engine_exited", { code: code ?? null, signal: signal ?? null });
        runtimeChild = null;
        if (runtimeRespawnTimer) return;
        runtimeRespawnTimer = setTimeout(() => {
          runtimeRespawnTimer = null;
          logger.info("app", "capture_engine_respawn");
          spawnRuntimeIfNeeded();
        }, 5_000);
        runtimeRespawnTimer.unref();
      });
      logger.info("app", "capture_engine_spawned", {
        pid: runtimeChild.pid,
        exe: cfg.captureExe,
        origin: cfg.runtimeOrigin,
        source: selectDataSource(cfg).kind,
      });
    } catch (error) {
      logger.error("app", "capture_engine_spawn_failed", { error: String(error) });
    }
    return;
  }
  const script = runtimeServerScript();
  if (!script) {
    logger.warn("app", "runtime_script_missing", { packaged: isPackaged });
    return;
  }
  try {
    runtimeChild = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        PORT: String(new URL(cfg.runtimeOrigin).port),
        ELECTRON_RUN_AS_NODE: "1",
        // Elevated GEP provider (original-style UAC); set "0" in the config to disable.
        HAVOC_ELEVATE_GEP: cfg.elevateGep ? "1" : "0",
      },
      // Capture stderr so runtime crashes are diagnosable (they were invisible
      // with stdio:ignore — the runtime could die silently and take the whole
      // game-data pipeline with it).
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    runtimeChild.stderr?.on("data", (chunk: Buffer) => {
      const text = String(chunk).trim();
      if (text) logger.warn("app", "runtime_stderr", { text: text.slice(0, 600) });
    });
    runtimeChild.on("error", (error) =>
      logger.error("app", "runtime_child_error", { error: String(error) }),
    );
    // Self-healing: if the runtime dies for ANY reason, respawn it after a
    // short delay — the game-data pipeline must not stay down.
    runtimeChild.on("exit", (code, signal) => {
      logger.error("app", "runtime_child_exited", { code: code ?? null, signal: signal ?? null });
      runtimeChild = null;
      if (runtimeRespawnTimer) return;
      runtimeRespawnTimer = setTimeout(() => {
        runtimeRespawnTimer = null;
        logger.info("app", "runtime_respawn");
        spawnRuntimeIfNeeded();
      }, 5_000);
      runtimeRespawnTimer.unref();
    });
    logger.info("app", "runtime_child_spawned", { pid: runtimeChild.pid, script });
  } catch (error) {
    logger.error("app", "runtime_spawn_failed", { error: String(error) });
  }
}

/* ----------------------------- Publisher loop ----------------------------- */

/** Pipeline telemetry — enabled with HAVOC_DEBUG_PIPELINE=1 (no secrets). */
function pipelineDebug(event: string, data: Record<string, unknown>): void {
  if (process.env.HAVOC_DEBUG_PIPELINE === "1") logger.info("pipeline", event, data);
}

function queuePublish(): void {
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    publishNow();
  }, 250);
}

/** A2: latest GEP telemetry-delivery state (from provider_status facts, additive). */
let gepTelemetryState: string | null = null;
let gepTelemetryStateAt = 0;

/** Tracks which projection changes were already surfaced as game-event frames. */
let lastEventState = initialBridgeEventState();

function publishNow(): void {
  try {
    publishNowUnsafe();
  } catch (error) {
    // Timer-driven publish: a throw here would otherwise reach the top level as
    // an uncaught exception (see the crash-containment note in this file).
    logger.error("pipeline", "publish_failed", {
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
    });
  }
}

function publishNowUnsafe(): void {
  if (!producer || !activeRoom) {
    pipelineDebug("publish_skipped", { hasProducer: !!producer, hasRoom: !!activeRoom });
    return;
  }
  const proj = projection.snapshotValue();
  const snapshot = toGameSnapshot(proj);
  pipelineDebug("publish_to_bridge", {
    hudRevision: proj.revision,
    players: snapshot.state.players.length,
    scores: snapshot.state.gameScore,
    roundNumber: snapshot.state.currentRound.roundNumber,
    roundPhase: snapshot.state.roundPhase ?? null,
    isAgentSelectPhase: snapshot.state.isAgentSelectPhase ?? null,
    scene: snapshot.state.scene ?? null,
    mapName: snapshot.state.mapName ?? null,
  });
  producer.publishSnapshot(snapshot);
  // Game-event frames feed the site's OWN event pipeline (KillBanner banners +
  // the EVENT_TEXT / Game Event sequence). The derivation lives in
  // `gameEvents.ts`: it guarantees exactly ONE roundWin per completed round
  // (keyed on the settled round, not on the round in progress).
  const derived = deriveBridgeEvents(proj, lastEventState);
  lastEventState = derived.next;
  for (const e of derived.events) producer.publishEvent(e);
}

async function connectProducer(): Promise<void> {
  try {
    if (!auth || !session) return;
    const trpc = new TrpcClient(cfg.bridgeOrigin);
    const wantRoomId = cfg.roomId.trim();
    if (!wantRoomId) return; // manual mode: the shell UI drives room selection
    let room = await trpc.findRoomById(wantRoomId);
    if (!room) {
      // The bridge auto-registers unknown server codes on request (original flow).
      logger.info("producer", "auto_register_configured_room", { roomId: wantRoomId });
      try {
        const req = await trpc.desktopRequestAccess({ roomId: wantRoomId });
        // Wait out a pending approval (instant on the HU bridge, which
        // auto-accepts; polls like the original app against a real bridge).
        await trpc.awaitRoomAccess(req.requestId);
        room = await trpc.findRoomById(wantRoomId);
      } catch (error) {
        logger.error("producer", "auto_register_failed", { error: String(error) });
      }
    }
    if (room) await connectToRoom(room);
  } catch (error) {
    logger.error("producer", "connect_failed", { error: String(error) });
  }
}

async function connectToRoom(room: RealtimeRoom): Promise<void> {
  const ticket = await trpcForSession().desktopProducerTicket({
    roomId: room.roomId,
    roomName: room.roomName,
    roomGame: room.roomGame,
  });
  activeRoom = {
    roomId: room.roomId,
    roomName: room.roomName,
    roomGame: room.roomGame,
    overlayId: room.overlayId ?? "ingame-hud",
  };
  producer = new ProducerClient(cfg.bridgeOrigin);
  const roomForRefresh = activeRoom;
  producer.setTicketRefresher(async () => {
    const refreshed = await trpcForSession().desktopProducerTicket({
      roomId: roomForRefresh.roomId,
      roomName: roomForRefresh.roomName,
      roomGame: roomForRefresh.roomGame,
    });
    return refreshed.ticket;
  });
  await producer.connect(ticket.ticket, activeRoom);
  logger.info("producer", "connected_as_producer", { roomId: activeRoom.roomId });
  // Original behaviour: the overlay appears once the desktop is connected to the room.
  overlayRequested = true;
  openOverlayPopout(activeRoom);
  queuePublish();
}

function trpcForSession(): TrpcClient {
  return new TrpcClient(cfg.bridgeOrigin);
}

/* --------------------------- Shell control plane --------------------------- */

const shellControls: ShellControls = {
  status(): ShellStatus {
    const snap = projection?.snapshotValue();
    return {
      signedIn: session !== null,
      userName: session?.user.name ?? null,
      room: activeRoom ? { roomId: activeRoom.roomId, roomName: activeRoom.roomName } : null,
      connecting: connectingRoom,
      overlayRequested,
      runtimeConnected: snap?.connectedToRuntime ?? false,
      gepTelemetry:
        gepTelemetryState !== null ? { state: gepTelemetryState, at: gepTelemetryStateAt } : null,
      live: snap
        ? {
            sessionPhase: snap.sessionPhase,
            mapName: snap.mapName,
            scene: snap.scene,
            score: snap.score,
            roundNumber: snap.round.number,
          }
        : null,
    };
  },
  startSignIn(): void {
    if (session) return;
    void initiateSignIn();
  },
  async listRooms() {
    return trpcForSession().desktopRooms();
  },
  async joinRoom(roomId) {
    if (!session) return { ok: false, error: "Sign in first." };
    if (connectingRoom) return { ok: false, error: "Already connecting…" };
    connectingRoom = true;
    try {
      const trpc = trpcForSession();
      const rooms = await trpc.desktopRooms();
      let room = rooms.find(
        (r) => r.roomId === roomId || r.roomName.toLowerCase() === roomId.toLowerCase(),
      );
      if (!room) {
        // Unknown server code: the bridge auto-registers rooms on request.
        // Original flow: request access → poll status (the old renderer polls
        // every 5s until the website dashboard approves) → connect.
        const request = await trpc.desktopRequestAccess({
          roomId,
          roomName: roomId,
          roomGame: "VAL",
        });
        const status = await trpc.awaitRoomAccess(request.requestId);
        if (status.status !== "accepted") {
          return {
            ok: false,
            error:
              status.status === "pending"
                ? "Timed out waiting for room approval on the website."
                : "The bridge denied access to that room.",
          };
        }
        room = {
          roomId: status.roomId ?? roomId,
          roomName: status.roomName || roomId,
          roomGame: status.roomGame ?? "VAL",
          overlayId: status.overlayId ?? "ingame-hud",
        };
        logger.info("realtime", "room_auto_registered", { roomId: room.roomId });
      }
      if (producer) {
        await producer.stop();
        producer = null;
        activeRoom = null;
      }
      await connectToRoom(room);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      connectingRoom = false;
    }
  },
  async leaveRoom() {
    try {
      if (producer) {
        await producer.stop();
        producer = null;
      }
      activeRoom = null;
      overlayRequested = false;
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.destroy();
        overlayWindow = null;
      }
      logger.info("producer", "left_room");
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  async resetNetwork() {
    try {
      const res = await fetch(`${cfg.runtimeOrigin}/network/reset`, { method: "POST" });
      const body = (await res.json()) as { ok?: boolean; result?: unknown; error?: string };
      logger.info("network", "socket_reset_attempted", { ok: body.ok ?? false });
      return { ok: body.ok ?? false, result: body.result ?? null, error: body.error };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("network", "socket_reset_failed", { error: message });
      return { ok: false, error: message };
    }
  },
  async toggleOverlay() {
    if (!activeRoom) return { on: false };
    overlayRequested = !overlayRequested;
    if (overlayRequested) {
      openOverlayPopout(activeRoom);
    } else if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.destroy();
      overlayWindow = null;
    }
    logger.info("overlay", "toggled", { on: overlayRequested });
    return { on: overlayRequested };
  },
};

function createShellWindow(): void {
  if (shellWindow && !shellWindow.isDestroyed()) {
    shellWindow.show();
    return;
  }
  shellWindow = new BrowserWindow({
    width: 470,
    height: 580,
    autoHideMenuBar: true,
    backgroundColor: "#141517",
    title: "Havoc Unleash — Desktop",
    // HU logo (padded square 640px) — ships via files: build/icon.png.
    icon: path.join(__dirname, "..", "build", "icon.png"),
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  void shellWindow.loadURL(`${cfg.hudOrigin}/shell/index.html`);
  shellWindow.once("ready-to-show", () => shellWindow?.show());
  shellWindow.on("closed", () => {
    shellWindow = null;
  });
}

/* ----------------------------- Deep link auth ----------------------------- */

function handleDeepLink(url: string): void {
  if (!auth || !pending) return;
  const token = extractTokenFromDeepLink(url);
  if (!token) return;
  void auth
    .completeLogin(token, pending)
    .then((s) => {
      session = s;
      pending = null;
      logger.info("app", "logged_in");
      return connectProducer();
    })
    .catch((error) => logger.error("auth", "login_failed", { error: String(error) }));
}

function extractDeepLink(argv: string[], protocols: readonly string[]): string | undefined {
  for (const protocol of protocols) {
    const link = argv.find((a) => a.toLowerCase().startsWith(protocol.toLowerCase() + ":"));
    if (link) return link;
  }
  return undefined;
}

function fakeSession(): import("./auth").HavocSession {
  return { sessionToken: "dev-session-token", user: { id: "dev", email: "dev@local", name: "Dev", image: null } };
}

async function initiateSignIn(): Promise<void> {
  if (!auth) return;
  pending = createPendingContext();
  await auth.begin(pending);
}

/* ------------------------------- Overlay ---------------------------------- */

function openOverlayPopout(room: ProducerRoom): void {
  const url = overlayPopoutUrl(cfg.overlayOrigin, room.roomId, room.overlayId ?? "ingame-hud", "default", cfg.bridgeOrigin);
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    overlayWindow = new BrowserWindow({
      show: false, frame: false, transparent: true, hasShadow: false,
      resizable: false, movable: false, alwaysOnTop: true, fullscreenable: false,
      backgroundColor: "#00000000", width: 800, height: 600, x: 100, y: 100,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.setAlwaysOnTop(true, "screen-saver");
  }
  void overlayWindow.loadURL(url);
  logger.info("overlay", "open", { url });
}

function followGameWindow(): void {
  try {
    followGameWindowUnsafe();
  } catch (error) {
    // Win32 FFI + window ops run on a 1s timer; a throw must not kill the app.
    logger.error("overlay", "follow_window_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function followGameWindowUnsafe(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (!overlayRequested) {
    if (overlayWindow.isVisible()) overlayWindow.hide();
    return;
  }
  const bounds = getWindowBoundsByTitle(cfg.gameWindowTitle);
  // Original behaviour: the anchored HUD shows whenever the game window is
  // present (agent select included) — the HUD page renders its own state.
  if (!bounds.isVisible || bounds.isMinimized || bounds.width <= 0) {
    if (overlayWindow.isVisible()) overlayWindow.hide();
    return;
  }
  try {
    overlayWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  } catch {
    /* race with destroy */
  }
  const handleBuf = overlayWindow.getNativeWindowHandle();
  let hwnd = 0;
  try {
    hwnd = handleBuf.length >= 8 ? Number(handleBuf.readBigUInt64LE(0)) : handleBuf.readUInt32LE(0);
  } catch {
    /* ignore */
  }
  placeOverlayAboveGame(hwnd, cfg.gameWindowTitle);
  if (!overlayWindow.isVisible()) overlayWindow.showInactive();
}
async function boot(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    console.log("[havoc-unleash] another instance holds the lock; exiting");
    app.exit(0);
    return;
  }
  cfg = loadConfig();
  logger.info("app", "bootstrap_started", { win32Bridge: isWin32BridgeAvailable() });

  projection = new ValProjectionSession();
  hudServer = new HudServer(
    cfg.hudPort,
    hudPublicDir(),
    shellControls,
    // Local-first: persist the latest broadcast frame under userData/state so
    // a restart repaints the overlay instantly (see hudServer persistence).
    path.join(app.getPath("userData"), "state"),
  );
  gateway = new LocalGateway(cfg.gatewayPort, () => {});
  await Promise.all([hudServer.start(), gateway.start()]);

  projection.subscribe(() => {
    hudServer.publish(projection.snapshotValue());
    // Broadcast-snapshot channel: the SAME GameSnapshot the bridge receives,
    // pushed locally (revision + observedAt) for ?local=1 authoritative overlays.
    hudServer.publishBroadcast(toGameSnapshot(projection.snapshotValue()));
    queuePublish();
  });

  client = new GameDataRuntimeClient(cfg.runtimeOrigin, {
    onFact: ({ key, value }) => {
      // A2: surface the GEP telemetry-delivery state machine on /api/status.
      // provider_status facts carry {key, value:{state, previous, ...}}.
      if (key === "provider_status") {
        const rec = value as
          | { key?: unknown; value?: { state?: unknown } | null }
          | null;
        if (rec?.key === "provider_telemetry_state") {
          const state = (rec.value as { state?: unknown } | null)?.state;
          if (typeof state === "string") {
            gepTelemetryState = state;
            gepTelemetryStateAt = Date.now();
          }
        }
      }
      projection.applyFact(key, value);
    },
    onScore: (score) => projection.applyScore(score.blue, score.red, score.matchId),
    onSnapshot: (snapshot) => projection.applySnapshot(snapshot),
    onGameState: (frame) => logger.info("runtime-client", "game_state_event", { kind: frame.kind }),
    onStatus: (status) => logger.info("runtime-client", "status", status),
  });

  await Promise.race([
    app.whenReady(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("app.whenReady timed out")), 12_000),
    ),
  ]);

  registerProtocol();

  // PASS 9 (R2): state which source produced this artifact. Logged on every
  // start so a support bundle can answer "which build was running?" without
  // trusting the working tree. Contains no user data by construction.
  const buildInfo = getBuildInfo();
  logger.info("app", "build_provenance", { ...buildInfo });

  // PASS 9 (R4): expose the support-bundle collector over IPC. Deliberately an
  // IPC surface rather than a UI change — the desktop has no support menu, and
  // the operator path (dev-utils/make-support-bundle.mjs) works without the app
  // running at all. Failures are returned, never silently swallowed.
  ipcMain.handle("hu:support-bundle", (_event, outDir: unknown) => {
    const dir = typeof outDir === "string" && outDir.length > 0 ? outDir : path.join(app.getPath("documents"), "havoc-support");
    try {
      const result = createSupportBundle({ outDir: dir, buildInfo });
      logger.info("app", "support_bundle", {
        ok: result.ok,
        bundleDir: result.bundleDir ?? null,
        hasArchive: result.archivePath !== null && result.archivePath !== undefined,
        error: result.error ?? null,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("app", "support_bundle_failed", { error: message });
      return { ok: false, error: message };
    }
  });

  spawnRuntimeIfNeeded();
  // HAVOC_APP_WINDOW (REA parity): "hidden"/"overlay" boot as a background
  // companion — no shell window until the user clicks the app again
  // (second-instance handler below recreates it). "visible" (default)
  // preserves the current show-at-boot behaviour.
  if (cfg.appWindow === "visible") createShellWindow();
  setInterval(followGameWindow, FOLLOW_INTERVAL_MS);
  void client!.start();

  auth = new DesktopAuth(cfg.appBase, cfg.bridgeOrigin, cfg.desktopProtocol, createSessionStore());
  app.on("second-instance", (_event, argv) => {
    const link = extractDeepLink(argv, cfg.desktopProtocols);
    if (link) handleDeepLink(link);
    createShellWindow();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  const saved = cfg.skipLogin ? fakeSession() : auth.load();
  if (saved) {
    session = saved;
    logger.info("app", "restored_session", {
      userId: saved.user.id,
      skipLogin: cfg.skipLogin,
    });
    void connectProducer();
  } else {
    // Manual flow (like the original): the shell shows the Discord sign-in
    // button; nothing opens the browser until the user clicks it.
    logger.info("app", "awaiting_sign_in");
  }

  logger.info("app", "bootstrap_completed");

  const smokeMs = Number(process.env.HAVOC_SMOKE_QUIT_MS ?? 0);
  if (smokeMs > 0) {
    setTimeout(() => {
      logger.info("app", "smoke_quit");
      app.exit(0);
    }, smokeMs);
  }
}

const FOLLOW = 1_000;
void boot().catch((error) => {
  logger.error("app", "init_error", {
    error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
  });
});

app.on("before-quit", () => {
  client?.stop();
  runtimeChild?.kill();
  void producer?.stop();
});

app.on("window-all-closed", () => {
  /* stay alive as a companion/overlay host with hidden windows */
});

