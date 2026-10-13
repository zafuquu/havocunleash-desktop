/**
 * Spectra bridge data source — connects to a running ValoSpectra Server
 * (https://github.com/ValoSpectra/Spectra-Server) via Socket.IO and
 * transforms their wire format into the fork's ProviderFact stream.
 *
 * This lets the full HU pipeline (runtime → desktop → bridge → overlays)
 * work with REAL Valorant data captured by the Spectra Client (which has
 * its own Overwolf GEP license), without needing your own license.
 *
 * Activate with:  HAVOC_SOURCE=spectra
 *
 * Required env:
 *   SPECTRA_SERVER_URL   - Spectra Server WebSocket URL (default: https://localhost:5100)
 *   SPECTRA_GROUP_CODE   - Match group code from Spectra Client
 *   SPECTRA_OBS_NAME     - Observer name for auth (default: havoc-bridge)
 *
 * Optional env:
 *   SPECTRA_AUTH_KEY     - Auth key if Spectra Server requires one
 *   SPECTRA_INSECURE     - Set to "1" to allow self-signed TLS certs
 */

import type { ProviderFact, SourceEmit } from "./mock-source";

// ─── Spectra wire types (mirrors Spectra-Server/src/model/eventData.ts) ───

/** Spectra DataTypes enum values (strings in transit). */
const SpectraDataTypes = {
  AUTH: "AUTH",
  AUTH_ACK: "AUTH_ACK",
  SCOREBOARD: "SCOREBOARD",
  KILLFEED: "KILLFEED",
  ROSTER: "ROSTER",
  ROUND_INFO: "ROUND_INFO",
  SCORE: "SCORE",
  SERIES_INFO: "SERIES_INFO",
  SEEDING_INFO: "SEEDING_INFO",
  TOURNAMENT_INFO: "TOURNAMENT_INFO",
  SPONSOR_INFO: "SPONSOR_INFO",
  WATERMARK_INFO: "WATERMARK_INFO",
  PLAYERCAMS_INFO: "PLAYERCAMS_INFO",
  TIMEOUT_INFO: "TIMEOUT_INFO",
  ROUND_WIN_BOX: "ROUND_WIN_BOX",
  TOAST: "TOAST",
  MIDMATCH: "MIDMATCH",
} as const;

interface SpectraScoreboard {
  name: string;
  tagline: string;
  playerId: string;
  startTeam: number;
  agentInternal: string;
  isAlive: boolean;
  initialArmor: number;
  scoreboardWeaponInternal: string;
  currUltPoints: number;
  maxUltPoints: number;
  hasSpike: boolean;
  money: number;
  kills: number;
  deaths: number;
  assists: number;
}

interface SpectraKillfeed {
  attacker: string;
  victim: string;
  weaponKillfeedInternal: string;
  headshotKill: boolean;
  assists: string[];
  isTeamkill: boolean;
}

interface SpectraRoster {
  name: string;
  tagline: string;
  startTeam: number;
  agentInternal: string;
  playerId: string;
  position: number;
  locked: boolean;
  rank: number;
}

interface SpectraRoundInfo {
  roundPhase: string;
  roundNumber: number;
}

interface SpectraScore {
  team_0: number;
  team_1: number;
}

interface SpectraMessage {
  obsName?: string;
  groupCode?: string;
  type: string;
  timestamp?: number;
  data: unknown;
}

// ─── Data mappers ────────────────────────────────────────────────────────

function mapScoreboard(data: SpectraScoreboard): Record<string, unknown> {
  // Split agentInternal (e.g. "Jett" or internal name) for compatibility
  const nameParts = (data.name ?? "").split(" #");
  return {
    player_id: data.playerId,
    name: nameParts[0] ?? data.name,
    tagline: data.tagline ?? nameParts[1] ?? "",
    team: data.startTeam,
    character: data.agentInternal,
    alive: data.isAlive,
    shield: data.initialArmor,
    weapon: data.scoreboardWeaponInternal,
    ult_points: data.currUltPoints,
    ult_max: data.maxUltPoints,
    hasSpike: data.hasSpike,
    money: data.money,
    credits: data.money,
    kills: data.kills,
    deaths: data.deaths,
    assists: data.assists,
  };
}

function mapKillfeed(data: SpectraKillfeed): Record<string, unknown> {
  return {
    attacker: data.attacker,
    victim: data.victim,
    weapon: data.weaponKillfeedInternal,
    modifier: data.headshotKill ? "headshot" : "bodyshot",
    assists: data.assists ?? [],
    is_teamkill: data.isTeamkill,
  };
}

