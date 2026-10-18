/**
 * Game-data runtime HTTP service (upstream-wire-compatible).
 * GET /health, GET /events SSE. First data frame is always a
 * valorant_session_snapshot envelope.
 *
 * Data sources:
 *  - default: Overwolf GEP provider (real, live Valorant data via the same
 *    Game Events Provider the original HAVOC runtime uses). Never invents
 *    players: teams stay empty until a real match reports them.
 *  - HAVOC_SOURCE=mock: deterministic mock source (dev only).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import {
  GAME_DATA_PROTOCOL_VERSION,
  GAME_DATA_RUNTIME_PATHS,
  gameDataRuntimeHealthSchema,
  type GameDataRuntimeHealth,
} from "@havoc-unleash/contracts";

import { MockValorantSource, ROSTER } from "./mock-source";
import { GepProviderSource } from "./gep-capture";
import { SpectraSource } from "./spectra-source";
import { RiotIdentitySource } from "./riot-identity";
import { ValRoundEngine, type ValNativeRoundSettlement } from "./val-engine";
import { checkValorantProcess, getValorantProcessId } from "./valorant-detect";

const PORT = Number(process.env.PORT ?? 7423);
const HEARTBEAT_MS = 15_000;
const SNAP_EVENT = "valorant_session_snapshot";
const KILLFEED_CAP = 12;

/** Pipeline telemetry — enabled with HAVOC_DEBUG_PIPELINE=1 (no secrets). */
function pipelineDebug(...args: unknown[]): void {
  if (process.env.HAVOC_DEBUG_PIPELINE === "1") console.log("[pipeline:runtime]", ...args);
}
let pipelineFactCount = 0;

type Frame = Record<string, unknown>;

/** Player record accumulated from real GEP scoreboard/roster facts. */
interface RealPlayer {
  playerId: string;
  name: string;
  tagline: string;
  agent: string | null;
  weapon: string | null;
  team: number | null;
  observerSlot: number | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  credits: number | null;
  health: number | null;
  isAlive: boolean | null;
  hasSpike: boolean | null;
  ultPoints: number | null;
  ultMax: number | null;
  shield: number | null;
  shieldType: number | null;
}

const num = (v: unknown, fallback: number | null): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  return fallback;
};

function upsertPlayer(players: Map<string, RealPlayer>, patch: Record<string, unknown>): void {
  const id = String(patch.player_id ?? "").trim();
  const name = String(patch.name ?? "").trim();
  if (!id && !name) return;
  const key = id || name;
  const prev: RealPlayer =
    players.get(key) ??
    players.get(name) ?? {
      playerId: id || name,
      name: name || id,
      tagline: "",
      agent: null,
      weapon: null,
      team: null,
      observerSlot: null,
      kills: null,
      deaths: null,
      assists: null,
      credits: null,
      health: null,
      isAlive: null,
      hasSpike: null,
      ultPoints: null,
      ultMax: null,
      shield: null,
      shieldType: null,
    };
  const next: RealPlayer = {
    playerId: id || prev.playerId,
    name: name || prev.name,
    tagline: typeof patch.tagline === "string" && patch.tagline ? patch.tagline : prev.tagline,
    agent: typeof patch.character === "string" && patch.character ? patch.character : prev.agent,
    weapon: typeof patch.weapon === "string" && patch.weapon ? patch.weapon : prev.weapon,
    team: num(patch.team, prev.team),
    observerSlot: num(patch.position ?? patch.observerSlot, prev.observerSlot),
    kills: num(patch.kills, prev.kills),
    deaths: num(patch.deaths, prev.deaths),
    assists: num(patch.assists, prev.assists),
    credits: num(patch.credits, prev.credits),
    health: num(patch.health, prev.health),
    isAlive: typeof patch.alive === "boolean" ? patch.alive : prev.isAlive,
    hasSpike: typeof patch.hasSpike === "boolean" ? patch.hasSpike : prev.hasSpike,
    ultPoints: num(patch.ultPoints, prev.ultPoints),
    ultMax: num(patch.ultMax, prev.ultMax),
    shield: num(patch.shield, prev.shield),
    shieldType: num(patch.shieldType, prev.shieldType),
  };
  players.delete(key);
  players.delete(prev.name);
  players.set(next.playerId || next.name, next);
}

