/**
 * Overwolf GEP capture — parent side.
 *
 * Spawns @overwolf/ow-electron's electron.exe running the gep-provider child
 * app (../gep-provider), which uses Overwolf's PackageManager to load the GEP
 * package (the same Game Events Provider data path the original HAVOC runtime
 * uses — confirmed by dissecting havoc-game-data-runtime.exe).
 *
 * The child speaks NDJSON protocol v1 on stdout; this module parses it and
 * translates gep.InfoUpdate / gep.GameEvent payloads into the same ProviderFact
 * stream the runtime + desktop pipeline already consume.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { monitorRecoveryDecision, type MonitorRecoveryState } from "./provider-recovery";
import { createServer, type Server, type Socket } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
  type WriteStream as FsWriteStream,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { formatKill, formatMap, formatMapKey, formatPlayer, formatRoster } from "./gep-format";
import { bootGepPackage, backgroundGepUpdate, deriveAppUid, resolveGameDataDir } from "./gep-download";
import {
  findOverwolfProcesses,
  MONITOR_CONFLICT_ERROR,
  stopOverwolf,
} from "./overwolf-conflict";
import type { ProviderFact } from "./mock-source";

const ELEVATED_CONNECTION_TIMEOUT_MS = 45_000;


/**
 * A5: map the GEP session-layer `disconnected` callback onto the runtime's
 * EXISTING game_exit lifecycle. A5-PRE evidence: when VALORANT closes the
 * plugin emits `disconnected` — never `game-exit` — so without this mapping
 * the runtime's reset path (which keys on `game_exit`) never fired, and a
 * close→restart that outran the presence retirement streak (~3-6s restart
 * vs ~12s streak) left the session permanently live. Reuses the existing
 * lifecycle mechanism; no second state machine.
 */
export function gepDisconnectLifecycleEvent(code?: unknown): {
  key: "game_exit";
  value: { reason: "gep_disconnected"; code: number | null };
} {
  return {
    key: "game_exit",
    value: { reason: "gep_disconnected", code: typeof code === "number" ? code : null },
  };
}

export type ProviderEmit = (fact: ProviderFact) => void;

export type ProviderState = "unavailable" | "starting" | "ready" | "error";

export interface ProviderHealth {
  state: ProviderState;
  lastError: string | null;
  providerVersion: string | null;
  /** Telemetry-delivery state machine (A2). Additive — see computeTelemetryState. */
  telemetry?: GepTelemetryStatus;
}

/**
 * GEP telemetry-freshness window. Matches the existing re-attach staleness
 * contract (330s = GEP's observed plugin init window of up to 300s + margin):
 * a live match always streams info updates well inside this window, so
 * silence beyond it means the fact stream is genuinely not flowing.
 */
export const TELEMETRY_FRESHNESS_MS = 330_000;

/**
 * Telemetry-delivery state — distinct from ProviderState (process health).
 * ProviderState says the child is alive; this says whether the game fact
 * stream is actually flowing. The two can diverge silently in the field:
 * a provider can attach and produce ZERO info updates for entire matches.
 */
export type ProviderTelemetryState =
  | "DISCONNECTED"
  | "ERROR"
  | "WAITING_FOR_TELEMETRY"
  | "FEATURES_SET"
  | "CONNECTED_BUT_NO_TELEMETRY"
  | "STALE"
  | "HEALTHY";

export interface GepTelemetryStatus {
  state: ProviderTelemetryState;
  previous: ProviderTelemetryState;
  /** connect-game sent for this game pid (attach confirmed on our side). */
  attached: boolean;
  attachedAt: number | null;
  /** PM path only — the direct addon cannot report feature registration. */
  featuresSetAt: number | null;
  firstInfoUpdateAt: number | null;
  lastGameDataAt: number | null;
  lastError: string | null;
}

/**
 * Pure telemetry-state machine. HEALTHY requires an actually-received info
 * update inside the freshness window — connection and feature registration
 * alone can never produce HEALTHY (that was the field failure this guards).
 */
export function computeTelemetryState(input: {
  providerState: ProviderState;
  attached: boolean;
  featuresSetAt: number | null;
  firstInfoUpdateAt: number | null;
  lastGameDataAt: number;
  now: number;
}): ProviderTelemetryState {
  if (input.providerState === "error") return "ERROR";
  if (!input.attached) return "DISCONNECTED";
  const sinceData = input.now - input.lastGameDataAt;
  if (input.firstInfoUpdateAt != null) {
    return sinceData > TELEMETRY_FRESHNESS_MS ? "STALE" : "HEALTHY";
  }
  if (sinceData > TELEMETRY_FRESHNESS_MS) return "CONNECTED_BUT_NO_TELEMETRY";
  return input.featuresSetAt != null ? "FEATURES_SET" : "WAITING_FOR_TELEMETRY";
}

/**
 * Static identity pings repeat on every rearm cycle even when GEP injection
 * is dead and ZERO match data flows (patch-day 2026-10-20: 13×
 * game_info:is_pbe across the whole match, zero match_info) — stamping
 * telemetry proof on them made the state machine report HEALTHY through a
 * completely starved match. Only these known-static items are excluded;
 * every other info update (including unknown shapes) still counts.
 */
export function isStaticGameDataItem(
  item: { feature?: unknown; key?: unknown } | null | undefined,
): boolean {
  return item?.feature === "game_info" && item?.key === "is_pbe";
}

interface ProtocolMessage {
  type?: string;
  protocolVersion?: number;
  kind?: string;
  payload?: unknown;
  reason?: string;
}

interface GepItem {
  gameId?: number;
  feature?: string;
  category?: string;
  key?: string;
  value?: unknown;
}

/** Rewrite an asar path to its unpacked sibling so spawn() can execute it. */
function asarReal(path: string): string {
  return path.includes(".asar") ? path.replace(".asar", ".asar.unpacked") : path;
}

/** Locate ow-electron's electron.exe (dev workspace or packaged resources). */
export function resolveOwElectronPath(): string | null {
  const candidates: string[] = [];
  const envPath = process.env.HAVOC_OW_ELECTRON_PATH?.trim();
  if (envPath) candidates.push(envPath);

  // Dev: walk up from the bundle location to the workspace root's node_modules.
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    candidates.push(join(dir, "node_modules", "@overwolf", "ow-electron", "dist", "electron.exe"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Packaged: electron-builder extraResources put it under <resources>/ow-electron.
  const exeDir = dirname(process.execPath);
  candidates.push(join(exeDir, "resources", "ow-electron", "dist", "electron.exe"));
  candidates.push(join(exeDir, "ow-electron", "dist", "electron.exe"));

  for (const candidate of candidates) {
    const real = asarReal(candidate);
    if (existsSync(real)) return real;
  }
  return null;
}

/** Locate the gep-provider child app directory. */
export function resolveProviderDir(): string | null {
  const candidates: string[] = [];
  const envDir = process.env.HAVOC_GEP_PROVIDER_DIR?.trim();
  if (envDir) candidates.push(envDir);
  candidates.push(join(__dirname, "gep-provider")); // bundled next to runtime-server.cjs
  candidates.push(join(__dirname, "..", "gep-provider")); // dev: dist/../gep-provider
  const exeDir = dirname(process.execPath);
  candidates.push(join(exeDir, "resources", "gep-provider"));
  candidates.push(join(exeDir, "gep-provider"));

  for (const candidate of candidates) {
    const real = asarReal(candidate);
    if (existsSync(join(real, "package.json")) && existsSync(join(real, "index.js"))) return real;
  }
  return null;
}

/**
 * GEP delivers values as JSON strings ('{"a":1}'), plain strings, or objects.
 * Returns the parsed object when the value is (or encodes) one, else null.
 */
function parseMaybeJsonObject(value: unknown): Record<string, unknown> | null {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch { /* fall through to raw handling */ }
    }
  }
  return null;
}

