/**
 * HUD origin (:7103): static browser-source pages + REST snapshot + WS push.
 *   GET /            -> HUD page (OBS browser source target)
 *   GET /api/state   -> current HudRelayState JSON
 *   WS   /ws         -> server-pushes every new state (retained latest on join)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

import type { HudRelayState } from "@havoc-unleash/contracts";
import { logger } from "./logger";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Control-plane handlers the shell UI calls (wired to main-process actions). */
export interface ShellControls {
  status(): ShellStatus;
  startSignIn(): void;
  listRooms(): Promise<Array<{ roomId: string; roomName: string; roomGame: string }>>;
  joinRoom(roomId: string): Promise<{ ok: boolean; error?: string }>;
  leaveRoom(): Promise<{ ok: boolean; error?: string }>;
  resetNetwork(): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  toggleOverlay(): Promise<{ on: boolean }>;
  /** v11 A1 — OCR backup toggle (persisted; default OFF). */
  setOcrSettings(next: { enabled?: boolean }): { enabled: boolean };
  /** v11 C12 — build a support bundle and return its folder. */
  createSupportBundle(): Promise<{ ok: boolean; dir?: string; error?: string }>;
}

export interface ShellStatus {
  signedIn: boolean;
  userName: string | null;
  room: { roomId: string; roomName: string } | null;
  connecting: boolean;
  overlayRequested: boolean;
  runtimeConnected: boolean;
  /** A2: GEP telemetry-delivery state (additive) — e.g. HEALTHY / CONNECTED_BUT_NO_TELEMETRY. */
  gepTelemetry: { state: string; at: number; lastDataAt: number | null } | null;
  /** v11 C11 — versions strip: what is running and when the game last changed. */
  versions: {
    app: string;
    gepPackage: string | null;
    gameBuildAt: number | null;
    gameRecentlyUpdated: boolean;
  };
  /** v11 A — OCR backup state (default disabled). */
  ocr: {
    enabled: boolean;
    engaged: boolean;
    engineError: string | null;
    lastReadAt: number | null;
    hint: string | null;
    score: { left: number; right: number } | null;
  };
  live: {
    sessionPhase: string;
    mapName: string | null;
    scene: string | null;
    score: { blue: number; red: number } | null;
    roundNumber: number | null;
  } | null;
}