function playerToSnapshot(p: RealPlayer): Record<string, unknown> {
  const agent = p.agent ?? "";
  return {
    agent: { key: agent.toLowerCase(), name: agent, riotId: p.name },
    observerSlot: p.observerSlot ?? 0,
    player: {
      identity: {
        displayName: p.tagline ? `${p.name}#${p.tagline}` : p.name,
        gameName: p.name,
        tagLine: p.tagline,
      },
      // Live scoreboard detail (desktop projection forwards these).
      playerId: p.playerId,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      credits: p.credits,
      health: p.health,
      isAlive: p.isAlive,
      hasSpike: p.hasSpike,
      ultPoints: p.ultPoints,
      ultMax: p.ultMax,
      shield: p.shield,
      shieldType: p.shieldType,
      weapon: p.weapon,
    },
    teamIndex: p.team ?? undefined,
  };
}

class RuntimeHub {
  private readonly subscribers = new Map<number, http.ServerResponse>();
  private nextSubscriberId = 1;
  private nextFrameId = 1;
  private readonly source = new MockValorantSource();
  private readonly gep = new GepProviderSource();
  private readonly spectra = new SpectraSource();
  /** Mock only when explicitly requested; real GEP is the default. */
  private readonly useMock: boolean;
  /** Spectra bridge mode: connect to a running ValoSpectra Server. */
  private readonly useSpectra: boolean;
  private revision = 0;
  private matchId: string | null = null;
  private sessionPhase: "idle" | "loading" | "live" | "ending" = "idle";
  private currentScene: string | null = null;
  private mapKey: string | null = null;
  private score: { blue: number; red: number } | null = null;
  private errorState: string | null = null;
  private readonly bootedAt = Date.now();
  private valorantDetected = false;
  private detectorTimer: NodeJS.Timeout | null = null;
  private readonly identity = new RiotIdentitySource((fact) => this.acceptFact(fact));
  private readonly engine = new ValRoundEngine((result) => this.broadcastRoundSettled(result));
  private priorityBoosted = false;
  /** Real players reported by GEP (never faked). */
  private readonly players = new Map<string, RealPlayer>();
  private killfeed: unknown[] = [];
  /** GEP "me" player id — routes live local_health updates to the right player. */
  private localPlayerId: string | null = null;
  /**
   * The LOCAL player's GEP start team (0/1), from the `me`-routed player id
   * matched against the scoreboard roster. Every published side must be
   * VIEWER-anchored (Blue = the local player's team) — native team_0
   * ordering inverted the scoreline/panels for a non-team-1 viewer
   * (live 2026-10-18: "enemy scored 1:2, a split second later it swapped
   * to 2:1" — the native-ordered snapshot heartbeat fought the anchored
   * fact score and the roster sides, corrupting the round-delta
   * bookkeeping behind the round-reason strip).
   */
  private localTeam(): 0 | 1 | null {
    if (!this.localPlayerId) return null;
    const local = [...this.players.values()].find((p) => p.playerId === this.localPlayerId);
    return local && (local.team === 0 || local.team === 1) ? local.team : null;
  }

  constructor() {
    const source = (process.env.HAVOC_SOURCE ?? "").toLowerCase();
    this.useMock = source === "mock";
    this.useSpectra = source === "spectra";
    if (this.useMock) {
      this.source.start((fact) => this.acceptFact(fact));
    } else if (this.useSpectra) {
      // Spectra bridge: connect to a running ValoSpectra Server via Socket.IO
      // and transform their wire format into our ProviderFact stream.
      const started = this.spectra.start((fact) => this.acceptFact(fact));
      if (!started) {
        console.warn(`[runtime] Spectra source unavailable: ${this.spectra.health().lastError ?? "unknown"}`);
      }
    } else {
      // Real GEP capture. If it cannot start we stay idle — never fake data.
      const started = this.gep.start((fact) => this.acceptFact(fact));
      if (!started) {
        console.warn(`[runtime] GEP provider unavailable: ${this.gep.health().lastError ?? "unknown"}`);
      }
      // Riot identity layer (LCU/GLZ/PD): real match id, map, roster with
      // Riot IDs + ranks. Starts unconditionally; it self-disables while the
      // Riot client is closed and fails soft on every error.
      this.identity.start();
    }
    this.startDetector();
  }