/** Normalize a NATIVE GEP score value ({team_0,team_1} | {blue,red} | "a-b") to team_0/team_1. */
function normalizeScore(value: unknown): { team_0: number; team_1: number } | null {
  const asObject = parseMaybeJsonObject(value);
  if (asObject) {
    const t0 = Number(asObject.team_0 ?? asObject.blue);
    const t1 = Number(asObject.team_1 ?? asObject.red);
    if (Number.isFinite(t0) && Number.isFinite(t1)) return { team_0: t0, team_1: t1 };
    // NOTE: the viewer-relative {won, lost} form (GEP `score`, riot presence)
    // is deliberately NOT normalized here. Relabeling it as
    // {team_0: lost, team_1: won} made every consumer anchor it a SECOND time
    // via the viewer's GEP team number — correct only while the viewer
    // happened to be team 1; a team-0 viewer (live 2026-10-18) got score,
    // round history and ceremony winners all inverted. The caller forwards
    // {won, lost} under its own fact key instead.
    return null;
  }
  if (typeof value === "string") {
    // Plain "a-b" text scores only — JSON strings were handled above (a digit
    // regex here would match the "0" inside the key name "team_0" and yield
    // {0, x} garbage, which is exactly what froze the score at 0-0 in the field).
    const m = value.match(/(\d+)\s*[-:]\s*(\d+)/);
    return m ? { team_0: Number(m[1]), team_1: Number(m[2]) } : null;
  }
  return null;
}

/** One flat gep.InfoUpdate -> 0..n ProviderFacts. */
function factFromInfoUpdate(item: GepItem, emit: ProviderEmit): void {
  const key = String(item.key ?? "").trim();
  const category = String(item.category ?? item.feature ?? "").toLowerCase();
  const value = item.value;
  if (!key) return;
  const low = key.toLowerCase();

  const pushInfo = (k: string, v: unknown): void => emit({ kind: "new_info_update", key: k, value: v });

  if (low === "map") {
    // Canonical lowercase key ("split"), not the display name — projection.ts
    // resolves mapKey -> mapName, and round bookkeeping keys on this value.
    const mapKey = formatMapKey(value);
    if (mapKey) pushInfo("map", mapKey);
    return;
  }
  if (low === "scene") {
    if (typeof value === "string") pushInfo("scene", value);
    return;
  }
  if (low === "match_id") {
    pushInfo("match_id", typeof value === "string" ? value : String(value ?? ""));
    return;
  }
  if (low === "round_phase") {
    // Phase only ever arrives as a plain string; anything else (e.g. a
    // round_report object relayed under a similar key) must not pollute the
    // phase stream — it corrupts the round engine and the projector.
    if (typeof value === "string") {
      pushInfo("round_phase", value);
      // GEP ends a match with roundPhase "game_end" (ValoSpectra parity —
      // their gepService treats it as MatchEnd). Forward it as an explicit
      // match_end fact so the projector can settle + flip to post-game even
      // when the final score never reached 13 (custom games).
      if (value.trim().toLowerCase() === "game_end") {
        emit({ kind: "new_game_event", key: "match_end", value: { reason: "game_end" } });
      }
    }
    return;
  }
  if (low === "match_outcome") {
    // GEP's me/match_info match outcome — another match-end evidence source.
    emit({ kind: "new_game_event", key: "match_end", value: { reason: "match_outcome", outcome: value } });
    return;
  }
  if (low === "team") {
    // GEP game_info/team — the LOCAL player's side THIS round ("attack" /
    // "defense"). Definitive attack/defender ground truth; flips at halftime.
    if (value === "attack" || value === "defense") pushInfo("viewer_side", value);
    return;
  }
  if (low === "abilities") {
    // GEP "me" feature ability charges — {C,Q,E,X} as 0/1 NUMBERS (not
    // booleans). Normalize to booleans: >=1 means the charge is available.
    const rec = parseMaybeJsonObject(value);
    if (rec) {
      const n = (v: unknown): boolean => v === true || Number(v) >= 1;
      pushInfo("abilities", {
        C: n((rec as Record<string, unknown>).C),
        Q: n((rec as Record<string, unknown>).Q),
        E: n((rec as Record<string, unknown>).E),
        X: n((rec as Record<string, unknown>).X),
      });
    }
    return;
  }
  if (low === "round_outcome") {
    // GEP viewer-perspective round result {won, lost} — cumulative. A delta
    // tells us DEFINITIVELY who won the round without any score-delta or
    // alive-count guessing. Forward the raw numbers; the projector compares.
    const rec = parseMaybeJsonObject(value);
    if (rec) {
      pushInfo("round_outcome", {
        won: Number((rec as Record<string, unknown>).won ?? 0),
        lost: Number((rec as Record<string, unknown>).lost ?? 0),
      });
    }
    return;
  }
  if (low === "health") {
    // GEP "me" feature: the LOCAL player's HP, streamed live (ValoSpectra's
    // setPlayerHealth parity). GEP never streams per-player health for the
    // rest of the roster — this is the only live HP source.
    const hp = Number(value);
    if (Number.isFinite(hp) && hp >= 0) pushInfo("local_health", hp);
    return;
  }
  if (low === "round_report") {
    // Per-round damage stats — passthrough under its own key for consumers.
    const rec = parseMaybeJsonObject(value);
    if (rec) pushInfo("round_report", rec);
    return;
  }
  // GEP's live round key is "round" (a plain number); "round_number" is kept
  // for the upstream dialect. Without "round" here the projector never learns
  // the round number and holds every phase forever (scene stuck on null).
  if (low === "round" || low === "round_number") {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) pushInfo("round_number", n);
    return;
  }
  if (low === "score" || low === "match_score") {
    // Dialect split (live 2026-10-18 inversion fix): native `match_score`
    // {team_0, team_1} keeps GEP's team numbering, but the viewer-relative
    // `score` {won, lost} MUST stay under its own key — the projection
    // dispatches on shape ({won,lost} = blue/won directly; {team_0,team_1}
    // = anchored by the viewer's is_local team). Relabeling won/lost as
    // team_0/team_1 here double-anchored it downstream.
    const asObject = parseMaybeJsonObject(value);
    if (asObject && asObject.won !== undefined && asObject.lost !== undefined) {
      const won = Number(asObject.won);
      const lost = Number(asObject.lost);
      if (Number.isFinite(won) && Number.isFinite(lost)) {
        pushInfo("score", { won, lost });
        return;
      }
    }
    const score = normalizeScore(value);
    if (score) pushInfo("match_score", score);
    return;
  }
  if (low === "player_id" || low === "game_mode") {
    pushInfo(low, value);
    return;
  }
  if (category.includes("roster") || low.startsWith("roster")) {
    const items = Array.isArray(value) ? value : [value];
    for (const item2 of items) {
      const rec = parseMaybeJsonObject(item2);
      if (rec) pushInfo("roster", formatRoster(rec).value);
    }
    return;
  }
  if (category.includes("scoreboard") || low.startsWith("scoreboard") || category.includes("player")) {
    const items = Array.isArray(value) ? value : [value];
    for (const item2 of items) {
      const rec = parseMaybeJsonObject(item2);
      if (rec) pushInfo("scoreboard", formatPlayer(rec).value);
    }
    return;
  }
  if (low === "spike") {
    const v = String(value ?? "").toLowerCase();
    if (v.includes("plant")) emit({ kind: "new_game_event", key: "spike_planted", value: true });
    else if (v.includes("defuse")) emit({ kind: "new_game_event", key: "spike_defused", value: true });
    return;
  }
  // Pass through other structured info so nothing is lost — objects AND plain
  // strings. The `me` feature's `player_name` (the local player's identity!)
  // arrives as a STRING and was silently dropped by the object-only check,
  // which left the projector's viewer anchor dependent on a scoreboard row.
  if (value != null && typeof value === "object") pushInfo(low, value);
  else if (typeof value === "string" && value.length > 0 && value.length <= 1024) pushInfo(low, value);
}