export class HudServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private lastState: HudRelayState | null = null;
  // Broadcast-snapshot channel (/ws/broadcast): pushes the SAME GameSnapshot
  // shape the bridge distributes — the website's ?local=1 authoritative source.
  private broadcastClients = new Set<WebSocket>();
  private lastBroadcast: unknown = null;
  /** The HTTP listener — kept so the server can be shut down (tests / quit path). */
  private server: http.Server | null = null;
  // Local-first persistence (Phase 1): the latest broadcast frame is written
  // through to disk (atomic tmp+rename, throttled) so an app restart repaints
  // the overlay INSTANTLY from state/live-snapshot.json instead of waiting for
  // the first live game frame. Never on the hot path: write failures are
  // swallowed (the in-memory frame is authoritative).
  private stateFile: string | null = null;
  private persistTimer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly port: number,
    private readonly publicDir: string,
    private readonly controls?: ShellControls,
    stateDir?: string,
  ) {
    if (stateDir) {
      // Own the state layout up front (BLOB's DesktopRuntimeStorage pattern):
      // Electron only creates userData itself, never its subfolders.
      try {
        fs.mkdirSync(stateDir, { recursive: true });
        this.stateFile = path.join(stateDir, "live-snapshot.json");
      } catch (error) {
        logger.warn("hud-server", "state_dir_create_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  public async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      try {
        this.route(req, res);
      } catch (error) {
        // A handler defect must never escape as an uncaught exception: inside the
        // Electron main process that becomes a BLOCKING error dialog and freezes
        // the whole publisher (2026-09-24: GET /api/status threw a ZodError and
        // took the runtime stream, the bot publisher and the relay down with it).
        logger.error("hud-server", "route_error", {
          url: req.url ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "internal" }));
        } catch {
          /* connection already gone */
        }
      }
    });
    this.server = server;
    this.wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
      if (url.pathname === "/ws" && this.wss) {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.clients.add(ws);
          logger.debug("hud-server", "ws_client_connected", { clients: this.clients.size });
          ws.send(JSON.stringify(this.lastState ?? { revision: -1 }));
          ws.on("close", () => this.clients.delete(ws));
          ws.on("error", () => this.clients.delete(ws));
        });
      } else if (url.pathname === "/ws/broadcast" && this.wss) {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.broadcastClients.add(ws);
          if (this.lastBroadcast != null) ws.send(JSON.stringify(this.lastBroadcast));
          ws.on("close", () => this.broadcastClients.delete(ws));
          ws.on("error", () => this.broadcastClients.delete(ws));
        });
      } else {
        socket.destroy();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(this.port, "127.0.0.1", () => resolve());
    });
    this.restorePersistedBroadcast();
    logger.info("hud-server", "listening", { port: this.port });
  }

  /** Release the listener + push channels (tests and the app's quit path). */
  public async stop(): Promise<void> {
    // Final flush: the quit path must not lose the newest frame.
    this.flushBroadcastState();
    for (const ws of [...this.clients, ...this.broadcastClients]) {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
    this.broadcastClients.clear();
    this.wss?.close();
    this.wss = null;
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Throttle-free direct push; UI layers coalesce their own animation. */
  public publish(state: HudRelayState): void {
    this.lastState = state;
    if (process.env.HAVOC_DEBUG_PIPELINE === "1") {
      // Boundary telemetry: normalized game state forwarded to the overlay.
      logger.debug("hud-server", "state_pushed_to_overlay", {
        wsClients: this.clients.size,
        revision: state.revision,
        sessionPhase: state.sessionPhase,
        scene: state.scene,
        roster: state.roster?.length ?? 0,
        round: `${state.round.number}/${state.round.phase}`,
        score: `${state.score.blue}-${state.score.red}`,
      });
    }
    const payload = JSON.stringify(state);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  /** Broadcast-snapshot push: revisioned GameSnapshot frames for ?local=1 overlays. */
  public publishBroadcast(snapshot: unknown): void {
    const state = (snapshot as { state?: { observedAt?: number; timeout?: unknown } } | null)?.state;
    this.lastBroadcast = {
      kind: "broadcast",
      revision: (this.lastState?.revision as number) ?? 0,
      observedAt: state?.observedAt ?? Date.now(),
      snapshot,
      // Tactical timeout / tech pause (BLOB parity): the website's TimeoutOverlay
      // reads frame.timeout = {team, calledAt, timeoutType} (null when idle).
      timeout: state?.timeout ?? null,
    };
    this.scheduleBroadcastPersist();
    const payload = JSON.stringify(this.lastBroadcast);
    for (const ws of this.broadcastClients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  /* ------------------------- local-first persistence ------------------------ */

  /** Restore the persisted frame BEFORE any live publish (instant repaint). */
  private restorePersistedBroadcast(): void {
    if (!this.stateFile) return;
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.snapshot) {
        this.lastBroadcast = parsed;
        logger.info("hud-server", "broadcast_state_restored", {
          observedAt: (parsed as { observedAt?: number }).observedAt ?? null,
        });
      }
    } catch (error) {
      logger.warn("hud-server", "broadcast_state_restore_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Throttled (1/s) schedule — snapshots publish ~250ms; never queue up. */
  private scheduleBroadcastPersist(): void {
    if (!this.stateFile || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushBroadcastState();
    }, 1_000);
    this.persistTimer.unref?.();
  }

  /** Atomic tmp+rename write of the latest frame; failures are non-fatal. */
  private flushBroadcastState(): void {
    if (!this.stateFile || this.lastBroadcast == null) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.lastBroadcast));
      fs.renameSync(tmp, this.stateFile);
    } catch (error) {
      logger.debug("hud-server", "broadcast_state_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const controls = this.controls;
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };

    // ---- Shell control plane (local-only; the server binds 127.0.0.1) ----
    if (controls && req.method === "GET" && url.pathname === "/api/status") {
      send(200, controls.status());
      return;
    }
    if (controls && req.method === "POST" && url.pathname === "/api/auth/start") {
      controls.startSignIn();
      send(200, { ok: true });
      return;
    }
    if (controls && req.method === "GET" && url.pathname === "/api/rooms") {
      void controls
        .listRooms()
        .then((rooms) => send(200, { rooms }))
        .catch((error) => send(502, { rooms: [], error: String(error) }));
      return;
    }
    if (controls && req.method === "POST" && url.pathname === "/api/room/join") {
      void this.readBody(req).then((body) => {
        const roomId = String((body as { roomId?: unknown }).roomId ?? "").trim();
        if (!roomId) {
          send(400, { ok: false, error: "roomId required" });
          return;
        }
        void controls
          .joinRoom(roomId)
          .then((r) => send(200, r))
          .catch((error) => send(502, { ok: false, error: String(error) }));
      });
      return;
    }
    if (controls && req.method === "POST" && url.pathname === "/api/room/leave") {
      void controls
        .leaveRoom()
        .then((r) => send(200, r))
        .catch((error) => send(502, { ok: false, error: String(error) }));
      return;
    }
    if (controls && req.method === "POST" && url.pathname === "/api/network/reset") {
      void controls
        .resetNetwork()
        .then((r) => send(200, r))
        .catch((error) => send(502, { ok: false, error: String(error) }));
      return;
    }
    if (controls && req.method === "POST" && url.pathname === "/api/overlay/toggle") {
      void controls
        .toggleOverlay()
        .then((r) => send(200, r))
        .catch((error) => send(502, { on: false, error: String(error) }));
      return;
    }
    // v11 A1 — OCR backup toggle (persisted, default OFF).
    if (controls && req.method === "POST" && url.pathname === "/api/ocr/settings") {
      void this.readBody(req).then((body) => {
        const next = body as { enabled?: unknown };
        try {
          const settings = controls.setOcrSettings({ enabled: next?.enabled === true });
          send(200, { ok: true, settings });
        } catch (error) {
          send(500, { ok: false, error: String(error) });
        }
      });
      return;
    }
    // v11 C12 — one-click support bundle (logs + state summary + provenance).
    if (controls && req.method === "POST" && url.pathname === "/api/support-bundle") {
      void controls
        .createSupportBundle()
        .then((r) => send(200, r))
        .catch((error) => send(502, { ok: false, error: String(error) }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/broadcast") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(this.lastBroadcast ?? { kind: "broadcast", revision: 0, snapshot: null }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify(
          this.lastState ?? {
            revision: -1,
            connectedToRuntime: false,
            game: null,
            sessionPhase: "idle",
            matchId: null,
            mapKey: null,
            viewerRole: "unknown",
            roster: [],
            round: { number: 0, phase: "unknown", phaseStartedAt: null },
            score: { blue: 0, red: 0 },
            spike: null,
            killfeed: [],
            updatedAt: Date.now(),
          },
        ),
      );
      return;
    }

    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.join(this.publicDir, path.normalize(rel).replace(/^([/\\])+/, ""));
    if (!filePath.startsWith(this.publicDir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream",
        "cache-control": "no-cache",
      });
      res.end(data);
    });
  }

  /** Read and parse a JSON request body (size-capped). */
  private readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        if (data.length > 64 * 1024) req.destroy();
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(data || "{}"));
        } catch {
          resolve({});
        }
      });
      req.on("error", () => resolve({}));
    });
  }
}