  private broadcastRoundSettled(result: ValNativeRoundSettlement): void {
    this.broadcast("", {
      at: new Date().toISOString(),
      id: this.nextFrameId++,
      protocolVersion: GAME_DATA_PROTOCOL_VERSION,
      kind: "new_game_event",
      data: {
        gameId: 21640,
        key: "round_settled",
        value: {
          roundNumber: result.roundNumber,
          winnerStartTeam: result.winnerStartTeam,
          winningSide: result.winningSide,
          winningReason: result.winningReason,
          winType: result.winType,
          winTypeLabel: result.winTypeLabel,
          plantSite: result.plantSite ?? null,
          // Clutch-card identity (original-desktop parity): WHO clutched
          // (highlightOccurrencePlayerId = the player id) resolved to the
          // roster's name/agent/KDA so the site can render the agent image
          // + K/D/A instead of the plain attacker/defender line.
          highlightPlayer: (() => {
            const hpId = result.highlightOccurrencePlayerId;
            if (!hpId) return null;
            const p = [...this.players.values()].find((x) => x.playerId === hpId);
            if (!p) return null;
            return {
              name: p.tagline ? `${p.name}#${p.tagline}` : p.name,
              agent: p.agent ?? null,
              kills: p.kills,
              deaths: p.deaths,
              assists: p.assists,
            };
          })(),
        },
      },
    });
  }

  /** Reset VALORANT's UDP sockets through the elevated GEP host. */
  public executeValorantSocketReset(targetProcessId: number | null): Promise<unknown> {
    return this.gep.executeValorantSocketReset(targetProcessId);
  }

  private resetMatch(): void {
    this.matchId = null;
    this.mapKey = null;
    this.score = null;
    this.players.clear();
    this.killfeed = [];
    this.engine.reset();
    if (this.sessionPhase !== "idle") {
      this.sessionPhase = "idle";
      this.emitSessionSnapshot();
    }
  }

  private startDetector(): void {
    if (this.detectorTimer) return;
    const tick = (): void => {
      const presence = checkValorantProcess();
      if (presence.present) {
        if (!this.valorantDetected) {
          this.valorantDetected = true;
          this.boostGamePriority();
          if (this.sessionPhase === "idle") {
            this.sessionPhase = "loading";
            this.broadcastValorantPresence(presence.executablePath);
          }
        }
      } else {
        this.valorantDetected = false;
        this.priorityBoosted = false;
      }
      this.detectorTimer = setTimeout(tick, 5000);
    };
    tick();
  }