/** One gep.GameEvent -> ProviderFact. */
function factFromGameEvent(item: GepItem, emit: ProviderEmit): void {
  const key = String(item.key ?? "").trim().toLowerCase();
  const value = item.value;
  if (!key) return;

  if (key === "kill" || key === "kill_feed") {
    if (value != null && typeof value === "object") {
      emit({ kind: "new_game_event", key: "kill_feed", value: formatKill(value as Record<string, unknown>).value });
    }
    return;
  }
  if (key === "spike_planted" || key === "spike_defused" || key === "spike_detonated" || key === "spike_exploded") {
    const normalized = key === "spike_exploded" ? "spike_detonated" : key;
    emit({ kind: "new_game_event", key: normalized, value: true });
    return;
  }
  emit({ kind: "new_game_event", key, value });
}

/**
 * Normalize a nested getInfo() dump: {category: {key: value}} or {category: [items]}.
 */
function factFromInfoDump(dump: unknown, emit: ProviderEmit): void {
  if (dump == null || typeof dump !== "object" || Array.isArray(dump)) return;
  for (const [category, content] of Object.entries(dump as Record<string, unknown>)) {
    const entries: Array<[string, unknown]> =
      content != null && typeof content === "object" && !Array.isArray(content)
        ? Object.entries(content as Record<string, unknown>)
        : Array.isArray(content)
          ? content.map((v, i) => [`${category}_${i}`, v])
          : [];
    for (const [key, value] of entries) {
      factFromInfoUpdate({ category, key, value }, emit);
    }
  }
}

/** Extract a GEP item ({key, value, ...}) from a raw callback-args payload. */
function findInfoItem(payload: unknown): GepItem | null {
  const args = Array.isArray(payload) ? payload : [payload];
  for (const arg of args) {
    if (arg != null && typeof arg === "object" && !Array.isArray(arg)) {
      const rec = arg as Record<string, unknown>;
      if (typeof rec.key === "string" || typeof rec.category === "string" || typeof rec.feature === "string") {
        return rec as GepItem;
      }
    }
  }
  return null;
}

export class GepProviderSource {
  private emitFn: ProviderEmit | null = null;
  private child: ChildProcess | null = null;
  private stopped = false;
  private state: ProviderState = "unavailable";
  private lastError: string | null = null;
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  /** Debounce for the GEP monitor-conflict handler (see watchPluginStatus). */
  private monitorConflictHandled = false;
  private stdoutBuffer = "";
  private providerVersion: string | null = null;
  // Elevation (mirrors the original's windows-native-host design): the GEP
  // child is launched via PowerShell `Start-Process -Verb RunAs` and connects
  // BACK to a named pipe here, because an elevated process cannot share stdio
  // with a medium-integrity parent. If UAC is declined we fall back to the
  // direct (non-elevated) launch instead of nagging the user every retry.
  private elevate: boolean;
  /** After an Electron-mode provider failure, relaunch in bare-addon mode. */
  private preferNodeMode = false;
  private pipeServer: Server | null = null;
  private hostSocket: Socket | null = null;
  private connectionTimer: NodeJS.Timeout | null = null;
  private elevationToken: string | null = null;

  public constructor() {
    this.elevate = process.env.HAVOC_ELEVATE_GEP === "1";
  }

  public start(emit: ProviderEmit): boolean {
    this.emitFn = emit;
    const exe = resolveOwElectronPath();
    const providerDir = resolveProviderDir();
    if (!exe) {
      this.state = "unavailable";
      this.lastError = "ow-electron electron.exe not found (install @overwolf/ow-electron)";
      return false;
    }
    if (!providerDir) {
      this.state = "unavailable";
      this.lastError = "gep-provider directory not found next to the runtime";
      return false;
    }
    // Retail Overwolf owns the GEP process monitor exclusively. If it is up we
    // will get "failed_initializing_monitor" forever, so resolve it up front.
    this.resolveOverwolfConflict("startup");
    this.state = "starting";
    void this.prepareAndLaunch(exe, providerDir);
    return true;
  }

  /**
   * Detect (and optionally stop) retail Overwolf, which contends for the GEP
   * process monitor. With HAVOC_KILL_OVERWOLF=1 we terminate it like
   * ValoSpectra does; otherwise we surface the conflict so the UI can ask.
   */
  private resolveOverwolfConflict(reason: "startup" | "monitor-conflict"): boolean {
    const running = findOverwolfProcesses();
    if (running.length === 0) return false;
    const images = [...new Set(running.map((p) => p.image))];
    if (process.env.HAVOC_KILL_OVERWOLF === "1") {
      const stopped = stopOverwolf();
      this.emitProviderStatus("overwolf_conflict_resolved", {
        reason,
        stopped: stopped.map((p) => `${p.image}#${p.pid}`),
      });
      return stopped.length > 0;
    }
    this.lastError =
      `retail Overwolf is running (${images.join(", ")}) and owns the GEP process monitor; ` +
      `close Overwolf or set HAVOC_KILL_OVERWOLF=1 to stop it automatically`;
    this.emitProviderStatus("overwolf_conflict", { reason, processes: images });
    return false;
  }

  /** Download/verify the GEP module (original flow), then launch the child. */
  private async prepareAndLaunch(exe: string, providerDir: string): Promise<void> {
    let gepDir: string;
    try {
      // v11 D15: cache-first boot (no manifest wait) — the manifest check runs
      // in the background and stages any newer package for the NEXT launch.
      const info = await bootGepPackage(undefined, {
        backgroundUpdateImpl: async (dir, opts) => {
          const updated = await backgroundGepUpdate(dir, opts);
          if (updated) this.emitProviderStatus("gep_package_updated", { version: updated.version });
          return updated;
        },
      });
      gepDir = info.directory;
      this.providerVersion = info.version;
    } catch (error) {
      this.state = "error";
      this.lastError = `GEP package preparation failed: ${error instanceof Error ? error.message : String(error)}`;
      this.emitProviderStatus("provider_error", this.lastError);
      this.scheduleRestart(exe, providerDir);
      return;
    }
    this.launch(exe, providerDir, gepDir);
  }