function mapRoster(data: SpectraRoster): Record<string, unknown> {
  return {
    player_id: data.playerId,
    name: data.name,
    tagline: data.tagline ?? "",
    team: data.startTeam,
    character: data.agentInternal,
    position: data.position,
    locked: data.locked,
    rank: data.rank,
  };
}

// ─── Spectra Source class ────────────────────────────────────────────────

export type SpectraState = "disconnected" | "connecting" | "connected" | "authenticated" | "error";

export interface SpectraHealth {
  state: SpectraState;
  lastError: string | null;
  serverUrl: string;
  groupCode: string;
  eventsReceived: number;
}

export class SpectraSource {
  private emitFn: SourceEmit | null = null;
  private socket: ReturnType<typeof import("socket.io-client").io> | null = null;
  private stopped = false;
  private state: SpectraState = "disconnected";
  private lastError: string | null = null;
  private eventsReceived = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly serverUrl: string;
  private readonly groupCode: string;
  private readonly obsName: string;
  private readonly authKey: string;
  private readonly insecure: boolean;
  private lastRoundPhase: string | null = null;
  private lastRoundNumber: number | null = null;

  constructor() {
    this.serverUrl = (process.env.SPECTRA_SERVER_URL ?? "https://localhost:5100").replace(/\/+$/, "");
    this.groupCode = (process.env.SPECTRA_GROUP_CODE ?? "").toUpperCase();
    this.obsName = process.env.SPECTRA_OBS_NAME ?? "havoc-bridge";
    this.authKey = process.env.SPECTRA_AUTH_KEY ?? "";
    this.insecure = process.env.SPECTRA_INSECURE === "1";
  }

  start(emit: SourceEmit): boolean {
    if (this.socket) return true;
    this.emitFn = emit;

    if (!this.groupCode) {
      this.state = "error";
      this.lastError = "SPECTRA_GROUP_CODE not set — cannot connect to Spectra Server";
      console.warn(`[spectra-source] ${this.lastError}`);
      return false;
    }

    this.connect();
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.state = "disconnected";
  }

  health(): SpectraHealth {
    return {
      state: this.state,
      lastError: this.lastError,
      serverUrl: this.serverUrl,
      groupCode: this.groupCode,
      eventsReceived: this.eventsReceived,
    };
  }

  private connect(): void {
    if (this.stopped) return;
    this.state = "connecting";
    console.log(`[spectra-source] connecting to ${this.serverUrl} (group: ${this.groupCode})...`);

    // Dynamic import: socket.io-client is an optional dependency
    let ioConnect: typeof import("socket.io-client").io;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ioModule = require("socket.io-client") as typeof import("socket.io-client");
      ioConnect = ioModule.io;
    } catch {
      this.state = "error";
      this.lastError = "socket.io-client not installed — run: npm install socket.io-client";
      console.error(`[spectra-source] ${this.lastError}`);
      return;
    }

    this.socket = ioConnect(this.serverUrl, {
      rejectUnauthorized: !this.insecure,
      transports: ["websocket", "polling"],
      reconnection: false, // We handle reconnection ourselves
    });

    this.socket.on("connect", () => {
      console.log(`[spectra-source] connected to ${this.serverUrl}`);
      this.state = "connected";
      this.lastError = null;
      this.authenticate();
    });

    this.socket.on("disconnect", (reason: string) => {
      console.warn(`[spectra-source] disconnected: ${reason}`);
      this.state = "disconnected";
      this.scheduleReconnect();
    });

    this.socket.on("connect_error", (err: Error) => {
      this.state = "error";
      this.lastError = `connection failed: ${err.message}`;
      console.error(`[spectra-source] ${this.lastError}`);
      this.scheduleReconnect();
    });

    // ── Spectra data events ──

    // The Spectra Server emits "game_data" for all game state updates
    this.socket.on("game_data", (msg: string) => this.handleGameData(msg));

    // Some Spectra versions use per-type channels
    this.socket.on("obs_data", (msg: string) => this.handleGameData(msg));