  /**
   * Raise the game's priority to High (the original's native host does the
   * same; realtime requires admin so High is the safe default). One attempt
   * per game session, best-effort, never fatal.
   */
  private boostGamePriority(): void {
    if (this.priorityBoosted || process.env.HAVOC_BOOST_PRIORITY === "0") return;
    this.priorityBoosted = true;
    try {
      const { execFile } = require("node:child_process") as typeof import("node:child_process");
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Get-Process -Name 'VALORANT-Win64-Shipping','VALORANT' -ErrorAction SilentlyContinue | ForEach-Object { try { $_.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::High } catch {} }",
        ],
        { windowsHide: true, timeout: 10_000 },
        () => {},
      );
    } catch { /* best-effort */ }
  }

  private broadcastValorantPresence(executablePath: string | null): void {
    this.broadcast("", {
      at: new Date().toISOString(),
      id: this.nextFrameId++,
      protocolVersion: GAME_DATA_PROTOCOL_VERSION,
      kind: "presence",
      game: "VAL",
      detail: {
        detected: true,
        executablePath,
      },
    });
  }

  /** Mirror the upstream presence-repair path for authoritative facts. */
  private acceptFact(fact: { kind: string; key: string; value: unknown }): void {
    pipelineFactCount += 1;
    if (pipelineFactCount % 50 === 1) {
      // Boundary telemetry: events received (rate + latest type).
      pipelineDebug("fact_received", { kind: fact.kind, key: fact.key, total: pipelineFactCount });
    }
    try {
      if (fact.key === "provider_status") {
        const rec = fact.value as { key?: string; value?: unknown } | null;
        const statusKey = rec?.key ?? "";
        if (statusKey === "game_detected") {
          if (this.sessionPhase === "idle") {
            this.sessionPhase = "loading";
            this.emitSessionSnapshot();
          }
        } else if (statusKey === "game_exit") {
          // A5: full session retirement. The lifecycle signal (real GEP
          // game-exit, or the session-layer `disconnected` mapped onto it)
          // must leave NOTHING live behind: resetMatch() retires
          // phase/score/map/rounds, and the scene must be cleared too —
          // the old branch left currentScene=ingame_hud driving the HUD
          // after the session ended.
          this.currentScene = null;
          this.resetMatch();
        } else if (statusKey === "provider_error") {
          this.errorState = typeof rec?.value === "string" ? rec.value : "provider_error";
        } else if (statusKey === "provider_ready") {
          this.errorState = null;
        }
      } else if (fact.key === "match_score") {
        const rec = fact.value as { team_0?: unknown; team_1?: unknown };
        if (typeof rec?.team_0 === "number" && typeof rec?.team_1 === "number") {
          // Native GEP team numbers -> VIEWER-anchored blue/red (Blue = the
          // local player's start team; default team_1 = viewer, the
          // historically verified contract). The snapshot score must agree
          // with the projection's own anchored score — native order flipped
          // the scoreline for a non-team-1 viewer (live 2026-10-18:
          // "1:2 swaps to 2:1 a split second later").
          const lt = this.localTeam() ?? 1;
          this.score =
            lt === 0 ? { blue: rec.team_0, red: rec.team_1 } : { blue: rec.team_1, red: rec.team_0 };
          this.sessionPhase = "live";
          this.revision += 1;
          this.emitSessionSnapshot();
        }
      } else if (fact.key === "match_id" && typeof fact.value === "string" && fact.value) {
        this.matchId = fact.value;
        this.sessionPhase = "live";
        this.revision += 1;
        this.emitSessionSnapshot();
      } else if (fact.key === "scene" && typeof fact.value === "string") {
        this.currentScene = fact.value;
        this.revision += 1;
        this.emitSessionSnapshot();
      } else if (fact.key === "map" && typeof fact.value === "string") {
        if (fact.value !== "loading") {
          this.mapKey = fact.value;
          this.revision += 1;
          this.emitSessionSnapshot();
        }
      } else if (fact.key === "session_phase" && typeof fact.value === "string") {
        if (fact.value === "loading" || fact.value === "idle" || fact.value === "live") {
          this.sessionPhase = fact.value;
          if (fact.value === "idle") {
            // A5: presence-streak retirement (user backed out / closed the
            // game without a GEP lifecycle signal reaching us) must retire
            // FULLY — the old path only flipped the phase and left the
            // retired session's score/map/scene driving the HUD.
            this.currentScene = null;
            this.resetMatch();
          }
          this.revision += 1;
          this.emitSessionSnapshot();
        }
      } else if (fact.key === "scoreboard") {
        upsertPlayer(this.players, fact.value as Record<string, unknown>);
        this.revision += 1;
        this.emitSessionSnapshot();
      } else if (fact.key === "roster") {
        upsertPlayer(this.players, fact.value as Record<string, unknown>);
        this.revision += 1;
        this.emitSessionSnapshot();
      } else if (fact.key === "kill_feed") {
        this.killfeed.push(fact.value);
        if (this.killfeed.length > KILLFEED_CAP) this.killfeed.shift();
        // Deaths/kills attribution stays with the GEP scoreboard (alive /
        // health evidence) and the ported round-settlement engine. Deriving
        // them here from kill_feed fuzzy name matching false-killed players
        // (an empty victim name matched EVERYONE) and double-counted kills
        // the engine already tallies (overlay "damage -> death state" bug).
        this.revision += 1;
        this.emitSessionSnapshot();
      } else if (fact.key === "round_phase" && fact.value === "shopping") {
        for (const p of this.players.values()) {
          p.isAlive = true;
          p.health = 100;
        }
        this.revision += 1;
        this.emitSessionSnapshot();
      } else if (fact.key === "match_start") {
        this.resetMatch();
        this.sessionPhase = "loading";
        this.emitSessionSnapshot();
      } else if (fact.key === "player_id" && (typeof fact.value === "string" || typeof fact.value === "number")) {
        // GEP "me" identity: needed to route live local_health updates.
        this.localPlayerId = String(fact.value);
      } else if (fact.key === "local_health" && typeof fact.value === "number") {
        // GEP "me" HP — merge into the local player's record and re-emit a
        // scoreboard fact so the desktop projector applies it (GEP's roster
        // scoreboard itself never streams per-player health).
        const hp = fact.value;
        const local = this.localPlayerId
          ? [...this.players.values()].find((p) => p.playerId === this.localPlayerId)
          : undefined;
        if (local) {
          local.health = hp;
          local.isAlive = hp > 0;
          this.revision += 1;
          this.emitSessionSnapshot();
          this.broadcast("", {
            at: new Date().toISOString(),
            id: this.nextFrameId++,
            protocolVersion: GAME_DATA_PROTOCOL_VERSION,
            kind: "new_info_update",
            data: {
              gameId: 21640,
              key: "scoreboard",
              value: {
                player_id: local.playerId,
                name: local.name,
                tagline: local.tagline,
                health: hp,
                alive: hp > 0,
              },
            },
          });
        }
      } else if (fact.key === "match_end") {
        // Match settled (game_end / match_outcome). Flip the session to
        // ending so every downstream consumer (bridge deriveScene, projector
        // deriveScene) lands on post-game.
        this.sessionPhase = "ending";
        this.revision += 1;
        this.emitSessionSnapshot();
      } else if (fact.key === "round_phase" && fact.value === "game_end") {
        // Raw GEP game_end phase: same as match_end for the session, but the
        // round engine below still receives it as a normal round end.
        this.sessionPhase = "ending";
        this.revision += 1;
        this.emitSessionSnapshot();
      }
      // Feed the ported round-state engine (non-mock only; the mock script is
      // not shaped like the original's fact stream).
      if (!this.useMock && fact.key !== "provider_status") {
        try {
          switch (fact.key) {
            case "match_score":
              this.engine.onScore(fact.value as { team_0: number; team_1: number });
              break;
            case "round_number":
              this.engine.onRoundNumber(Number(fact.value));
              break;
            case "round_phase":
              // The round engine only knows shopping/combat/end — "game_end"
              // is a MATCH-end signal (handled above), feed it as a round end.
              if (typeof fact.value === "string") {
                this.engine.onRoundPhase(fact.value === "game_end" ? "end" : fact.value);
              }
              break;
            case "scoreboard":
            case "roster":
              this.engine.onScoreboard([...this.players.values()].map((p) => ({
                player_id: p.playerId,
                name: p.name,
                agent: p.agent,
                team: p.team,
                kills: p.kills,
                deaths: p.deaths,
                assists: p.assists,
                alive: p.isAlive,
                credits: p.credits,
                // Spike flag: the carrier's start team is the round's attacking
                // side ground truth (settlement replaces its parity guess).
                spike: p.hasSpike,
              })));
              break;
            case "kill_feed": {
              const kill = fact.value as Record<string, unknown>;
              this.engine.onKillfeed({
                assists: Array.isArray(kill.assists)
                  ? (kill.assists as string[])
                  : typeof kill.assists === "string" && kill.assists
                    ? [kill.assists]
                    : [],
                attacker: String(kill.attacker ?? ""),
                headshotKill: kill.modifier === "headshot",
                isTeamkill: false,
                victim: String(kill.victim ?? ""),
                weaponName: String(kill.weapon ?? ""),
              });
              break;
            }
            case "spike_planted":
              this.engine.onSpikePlanted();
              break;
            case "spike_defused":
              this.engine.onSpikeOutcome("defused");
              break;
            case "spike_detonated":
              this.engine.onSpikeOutcome("detonated");
              break;
            default:
              break;
          }
        } catch {
          /* engine must never break the fact pipeline */
        }
      }
    } catch {
      this.errorState = "snapshot_absorb_failed";
    }
    this.broadcast("", {
      at: new Date().toISOString(),
      id: this.nextFrameId++,
      protocolVersion: GAME_DATA_PROTOCOL_VERSION,
      kind: fact.kind,
      data: { gameId: 21640, key: fact.key, value: fact.value },
    });
  }

  snapshotFrame(): Frame {
    const mockTeamPlayers = (side: readonly string[], teamIndex: 0 | 1) =>
      side.map((name, slot) => ({
        agent: { key: name.toLowerCase(), name, riotId: `${name}#000` },
        observerSlot: slot,
        player: { identity: { displayName: name, gameName: name, tagLine: "000" } },
        teamIndex,
      }));

    let teams: Array<{ teamId: string; players: Record<string, unknown>[] }>;
    if (this.useMock) {
      teams = [
        { teamId: "Blue", players: mockTeamPlayers(ROSTER.blue, 0) },
        { teamId: "Red", players: mockTeamPlayers(ROSTER.red, 1) },
      ];
    } else {
      // Real data only: group actual GEP-reported players by team. With no live
      // match there are no players — teams stay empty so the overlay shows nothing.
      const list = [...this.players.values()];
      const knownTeam = list.filter((p) => p.team === 0 || p.team === 1);
      const unknownTeam = list.filter((p) => p.team !== 0 && p.team !== 1);
      // Blue/Red are VIEWER-anchored (Blue = the local player's team): the
      // site renders Blue as LEFT and the projection relays the score
      // viewer-left. Native team_0 ordering flipped the roster sides for a
      // non-team-1 viewer — the desktop's snapshot-team merge and its
      // scoreboard-fact anchoring then fought each other, swapping the
      // panels/score on every heartbeat (live 2026-10-18) and corrupting
      // the score-delta round bookkeeping (blank/incorrect strip icons).
      const localTeam = this.localTeam();
      teams = [];
      for (const i of [0, 1] as const) {
        const nativeTeam = localTeam === 1 ? (i === 0 ? 1 : 0) : i;
        const side = knownTeam
          .filter((p) => p.team === nativeTeam)
          .sort((a, b) => (a.observerSlot ?? 99) - (b.observerSlot ?? 99))
          .map((p) => ({ ...playerToSnapshot(p), teamIndex: i }));
        if (side.length > 0) teams.push({ teamId: i === 0 ? "Blue" : "Red", players: side });
      }
      if (unknownTeam.length > 0) {
        teams.push({ teamId: "Unknown", players: unknownTeam.map(playerToSnapshot) });
      }
      if (teams.length === 0) {
        teams.push({ teamId: "Blue", players: [] }, { teamId: "Red", players: [] });
      }
    }

    return {
      at: new Date().toISOString(),
      id: this.nextFrameId++,
      protocolVersion: GAME_DATA_PROTOCOL_VERSION,
      kind: SNAP_EVENT,
      game: "VAL",
      snapshot: {
        // Bump per frame: the desktop's stream client drops frames whose
        // revision hasn't increased, and the publisher -> bridge mirror ->
        // OBS chain depends on every heartbeat frame flowing through.
        revision: ++this.revision,
        // Bump per frame: downstream (desktop publisher -> bridge mirror) dedupes
        // identical payloads, and liveness indicators need a fresh frame even
        // when no fact changed.
        frameId: this.nextFrameId,
        at: Date.now(),
        sessionPhase: this.sessionPhase,
        scene: this.currentScene,
        matchId: this.matchId,
        mapKey: this.mapKey,
        score: this.score,
        killfeed: [...this.killfeed],
        teams,
        valState: this.engine.snapshot(),
      },
    };
  }

  subscribe(res: http.ServerResponse): number {
    const id = this.nextSubscriberId++;
    this.subscribers.set(id, res);
    // Boundary telemetry: overlay/desktop SSE subscription established.
    pipelineDebug("sse_subscriber_connected", { subscribers: this.subscribers.size });
    res.write(`event: ${SNAP_EVENT}\n`);
    res.write(`data: ${JSON.stringify(this.snapshotFrame())}\n\n`);
    return id;
  }

  /** Push a fresh session snapshot so consumers track session-phase changes. */
  private emitSessionSnapshot(): void {
    this.broadcast("", this.snapshotFrame());
  }

  unsubscribe(id: number): void {
    this.subscribers.delete(id);
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  broadcast(label: string, frame: Frame): void {
    const payload = (label ? `event: ${label}\n` : "") + `data: ${JSON.stringify(frame)}\n\n`;
    for (const [, res] of this.subscribers) if (!res.writableEnded) res.write(payload);
  }

  stop(): void {
    this.source.stop();
    this.gep.stop();
    this.spectra.stop();
    this.identity.stop();
  }

  health(): GameDataRuntimeHealth {
    const gepHealth = this.useMock || this.useSpectra
      ? { state: "unavailable" as const, lastError: this.useMock ? "mock source (HAVOC_SOURCE=mock)" : "spectra bridge (HAVOC_SOURCE=spectra)", providerVersion: null }
      : this.gep.health();
    const spectraHealth = this.spectra.health();
    return gameDataRuntimeHealthSchema.parse({
      ok: true,
      service: "havoc-unleash-game-data-runtime",
      supportedGames: ["VAL"],
      capabilities: {
        overwolf: {
          state: gepHealth.state,
          lastError: gepHealth.lastError,
          providerVersion: gepHealth.providerVersion,
          // A2: telemetry-delivery state machine (additive; schema-optional).
          telemetry: gepHealth.telemetry ?? null,
        },
        valorantApi: this.useMock
          ? { state: "unavailable", lastError: "mock source" }
          : this.useSpectra
            ? { state: spectraHealth.state === "authenticated" ? "ready" : spectraHealth.state === "error" ? "error" : "starting", lastError: spectraHealth.lastError }
            : { state: "ready", lastError: null },
      },
      runtimeVersion: "0.1.0-fork",
      uptimeMs: Date.now() - this.bootedAt,
      runtime: {
        state: this.errorState ? "error" : "ready",
        detail: this.errorState ?? null,
        lastError: this.errorState ?? "",
      },
    });
  }
}