  public health(): ProviderHealth {
    return {
      state: this.state,
      lastError: this.lastError,
      providerVersion: this.providerVersion,
      telemetry: this.telemetryStatus(),
    };
  }

  /**
   * Telemetry-delivery status (A2). Computed on read — no polling. The
   * existing 4s attach loop also drives edge-triggered
   * `provider_status: provider_telemetry_state` emissions so consumers can
   * observe state transitions without reading /health.
   */
  public telemetryStatus(): GepTelemetryStatus {
    const previous = this.telemetryState;
    const state = computeTelemetryState({
      providerState: this.state,
      attached: this.attachedPid !== null,
      featuresSetAt: this.featuresSetAt,
      firstInfoUpdateAt: this.firstInfoUpdateAt,
      lastGameDataAt: this.lastGameDataAt,
      now: Date.now(),
    });
    if (state !== this.telemetryState) {
      this.telemetryPrevious = previous;
      this.telemetryState = state;
      this.emitProviderStatus("provider_telemetry_state", {
        state,
        previous,
        attached: this.attachedPid !== null,
        firstInfoUpdateAt: this.firstInfoUpdateAt,
        lastGameDataAt: this.lastGameDataAt || null,
      });
    }
    return {
      state: this.telemetryState,
      previous: this.telemetryPrevious,
      attached: this.attachedPid !== null,
      attachedAt: this.attachedAt,
      featuresSetAt: this.featuresSetAt,
      firstInfoUpdateAt: this.firstInfoUpdateAt,
      lastGameDataAt: this.lastGameDataAt || null,
      lastError: this.lastError,
    };
  }

  /** Re-evaluate + edge-emit telemetry state (driven by the attach loop tick). */
  