    // Auth acknowledgment
    this.socket.on("obs_logon_ack", (msg: string) => {
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.type === "AUTH_ACK" || parsed?.success) {
          this.state = "authenticated";
          console.log(`[spectra-source] authenticated as "${this.obsName}" in group ${this.groupCode}`);
          this.emitProviderStatus("provider_ready", { source: "spectra", groupCode: this.groupCode });
        } else {
          this.state = "error";
          this.lastError = `auth rejected: ${JSON.stringify(parsed)}`;
          console.error(`[spectra-source] ${this.lastError}`);
        }
      } catch {
        // Some servers send a simple string ack
        this.state = "authenticated";
        console.log(`[spectra-source] authenticated (simple ack)`);
        this.emitProviderStatus("provider_ready", { source: "spectra", groupCode: this.groupCode });
      }
    });

    // Forward connection status to the pipeline
    this.emitProviderStatus("game_detected", { source: "spectra", serverUrl: this.serverUrl });
  }

  private authenticate(): void {
    if (!this.socket?.connected) return;

    const authPayload: Record<string, unknown> = {
      type: SpectraDataTypes.AUTH,
      obsName: this.obsName,
      groupCode: this.groupCode,
      version: "1.0.0-havoc",
    };

    if (this.authKey) {
      authPayload.key = this.authKey;
    }

    this.socket.emit("obs_logon", JSON.stringify(authPayload));
    console.log(`[spectra-source] sent obs_logon (group: ${this.groupCode})`);
  }

  private handleGameData(msg: string): void {
    let parsed: SpectraMessage;
    try {
      parsed = JSON.parse(msg) as SpectraMessage;
    } catch {
      return; // malformed
    }

    this.eventsReceived++;

    const type = parsed.type ?? "";
    const data = parsed.data;

    switch (type) {
      case SpectraDataTypes.SCOREBOARD:
        if (data && typeof data === "object") {
          this.pushInfo("scoreboard", mapScoreboard(data as SpectraScoreboard));
        }
        break;

      case SpectraDataTypes.KILLFEED:
        if (data && typeof data === "object") {
          this.pushEvent("kill_feed", mapKillfeed(data as SpectraKillfeed));
        }
        break;

      case SpectraDataTypes.ROSTER:
        if (data && typeof data === "object") {
          this.pushInfo("roster", mapRoster(data as SpectraRoster));
        }
        break;

      case SpectraDataTypes.ROUND_INFO:
        if (data && typeof data === "object") {
          const roundInfo = data as SpectraRoundInfo;
          // Only emit if changed to avoid flooding
          if (roundInfo.roundPhase && roundInfo.roundPhase !== this.lastRoundPhase) {
            this.lastRoundPhase = roundInfo.roundPhase;
            this.pushInfo("round_phase", roundInfo.roundPhase);
          }
          if (roundInfo.roundNumber != null && roundInfo.roundNumber !== this.lastRoundNumber) {
            this.lastRoundNumber = roundInfo.roundNumber;
            this.pushInfo("round_number", roundInfo.roundNumber);
          }
        }
        break;

      case SpectraDataTypes.SCORE:
        if (data && typeof data === "object") {
          const score = data as SpectraScore;
          if (typeof score.team_0 === "number" && typeof score.team_1 === "number") {
            this.pushInfo("match_score", { team_0: score.team_0, team_1: score.team_1 });
          }
        }
        break;

      case SpectraDataTypes.MIDMATCH:
        // Mid-match events (pause, tech timeout etc.)
        if (data && typeof data === "object") {
          const midmatch = data as { type?: string };
          if (midmatch.type === "spike_planted") this.pushEvent("spike_planted", true);
          else if (midmatch.type === "spike_defused") this.pushEvent("spike_defused", true);
          else if (midmatch.type === "spike_detonated") this.pushEvent("spike_detonated", true);
        }
        break;

      // ── Extended data (forwarded for bridge/overlay consumption) ──

      case SpectraDataTypes.SERIES_INFO:
      case SpectraDataTypes.TOURNAMENT_INFO:
      case SpectraDataTypes.SEEDING_INFO:
      case SpectraDataTypes.SPONSOR_INFO:
      case SpectraDataTypes.WATERMARK_INFO:
      case SpectraDataTypes.PLAYERCAMS_INFO:
      case SpectraDataTypes.TIMEOUT_INFO:
      case SpectraDataTypes.ROUND_WIN_BOX:
      case SpectraDataTypes.TOAST:
        // Forward as-is for the overlay to pick up
        this.pushInfo(`spectra_${type.toLowerCase()}`, data);
        break;

      case SpectraDataTypes.AUTH:
      case SpectraDataTypes.AUTH_ACK:
        // Already handled in the obs_logon_ack listener
        break;

      default:
        // Unknown type — forward anyway so nothing is lost
        if (data != null) {
          this.pushInfo(`spectra_unknown_${type.toLowerCase()}`, data);
        }
        break;
    }
  }

  private pushInfo(key: string, value: unknown): void {
    this.emitFn?.({ kind: "new_info_update", key, value });
  }

  private pushEvent(key: string, value: unknown): void {
    this.emitFn?.({ kind: "new_game_event", key, value });
  }

  private emitProviderStatus(key: string, value: unknown): void {
    this.emitFn?.({
      kind: "new_game_event",
      key: "provider_status",
      value: { key, value, at: Date.now() },
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = 5_000;
    console.log(`[spectra-source] reconnecting in ${delay / 1000}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
      }
      this.connect();
    }, delay);
  }
}