async function main(): Promise<void> {
  const hub = new RuntimeHub();
  const server = http.createServer((req, res) => {
    // Crash forensics: log uncaught errors to a file so silent runtime deaths
    // are diagnosable (the desktop now also respawns + captures stderr).
    process.on("uncaughtException", (error) => {
      try {
        const dir = process.env.HAVOC_GAME_DATA_DIR?.trim() ||
          join(process.env.LOCALAPPDATA ?? "", "Havoc", "game-data-runtime");
        mkdirSync(join(dir, "run"), { recursive: true });
        appendFileSync(join(dir, "run", "runtime-crash.log"),
          `${new Date().toISOString()} uncaughtException: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      } catch { /* ignore */ }
    });
    process.on("unhandledRejection", (reason) => {
      try {
        const dir = process.env.HAVOC_GAME_DATA_DIR?.trim() ||
          join(process.env.LOCALAPPDATA ?? "", "Havoc", "game-data-runtime");
        mkdirSync(join(dir, "run"), { recursive: true });
        appendFileSync(join(dir, "run", "runtime-crash.log"),
          `${new Date().toISOString()} unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
      } catch { /* ignore */ }
    });
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    if (req.method === "POST" && url.pathname === "/network/reset") {
      void hub
        .executeValorantSocketReset(getValorantProcessId())
        .then((result: unknown) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        })
        .catch((error) => {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(error) }));
        });
      return;
    }
    if (req.method === "GET" && url.pathname === GAME_DATA_RUNTIME_PATHS.health) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(hub.health()));
      return;
    }
    if (req.method === "GET" && url.pathname === GAME_DATA_RUNTIME_PATHS.events) {
      if (req.headers.accept !== "text/event-stream") {
        res.writeHead(400, { connection: "close" });
        res.end("must Accept: text/event-stream");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": connected\n\n");
      const subId = hub.subscribe(res);
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        hub.unsubscribe(subId);
        res.end();
      };
      req.on("close", close);
      req.on("error", close);
      void (async () => {
        while (!closed) {
          await sleep(HEARTBEAT_MS, undefined, { ref: false }).catch(() => {});
          if (closed || res.writableEnded) break;
          // Re-send a fresh snapshot frame (not just a ping comment): the
          // desktop publisher -> bridge mirror -> OBS chain depends on frames
          // flowing even when no fact changed, for liveness + state freshness.
          try {
            hub.broadcast("", hub.snapshotFrame());
          } catch { /* subscriber gone */ }
          res.write(`: ping ${Date.now()}\n\n`);
        }
      })();
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "not_found" }));
  });

  if (process.env.HAVOC_DEBUG_PIPELINE === "1") {
    setInterval(() => {
      pipelineDebug("runtime_summary", {
        sseSubscribers: hub.subscriberCount(),
        factsLast15s: pipelineFactCount,
      });
      pipelineFactCount = 0;
    }, 15_000).unref();
  }

  server.listen(PORT, "127.0.0.1", () => {
    process.stdout.write(
      `[game-data-runtime] http://127.0.0.1:${PORT}${GAME_DATA_RUNTIME_PATHS.health}\n`,
    );
  });

  const shutdown = (): void => {
    hub.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<never>(() => {}); // park forever; server handles keep the loop alive
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