  /**
   * A4 (FIX B): terminate orphaned HU GEP provider processes.
   *
   * Identification is deliberately narrow: only processes whose command line
   * contains the gep-provider entrypoint directory are targeted. Unrelated
   * node.exe/electron.exe processes (dev servers, other HU services, user
   * apps) do not match and are never touched. The CURRENT child is skipped —
   * restartProviderNow() terminates it through the normal lifecycle.
   *
   * Returns the number of orphan pids actually terminated.
   */
  private async cleanupOrphanedGepProviders(): Promise<number> {
    const keepPid = this.child?.pid ?? null;
    const query =
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe' OR Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*gep-provider*' } | " +
      "Select-Object -ExpandProperty ProcessId";
    const pids = await new Promise<string[]>((resolve) => {
      try {
        const child = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", query],
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        child.stdout?.on("data", (d: Buffer) => {
          out += d.toString();
        });
        child.on("error", () => resolve([]));
        child.on("close", (code) => {
          if (code !== 0) {
            resolve([]);
            return;
          }
          resolve(
            out
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter((l) => /^\d+$/.test(l)),
          );
        });
      } catch {
        resolve([]);
      }
    });
    const targets = pids.map(Number).filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
    let killed = 0;
    for (const pid of targets) {
      if (keepPid != null && pid === keepPid) continue; // never touch the live child
      try {
        const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (d: Buffer) => {
          stderr += d.toString();
        });
        const exited = await new Promise<number | null>((resolve) => {
          child.on("close", (code) => resolve(code));
          child.on("error", () => resolve(null));
        });
        if (exited === 0) {
          killed += 1;
          this.emitProviderStatus("monitor_recovery_orphan_killed", { pid });
        } else {
          this.emitProviderStatus("monitor_recovery_orphan_skip", {
            pid,
            reason: stderr.slice(0, 200),
          });
        }
      } catch (error) {
        this.emitProviderStatus("monitor_recovery_orphan_skip", {
          pid,
          error: String(error),
        });
      }
    }
    return killed;
  }

  /** Re-evaluate + edge-emit telemetry state (driven by the attach loop tick). */
  private evaluateTelemetryState(): void {
    this.telemetryStatus();
  }

  /**
   * Ask the elevated provider to reset VALORANT's UDP sockets (original's
   * `valorant-socket-reset-attempt` command). Only available while the
   * elevated host is connected over the pipe. Resolves with the recovered
   * result schema; rejects on timeout or when no elevated host exists.
   */
  public executeValorantSocketReset(targetProcessId: number | null, timeoutMs = 20_000): Promise<unknown> {
    if (!this.hostSocket || !this.elevationToken) {
      return Promise.reject(new Error("elevated provider not connected"));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommand = null;
        reject(new Error("socket reset timed out"));
      }, timeoutMs);
      timer.unref();
      this.pendingCommand = { requestId, resolve, reject, timer };
      this.writeToHost({
        type: "command",
        requestId,
        name: "socket-reset",
        payload: { targetProcessId, koffiPath: this.resolveKoffiPath() },
      });
    });
  }

  private pendingCommand: {
    reject: (error: Error) => void;
    requestId: string;
    resolve: (value: unknown) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  private writeToHost(msg: unknown): void {
    if (!this.hostSocket || this.hostSocket.destroyed) return;
    this.hostSocket.write(JSON.stringify(msg) + "\n");
  }

  public stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.stopAttachLoop();
    this.clearConnectionTimer();
    this.pendingCommand?.reject(new Error("provider stopped"));
    this.pendingCommand = null;
    this.hostSocket?.destroy();
    this.hostSocket = null;
    this.closePipeServer();
    this.child?.kill();
    this.child = null;
  }

  private launch(exe: string, providerDir: string, gepDir?: string): void {
    if (this.elevate) {
      this.launchElevated(exe, providerDir, gepDir);
      return;
    }
    this.launchDirect(exe, providerDir, gepDir);
  }

  private launchDirect(exe: string, providerDir: string, gepDir?: string): void {
    // TWO provider modes:
    //
    //  ELECTRON (default): ow-electron's electron.exe runs the provider as a
    //    real Electron app whose PackageManager exposes the official GEP
    //    package API (setRequiredFeatures/game-detected) — the exact flow
    //    ValoSpectra ships, and the only one known to deliver the full event
    //    stream (roster/round/killfeed).
    //
    //  NODE (fallback, HAVOC_GEP_NODE_MODE=1 or after an Electron-mode
    //    failure): RUN_AS_NODE + the bare addon (gep.init/connect only). The
    //    addon's async callbacks only fire on a plain Node loop, and it
    //    delivered data in the field — but it has no features API and its
    //    attach is unreliable against Vanguard.
    const env: NodeJS.ProcessEnv = { ...process.env };
    const nodeMode = this.preferNodeMode || process.env.HAVOC_GEP_NODE_MODE === "1";
    if (nodeMode) {
      env.ELECTRON_RUN_AS_NODE = "1";
    } else {
      delete env.ELECTRON_RUN_AS_NODE;
      // Electron mode: ELECTRON_NO_ATTACH_CONSOLE is an ow-electron-specific
      // headless marker; with it set, every navigation in a BrowserWindow
      // failed with ERR_FAILED (-2) (file://, data: AND http://) — the
      // network/renderer services never came up. Only keep it for node mode.
      delete env.ELECTRON_NO_ATTACH_CONSOLE;
    }
    // Original flow: fixed app uid + GEP module directory for the provider child.
    // The GEP backend validates this uid (Overwolf extension id) before letting
    // the game monitor attach — it MUST be the original's registered id.
    env.OVERWOLF_APP_UID = env.OVERWOLF_APP_UID?.trim() || "mkcfiniehcpkhplpahgeepbdpjophjei";
    if (gepDir) env.HAVOC_GAME_DATA_OVERWOLF_GEP_DIRECTORY = gepDir;

    const entry = require("node:path").join(providerDir, "index.js");
    // ELECTRON mode: pass the provider DIRECTORY, not index.js. Electron reads
    // package.json (main + the overwolf.packages declaration) from the
    // directory — that declaration is what makes the PackageManager load the
    // GEP package. Passing index.js as a plain file routes through
    // default_app, which never loads the PackageManager and left
    // app.overwolf undefined (verified in the field 2026-09-22).
    const args = nodeMode ? [entry] : [providerDir];

    let child: ChildProcess;
    try {
      child = spawn(exe, args, {
        cwd: providerDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // windowsHide sets CREATE_NO_WINDOW. For node mode that is fine (no
        // windows are ever created), but for Electron mode it breaks the
        // renderer/GPU child-process startup — every navigation failed with
        // ERR_FAILED (-2). Only hide the node-mode console.
        windowsHide: nodeMode,
      });
    } catch (error) {
      this.state = "error";
      this.lastError = `spawn failed: ${String(error)}`;
      this.scheduleRestart(exe, providerDir, gepDir);
      return;
    }
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.consumeStream(String(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = String(chunk).trim();
      if (text) this.lastError = text.slice(0, 400);
    });
    child.on("error", (error) => {
      this.state = "error";
      this.lastError = `provider process error: ${String(error)}`;
      this.emitProviderStatus("provider_error", this.lastError);
    });
    child.on("exit", (code) => {
      this.child = null;
      if (this.stopped) return;
      this.state = "starting";
      this.lastError = `provider exited (code ${code ?? "signal"})`;
      this.emitProviderStatus("provider_exit", { code });
      this.scheduleRestart(exe, providerDir, gepDir);
    });
  }

  /** Locate the koffi package dir so the elevated child can load FFI bindings. */
  public resolveKoffiPath(): string | null {
    const candidates = [
      // packaged: asar.unpacked/dist -> asar.unpacked/node_modules
      resolve(__dirname, "../../node_modules/koffi"),
      // dev: services/game-data-runtime/dist -> repo node_modules
      resolve(__dirname, "../../../node_modules/koffi"),
    ];
    for (const candidate of candidates) {
      if (existsSync(join(candidate, "index.js"))) return candidate;
    }
    return null;
  }

  /**
   * Elevated launch — the original's windows-native-host design:
   *   1. create a named-pipe server + one-time token
   *   2. write a session file (pipeName + token)
   *   3. spawn via PowerShell `Start-Process -Verb RunAs` (UAC prompt)
   *   4. the elevated child connects back, authenticates, streams the protocol
   * An elevated process cannot share stdio with a medium-integrity parent,
   * which is exactly why the original uses this pipe+session pattern.
   */
  private launchElevated(exe: string, providerDir: string, gepDir?: string): void {
    const pipeName = `\\\\.\\pipe\\havoc-gep-provider-${randomUUID()}`;
    this.elevationToken = randomBytes(24).toString("hex");

    let sessionPath: string;
    try {
      const runDir = join(resolveGameDataDir(), "run");
      mkdirSync(runDir, { recursive: true });
      sessionPath = join(runDir, "gep-provider-session.json");
      writeFileSync(
        sessionPath,
        JSON.stringify(
          { pipeName, token: this.elevationToken, gepDirectory: gepDir ?? null, koffiPath: this.resolveKoffiPath() },
          null,
          2,
        ),
      );
    } catch (error) {
      this.state = "error";
      this.lastError = `session file write failed: ${String(error)}`;
      this.emitProviderStatus("provider_error", this.lastError);
      this.scheduleRestart(exe, providerDir, gepDir);
      return;
    }

    this.closePipeServer();
    const server = createServer((socket) =>
      this.handleElevatedConnection(socket, exe, providerDir, gepDir),
    );
    this.pipeServer = server;
    server.on("error", (error) => {
      this.state = "error";
      this.lastError = `pipe server error: ${String(error)}`;
      this.emitProviderStatus("provider_error", this.lastError);
    });
    server.listen(pipeName, () => {
      // Launcher env vs provider mode:
      //  ELECTRON mode: the env must NOT carry ELECTRON_RUN_AS_NODE, or the
      //    elevated electron.exe would start in node mode.
      //  NODE mode: the elevated electron.exe MUST boot as a plain Node
      //    runtime for the bare addon — force the RUN_AS_NODE marker through
      //    (UAC elevation rebuilds the environment from the spawner's env).
      const nodeModeRequested =
        this.preferNodeMode || process.env.HAVOC_GEP_NODE_MODE === "1";
      const psEnv: NodeJS.ProcessEnv = { ...process.env };
      if (nodeModeRequested) {
        psEnv.ELECTRON_RUN_AS_NODE = "1";
      } else {
        delete psEnv.ELECTRON_RUN_AS_NODE;
      }
      psEnv.OVERWOLF_APP_UID = psEnv.OVERWOLF_APP_UID?.trim() || "mkcfiniehcpkhplpahgeepbdpjophjei";
      if (gepDir) psEnv.HAVOC_GAME_DATA_OVERWOLF_GEP_DIRECTORY = gepDir;
      psEnv.HAVOC_GAME_DATA_DIR = psEnv.HAVOC_GAME_DATA_DIR?.trim() || resolveGameDataDir();

      const ps = (value: string): string => value.replace(/'/g, "''");
      // Elevated launcher script: stale elevated providers cannot be killed
      // from the non-elevated parent, and GEP is a machine-wide singleton —
      // a leftover provider freezes every new one at init. The elevated
      // script cleans them up before booting the fresh provider.
      const launcherScript = [
        "try { Get-Process electron -ErrorAction SilentlyContinue |",
        "  Where-Object { $_.Path -like '*ow-electron*' } | Stop-Process -Force } catch {}",
        "Start-Sleep -Milliseconds 800",
        // Deterministic provider mode: UAC elevation may not inherit this
        // process's environment, so the mode is written INTO the launcher.
        //  NODE mode: RUN_AS_NODE + index.js as a plain script.
        //  ELECTRON mode: launch the provider DIRECTORY so Electron reads its
        //    package.json manifest — the `overwolf.packages: ["gep"]`
        //    declaration (mirroring Spectra-Client) is what makes the
        //    PackageManager load the GEP package and fire `ready`.
        `$env:OVERWOLF_APP_UID = '${ps(psEnv.OVERWOLF_APP_UID ?? "")}'`,
        `$env:HAVOC_GAME_DATA_DIR = '${ps(psEnv.HAVOC_GAME_DATA_DIR ?? "")}'`,
        ...(gepDir ? [`$env:HAVOC_GAME_DATA_OVERWOLF_GEP_DIRECTORY = '${ps(gepDir)}'`] : []),
        ...(nodeModeRequested
          ? [
              "$env:ELECTRON_RUN_AS_NODE = '1'",
              `& '${ps(exe)}' '${ps(providerDir + "\\index.js")}' --session '${ps(sessionPath)}'`,
            ]
          : [
              // Electron mode: UAC rebuilds the elevated child's environment
              // from the spawner's, which carries ow-electron's headless
              // marker ELECTRON_NO_ATTACH_CONSOLE — with it set, every
              // BrowserWindow navigation fails ERR_FAILED (-2) (file://, data:
              // AND http://) because the renderer/network services never come
              // up, which killed the renderer-host fallback on the elevated
              // path. Same fix as launchDirect: strip it ($env:X = $null
              // removes the variable from the process env).
              "$env:ELECTRON_NO_ATTACH_CONSOLE = $null",
              `& '${ps(exe)}' '${ps(providerDir)}' --session '${ps(sessionPath)}'`,
            ]),
      ].join("\r\n");
      const launcherPath = sessionPath.replace(/[^/\\]+$/, "launch-elevated-provider.ps1");
      writeFileSync(launcherPath, launcherScript, "utf8");
      const launcher = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps(launcherPath)}'`,
        ],
        { env: psEnv, stdio: "ignore", windowsHide: true },
      );
      launcher.on("error", (error) => {
        this.state = "error";
        this.lastError = `elevation launcher failed: ${String(error)}`;
        this.emitProviderStatus("provider_error", this.lastError);
      });
      launcher.once("exit", (code) => {
        if (code !== 0 && code !== null) {
          this.state = "error";
          this.lastError = "UAC elevation declined — running GEP provider unelevated";
          this.emitProviderStatus("elevation_fallback", { exit: code });
          // One polite attempt only: continue unelevated instead of retrying UAC.
          this.elevate = false;
          this.closePipeServer();
          this.clearConnectionTimer();
          this.launch(exe, providerDir, gepDir);
        }
      });
      this.emitProviderStatus("elevation_requested", {});
    });

    // Elevated processes have no child handle to watch; the pipe connection is
    // the liveness signal (45s budget, same as the original's host timeout).
    this.clearConnectionTimer();
    this.connectionTimer = setTimeout(() => {
      this.connectionTimer = null;
      if (this.stopped || this.hostSocket) return;
      this.state = "error";
      this.lastError = "elevated provider did not connect (UAC declined?) — falling back to unelevated";
      this.emitProviderStatus("elevation_fallback", { reason: "connection_timeout" });
      // One polite attempt only: continue unelevated instead of retrying UAC.
      this.elevate = false;
      this.closePipeServer();
      this.launch(exe, providerDir, gepDir);
    }, ELEVATED_CONNECTION_TIMEOUT_MS);
    this.connectionTimer.unref();
  }

  private clearConnectionTimer(): void {
    if (!this.connectionTimer) return;
    clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
  }

  private closePipeServer(): void {
    this.pipeServer?.close();
    this.pipeServer = null;
  }

  private handleElevatedConnection(
    socket: Socket,
    exe: string,
    providerDir: string,
    gepDir?: string,
  ): void {
    if (this.hostSocket) {
      socket.destroy();
      return;
    }
    this.clearConnectionTimer();
    let pending = "";
    let authenticated = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (!authenticated) {
        pending += chunk;
        const newline = pending.indexOf("\n");
        if (newline === -1) return;
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        try {
          const hello = JSON.parse(line) as { type?: string; token?: string };
          if (hello?.type !== "hello" || hello.token !== this.elevationToken) {
            socket.destroy();
            return;
          }
        } catch {
          socket.destroy();
          return;
        }
        authenticated = true;
        this.hostSocket = socket;
        this.state = "starting";
        if (pending) this.consumeStream(pending);
        return;
      }
      this.consumeStream(chunk);
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (this.hostSocket !== socket) return;
      this.hostSocket = null;
      if (this.stopped) return;
      this.state = "starting";
      this.lastError = "elevated provider pipe disconnected";
      this.emitProviderStatus("provider_exit", { reason: "pipe_closed" });
      this.scheduleRestart(exe, providerDir, gepDir);
    });
  }

  private consumeStream(chunk: string): void {
    if (process.env.HAVOC_PROVIDER_DEBUG === "1") {
      process.stdout.write(`[provider-parent] recv: ${chunk.slice(0, 300).trim()}\n`);
    }
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.startsWith("{")) this.handleMessage(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private providerLogStream: FsWriteStream | null = null;

  /**
   * File log of every provider message — the fork's equivalent of the
   * original's runtime.jsonl, so live issues are diagnosable after the fact.
   */
  private logProviderMessage(msg: ProtocolMessage): void {
    try {
      if (!this.providerLogStream) {
        const dataDir = process.env.HAVOC_GAME_DATA_DIR?.trim() ||
          join(process.env.LOCALAPPDATA ?? "", "Havoc", "game-data-runtime");
        const logsDir = join(dataDir, "logs");
        mkdirSync(logsDir, { recursive: true });
        const stream = createWriteStream(join(logsDir, "provider-messages.jsonl"), { flags: "a" });
        stream.on("error", () => {});
        this.providerLogStream = stream;
      }
      const payloadPreview = JSON.stringify(msg.payload ?? null);
      this.providerLogStream.write(`${JSON.stringify({
        at: new Date().toISOString(),
        kind: msg.kind ?? msg.type,
        payload: payloadPreview && payloadPreview.length > 600
          ? payloadPreview.slice(0, 600) + "..."
          : payloadPreview,
      })}\n`);
    } catch { /* never break the pipeline on logging */ }
  }

  // Parent-driven attach state — the Overwolf process monitor never fires in
  // the field, so this is the only attach path: the pid we last sent
  // connect-game for, and the last time real game data arrived. Together they
  // drive the re-attach loop below (new pid, late launch, or stale connection
  // all trigger a fresh connect-game).
  private attachedPid: number | null = null;
  private lastGameDataAt = 0;
  private attachTimer: NodeJS.Timeout | null = null;
  // ---- Telemetry-delivery state machine (A2) — see computeTelemetryState ----
  private telemetryState: ProviderTelemetryState = "DISCONNECTED";
  private telemetryPrevious: ProviderTelemetryState = "DISCONNECTED";
  private attachedAt: number | null = null;
  private featuresSetAt: number | null = null;
  private firstInfoUpdateAt: number | null = null;
  // ---- A4 monitor-loss recovery (bounded, see provider-recovery.ts) ----
  private recoveryState: MonitorRecoveryState = { attempts: 0, windowStart: 0 };

  private startAttachLoop(): void {
    this.stopAttachLoop();
    // Fast tick: GEP can only hook VALORANT right after the ShooterGame
    // process spawns (Vanguard hardens it within seconds), so winning the
    // fresh-spawn race matters. Same-pid ticks are cheap no-ops.
    const initial = setTimeout(() => void this.attachAlreadyRunningGame(), 2_000);
    initial.unref();
    this.attachTimer = setInterval(() => void this.attachAlreadyRunningGame(), 4_000);
    this.attachTimer.unref();
  }

  private stopAttachLoop(): void {
    if (this.attachTimer) {
      clearInterval(this.attachTimer);
      this.attachTimer = null;
    }
  }

  /**
   * VALORANT attach loop tick: locate the game process and tell the provider
   * to gep.connect explicitly. Idempotent — sends only when the target pid
   * changed, nothing is attached, or the current attachment went stale.
   */
  private attachAlreadyRunningGame(): void {
    const exec = (file: string, args: string[]): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawn(file, args, { windowsHide: true });
        let out = "";
        child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)));
      });
    void exec("tasklist", [
      "/FI", "IMAGENAME eq VALORANT-Win64-Shipping.exe", "/FO", "CSV", "/NH",
    ]).then((out) => {
      const match = /"VALORANT-Win64-Shipping\.exe","(\d+)"/.exec(out);
      if (!match) return; // not running yet — the loop keeps polling
      const pid = Number(match[1]);
      const now = Date.now();
      // Healthy = attached to this pid AND data arrived recently.
      //
      // STALE THRESHOLD MUST EXCEED GEP'S INIT WINDOW. After gep.connect()
      // resolves, the GEP plugin spends up to 300s initializing (observed:
      // plugin_status "initializing" for exactly 5:00 before it either
      // streams or errors). The old 60s threshold declared the attachment
      // stale mid-init and re-sent connect-game every ~64s, which RESET the
      // plugin's initialization — an infinite loop where data could never
      // arrive (observed 06:29-06:59: connect resolved -> 5min -> nothing ->
      // re-attach). Only re-attach after the full init window plus margin.
      const stale = this.attachedPid !== null && now - this.lastGameDataAt > TELEMETRY_FRESHNESS_MS;
      this.evaluateTelemetryState();
      if (this.attachedPid === pid && !stale) return;
      const msg = {
        type: "command",
        requestId: randomUUID(),
        name: "connect-game",
        payload: { gameId: 21640, pid, name: "VALORANT" },
      };
      this.emitProviderStatus("preopened_game_attach", {
        pid,
        reattach: this.attachedPid !== null,
      });
      this.attachedPid = pid;
      // Seed the freshness window so the loop does not spam connect-game while
      // the child settles the connection; real data refreshes it from then on.
      this.lastGameDataAt = now;
      this.attachedAt = now;
      if (this.hostSocket && !this.hostSocket.destroyed) {
        this.hostSocket.write(JSON.stringify(msg) + "\n");
      } else {
        this.child?.stdin?.write(JSON.stringify(msg) + "\n");
      }
      this.evaluateTelemetryState();
    }).catch(() => { /* process scan failed — the loop retries next tick */ });
  }

  private scheduleRestart(exe: string, providerDir: string, gepDir?: string): void {
    if (this.stopped || this.restartTimer) return;
    this.restartAttempt += 1;
    const delay = Math.min(2_000 * this.restartAttempt, 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.state = "starting";
      this.launch(exe, providerDir, gepDir);
    }, delay);
  }

  /**
   * Watch GEP's own plugin_status stream for the monitor-conflict signature.
   *
   * The addon reports `last_error = failed_initializing_monitor` when another
   * host (retail Overwolf) already owns the process monitor. Without this the
   * provider silently loops disconnected -> shutdown -> initializing and the
   * HUD freezes on whatever scene it last saw.
   */
  private watchPluginStatus(item: GepItem): void {
    const category = String(item.category ?? item.feature ?? "").toLowerCase();
    if (category !== "plugin_status") return;
    const key = String(item.key ?? "").toLowerCase();
    const value = typeof item.value === "string" ? item.value : "";
    if (key !== "last_error" || !value.includes(MONITOR_CONFLICT_ERROR)) return;
    if (this.monitorConflictHandled) return;
    this.monitorConflictHandled = true;
    this.state = "error";
    this.lastError = `GEP monitor unavailable (${MONITOR_CONFLICT_ERROR})`;
    // A4 (FIX A): recover UNCONDITIONALLY. The previous path restarted only
    // when retail Overwolf was found and killed — when Overwolf was already
    // dead (resolved=false) the provider was never restarted and the fact
    // stream stayed dead for the rest of the match (A3-LIVE, confirmed).
    const overwolfFound = findOverwolfProcesses().length > 0;
    const decision = monitorRecoveryDecision(this.recoveryState, Date.now());
    this.recoveryState = { attempts: decision.attempts, windowStart: decision.windowStart };
    this.emitProviderStatus("provider_error", this.lastError);
    if (!decision.restart) {
      // §11: bounded — repeated failures inside the window enter a cooldown
      // instead of an uncontrolled spawn loop. The next failure after the
      // cooldown re-triggers recovery (60s debounce re-arms meanwhile).
      const cooldown = Math.max(1, Math.ceil(decision.cooldownMs / 1000));
      this.emitProviderStatus("monitor_recovery_cooldown", {
        attempts: decision.attempts,
        cooldownSeconds: cooldown,
      });
      setTimeout(() => {
        this.monitorConflictHandled = false;
      }, decision.cooldownMs);
      return;
    }
    // Attempt Overwolf conflict cleanup first (harmless when absent).
    const resolved = this.resolveOverwolfConflict("monitor-conflict");
    // A4 (FIX B): terminate orphaned gep-provider processes — the likely
    // monitor thief — before spawning the replacement (§4: at most one).
    this.emitProviderStatus("monitor_recovery_started", {
      overwolfFound,
      overwolfKilled: resolved,
      attempts: decision.attempts,
    });
    void this
      .cleanupOrphanedGepProviders()
      .then((cleaned) => {
        this.emitProviderStatus("monitor_recovery_cleanup_done", { killed: cleaned });
        this.restartProviderNow();
      })
      .catch((error) => {
        this.emitProviderStatus("monitor_recovery_failed", { error: String(error) });
        // Recovery must not die with the cleanup: restart regardless.
        this.restartProviderNow();
      });
    setTimeout(() => {
      this.monitorConflictHandled = false;
    }, 60_000);
  }

  /** Force an immediate provider relaunch (used after clearing a conflict). */
  private restartProviderNow(): void {
    if (this.stopped) return;
    const exe = resolveOwElectronPath();
    const providerDir = resolveProviderDir();
    if (!exe || !providerDir) return;
    this.child?.kill();
    this.child = null;
    this.hostSocket?.destroy();
    this.hostSocket = null;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.restartAttempt = 0;
    this.scheduleRestart(exe, providerDir);
  }

  private handleMessage(line: string): void {
    let msg: ProtocolMessage;
    try {
      msg = JSON.parse(line) as ProtocolMessage;
    } catch {
      return;
    }
    this.logProviderMessage(msg);
    if (msg.type === "ready") {
      // Child is alive; PackageManager may still be downloading GEP.
      if (this.state !== "ready") this.state = "starting";
      return;
    }
    if (msg.type === "failure") {
      this.state = "error";
      this.lastError = msg.reason ?? "unknown provider failure";
      this.emitProviderStatus("provider_error", this.lastError);
      // A failed provider child (e.g. PM fallback timeout) stays alive in retry
      // loops that will never succeed — stop it and let the backoff restart.
      this.child?.kill();
      this.child = null;
      this.hostSocket?.destroy();
      this.hostSocket = null;
      // Electron mode (official PackageManager API) failed: fall back to the
      // bare-addon node mode for the next launch instead of retrying the same
      // failing mode forever.
      if (!this.preferNodeMode && process.env.HAVOC_GEP_NODE_MODE !== "1") {
        this.preferNodeMode = true;
        this.emitProviderStatus("provider_fallback_node_mode", { reason: this.lastError });
      }
      return;
    }
    if (msg.type !== "event") return;

    // Command responses (pipe mode): correlate by requestId.
    if ((msg.kind ?? "").startsWith("command-result")) {
      const payload = msg.payload as { requestId?: string; result?: unknown; error?: string } | null;
      const pending = this.pendingCommand;
      if (pending && payload?.requestId === pending.requestId) {
        this.pendingCommand = null;
        clearTimeout(pending.timer);
        if (payload.error) pending.reject(new Error(payload.error));
        else pending.resolve(payload.result ?? null);
      }
      return;
    }

    switch (msg.kind ?? "") {
      case "provider-ready": {
        this.state = "ready";
        this.lastError = null;
        this.restartAttempt = 0;
        // Fresh provider session — per-match telemetry proof resets.
        this.attachedAt = null;
        this.featuresSetAt = null;
        this.firstInfoUpdateAt = null;
        const rec = msg.payload as { version?: string } | null;
        if (typeof rec?.version === "string" && rec.version) this.providerVersion = rec.version;
        this.emitProviderStatus("provider_ready", msg.payload);
        // The Overwolf process monitor only reports games that LAUNCH after it
        // starts — and in the field it has never fired at all. Valorant may
        // already be running, or may launch minutes later: keep polling.
        this.startAttachLoop();
        return;
      }
      case "game-detected":
        this.emitProviderStatus("game_detected", msg.payload);
        return;
      case "game-exit":
        this.attachedPid = null;
        // Per-match telemetry proof resets: the next game must re-prove the
        // fact stream (game_exit → ATTACHED until new telemetry arrives).
        this.featuresSetAt = null;
        this.firstInfoUpdateAt = null;
        this.emitProviderStatus("game_exit", msg.payload);
        this.evaluateTelemetryState();
        return;
      case "elevated-privileges-required":
        this.state = "error";
        this.lastError = "VALORANT is running elevated; run the desktop as administrator to capture events";
        this.emitProviderStatus("provider_error", this.lastError);
        return;
      case "gep-error":
        this.lastError = typeof msg.payload === "string" ? msg.payload : JSON.stringify(msg.payload);
        this.emitProviderStatus("provider_error", this.lastError);
        return;
      case "features-set":
        this.featuresSetAt = Date.now();
        this.evaluateTelemetryState();
        this.emitProviderStatus("features_set", msg.payload);
        return;
      case "info-update": {
        // Telemetry proof lives here too: the ELECTRON package path delivers
        // kebab-kind messages, and only the underscore aliases used to stamp
        // lastGameDataAt/firstInfoUpdateAt — so a fully healthy stream stayed
        // FEATURES_SET with firstInfoUpdateAt:null forever (live 2026-10-18).
        //
        // v10 (patch-day 2026-10-20): static pings (game_info:is_pbe) kept
        // arriving on the rearm loop while injection was dead — they must NOT
        // stamp the proof, or the state machine reports HEALTHY through a
        // completely starved match (facts still flow unchanged).
        const item = msg.payload != null && typeof msg.payload === "object" ? (msg.payload as GepItem) : null;
        if (!item || !isStaticGameDataItem(item)) {
          this.lastGameDataAt = Date.now();
          if (this.firstInfoUpdateAt === null) this.firstInfoUpdateAt = this.lastGameDataAt;
          this.evaluateTelemetryState();
        }
        if (item) {
          this.watchPluginStatus(item);
          factFromInfoUpdate(item, this.emit);
        }
        return;
      }
      case "game-event": {
        this.lastGameDataAt = Date.now();
        if (msg.payload != null && typeof msg.payload === "object") {
          factFromGameEvent(msg.payload as GepItem, this.emit);
        }
        return;
      }
      case "info-dump":
        factFromInfoDump(msg.payload, this.emit);
        return;
      // Direct-addon stream: payload is an array of raw callback args.
      // The raw addon emits camelCase callback kinds ("infoUpdate", "newEvent",
      // "disconnected", ...); kebab/snake names cover the host-relayed and
      // legacy paths. Every alias MUST land on the same handler — a missing
      // alias silently drops live game data (root cause of "Valorant never
      // detected / scenes never switch" in the field).
      case "new_info_update":
      case "info_update":
      case "infoUpdate": {
        const item = findInfoItem(msg.payload);
        // v10: static pings never stamp telemetry proof (see info-update).
        if (!item || !isStaticGameDataItem(item)) {
          this.lastGameDataAt = Date.now();
          if (this.firstInfoUpdateAt === null) this.firstInfoUpdateAt = this.lastGameDataAt;
          this.evaluateTelemetryState();
        }
        if (item) factFromInfoUpdate(item, this.emit);
        return;
      }
      case "new_game_event":
      case "game_event":
      case "newEvent":
      case "gameEvent": {
        this.lastGameDataAt = Date.now();
        const item = findInfoItem(msg.payload);
        if (item) factFromGameEvent(item, this.emit);
        return;
      }
      case "disconnected": {
        // The GEP addon lost its game connection. The attach loop re-attaches
        // on its next tick; surface it for diagnostics — AND retire the local
        // session through the runtime's existing game_exit path (A5: this is
        // the lifecycle evidence VALORANT close actually produces; the old
        // diagnostics-only handling left phantom live sessions behind).
        this.attachedPid = null;
        this.emitProviderStatus("game_connection_lost", msg.payload);
        const args = Array.isArray(msg.payload) ? (msg.payload as unknown[]) : [];
        const lifecycle = gepDisconnectLifecycleEvent(args[2]);
        this.emitProviderStatus(lifecycle.key, lifecycle.value);
        return;
      }
      case "gameDetected":
        this.emitProviderStatus("game_detected", msg.payload);
        return;
      case "gameExit":
        this.emitProviderStatus("game_exit", msg.payload);
        return;
      case "monitor":
      case "connect-attempted":
      case "log":
      case "gep-log":
      case "unknown":
        this.emitProviderStatus(msg.kind === "unknown" ? "provider_raw" : (msg.kind ?? "provider_log"), msg.payload);
        return;
      default:
        return;
    }
  }

  private get emit(): ProviderEmit {
    return (fact) => this.emitFn?.(fact);
  }

  private emitProviderStatus(key: string, value: unknown): void {
    this.emitFn?.({ kind: "new_game_event", key: "provider_status", value: { key, value, at: Date.now() } });
  }
}
