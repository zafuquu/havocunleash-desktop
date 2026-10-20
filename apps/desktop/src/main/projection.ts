/**
 * Valorant projection session â€” normalizes provider facts into HUD relay
 * state, with the audited round-number/phase pairing rules (hold a backwards
 * phase until its matching number lands; drop stale end-phases).
 */
import {
  hudRelayStateSchema,
  type HudRelayState,
  type KillfeedEntry,
  type ValorantSessionSnapshot,
} from "@havoc-unleash/contracts";

import { logger } from "./logger";
import { agentDisplayName, agentIconUrl, weaponDisplayName } from "./valorant-identity";

import * as nodeFs from "fs";
import * as nodeOs from "os";
import * as nodePath from "path";

const PHASE_ORDER: Record<string, number> = { shopping: 0, combat: 1, end: 2 };

/**
 * Phase 2 â€” boot-cache provenance.
 *
 * Provider/plugin STATUS frames prove the provider is talking; they are not
 * evidence that a match exists, so they must never satisfy the boot-cache gate
 * (same principle as the A2 rule that plugin_status cannot make telemetry
 * HEALTHY â€” telemetry health needs real game data, not handshakes).
 */
const STATUS_FACT_KEYS: ReadonlySet<string> = new Set(["provider_status"]);

/**
 * Phase 2 â€” session phases that PROVE a real Valorant session. `idle`/`unknown`
 * are deliberately excluded: they are exactly what the runtime publishes when
 * nothing is running, and the first such frame used to be enough to promote a
 * restored previous match into authoritative state.
 */
const LIVE_SESSION_PHASES: ReadonlySet<string> = new Set(["loading", "pregame", "live", "ending"]);

/**
 * Relay board contract â€” `packages/contracts/src/hud-state.ts` caps the relay
 * roster at 10 entries (`.max(10)`) because the site renders a 5v5 board.
 *
 * Live defect fixed here (2026-09-24, hybrid Blob capture engine): the provider
 * can report MORE identities than the relay contract allows (an extra/duplicate
 * scoreboard row), so `s.roster` reached 11. `build()` then threw a ZodError
 * (`too_big`, path `["roster"]`) from an UNGUARDED `hudRelayStateSchema.parse`,
 * and that single throw took the whole publisher down:
 *
 *   - inside the SSE frame path it tore the runtime stream down
 *     (`runtime-client stream_reconnecting` burned the reconnect budget), and
 *   - inside an HTTP handler (`GET /api/status`) it escaped as an UNCAUGHT
 *     exception, so Electron showed its blocking
 *     "A JavaScript error occurred in the main process" dialog.
 *
 * The main thread never returned: snapshots stopped reaching the bridge, the
 * Supabase mirror/presence froze and the website/OBS stayed empty while the app
 * window still showed its last painted frame.
 *
 * The relay therefore enforces its own contract BEFORE validating, without
 * inventing anything: dedupe identities, then keep at most 5 per reported side
 * and 10 overall, preserving source order.
 */
const RELAY_ROSTER_MAX = 10;
const RELAY_ROSTER_PER_TEAM = 5;

/**
 * Diagnostics retained from the boot cache. This is NEVER authoritative state â€”
 * see restoreCache().
 */
interface BootContinuity {
  savedAt: number;
  ageMs: number;
  matchId: string | null;
  mapKey: string | null;
  mapName: string | null;
  score: { blue: number; red: number };
  roundNumber: number;
  roundPhase: string | null;
  rosterCount: number;
  rosterNames: string[];
}

/**
 * Reads a display name out of every identity dialect the runtimes send.
 *
 * Live 2026-09-29 (fork capture engine): the session viewer identity is nested â€”
 * `session.viewer.player.name.displayName` (+ `gameName`/`tagLine`) â€” while the
 * projection read `viewer.player.displayName`, which that engine never sends.
 * The authoritative local-player identity therefore stayed null for a whole match
 * and only the later `is_local` scoreboard row anchored it, i.e. the viewer's own
 * abilities had no identity to attach to for the first rounds. The roster build
 * already reads `player.name.displayName`; this is the same dialect union.
 */
function displayNameOf(player: unknown): string | null {
  const p = player as Record<string, any> | null | undefined;
  if (!p) return null;
  const nested = (p.name ?? p.identity ?? {}) as Record<string, any>;
  const joined =
    typeof nested.gameName === "string" && typeof nested.tagLine === "string"
      ? `${nested.gameName}#${nested.tagLine}`
      : null;
  const raw = p.displayName ?? nested.displayName ?? joined ?? p.gameName ?? nested.gameName ?? null;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * GEP facts frequently arrive as JSON-encoded STRINGS (scoreboard, kill_feed,
 * match_score, ...). Decode once so every case works with real objects.
 */
function parseFactValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

/** Pipeline telemetry â€” enabled with HAVOC_DEBUG_PIPELINE=1 (no secrets). */
function pipelineLog(event: string, data: Record<string, unknown>): void {
  if (process.env.HAVOC_DEBUG_PIPELINE === "1") {
    console.log("[pipeline:projection]", event, JSON.stringify(data));
  }
}

interface WorkingState {
  revision: number;
  // Includes all upstream phases (unknown/pregame/ending) + fork (loading).
  sessionPhase: "unknown" | "idle" | "loading" | "pregame" | "live" | "ending";
  matchId: string | null;
  mapKey: string | null;
  mapName: string | null;
  roundNumber: number;
  roundPhase: "shopping" | "combat" | "end" | "unknown";
  phaseStartedAt: number | null;
  spikePlantedAt: number | null;
  /**
   * Spike plant site ("A" | "B" | "C") while planted â€” mirrors the timestamp's
   * lifecycle (set on plant, cleared on defuse/detonation/round reset).
   */
  plantSite: string | null;
  /**
   * ROUND-LOCAL terminal spike outcome (defused/detonated) + the round it
   * belongs to. Needed because the spike event can be followed within
   * milliseconds by the NEXT round's plant (live capture 2026-09-24:
   * `spike_defused` â†’ +2 ms `planted_location`), so the global `spike` state
   * can no longer carry the round's outcome by the time the round settles.
   * The latch never crosses rounds: it is only applied when its round matches
   * the settling round and is cleared at every round/match reset.
   */
  terminalSpike: { round: number; outcome: "defused" | "detonated" } | null;
  viewerGepTeam: number | null;
  viewerName: string | null;
  pendingPhase: string | null;
  publishedNumber: number;
  publishedPhase: string | null;
  blue: number;
  red: number;
  spike: HudRelayState["spike"];
  killfeed: KillfeedEntry[];
  viewerRole: "player" | "observer" | "coach" | "spectator" | "unknown";
  /** Epoch ms when the session first went live â€” drives the round-1 buy grace. */
  liveSince: number | null;
  roster: HudRelayState["roster"];
  // --- Round-settlement classification (ported from upstream val-round-settlement) ---
  gameEvent: string | null;
  /**
   * PASS 7C â€” WHO the current `gameEvent` label belongs to.
   *
   * The label is established by the round the ENGINE named (`round_settled`,
   * which carries the authoritative winner/winType of the round that ended) or
   * by `settle()` when the projection settles first. It is deliberately NOT
   * cleared when the next round's buy/combat wipes the end-phase state (the
   * round-win banner stays on screen through the buy phase), so it outlives the
   * settlement it describes.
   *
   * `roundEnd` â€” the object consumers actually render â€” is REPLACED every time
   * any winner source settles a round. Without this ownership record a later
   * settlement would carry the PREVIOUS round's label: live 2026-09-30
   * 05:51:48 the round-9 label survived into rounds 10-16 (each showing the round
   * it settled next to a stale classification), and 03:28:13 the enemy's round-3
   * ACE was published alongside round 4's blue win.
   *
   * `gameEventRound` = `roundEnd.round` while the two describe the same round,
   * and null whenever they do not â€” so a consumer can never pair a winner with
   * another round's classification.
   */
  gameEventRound: number | null;
  roundKills: Map<string, number>;
  /**
   * Per-round ACE evidence: the DISTINCT victims each killer actually eliminated,
   * recorded only when the victim resolves to a known roster row. An ACE is
   * "the same player eliminated all five opponents", which can only be proven
   * from identities â€” never from a kill COUNT (live 2026-09-30: 3 real kills
   * were counted as 6 because the engine emits every kill twice, and the old
   * `>= 5` predicate displayed ACE for a round nobody aced).
   */
  roundKillVictims: Map<string, Set<string>>;
  roundDeaths: Set<string>;
  clutchMax: Map<string, number>;
  roundStartScore: { blue: number; red: number } | null;
  /** Combat phase start (epoch) â€” base for the derived timeout reason (VS round-clock parity). */
  combatStartedAt: number | null;
  /**
   * The round whose combat phase the clock above belongs to (0 = none observed).
   * The clock is ROUND-SCOPED: without this, a round the engine never sent a
   * combat fact for (fork R1/R2: no round facts until R3, live 2026-09-25
   * 02:07:18-02:09:14) inherited the previous round's clock and the settlement
   * classified it by the WRONG elapsed time.
   */
  combatStartedRound: number;
  /** Epoch ms the CURRENT round started (its buy/in-play boundary) + which round. */
  roundStartedAt: number | null;
  roundStartedRound: number;
  /**
   * True once the engine has published a ROUND fact for the current match.
   *
   * A `round_number` / `round_phase` fact can only come from a match that is
   * actually being played, but the runtime's SESSION-level phase lags the match
   * load: live 2026-09-30 05:41:10 the engine published `round 1/shopping` while
   * the session snapshot still reported `pregame` for ~19 s, so HU presented the
   * agent-select scene (and `isAgentSelectPhase: true`) through the first part of
   * R1's buy â€” the "R1 BuyRound has no data / R2 is normal" divergence (R2+ always
   * had a live session by the time its buy started). Once set, a stale
   * pregame/loading frame can no longer pull the session back.
   */
  roundFactsSeen: boolean;
  /**
   * True when the published phase came from a real engine fact (publishRound).
   * False when the score-stream round sync derived it. The terminal-spike latch
   * needs this: a straggler `spike_defused` belongs to the round that just
   * settled while WE still own the derived buy phase, but it is stale once the
   * engine has named the next round's phase itself.
   */
  roundPhaseFromFact: boolean;
  /**
   * True once a score observation has been applied to this match. The FIRST
   * observation cannot describe a transition we watched (HU can join mid-match),
   * so it only seeds the round number and never synthesizes a round boundary.
   */
  scoreSeen: boolean;
  /** Restored-from-cache data not yet confirmed by live runtime frames. */
  restorePending: boolean;
  /** Epoch ms of the last round settlement â€” drives the endround hold. */
  roundEndedAt: number | null;
  matchWinner: "blue" | "red" | null;
  /**
   * PASS 7B â€” true between a new-match boundary (fresh agent select) and the new
   * match's own live evidence. A trailing frame from the retired match (e.g. a
   * belated `game_end`) must not re-select Post Game because of it.
   */
  newMatchPending: boolean;
  matchMvp: { name: string; teamId: string; kills: number; deaths: number; assists: number } | null;
  /**
   * Active tactical timeout / tech pause (BLOB timeoutStarted parity; the
   * runtime detects the buy-phase freeze and emits `timeout_changed`). `team`
   * is null when the caller is unknown (GEP never attributes it) — the overlay
   * renders a neutral banner instead of mislabeling a side.
   */
  timeout: {
    team: "left" | "right" | null;
    calledAt: number;
    timeoutType: "tactical" | "tech_pause";
  } | null;
  roundEnd: {
    winner: "blue" | "red";
    reason: "elimination" | "detonation" | "defusion" | "time";
    winnerSide?: "attacker" | "defender" | null;
    /** The settled round's number â€” the stable Game Event identity. */
    round?: number | null;
    /** The settlement's ceremony label for THIS round (mirrors roundHistory[].label). */
    label?: string | null;
    /** Clutch/highlight player (agent + KDA) for the ceremony card. */
    highlightPlayer?: {
      name: string;
      agent: string | null;
      kills: number | null;
      deaths: number | null;
      assists: number | null;
    } | null;

  } | null;
  /** The viewer's START side from the snapshot (defense/attack) â€” side label ground truth. */
  viewerStartSide: "attack" | "defense" | null;
  /** Epoch of the last authoritative session snapshot (hybrid: blob runtime). */
  sessionPhaseAt: number | null;
  /** The viewer's side THIS round â€” GEP `game_info/team` ground truth ("attack"/"defense"). */
  viewerSide: "attack" | "defense" | null;
  /**
   * The viewer's side as observed when the CURRENT round started.
   *
   * The ATTACKER/DEFENDER label needs the side of the round being settled. When
   * the session's START side is unknown (a mid-match HU start, or an engine that
   * never re-sends the session's startingSide â€” live 2026-09-30 06:49:
   * `viewerSide=null/defense` with the start side present only in some sessions)
   * `viewerSideForRound()` had nothing to derive from and the round-win label
   * vanished from the Game Event. The side sampled at the round's own start is
   * that round's side, so it is recorded per round (round-scoped, no carry-over).
   */
  roundViewerSide: "attack" | "defense" | null;
  /** Last seen GEP round_outcome {won,lost} â€” viewer-perspective round result. */
  roundOutcome: { won: number; lost: number } | null;
  /**
   * Highest round number whose settlement was recorded (by ANY source: the
   * runtime's round_settled event, the end-phase settle, the score delta). The
   * score-stream round-progression sync (HU-014) reads this to tell "the round
   * that just scored is already settled" apart from "no round fact ever
   * described it" â€” it is monotonic per match and reset by every match wipe.
   */
  lastSettledRound: number;
  roundHistory: Array<{
    /** The settlement's ceremony label for THIS round (Thrifty/Ace/Clutch/Flawless...). */
    label?: string | null;

    round: number;
    winner: "blue" | "red";
    reason: "elimination" | "detonation" | "defusion" | "time";
  }>;
}

function initial(): WorkingState {
  return {
    revision: 0,
    sessionPhase: "idle",
    matchId: null,
    mapKey: null,
    mapName: null,
    roundNumber: 0,
    roundPhase: "unknown",
    phaseStartedAt: null,
    spikePlantedAt: null,
    plantSite: null,
    terminalSpike: null,
    viewerGepTeam: null,
    viewerName: null,
    pendingPhase: null,
    publishedNumber: 0,
    publishedPhase: null,
    blue: 0,
    red: 0,
    spike: null,
    killfeed: [],
    viewerRole: "unknown",
    liveSince: null,
    roster: [],
    gameEvent: null,
    gameEventRound: null,
    roundKills: new Map(),
    roundKillVictims: new Map(),
    roundDeaths: new Set(),
    clutchMax: new Map(),
    roundStartScore: null,
    combatStartedAt: null,
    combatStartedRound: 0,
    roundStartedAt: null,
    roundStartedRound: 0,
    roundPhaseFromFact: false,
    scoreSeen: false,
    roundFactsSeen: false,
    restorePending: false,
    roundEndedAt: null,
    matchWinner: null,
    newMatchPending: false,
    matchMvp: null,
    timeout: null,
    roundEnd: null,
    viewerStartSide: null,
    sessionPhaseAt: null,
    viewerSide: null,
    roundViewerSide: null,
    roundOutcome: null,
    lastSettledRound: 0,
    roundHistory: [],
  };
}

export class ValProjectionSession {
  private s = initial();
  private killSeq = 1;
  /**
   * Signature + epoch of the last kill fact that was APPLIED.
   *
   * The capture engine emits the SAME kill twice â€” byte-identical payloads a
   * couple of milliseconds apart (live capture 2026-09-30 03:26:38.352, and the
   * relay kill feed showed every kill as a pair: seq 2/3, 4/5, 6/7 ... 14/15).
   * Each duplicate used to add a second kill-feed row AND a second round kill,
   * so a player with 3 real kills was counted at 6 and the round-win ceremony
   * displayed ACE for a round nobody aced. One kill event is applied once.
   *
   * The window is 500 ms: the observed duplicate is 0-2 ms apart, while a
   * legitimate second kill of the same victim by the same attacker with the same
   * weapon needs a revive/re-engagement cycle (seconds).
   */
  private lastKillFact: { sig: string; at: number } | null = null;
  /** Stable per-player creation order â€” keeps roster positions fixed across publishes. */
  private rosterSeq = new Map<string, number>();
  /**
   * Identities that exist ONLY as scoreboard observations (never listed in a
   * provider squad snapshot). They may fill a free board slot but must never
   * displace a real squad member â€” the live provider reported such extra rows
   * (2026-09-24) and they must not cost a player their slot.
   */
  private observedOnlyRoster = new Set<string>();
  /**
   * Last GEP team number seen per player â€” the team-side source of truth.
   */
  private lastGepTeam = new Map<string, number>();
  /**
   * The viewer's GEP team number derived from the engine's VIEWER-RELATIVE
   * `teammate` flag, before the local player's own row has been seen.
   *
   * Live 2026-09-30: every GEP scoreboard row carries `teammate` (true when the
   * row is on the local player's side) and the ENEMY rows are emitted FIRST â€”
   * `scoreboard_0..2` (teammate:false) at 03:25:51.965, the local squad
   * (`teammate:true`) at .990. Without this the cold start assigned every
   * pre-anchor row to the viewer's side, so the opponent sat on the left with the
   * viewer's score until the local `is_local` row finally landed â€” the reported
   * "team block on one side, score on the other" Agent-Select defect. The flag is
   * pure identity evidence (never array order, never a team LABEL), and the direct
   * `is_local` anchor always outranks it.
   */
  private gepTeamFromTeammate: number | null = null;
  /**
   * Names the engine itself flagged `is_local: true` â€” the fallback local-player
   * identity when the authoritative session snapshot carries no viewer. Identity
   * only: it never creates a roster entry and never guesses by position.
   */
  private localNames = new Set<string>();
  /**
   * The last `me|abilities` payload received BEFORE the local player was
   * identified. The engine emits abilities only when the charges change, so
   * dropping that first frame lost the viewer's abilities for the whole match.
   */
  private pendingAbilityState: { C: boolean; Q: boolean; E: boolean; X: boolean } | null = null;

  private readonly listeners = new Set<(state: HudRelayState) => void>();
  /** Phase 2: quarantined previous-match mirror â€” diagnostics only, never `s`. */
  private bootContinuity: BootContinuity | null = null;
  /** Last relay state that satisfied the contract â€” fallback so build() never throws. */
  private lastGoodRelayState: HudRelayState | null = null;
  /** One-shot warning: a provider reporting extra board rows is visible, not silent. */
  private loggedRosterOverflow = false;

  constructor() {
    // Phase 2: the previous match's disk mirror is QUARANTINED, never applied.
    // A cold boot starts unknown â†’ idle and only live provider evidence may
    // establish a session. (Applying it made a finished board present itself as
    // the live game â€” the HUD showed a stale "0-2 / Ascent" with no VALORANT
    // running, because any first provider frame cleared the unconfirmed flag.)
    this.restoreCache();
  }

  public reset(): void {
    this.s = initial();
    this.emitChange();
  }

  public subscribe(fn: (state: HudRelayState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  public snapshotValue(): HudRelayState {
    return this.build();
  }

  /* ------------------------- inputs ------------------------- */

  public applySnapshot(snap: ValorantSessionSnapshot): void {
    const s = this.s;
    // Dialect normalization: upstream nests identity under session.*
    // A stale pregame/loading session frame cannot pull a match that has already
    // published round facts back out of `live` (see `roundFactsSeen`): the
    // runtime's session phase lags the match load, and letting it win made R1's
    // buy present as agent-select while R2+ presented the buy scene immediately.
    // The evidence is scoped to the match it was observed in: a snapshot naming a
    // DIFFERENT match is a new game and its pregame phase stands.
    const snapshotMatchId = snap.matchId ?? snap.session?.matchId ?? null;
    const sameMatch = snapshotMatchId !== null && snapshotMatchId === s.matchId;
    const sessionPhaseRaw = snap.sessionPhase ?? snap.phase ?? s.sessionPhase;
    // PASS 7B: a SETTLED match + a fresh pre-game phase is a NEW game, not the
    // Pass 5 lag. GEP reuses match_id across games, so `sameMatch` alone made the
    // new game's agent select look like a stale frame and coerced it to "live",
    // which kept the popout on Post Game. The Pass 5 suppression is preserved for
    // a match that is still in progress (round facts seen, nothing settled).
    const matchSettled = s.matchWinner !== null || s.roundHistory.length > 0;
    const newGamePregame =
      sameMatch && matchSettled && (sessionPhaseRaw === "pregame" || sessionPhaseRaw === "loading");
    if (newGamePregame) {
      this.retireMatchForNewGame();
    }
    const sessionPhase =
      s.roundFactsSeen &&
      sameMatch &&
      !matchSettled &&
      (sessionPhaseRaw === "pregame" || sessionPhaseRaw === "loading")
        ? "live"
        : sessionPhaseRaw;
    const matchId = snap.matchId ?? snap.session?.matchId ?? null;
    const mapKey = snap.mapKey ?? snap.session?.map?.key ?? null;
    // Phase 2: only a REAL session (a live-ish phase, or an actual match
    // identity) satisfies the boot-cache gate. An idle/unknown snapshot is what
    // the runtime publishes when nothing is running â€” it must never be able to
    // promote quarantined continuity into authoritative state.
    if (matchId !== null || LIVE_SESSION_PHASES.has(sessionPhase)) s.restorePending = false;

    s.revision += 1;
    if (sessionPhase !== s.sessionPhase && sessionPhase === "live") s.liveSince = Date.now();
    // PASS 7B: the new match is actually live â€” the retired match can no longer
    // bring Post Game back through a trailing frame.
    if (sessionPhase === "live") s.newMatchPending = false;
    s.sessionPhase = sessionPhase;
    // Freshness stamp: every authoritative session snapshot refreshes it. In
    // hybrid mode the blob runtime never sends round facts, so s.roundPhase is
    // FROZEN â€” the fresh session phase must outrank it in deriveScene.
    s.sessionPhaseAt = Date.now();
    // The snapshot's viewer identity, applied AFTER the fresh-match reset below:
    // it describes the match this snapshot reports, so the per-match wipe must
    // not erase the identity that arrived with it. Live 2026-09-26: that left the
    // local player unidentified until the NEXT snapshot, and an ability frame in
    // the gap used to be dropped outright.
    const snapshotViewerName = displayNameOf(
      snap.session?.viewer?.player ?? snap.viewer?.player ?? null,
    );
    if ((s.matchId ?? null) !== matchId) {
      // New match => clear the previous match's post-game result AND the whole
      // team/roster anchoring, so sides re-anchor fresh for the new match.
      s.matchId = matchId;
      s.matchWinner = null;
      s.matchMvp = null;
      s.roster = [];
      s.roundHistory = [];
      s.roundEnd = null;
      s.gameEvent = null;
      s.gameEventRound = null;
      s.viewerGepTeam = null;
      s.viewerName = null;
      // The new match re-anchors its own local player (snapshot viewer, else the
      // next is_local scoreboard row) â€” nothing may be inherited.
      this.localNames.clear();
      this.pendingAbilityState = null;
      s.viewerStartSide = null;
      s.viewerSide = null;
      s.roundOutcome = null;
      s.terminalSpike = null;
      // Round-scoped bookkeeping belongs to the PREVIOUS match and must not
      // survive into the new one. Live 2026-09-25 02:51:12-02:51:29: a fresh
      // match reached agent-select/live while still publishing round 21 and a
      // 0-1 score from the match before it (same map => the map-change reset
      // never fired and this block never reset the round/score counters). The
      // HUD showed a stale ROUND 21 until the new match's first round_number
      // fact arrived at 02:51:56.
      s.blue = 0;
      s.red = 0;
      s.roundNumber = 0;
      s.publishedNumber = 0;
      s.roundPhase = "unknown";
      s.publishedPhase = null;
      s.pendingPhase = null;
      s.phaseStartedAt = null;
      s.combatStartedAt = null;
      s.combatStartedRound = 0;
      s.roundStartedAt = null;
      s.roundStartedRound = 0;
      s.roundPhaseFromFact = false;
      s.scoreSeen = false;
      s.roundFactsSeen = false;
      s.lastSettledRound = 0;
      s.roundStartScore = null;
      s.roundEndedAt = null;
      s.spike = null;
      s.spikePlantedAt = null;
      s.plantSite = null;
      s.killfeed = [];
      this.rosterSeq.clear();
      this.lastGepTeam.clear();
    }
    // Remember the viewer's display name so GEP scoreboard facts can anchor the
    // local player (is_local/team) to their roster entry.
    if (snapshotViewerName && !s.viewerName) s.viewerName = snapshotViewerName;
    const MAP_NAMES: Record<string, string> = {
      // Canonical keys (formatMapKey output) -> display names. Codename
      // aliases included so a stale codename key still resolves.
      ascent: "Ascent", bind: "Bind", haven: "Haven", split: "Split", breeze: "Breeze",
      icebox: "Icebox", pearl: "Pearl", fracture: "Fracture", lotus: "Lotus", sunset: "Sunset",
      abyss: "Abyss", drift: "Drift", piazza: "Piazza", kasbah: "Kasbah", sunset2: "Sunset",
      "ascent-2": "Ascent", glaze: "Glitch", district: "District", summit: "Summit",
      infinity: "Abyss", bonsai: "Split", corrode: "Corrode", range: "The Range",
      // Riot internal codenames the engine actually sends:
      jam: "Lotus", duality: "Bind", foxtrot: "Breeze", canyon: "Fracture",
      pitt: "Pearl", triad: "Haven", port: "Icebox", rook: "Corrode", plummet: "Summit", gauntlet: "Gauntlet", adraft: "Gauntlet",
      infinity_: "Abyss", hurm_alley: "District", hurm_bowl: "Kasbah", hurm_helix: "Drift",
      hurm_hightide: "Glitch", hurm_yard: "Piazza", skirmish_a: "Skirmish A", skirmish_b: "Skirmish B",
      skirmish_c: "Skirmish C", skirmish_d: "Skirmish D", skirmish_e: "Skirmish E",
      juliett: "Sunset", drome: "Drome", riviera: "Riviera",
    };
    if (mapKey) {
      s.mapKey = mapKey;
      s.mapName = MAP_NAMES[mapKey] ?? mapKey;
    }
    if (snap.viewer?.role) s.viewerRole = snap.viewer.role;
    if (mapKey && s.mapKey !== mapKey) {
      // New map => fresh round bookkeeping.
      s.mapKey = mapKey;
      s.killfeed = [];
      s.spike = null;
      s.spikePlantedAt = null;
      s.plantSite = null;
      s.terminalSpike = null;
      s.roundNumber = 0;
      s.publishedNumber = 0;
      s.publishedPhase = null;
      s.pendingPhase = null;
      s.roundPhase = "unknown";
      s.roundEndedAt = null;
    }
    if (snap.viewer?.role) s.viewerRole = snap.viewer.role;
    else if (snap.session?.viewer?.role) s.viewerRole = snap.session.viewer.role;
    const teams = snap.teams ?? snap.session?.teams;
    // SIDE GROUND TRUTH: the upstream snapshot carries each team's starting
    // side (defense/attack). Find the viewer's team by player name and record
    // their START side â€” this replaces the inverted parity heuristic for the
    // ATTACKER WIN/DEFENDER WIN label (the user's matches start on defense,
    // so the assumption "team_0 attacks rounds 1-12" was inverted 100% of
    // the time for them).
    // Ground-truth start side: match the SNAPSHOT'S OWN viewer identity
    // (the matchId-reset above nulls s.viewerName before this loop on fresh
    // matches, which left viewerStartSide null forever â†’ side labels missing).
    //
    // The SAME identity match decides which squad is presented LEFT (teamIndex
    // 0). The snapshot's team labels are NOT presentation sides: Riot names a
    // custom lobby's squads "Team One"/"Team Two" (and the live game "Blue"/
    // "Red") in whatever order it likes, so mapping "Blue" â†’ left could put the
    // OPPONENT on the left while the score (which is anchored to the viewer:
    // blue = the local player's score) stays on the reader's side â€” the live
    // Agent-Select defect (team block on one side, score on the other, flipping
    // as soon as GEP's team numbers land). Presentation side follows TEAM
    // IDENTITY: the viewer's squad is always left.
    const snapViewerKey = (() => {
      const viewerPlayer = snap.session?.viewer?.player ?? snap.viewer?.player ?? null;
      const name = displayNameOf(viewerPlayer);
      return name ? this.normalizeName(name) : "";
    })();
    let viewerSquadPos: number | null = null;
    if (teams && teams.length > 0 && snapViewerKey) {
      teams.forEach((team, pos) => {
        const players = Array.isArray(team.players) ? team.players : [];
        if (players.length === 0) return;
        const isViewersTeam = players.some((p: any) => this.normalizeName(displayNameOf(p?.player ?? p) ?? "") === snapViewerKey);
        if (isViewersTeam) {
          if (viewerSquadPos === null) viewerSquadPos = pos;
          if (team.startingSide != null && s.viewerStartSide === null) {
            s.viewerStartSide = team.startingSide;
          }
        }
      });
    }
    // Capture the pre-refresh roster first: snapshot refreshes must not wipe
    // stats merged from scoreboard facts between heartbeats.
    const previousRoster = s.roster;
    if (teams && teams.length > 0) {
      s.roster = teams.flatMap((team, teamPos) => {
        // Normalize team naming: Riot pregame uses "Team One"/"Team Two", the
        // live game uses "Blue"/"Red", and unknown teams may say anything.
        const lower = team.teamId.toLowerCase();
        const isBlue = lower === "blue" || lower === "team one";
        const isRed = lower === "red" || lower === "team two";
        // The viewer's squad is presentation-left whenever the snapshot names
        // the viewer (identity evidence only â€” never array order or a label).
        const fallbackIndex =
          viewerSquadPos === null ? (isBlue ? 0 : isRed ? 1 : undefined) : teamPos === viewerSquadPos ? 0 : 1;
        // HUD color/split logic keys on "Blue"/"Red" strings.
        const normalizedTeamId = isBlue ? "Blue" : isRed ? "Red" : team.teamId;
        // Agent-select cache gate: suppress stale agent evidence while it is
        // active (see agentGateUntil).
        const agentGate = this.agentGateUntil > Date.now();
        return team.players.map((p) => ({
          displayName:
            p.player.name?.displayName ??
            p.player.identity?.displayName ??
            p.player.identity?.gameName ??
            p.player.puuid ??
            "?",
          // Stable identity (the runtime's snapshot playerId / puuid) â€” panel
          // position must never decide which telemetry a row owns.
          puuid: (p.player.playerId ?? p.player.puuid ?? undefined) as string | undefined,
          agentName: agentGate ? null : (p.agent?.name ?? null),
          agentIcon: agentGate ? null : (p.agent?.riotId ? agentIconUrl(p.agent.riotId) ?? null : undefined),
          agentKey: agentGate ? undefined : (p.agent?.key ?? undefined),
          teamId: normalizedTeamId,
          teamIndex: p.teamIndex ?? fallbackIndex,
          slot: p.observerSlot ?? undefined,
          // Live scoreboard detail (fork runtime dialect nests these under
          // player; upstream "scoreboard" facts merge in via applyFact).
          kills: p.player.kills ?? undefined,
          deaths: p.player.deaths ?? undefined,
          assists: p.player.assists ?? undefined,
          weapon: weaponDisplayName(p.player.weapon ?? undefined) ?? undefined,
          credits: p.player.credits ?? undefined,
          spentCredits: p.player.spentCredits ?? undefined,
          health: p.player.health ?? undefined,
          isAlive: p.player.isAlive ?? undefined,
          ultPoints: p.player.ultPoints ?? undefined,
          ultMax: p.player.ultMax ?? undefined,
          shield: p.player.shield ?? undefined,
          shieldType: p.player.shieldType ?? undefined,
          hasSpike: p.player.hasSpike ?? undefined,
        }));
      });
      // PASS 7D â€” the snapshot heartbeat REFRESHES identities; it must NOT erase
      // telemetry that only the GEP scoreboard provides.
      //
      // The previous implementation rebuilt `s.roster` from the snapshot and only
      // carried previous stats over when the snapshot supplied NONE. Whenever the
      // snapshot carried any stat (its KDA), the carry-over was skipped â€” so
      // agent / weapon / shield / credits, which the GEP scoreboard frames keep
      // current between heartbeats, were WIPED on every heartbeat. Live symptoms:
      // "K/D/A updated but the agent icon, loadout, shield and credits did not"
      // (blank BuyRound / IngameHUD panels, credits/loadout stuck at "-"), the
      // round-start alive reset undone (greyed cards), a revived player flipped
      // back to dead, and Sage's row losing its agent key.
      //
      // The merge is by IDENTITY (engine id first, then the normalized display
      // name) â€” never by panel position â€” and it never re-keys or duplicates an
      // established row (Pass 6): a prior row is only ever MATCHED, never moved to
      // another player. The prior row IS the live row (already updated by the GEP
      // facts and the round bookkeeping), so "snapshot value if provided, else the
      // live value" keeps both sources coherent without inventing anything.
      const priorById = new Map<string, NonNullable<HudRelayState["roster"]>[number]>();
      const priorByKey = new Map<string, NonNullable<HudRelayState["roster"]>[number]>();
      for (const p of previousRoster ?? []) {
        if (p.puuid) priorById.set(String(p.puuid).toLowerCase(), p);
        const pk = this.normalizeName(p.displayName);
        if (!priorByKey.has(pk)) priorByKey.set(pk, p);
      }
      const agentGateNow = this.agentGateUntil > Date.now();
      const seenNames = new Set<string>();
      const mergedRoster: NonNullable<HudRelayState["roster"]> = [];
      for (const entry of s.roster) {
        // Some engine snapshots list the viewer under BOTH squads â€” keep the
        // first entry per normalized display name.
        const key = this.normalizeName(entry.displayName);
        if (seenNames.has(key)) continue;
        seenNames.add(key);
        const prior =
          (entry.puuid ? priorById.get(String(entry.puuid).toLowerCase()) : undefined) ??
          priorByKey.get(key);
        // A snapshot row is the provider's OWN squad, so it is no longer an
        // observation-only row (that ranking only exists to keep extra provider
        // rows from costing a squad member a slot). GEP-only rows keep it.
        this.observedOnlyRoster.delete(key);
        if (!prior) {
          mergedRoster.push(entry);
          continue;
        }
        // Team side stays anchored by the GEP facts: the engine snapshot's squad
        // labels oscillate between heartbeats and must not flip or reorder rows.
        const gt = s.viewerGepTeam !== null ? this.lastGepTeam.get(key) : undefined;
        const anchoredTeam =
          gt != null && s.viewerGepTeam !== null
            ? { teamIndex: gt === s.viewerGepTeam ? 0 : 1, teamId: gt === s.viewerGepTeam ? "Blue" : "Red" }
            : { teamIndex: prior.teamIndex, teamId: prior.teamId };
        mergedRoster.push({
          ...prior,
          ...entry,
          displayName: entry.displayName || prior.displayName,
          puuid: entry.puuid ?? prior.puuid,
          teamIndex: anchoredTeam.teamIndex ?? entry.teamIndex ?? prior.teamIndex,
          teamId: anchoredTeam.teamId ?? entry.teamId ?? prior.teamId,
          slot: entry.slot ?? prior.slot,
          // The snapshot leads on the agent â€” but only while the agent-select
          // cache gate is off (a gate-active snapshot deliberately reports none).
          agentName: agentGateNow ? entry.agentName : entry.agentName ?? prior.agentName,
          agentKey: agentGateNow ? entry.agentKey : entry.agentKey ?? prior.agentKey,
          agentIcon: agentGateNow ? entry.agentIcon : entry.agentIcon ?? prior.agentIcon,
          // GEP-updated telemetry survives the heartbeat.
          kills: entry.kills ?? prior.kills,
          deaths: entry.deaths ?? prior.deaths,
          assists: entry.assists ?? prior.assists,
          weapon: entry.weapon ?? prior.weapon,
          credits: entry.credits ?? prior.credits,
          spentCredits: entry.spentCredits ?? prior.spentCredits,
          // Shield: the snapshot heartbeat often carries a stale 0 (its own
          // economy view lags the scoreboard facts) â€” a truthy snapshot value
          // leads, otherwise the FACT-derived prior survives (the "shield
          // always blank" flicker). Facts correct both directions: a real
          // unpurchase reports tier 0 on the next scoreboard frame.
          shield:
            entry.shield != null && entry.shield > 0
              ? entry.shield
              : (prior.shield ?? entry.shield ?? null),
          shieldType:
            entry.shieldType != null && entry.shieldType > 0
              ? entry.shieldType
              : (prior.shieldType ?? entry.shieldType ?? null),
          ultPoints: entry.ultPoints ?? prior.ultPoints,
          ultMax: entry.ultMax ?? prior.ultMax,
          hasSpike: entry.hasSpike ?? prior.hasSpike,
          // Alive/health: the freshest reading wins. The prior row carries the
          // GEP scoreboard's value (and the round-start alive reset), so a coarser
          // heartbeat must never re-kill a revived player or a respawned squad.
          isAlive: prior.isAlive ?? entry.isAlive,
          health: prior.health ?? entry.health,
        });
      }
      s.roster = mergedRoster;
    } else if (s.sessionPhase === "idle") s.roster = [];
    this.emitChange();
  }

  /**
   * PASS 7B â€” the authoritative NEW-MATCH boundary (a fresh agent select while a
   * previous match was tracked). Unlike `wipeMatchState()` this also RETIRES the
   * previous match's roster identities: the new match has its own players, and
   * stale identity rows (telemetry wiped, identities kept) filled the relay's
   * 5-per-side cap and starved the new match's real rows â€” the reported "new
   * match with incomplete player data". The new roster rehydrates from the
   * session snapshot teams and the new match's own scoreboard facts.
   */
  private retireMatchForNewGame(): void {
    const s = this.s;
    this.wipeMatchState();
    s.roster = [];
    s.viewerGepTeam = null;
    s.viewerName = null;
    this.localNames.clear();
    this.pendingAbilityState = null;
    s.newMatchPending = true;
  }

  /**
   * A5: match-scoped wipe â€” shared by the fresh-match detection (round 1
   * after a tracked match) and the game_exit retirement. Clears every field
   * the previous match owns; roster identities are KEPT (fresh-match
   * semantics) â€” the retirement caller overrides with a full roster clear.
   */
  private wipeMatchState(): void {
    const s = this.s;
    s.blue = 0;
    s.red = 0;
    s.roundNumber = 0;
    s.roundPhase = "unknown";
    s.publishedNumber = 0;
    s.publishedPhase = null;
    s.pendingPhase = null;
    s.roundHistory = [];
    s.roundEnd = null;
    s.timeout = null;
    s.gameEvent = null;
    s.gameEventRound = null;
    s.matchWinner = null;
    s.matchMvp = null;
    s.roundEndedAt = null;
    s.spike = null;
    s.spikePlantedAt = null;
    s.plantSite = null;
    s.terminalSpike = null;
    s.killfeed = [];
    // The map is match-scoped: a stale mapKey painted the PREVIOUS match's
    // map + splash on the next match's agent-select scene (reported live
    // 2026-10-18). The fresh match's session snapshot re-sets it when the
    // game reports the real map.
    s.mapKey = null;
    s.mapName = null;
    s.roundKills.clear();
    s.roundKillVictims.clear();
    s.roundDeaths.clear();
    s.clutchMax.clear();
    s.roundStartScore = null;
    // Round-progression bookkeeping is match-scoped (HU-014/HU-015): the new
    // match's first score must never be measured against the previous match's
    // round boundary or combat clock.
    s.lastSettledRound = 0;
    s.combatStartedAt = null;
    s.combatStartedRound = 0;
    s.roundStartedAt = null;
    s.roundStartedRound = 0;
    s.roundPhaseFromFact = false;
    s.scoreSeen = false;
    s.roundFactsSeen = false;
    s.roundViewerSide = null;
    // The viewer-relative team evidence belongs to the match that just retired.
    this.gepTeamFromTeammate = null;
    this.creditsAtRoundStart.clear();
    for (const p of s.roster ?? []) {
      p.kills = null;
      p.deaths = null;
      p.assists = null;
      p.credits = null;
      p.spentCredits = null;
      p.shield = null;
      p.shieldType = null;
      p.weapon = null;
      // Unknown semantics (Â§14): a wiped round has NO health/alive evidence â€”
      // fabricating HP=100/alive=true was a fake "full HP" board (the HUD
      // treats only an explicit false as dead, so null renders unchanged).
      p.health = null;
      p.isAlive = null;
      p.ultPoints = null;
      p.ultMax = null;
      p.hasSpike = null;
      // Agent evidence is per-match too â€” stale agentKey/agentIcon from
      // the previous game made the buy-round cards show wrong/duplicated
      // agent icons until GEP re-reports the roster.
      p.agentKey = undefined;
      p.agentIcon = null;
      p.agentName = null;
      // Ability charges are per-round too â€” stale {C,Q,E,X} from the
      // previous game made every skill icon render as bought/available.
      p.abilityState = undefined;
      p.abilities = undefined;
    }
    
    this.shieldZeroStreak.clear();
    // Ability charges belong to the previous match â€” including a payload that
    // was still waiting for the local player to be identified.
    this.pendingAbilityState = null;
    this.clearCache();
  }

  /* --------------------- local-player identity --------------------- */

  /**
   * Establishes the local-player identity from the scoreboard row the engine
   * flags `is_local: true`, in the reliability order the runtime allows:
   *
   *   1. the authoritative session snapshot's viewer (applySnapshot)
   *   2. this `is_local` roster/scoreboard evidence
   *
   * Step 1 is preserved as-is: this only ever fills `viewerName` while it is
   * still null, and records the name through the same canonical normalization the
   * roster already uses (no second identity system, no positional or username
   * guessing, no timing heuristic).
   *
   * It matters because the hybrid provider's `me|abilities` fact is LOCAL-player
   * telemetry keyed to this name, and an `is_local` row can arrive without a team
   * field â€” the old code only anchored the name inside the team-anchor branch, so
   * a viewerless session never identified its own player (live 2026-09-26:
   * `viewerName` stayed null for a whole match and the website got no abilities).
   */
  private anchorLocalName(name: string): void {
    this.localNames.add(this.normalizeName(name));
    if (!this.s.viewerName) this.s.viewerName = name;
  }

  /** The local player's roster entry â€” undefined until identity is anchored. */
  private localRosterEntry(): NonNullable<HudRelayState["roster"]>[number] | undefined {
    const s = this.s;
    const viewer = s.viewerName;
    if (viewer != null) {
      const byName = (s.roster ?? []).find(
        (p) => this.normalizeName(p.displayName) === this.normalizeName(viewer),
      );
      if (byName) return byName;
    }
    return (s.roster ?? []).find((p) => this.localNames.has(this.normalizeName(p.displayName)));
  }

  /**
   * Writes a `me|abilities` payload onto the local player's persistent ability
   * state. When the local player has not been identified yet the payload is
   * RETAINED (not dropped) and applied the moment the identity lands: the engine
   * only emits abilities when the charges change (live capture: an 11-minute gap
   * between facts), so losing the round-start frame used to leave every skill
   * icon unavailable for the rest of the match.
   */
  private writeAbilityState(state: { C: boolean; Q: boolean; E: boolean; X: boolean }): void {
    const local = this.localRosterEntry();
    if (!local) {
      this.pendingAbilityState = state;
      return;
    }
    this.pendingAbilityState = null;
    local.abilityState = state;
    // The same telemetry in the relay's `abilities` slot: the ability slots the
    // engine CURRENTLY reports as available for the LOCAL player. Strictly local
    // â€” the provider has no per-opponent ability telemetry, so every other row
    // keeps `abilities` undefined (= unknown), never "unbought".
    local.abilities = (["C", "Q", "E", "X"] as const).filter((slot) => state[slot]);
  }

  /** Replays a retained ability payload once the local player is known. */
  private applyPendingAbilities(): void {
    const pending = this.pendingAbilityState;
    if (!pending) return;
    this.writeAbilityState(pending);
  }


  public applyFact(key: string, rawValue: unknown): void {
    const s = this.s;
    // Phase 2: the boot-cache gate is satisfied only by real game telemetry.
    // `provider_status` frames (plugin/telemetry state, recovery, game-exit)
    // report the PROVIDER, not the match â€” they leave the gate closed.
    if (!STATUS_FACT_KEYS.has(key)) s.restorePending = false;
    const value = parseFactValue(rawValue);
    // The engine emits prefixed scoreboard variants (scoreboard_ally,
    // scoreboard_enemy, scoreboard_N, ...). Normalize to the base case.
    const normalizedKey = key.startsWith("scoreboard") ? "scoreboard" : key;
    switch (normalizedKey) {
      case "provider_status": {
        // A5: the runtime retired the local session (real GEP game-exit, or
        // the session-layer `disconnected` mapped onto game_exit). Wipe ALL
        // match-scoped state â€” including identity/map/roster â€” so the retired
        // session's score/map/rounds cannot survive as "current" payload
        // until the next live session repopulates them. The HUD leaves the
        // live scene via deriveScene (idle â†’ null).
        const rec = value as { key?: unknown } | null;
        if (rec?.key !== "game_exit") break;
        this.wipeMatchState();
        s.roster = [];
        s.matchId = null;
        s.mapKey = null;
        s.mapName = null;
        s.sessionPhase = "idle";
        s.revision += 1;
        this.emitChange();
        break;
      }
      case "match_score":
      case "score": {
        // HU-014: the previous score is the baseline for the round-delta
        // inference below (every point == exactly one completed round).
        const prevBlue = s.blue;
        const prevRed = s.red;
        const rec = value as { team_0?: unknown; team_1?: unknown; won?: unknown; lost?: unknown };
        // Fork dialect: {team_0, team_1} are absolute sides (blue/red).
        // Engine dialect: {won, lost} is the LOCAL PLAYER's perspective - the
        // viewer's side is anchored by their GEP team number (is_local
        // scoreboard entries), NOT assumed to be blue.
        let viewerScore: number | null = null;
        let enemyScore: number | null = null;
        if (rec?.team_0 !== undefined || rec?.team_1 !== undefined) {
          const t0 = Number(rec?.team_0);
          const t1 = Number(rec?.team_1);
          if (Number.isFinite(t0) && Number.isFinite(t1)) {
            // GEP score contract (verified against the user's own provider log:
            // won r1 -> {team_0:0, team_1:1}; lost r2 -> {1,1}; won r3 -> {1,2}
            // with round_outcome {won,lost} as the viewer's cumulative W/L):
            // team_1 = LOCAL PLAYER'S score, team_0 = enemy. The roster is
            // anchored with the viewer on blue/left, so blue = the VIEWER'S
            // team score. Anchor by the LOCAL GEP team number (is_local row)
            // so a viewer on start team 0 keeps team_0 on blue/left too â€”
            // the default stays team_1 (the historically verified case) until
            // that anchor lands.
            const blueIsTeam0 = (s.viewerGepTeam ?? 1) === 0;
            s.blue = blueIsTeam0 ? t0 : t1;
            s.red = blueIsTeam0 ? t1 : t0;
          } else return;
        } else if (rec?.won !== undefined || rec?.lost !== undefined) {
          viewerScore = Number(rec?.won);
          enemyScore = Number(rec?.lost);
          if (!Number.isFinite(viewerScore) || !Number.isFinite(enemyScore)) return;
          // {won,lost} is the VIEWER's cumulative round record and the engine
          // anchors the viewer to blue/left â€” no team-index lookup needed.
          // (The old viewerTeamIndex() call could return the GEP-absolute
          // team number and misattribute the score.)
          s.blue = viewerScore;
          s.red = enemyScore;
        } else return;
        // Match won: first to 13 WITH a 2-round lead â€” the bare >=13 check
        // fired post-game mid-OVERTIME (13-12 is not a finished match).
        if (s.blue >= 13 && s.blue - s.red >= 2) s.matchWinner = "blue";
        else if (s.red >= 13 && s.red - s.blue >= 2) s.matchWinner = "red";
        // The engine delivers match_score AFTER round_phase:end - settle now
        // so the round winner/reason is never lost to the shopping wipe.
        if (s.roundPhase === "end" && s.gameEvent === null) this.settle();
        // HU-014: R1/R2 bootstrap. Live 2026-09-25 02:08:30-02:09:14 the fork
        // engine streamed NO round_number/round_phase fact for the first two
        // rounds (they only became visible through the score: 1-0 then 2-0 with
        // `round 0/unknown` published the whole time), so the HUD kept the buy
        // scene during both rounds, never produced a roundEnd and left the
        // round strip cells empty. The score is the authority that survives.
        // HU-015: a DECREASE means a new match took over the score panel â€” the
        // boundary is taken first (match-scoped stats/round state wiped) and the
        // new match's first score never describes a transition of the old one.
        if (!this.scoreStartsNewMatch(prevBlue, prevRed)) this.syncRoundProgression(prevBlue, prevRed);
        break;
      }
      case "round_outcome": {
        // GEP's AUTHORITATIVE round result: {won, lost} is the VIEWER's
        // cumulative round record (verified against the provider log:
        // match_score {team_0:0,team_1:1} â†” round_outcome {won:1}). An
        // increment is the ground-truth winner â€” no score-delta or
        // alive-count guessing. The viewer is ALWAYS blue (engine anchors
        // the roster viewer-left), so the result maps straight through.
        const rec = value as { won?: unknown; lost?: unknown };
        const won = Number(rec?.won);
        const lost = Number(rec?.lost);
        if (!Number.isFinite(won) || !Number.isFinite(lost)) return;
        const prev = s.roundOutcome;
        if (prev && (won > prev.won || lost > prev.lost)) {
          this.recordRoundWinner(won > prev.won ? "blue" : "red", null);
        }
        s.roundOutcome = { won, lost };
        break;
      }
      case "viewer_side": {
        // GEP `match_info.info.team` (adapter: gep-capture.ts â†’ `viewer_side`):
        // the VIEWER's current side. The GEP provider maintains this fact and
        // flips it at halftime/overtime, so it is the authoritative side source
        // â€” never derived from team index, roster order or round parity.
        // First observation seeds the start side (drives the ATTACKER/DEFENDER
        // labels + the parity fallback for rounds the provider has not
        // refreshed); every observation refreshes the current side.
        // Restored from 0511dc7:539-552 (removed by the 6e9236e revert).
        const v = typeof value === "string" ? value.toLowerCase() : null;
        if (v !== "attack" && v !== "defense") return;
        if (s.viewerStartSide === null) s.viewerStartSide = v;
        if (s.viewerSide !== v) s.viewerSide = v;
        break;
      }
      case "match_start":
      case "match_id": {
        // Pass 2A â€” the runtime's AUTHORITATIVE match boundary.
        //   `match_start`  the capture engine's identity layer emits it when a
        //                  new match begins (agent-select flip after a live
        //                  session, or a score that went DOWN vs the previous
        //                  poll) and the runtime resets its own match state
        //                  (score/roster/rounds) on it.
        //   `match_id`     emitted whenever the authoritative match id changes.
        // The projection dropped BOTH, so the previous match's K/D/A and round
        // state stayed on the board until some unrelated reset fired â€” the
        // reported "MATCH A K/D/A shows up in MATCH B". Only MATCH-SCOPED state
        // is wiped (wipeMatchState): roster identities, viewer identity and the
        // room/connection configuration survive untouched.
        if (normalizedKey === "match_id") {
          const id = typeof value === "string" && value.length > 0 ? value : null;
          if (id === null || id === s.matchId) break;
          s.matchId = id;
        }
        // Fresh agent-select: the scene/snapshot path has already retired the
        // previous match (or nothing match-scoped exists to clear). Wiping here
        // lands seconds after the pick and NULLS the newly picked agents â€”
        // the live 2026-10-18 "picked agent appears, then vanishes" defect.
        const freshPregame =
          s.sessionPhase === "pregame" &&
          s.roundHistory.length === 0 &&
          s.matchWinner === null &&
          s.roundNumber === 0 &&
          s.blue === 0 &&
          s.red === 0;
        if (!freshPregame) this.wipeMatchState();
        break;
      }
      case "round_number": {
        const n = Number(value);
        if (!Number.isFinite(n)) return;
        // Fresh-match detection: GEP frequently keeps the SAME match_id across
        // games, so the match_id-change wipe never fired and the previous
        // game's score/KD/round history bled into the next one. Round 1
        // arriving while a previous match was already tracked means a new
        // game started â€” clear its state now (roster identities + team
        // anchoring are kept; stats repopulate from the next scoreboard).
        if (
          n === 1 &&
          (s.publishedNumber > 1 || s.roundNumber > 1 || s.matchWinner !== null || s.roundHistory.length > 0)
        ) {
          this.wipeMatchState();
        }
        s.roundNumber = n;
        if (s.pendingPhase !== null && n > s.publishedNumber) this.publishRound();
        break;
      }
      case "round_settled": {
        // GROUND TRUTH from the runtime's ValRoundEngine (round_settled event):
        // the winner's GEP start team + the winning SIDE (attacker/defender).
        // This replaces every heuristic â€” score deltas, alive counts, parity.
        const rec = value as {
          roundNumber?: unknown;
          winnerStartTeam?: unknown;
          winningSide?: unknown;
          winningReason?: unknown;
          winType?: unknown;
          winTypeLabel?: unknown;
          highlightPlayer?: unknown;
        };
        const winnerStart = Number(rec?.winnerStartTeam);
        const rn = Number(rec?.roundNumber);
        const reasonRaw = String(rec?.winningReason ?? "").toLowerCase();
        const reason: "elimination" | "detonation" | "defusion" | "time" =
          reasonRaw.includes("defus") ? "defusion"
          : reasonRaw.includes("detonat") ? "detonation"
          : reasonRaw.includes("eliminat") ? "elimination"
          : reasonRaw.includes("time") ? "time"
          : "elimination";
        // Winner â†’ blue iff its start team matches the viewer's GEP team
        // (fallback: GEP team 1 = the viewer, proven by the provider log's
        // match_scoreâ†”round_outcome correlation).
        const winner: "blue" | "red" | null =
          !Number.isFinite(winnerStart) ? null
          : winnerStart === (s.viewerGepTeam ?? 1) ? "blue" : "red";
        const sideRaw = String(rec?.winningSide ?? "").toLowerCase();
        const winnerSide: "attacker" | "defender" | null =
          sideRaw.includes("attack") ? "attacker"
          : sideRaw.includes("defen") ? "defender"
          : null;
        if (winner) {
          this.recordRoundWinner(winner, reason, winnerSide, Number.isFinite(rn) && rn > 0 ? rn : undefined);
          // Special ceremony labels only from the engine's winType â€” never
          // invent one (winType: Eliminated/Defuse/Detonate/... from ValRoundEngine).
          const wt = String(rec?.winType ?? "").toLowerCase();
          const label =
            wt.includes("clutch") ? "Clutch"
            : wt.includes("ace") && wt.includes("team") ? "Team Ace"
            : wt === "ace" || wt.includes("ace") ? "Ace"
            : wt.includes("flawless") ? "Flawless"
            : wt.includes("thrifty") ? "Thrifty"
            : null;
          if (label) {
            // PASS 7C â€” attribution guard. The engine reports the round it
            // settled together with the label, so a label for a round that is
            // NOT the settlement on the board is a LATE duplicate of an earlier
            // round: publishing it would pair this round's winner with another
            // round's classification (live 2026-09-30 03:28:13: round 4's blue
            // win published with the enemy's round-3 ACE). `recordRoundWinner`
            // above has already replaced the board for a genuine settlement, so
            // a mismatch here can only be that stale duplicate â€” the label is
            // ignored, never reassigned to the live round.
            const labelRound = Number.isFinite(rn) && rn > 0 ? rn : null;
            const staleForAnotherRound =
              labelRound !== null &&
              s.roundEnd !== null &&
              s.roundEnd.round != null &&
              s.roundEnd.round !== labelRound;
            if (!staleForAnotherRound) {
              s.gameEvent = label;
              // The label belongs to the settlement on the board â€” never to the
              // round in progress. When the engine named its round and the board
              // has no identity yet, the engine's own number is the authority.
              s.gameEventRound = s.roundEnd?.round ?? labelRound;
              // Per-round ceremony stamp: `gameEvent` only ever names the LATEST
              // ceremony, so the site's round-history strip could never show
              // thrifty/ace/clutch/flawless icons per round (the reported
              // "round reason icons wrong most of the time"). Stamp the round's
              // OWN history entry + roundEnd with the label.
              const targetRound = s.gameEventRound;
              if (targetRound != null) {
                const hist = s.roundHistory.find((h) => h.round === targetRound);
                if (hist) hist.label = label;
                if (s.roundEnd !== null && s.roundEnd.round === targetRound) s.roundEnd.label = label;
              }
              // Clutch-card identity (original-desktop parity): WHO clutched —
              // name/agent/KDA from the runtime's round_settled payload — stored
              // on the board's roundEnd so the site can render the agent image
              // + K/D/A instead of the plain attacker/defender line on a 1vX.
              const hpRaw = rec.highlightPlayer as {
                name?: unknown; agent?: unknown; kills?: unknown; deaths?: unknown; assists?: unknown;
              } | null | undefined;
              if (
                hpRaw != null && typeof hpRaw.name === "string" && hpRaw.name.length > 0 &&
                s.roundEnd !== null && labelRound !== null && s.roundEnd.round === labelRound
              ) {
                s.roundEnd.highlightPlayer = {
                  name: hpRaw.name,
                  agent: typeof hpRaw.agent === "string" && hpRaw.agent.length > 0 ? hpRaw.agent : null,
                  kills: typeof hpRaw.kills === "number" ? hpRaw.kills : null,
                  deaths: typeof hpRaw.deaths === "number" ? hpRaw.deaths : null,
                  assists: typeof hpRaw.assists === "number" ? hpRaw.assists : null,
                };
              }
            }
          }
        }
        s.revision += 1;
        this.emitChange();
        return; // fully handled
      }
      case "timeout_changed": {
        // Tactical timeout / tech pause from the runtime engine (BLOB
        // timeoutStarted parity). `active:false` clears; the caller team is
        // usually null (GEP never attributes it) — the overlay renders the
        // neutral banner for null instead of guessing a side.
        const rec = value as {
          active?: unknown;
          calledAt?: unknown;
          timeoutType?: unknown;
          team?: unknown;
        };
        s.timeout = rec?.active
          ? {
              team: rec?.team === "left" || rec?.team === "right" ? rec.team : null,
              calledAt: Number(rec?.calledAt) || Date.now(),
              timeoutType: rec?.timeoutType === "tech_pause" ? "tech_pause" : "tactical",
            }
          : null;
        break;
      }
      case "round_phase": {
        if (typeof value !== "string") return;
        // GEP signals the END OF THE MATCH with phase "game_end" (VS parity).
        // It must never enter the round-phase state machine â€” settle the
        // match, flip to post-game and stop.
        if (value === "game_end") {
          s.sessionPhase = "ending";
          if (s.matchWinner === null && (s.blue > 0 || s.red > 0)) {
            s.matchWinner = s.blue >= s.red ? "blue" : "red";
          }
          this.settle();
          s.revision += 1;
          this.emitChange();
          return;
        }
        // PASS 7B: a real round phase is live evidence from the NEW match â€” the
        // retired match's frames can no longer resurrect Post Game.
        s.newMatchPending = false;
        if (!(value in PHASE_ORDER)) return;
        if (value === "end" && s.roundNumber <= 0) {
          s.pendingPhase = null;
          break;
        }
        s.pendingPhase = value;
        if (!this.shouldWaitForNumber(value)) this.publishRound();
        else break;
        break;
      }
      case "kill_feed": {
        const rec = value as Record<string, unknown>;
        if (
          !rec ||
          typeof rec.attacker !== "string" ||
          typeof rec.victim !== "string" ||
          rec.attacker.length === 0
        ) {
          return;
        }
        const weaponName = weaponDisplayName(rec.weapon ?? rec.weaponName) ?? "";
        // One kill event is applied exactly once (see `lastKillFact`).
        if (this.isDuplicateKillFact(rec.attacker, rec.victim, weaponName)) break;
        s.killfeed.unshift({
          seq: this.killSeq++,
          attacker: rec.attacker,
          victim: rec.victim,
          weapon: weaponName,
          modifier: rec.headshot === true ? "headshot" : typeof rec.modifier === "string" ? rec.modifier : null,
          at: Date.now(),
        });
        s.killfeed = s.killfeed.slice(0, 25);
        this.trackRoundKill(rec.attacker, rec.victim, weaponName, rec.assists);
        break;
      }
      case "kill": {
        const rec = value as Record<string, unknown>;
        if (rec && typeof rec.attacker === "string" && typeof rec.victim === "string") {
          const weaponName = weaponDisplayName(rec.weapon ?? rec.weaponName) ?? "";
          if (this.isDuplicateKillFact(rec.attacker, rec.victim, weaponName)) break;
          this.trackRoundKill(rec.attacker, rec.victim, weaponName, rec.assists);
        }
        break;
      }
      case "death": {
        const rec = value as Record<string, unknown>;
        const victim = typeof rec?.victim === "string" ? rec.victim : typeof rec?.name === "string" ? rec.name : null;
        if (victim) {
          if (this.isDuplicateKillFact("", victim, "death")) break;
          // Exact normalized match FIRST; containment fuzzy matching only
          // when it is UNIQUE â€” ambiguous partial names killed the wrong
          // player, which corrupted alive counts and then the winner
          // fallback ("sometimes correct, sometimes wrong").
          for (const p of this.resolveRosterRows(victim)) {
            p.isAlive = false;
            p.health = 0;
            p.deaths = (p.deaths ?? 0) + 1;
          }
        }
        break;
      }
      case "spike_planted":
        s.spike = "planted";
        s.spikePlantedAt = Date.now();
        break;
      case "spike_defused":
        s.spike = "defused";
        s.spikePlantedAt = null;
        s.plantSite = null;
        this.latchTerminalSpike("defused");
        break;
      case "spike_detonated":
        s.spike = "detonated";
        s.spikePlantedAt = null;
        s.plantSite = null;
        this.latchTerminalSpike("detonated");
        break;
      // GEP-raw spike event names (verified from the provider log: newEvent
      // frames named planted_location/defused/detonated â€” the spike_*-prefixed
      // keys above never appear in the raw stream).
      case "planted_location":
      case "planted": {
        // GEP delivers the plant SITE together with the plant event
        // ({"feature":"match_info","key":"planted_location","value":"B"} â€”
        // verified live against the running runtime). Publish the raw site
        // letter only; the "SITE X" presentation lives in the website.
        if (key === "planted_location") {
          const site = typeof value === "string" ? value.trim().toUpperCase() : "";
          if (site === "A" || site === "B" || site === "C") s.plantSite = site;
        }
        if (s.spike !== "planted") s.spikePlantedAt = Date.now(); // re-emits must not skew the countdown
        s.spike = "planted";
        break;
      }
      case "defused":
        s.spike = "defused";
        s.spikePlantedAt = null;
        s.plantSite = null;
        this.latchTerminalSpike("defused");
        break;
      case "detonated":
        s.spike = "detonated";
        s.spikePlantedAt = null;
        s.plantSite = null;
        this.latchTerminalSpike("detonated");
        break;
      case "match_end": {
        // Upstream engine emits match_end when the match settles. Resolve the
        // winner from the score if the end-phase classification has not yet â€”
        // custom games end below 13 rounds, so the leader wins on evidence.
        if (s.matchWinner === null && (s.blue >= 13 || s.red >= 13)) {
          s.matchWinner = s.blue >= s.red ? "blue" : "red";
        }
        if (s.matchWinner === null && (s.blue > 0 || s.red > 0 || s.roundNumber > 0)) {
          s.matchWinner = s.blue >= s.red ? "blue" : "red";
        }
        s.sessionPhase = "ending";
        if (s.roundPhase === "end" || s.sessionPhase === "ending") this.settle();
        s.revision += 1;
        this.emitChange();
        return; // already emitted
      }
      case "scene": {
        const sc = String(value ?? "").toLowerCase().replace(/_/g, "-");
        if (
          sc === "agent-select" || sc === "character-select" || sc === "lobby" || sc === "pregame" ||
          // GEP-raw scene names (verified from the provider log): the agent
          // select scene is "CharacterSelectPersistentLevel". Reading CURRENT
          // state â€” HU starting mid-agent-select must enter Agent Select.
          sc.startsWith("characterselect")
        ) {
          if (s.sessionPhase !== "pregame") {
            // PASS 7B: a NEW match's agent select is the authoritative new-match
            // boundary whenever the engine keeps the previous match_id (GEP reuses
            // it). Only when a match was actually tracked AND is no longer in play
            // (a stale characterselect frame during a live round must never retire
            // the running match).
            const trackedMatch =
              s.matchWinner !== null || s.roundHistory.length > 0 || s.publishedNumber > 1 || s.roundNumber > 0;
            const matchInPlay =
              s.matchWinner === null && (s.roundPhase === "combat" || s.roundPhase === "shopping");
            // The phase timestamp must describe the phase that is current now:
            // deriveScene's freshness guard reads it, and a stamp left over from
            // the previous phase made fresh agent-select evidence look stale.
            s.sessionPhaseAt = Date.now();
            if (trackedMatch && !matchInPlay) {
              this.retireMatchForNewGame();
              // Agent-select cache gate: suppress the RETIRED match's stale
              // agent evidence ONLY on a real new-match boundary. The gate and
              // the roster blank used to run on EVERY CharacterSelect scene
              // fact (GEP re-emits it while the pick is on screen, and the
              // session snapshot's "loading" phase keeps the outer guard true)
              // â€” the live 2026-10-18 "picked agent appears, then vanishes".
              this.agentGateUntil = Date.now() + 3000;
              for (const p of s.roster ?? []) {
                p.agentKey = undefined;
                p.agentIcon = null;
                p.agentName = null;
              }
            }
          }
          s.sessionPhase = "pregame";
        } else if (sc === "in-game" || sc === "combat" || sc === "live") {
          s.sessionPhase = "live";
        } else if (sc === "post-game" || sc === "game-end" || sc === "match-end") {
          s.sessionPhase = "ending";
        } else if (sc === "mainmenu") {
          // GEP-raw: back at the main menu. A settled match keeps its Post
          // Game latch (matchWinner wins in deriveScene); only a clean menu
          // with no settled match drops to idle.
          if (s.matchWinner === null) s.sessionPhase = "idle";
        }
        break;
      }
      case "player_name": {
        // The `me` feature's own display name â€” the local player BY DEFINITION
        // (identity, never a guess). Anchors the viewer when the session
        // snapshot carries no viewer and before any scoreboard row lands;
        // abilities/health telemetry keys off this identity (writeAbilityState /
        // localRosterEntry) â€” live 2026-10-18 this stayed null all match, so
        // every `abilities` payload was parked in pending forever (grey icons).
        if (typeof value !== "string" || value.trim().length === 0) break;
        if (!s.viewerName) {
          this.anchorLocalName(value.trim());
          this.applyPendingAbilities();
        }
        break;
      }
      case "local_health": {
        // GEP `me` health (adapter: gep-capture maps `health` -> local_health):
        // the ONLY live HP stream for the local player in this dialect
        // (scoreboard rows carry alive but not hp). Positive hp is definitive
        // revive evidence; explicit 0 mid-combat is death.
        const hp = Number(value);
        if (!Number.isFinite(hp)) break;
        const local = this.localRosterEntry();
        if (!local) break;
        local.health = hp;
        if (hp > 0) local.isAlive = true;
        else if (s.roundPhase !== "shopping") {
          local.isAlive = false;
          this.diedLastRound.add(this.normalizeName(local.displayName));
        }
        break;
      }
      case "roster": {
        // match_info roster rows carry the LOCKED agent pick (character +
        // player_id, formatRoster output). UPDATE-ONLY: rows are created by the
        // snapshot teams â€” without this the picked agent was lost whenever a
        // match boundary cleared it (agent-select "agent vanishes after pick").
        const rec = value as Record<string, unknown>;
        const character = typeof rec?.character === "string" ? rec.character : "";
        if (!character || Date.now() < this.agentGateUntil) break;
        const pid = typeof rec?.player_id === "string" && rec.player_id.length > 0 ? rec.player_id : null;
        const rname = typeof rec?.name === "string" && rec.name.length > 0 ? rec.name : null;
        const row = (s.roster ?? []).find(
          (r) =>
            (pid != null && r.puuid === pid) ||
            (rname != null && this.normalizeName(r.displayName) === this.normalizeName(rname)),
        );
        if (!row) break;
        row.agentName = agentDisplayName(character) ?? row.agentName;
        row.agentKey = character.toLowerCase().replace(/_pc(_c)?$/i, "");
        row.agentIcon = agentIconUrl(character) ?? row.agentIcon;
        break;
      }
      case "scoreboard": {
        // Per-player detail observation (weapon/credits/ults/shield/scoreline)
        // from the provider; merged into the matching roster entry by name.
        const rec = value as Record<string, unknown>;
        const name = typeof rec?.name === "string" ? rec.name : null;
        if (!name) return;
        // PASS 6 (kept): the row is matched by DISPLAY NAME within the match â€” a
        // frame that disagrees about the engine id must never re-key an established
        // row or grow a phantom identity (the provider flaps spellings/ids).
        // PASS 7B cross-match isolation is provided by the new-match retirement
        // (retireMatchForNewGame) instead: when a new game's agent select arrives,
        // the previous match's identities are dropped, so a reused display name can
        // only ever match the NEW match's own row.
        let entry = this.findRosterRow(rec, name);
        const num = (v: unknown): number | undefined =>
          typeof v === "number" && Number.isFinite(v) ? v : undefined;
        const str = (v: unknown): string | undefined =>
          typeof v === "string" && v.length > 0 ? v : undefined;
        // Dialect union: the GEP-raw dialect sends {team, weapon, credits,
        // alive, ult_points}; the VS-family engine dialect sends {startTeam,
        // scoreboardWeaponInternal, money, isAlive, currUltPoints, initialArmor,
        // agentInternal}. Accept every alias so the anchor and all per-player
        // detail land regardless of which engine dialect is live.
        const gepTeam =
          typeof rec.team === "number"
            ? rec.team
            : typeof rec.startTeam === "number"
              ? rec.startTeam
              : null;
        // Anchor the viewer's GEP team from their scoreboard row â€” is_local
        // when the provider sends it, otherwise the snapshot's viewer name.
        // (Without this, a cold start piles every player onto one team.)
        const normName = this.normalizeName(name);
        if (gepTeam !== null) this.lastGepTeam.set(normName, gepTeam);
        // Viewer-relative team evidence (see gepTeamFromTeammate): it yields the
        // viewer's own GEP team number from ANY row, so the board never has to
        // wait for the local player's row to land before it splits correctly.
        if (
          typeof rec.teammate === "boolean" &&
          gepTeam !== null &&
          s.viewerGepTeam === null
        ) {
          this.gepTeamFromTeammate = rec.teammate ? gepTeam : gepTeam === 0 ? 1 : 0;
        }
        // Identity anchor FIRST: an `is_local` row is genuine local-player
        // evidence whether or not it also carries a team number (the team anchor
        // below needs `gepTeam`, the viewer identity does not).
        if (rec.is_local === true) this.anchorLocalName(name);
        const isViewerRow =
          rec.is_local === true ||
          (s.viewerName != null && normName === this.normalizeName(s.viewerName));
        if (isViewerRow && gepTeam !== null) {
          if (s.viewerGepTeam === null) {
            s.viewerGepTeam = gepTeam;
            if (!s.viewerName) s.viewerName = name;
            // First anchor: re-side every already-known player from their own
            // last GEP team (self-heals the pre-anchor cold start).
            for (const p of s.roster ?? []) {
              const gt = this.lastGepTeam.get(this.normalizeName(p.displayName));
              if (gt != null) {
                p.teamIndex = gt === s.viewerGepTeam ? 0 : 1;
                p.teamId = p.teamIndex === 0 ? "Blue" : "Red";
              }
            }
          } else if (gepTeam !== s.viewerGepTeam) {
            // The viewer's own GEP team number changed mid-match (halftime
            // side flip or squad re-index). Hysteresis: only commit the
            // re-anchor once the new team has been reported consistently for
            // 1.5s â€” alternating team facts used to re-side the whole board
            // on every cycle ("score switches to the other team and back").
            if (this.pendingAnchorTeam === gepTeam && Date.now() - this.pendingAnchorSince > 1500) {
              this.pendingAnchorTeam = null;
              s.viewerGepTeam = gepTeam;
              this.reSideRoster();
            } else if (this.pendingAnchorTeam !== gepTeam) {
              this.pendingAnchorTeam = gepTeam;
              this.pendingAnchorSince = Date.now();
            }
          } else {
            this.pendingAnchorTeam = null;
          }
        }
        if (!entry) {
          // ValoSpectra-style: GEP scoreboard is authoritative - create the
          // player on the fly instead of dropping the fact (cold-start safe).
          const viewerIdx = this.viewerTeamIndex();
          const anchorTeam = s.viewerGepTeam ?? this.gepTeamFromTeammate;
          const teamIdx =
            gepTeam === null
              ? undefined
              : anchorTeam !== null
                ? gepTeam === anchorTeam
                  ? 0
                  : 1
                : // No anchor at all yet: the engine's viewer-relative `teammate`
                  // flag still identifies the side of THIS row.
                  typeof rec.teammate === "boolean"
                  ? rec.teammate
                    ? 0
                    : 1
                  : viewerIdx;
          entry = {
            displayName: name,
            // The engine's own stable player id (GEP `player_id` / PUUID) â€” the
            // identity the relay keys rows on and the snapshot publishes so a
            // consumer can bind telemetry by identity instead of panel index.
            puuid: str(rec.player_id) ?? str(rec.playerId) ?? str(rec.puuid),
            agentName: agentDisplayName(rec.character) ?? null,
            agentKey:
              typeof rec.character === "string" && rec.character.length > 0
                ? rec.character.toLowerCase()
                : undefined,
            agentIcon: agentIconUrl(rec.character) ?? null,
            teamId: teamIdx === 0 ? "Blue" : teamIdx === 1 ? "Red" : undefined,
            teamIndex: teamIdx ?? undefined,
            kills: num(rec.kills) ?? null,
            deaths: num(rec.deaths) ?? null,
            assists: num(rec.assists) ?? null,
            credits: num(rec.credits ?? rec.money) ?? null,
            // Tier-aware shield: GEP armor is the tier enum 0-4, never points.
            shield:
              (() => {
                const v = num(rec.shield ?? rec.armor ?? rec.initialArmor);
                if (v === undefined) return null;
                if (v === 25 || v === 50) return v;
                if (Number.isInteger(v) && v >= 0 && v <= 4) return [0, 25, 50, 50, 25][v];
                return null;
              })(),
            shieldType:
              (() => {
                // Canonical GEP armor TIER: 0 none / 1 light / 2 heavy /
                // 3 enemy-unknown / 4 REGEN. The provider reports the tier in
                // its `shield` field (raw scoreboard has no shieldType/armor),
                // so an explicit tier field wins, then the small-integer
                // `shield` reading. Dropping the tier made snapshot.ts derive
                // it from POINTS (25 -> 1 light), so a Regen Shield rendered as
                // Light in BOTH scenes (live 2026-09-26).
                const explicit = num(rec.shieldType ?? rec.armor ?? rec.initialArmor);
                if (explicit !== undefined && Number.isInteger(explicit) && explicit >= 0 && explicit <= 4) return explicit;
                const rawShield = num(rec.shield);
                if (rawShield !== undefined && Number.isInteger(rawShield) && rawShield >= 0 && rawShield <= 4) return rawShield;
                return null;
              })(),
            weapon:
              weaponDisplayName(rec.weapon ?? rec.weaponName ?? rec.scoreboardWeaponInternal) ??
              null,
            isAlive: typeof rec.alive === "boolean" ? rec.alive : typeof rec.isAlive === "boolean" ? rec.isAlive : undefined,
            ultPoints: num(rec.ultPoints ?? rec.ult_points ?? rec.currUltPoints) ?? null,
            ultMax: num(rec.ultMax ?? rec.ult_max ?? rec.maxUltPoints) ?? null,
            hasSpike: typeof rec.spike === "boolean" ? rec.spike : null,
          };
          (s.roster ?? []).push(entry);
          // Lock the player's stable position (first-seen order). Fixes players
          // swapping rows/teams between publishes when fact order varies.
          const posKey = this.normalizeName(entry.displayName);
          if (!this.rosterSeq.has(posKey)) this.rosterSeq.set(posKey, this.rosterSeq.size + 1);
          // Observation-only: this identity is NOT part of any squad snapshot.
          this.observedOnlyRoster.add(posKey);
          // The identity anchor above can be what finally makes the local player
          // resolvable â€” replay any ability payload that arrived first.
          this.applyPendingAbilities();
          break;
        }
        // A row created from an identity-less frame (or from the session snapshot)
        // adopts the engine's stable id the FIRST time it is reported, and never
        // re-keys afterwards: a later frame that omits (or disagrees about) the id
        // must not move an established row to another player.
        const puuid = str(rec.player_id) ?? str(rec.playerId) ?? str(rec.puuid);
        if (puuid && !entry.puuid) entry.puuid = puuid;
        // Team side from the player's own last GEP team vs the viewer's
        // anchored team (the direct `is_local` anchor, else the viewer-relative
        // `teammate` evidence). Recompute is idempotent (GEP team ids are stable
        // per match), so rows never oscillate â€” and a pre-anchor cold start
        // self-heals on the next scoreboard cycle.
        const sideAnchor = s.viewerGepTeam ?? this.gepTeamFromTeammate;
        if (sideAnchor !== null) {
          const gt = this.lastGepTeam.get(this.normalizeName(name));
          if (gt != null) {
            const wantIdx = gt === sideAnchor ? 0 : 1;
            entry.teamIndex = wantIdx;
            entry.teamId = wantIdx === 0 ? "Blue" : "Red";
          }
        } else if (typeof rec.teammate === "boolean") {
          const wantIdx = rec.teammate ? 0 : 1;
          entry.teamIndex = wantIdx;
          entry.teamId = wantIdx === 0 ? "Blue" : "Red";
        }
        // GEP internal codenames -> human display + icon. The VS-family engine
        // dialect names the agent `agentInternal` ("Clay_PC_C") instead of
        // `character` ("Clay") â€” accept both.
        const agentInternal = str(rec.character) ?? str(rec.agentInternal) ?? null;
        if (Date.now() >= this.agentGateUntil) {
          entry.agentName = agentDisplayName(agentInternal) ?? entry.agentName ?? null;
          entry.agentKey =
            typeof agentInternal === "string" && agentInternal.length > 0
              ? agentInternal.toLowerCase().replace(/_pc(_c)?$/i, "")
              : (entry.agentKey ?? undefined);
          entry.agentIcon =
            agentIconUrl(agentInternal) ?? agentIconUrl(rec.agentUuid) ?? entry.agentIcon ?? null;
        }
        const wNew =
          weaponDisplayName(rec.weapon ?? rec.weaponName ?? rec.scoreboardWeaponInternal) ?? null;
        // Knife equipped while a primary is still owned: keep the gun visible
        // (ValoSpectra highestWeapon semantics â€” GEP reports the HELD weapon).
        entry.weapon =
          wNew && !/knife|melee/i.test(wNew)
            ? wNew
            : (entry.weapon ?? wNew);
        entry.credits = num(rec.credits ?? rec.money) ?? entry.credits ?? null;
        entry.spentCredits = num(rec.spentCredits ?? rec.spent) ?? entry.spentCredits ?? null;
        // Lazy buy-start base capture (boundary rounds null the credits at
        // publish, so the first fresh money report during shopping becomes
        // the base) + LIVE loadout recomputed on every money update.
        let creditBase = this.creditsAtRoundStart.get(this.normalizeName(entry.displayName));
        if (s.roundPhase === "shopping" && entry.credits != null && creditBase == null) {
          creditBase = entry.credits;
          this.creditsAtRoundStart.set(this.normalizeName(entry.displayName), creditBase);
        }
        if (creditBase != null && entry.credits != null && s.roundPhase === "shopping") {
          entry.spentCredits = Math.max(0, creditBase - entry.credits);
        }
        // Shield: GEP's armor field is the TIER enum (0 none / 1 light / 2
        // heavy / 3 enemy-unknown / 4 regen) â€” the VS-family dialect sends it
        // as initialArmor, the fork engine as shield+shieldType. Treating a
        // raw tier as POINTS made every shield render light (tiers are 0-4).
        const shieldPointsFromTier = (v: number | undefined): number | undefined => {
          if (v === undefined || v === null || !Number.isFinite(v)) return undefined;
          if (v === 25 || v === 50) return v; // already points
          if (Number.isInteger(v) && v >= 0 && v <= 4) return [0, 25, 50, 50, 25][v];
          return undefined;
        };
        const tierFrom = (v: unknown): number | undefined => {
          const n = num(v);
          return n !== undefined && Number.isInteger(n) && n >= 0 && n <= 4 ? n : undefined;
        };
        const shieldTierReported =
          tierFrom(rec.shieldType) ??
          tierFrom(rec.armor) ??
          tierFrom(rec.initialArmor) ??
          // GEP reports the TIER in the `shield` field for the hybrid dialect
          // (raw scoreboard carries no shieldType/armor): read it as a tier so
          // REGEN (4) survives even when the fact arrives after the entry was
          // created (live 2026-09-26: a regen shield rendered as Light because
          // the tier was dropped and re-derived from 25 points).
          tierFrom(rec.shield);
        // Shield TIER is a BUY-STATE: it changes in the shop, never
        // mid-combat (damage removes POINTS, not the tier). GEP heartbeats
        // reported tier 0 mid-round while the shield was still held in-game
        // (live 2026-10-18 self-damage test) â€” the overlay shield icon
        // vanished. A zero outside the shopping phase cannot clear a known
        // non-zero tier; a real unpurchase only becomes observable in the
        // shop phase.
                // Shield break PENDING-ZERO: GEP's tier-0 report is noisy (a single
        // spurious zero on the self-damage race) but a REAL break persists.
        // Hold through ONE zero; accept it on a repeat report or when the
        // pending zero is still the latest state 4 s later - fixing both
        // reported directions ("icon vanishes on self damage" and "icon
        // doesn't disappear after the shield is broken").
        let shieldTier = shieldTierReported ?? (entry.shieldType ?? undefined);
        const shieldKey = this.normalizeName(entry.displayName);
        if (
          shieldTierReported === 0 &&
          s.roundPhase !== "shopping" &&
          (entry.shieldType ?? 0) > 0
        ) {
          const pending = this.shieldZeroStreak.get(shieldKey);
          const nowMs = Date.now();
          if (!pending) {
            this.shieldZeroStreak.set(shieldKey, { n: 1, firstAt: nowMs });
            shieldTier = entry.shieldType ?? undefined; // hold through the first zero
          } else {
            const n = pending.n + 1;
            this.shieldZeroStreak.set(shieldKey, { n, firstAt: pending.firstAt });
            // Repeated zero OR a zero that was never contradicted within 4 s
            // = the shield is really gone.
            shieldTier = n >= 2 || nowMs - pending.firstAt >= 4000 ? 0 : entry.shieldType ?? undefined;
          }
        } else {
          this.shieldZeroStreak.delete(shieldKey); // any non-zero report (or the shop) resets
        }        const shieldPts =
          shieldPointsFromTier(num(rec.shield)) ??
          shieldPointsFromTier(shieldTier) ??
          shieldPointsFromTier(num(rec.armor)) ??
          shieldPointsFromTier(num(rec.initialArmor));
        entry.shield = shieldPts ?? entry.shield ?? null;
        entry.shieldType = shieldTier ?? (entry.shield != null ? (entry.shield >= 50 ? 2 : entry.shield > 0 ? 1 : 0) : null);
        entry.kills = num(rec.kills) ?? entry.kills ?? null;
        entry.deaths = num(rec.deaths) ?? entry.deaths ?? null;
        entry.assists = num(rec.assists) ?? entry.assists ?? null;
        // Buy phase: everyone is alive by definition. Ignore stale death
        // evidence that can trail the round reset (greyed-out card bug).
        const shopping = s.roundPhase === "shopping";
        const aliveEvidence =
          typeof rec.alive === "boolean" ? rec.alive : typeof rec.isAlive === "boolean" ? rec.isAlive : undefined;
        if (aliveEvidence !== undefined) {
          if (shopping) {
            entry.isAlive = true;
            entry.health = 100;
          } else {
            entry.isAlive = aliveEvidence;
            if (!aliveEvidence) {
              entry.health = 0;
              this.diedLastRound.add(this.normalizeName(name));
            } else if (entry.health === 0) {
              // PASS 7B revive (dead -> alive): alive evidence with no fresh health
              // reading. The death's hp=0 must not survive the revive, and a
              // fabricated 100 would be fake telemetry â€” the value becomes
              // "unknown" until the provider reports real health again.
              entry.health = null;
            }
          }
        }
        // Health is applied AFTER the alive flag: a positive health reading is
        // definitive alive evidence and rescues a wounded player whose GEP
        // alive flag trailed the damage packet (the "damage -> death state"
        // bug). Only explicit dead evidence may mark a death.
        const hRaw = num(rec.health);
        if (hRaw !== undefined) {
          entry.health = shopping ? Math.max(100, hRaw) : hRaw;
          if (hRaw > 0) entry.isAlive = true;
          else if (!shopping && aliveEvidence === false) entry.isAlive = false;
        }
        entry.ultPoints =
          num(rec.ultPoints ?? rec.ult_points ?? rec.currUltPoints) ?? entry.ultPoints ?? null;
        entry.ultMax = num(rec.ultMax ?? rec.ult_max ?? rec.maxUltPoints) ?? entry.ultMax ?? null;
        if (typeof rec.hasSpike === "boolean") entry.hasSpike = rec.hasSpike;
        else if (typeof rec.spike === "boolean") entry.hasSpike = rec.spike;
        if (Array.isArray(rec.abilities)) {
          entry.abilities = rec.abilities.filter((a): a is string => typeof a === "string");
        }
        // This row may be the one that finally identifies the local player
        // (is_local on a row that arrives after the round-start ability frame).
        this.applyPendingAbilities();
        break;
      }
      case "abilities": {
        // GEP emits the LOCAL player's ability charges. Values arrive as 0/1
        // NUMBERS (provider log: {C:0,Q:0,E:1,X:0}), real booleans, or "0"/"1"
        // strings depending on the dialect â€” normalize all of them safely.
        const asBool = (v: unknown): boolean =>
          v === true || v === 1 || v === "1" || v === "true";
        const rec = value as Record<string, unknown>;
        // Keyed to the local player, with the retained-payload path inside:
        // `viewerName` is normally already anchored, but the round-start frame
        // may legitimately arrive BEFORE the scoreboard row that identifies the
        // local player â€” it must still be applied, not discarded.
        this.writeAbilityState({
          C: asBool(rec?.C),
          Q: asBool(rec?.Q),
          E: asBool(rec?.E),
          X: asBool(rec?.X),
        });
        break;
      }
      default:
        return; // unhandled keys never mutate -> no emit
    }
    s.revision += 1;
    this.emitChange();
  }

  /**
   * Authoritative score-snapshot input (runtime `valorant_score_snapshot`).
   *
   * The frame carries the match id, which makes it the most reliable new-match
   * boundary HU receives (the score stream is published at every match start â€”
   * live 2026-09-29: 03:52:26 `ally 0 / enemy 0` for the fresh match right after
   * the previous match retired) and the score itself is the round-progression
   * authority for dialects that stream no round facts at all (HU-014).
   */
  public applyScore(blue: number, red: number, matchId?: string | null): void {
    const s = this.s;
    if (!Number.isFinite(blue) || !Number.isFinite(red)) return;
    const prevBlue = s.blue;
    const prevRed = s.red;
    // New match? The frame names a different match id, or the score went DOWN
    // (a match score never decreases inside a match).
    if (typeof matchId === "string" && matchId.length > 0 && s.matchId !== null && matchId !== s.matchId) {
      s.matchId = matchId;
      this.wipeMatchState();
    } else if (this.scoreStartsNewMatch(prevBlue, prevRed)) {
      this.wipeMatchState();
    }
    s.blue = blue;
    s.red = red;
    // Provider publishes the score AFTER the end phase; resolve winner now.
    // Win-by-2: a bare >=13 fired post-game mid-OVERTIME (13-12 is not over).
    if (blue >= 13 && blue - red >= 2) s.matchWinner = "blue";
    else if (red >= 13 && red - blue >= 2) s.matchWinner = "red";
    // If the end-phase classification could not pick a winner yet (equal alive
    // counts), resolve now.
    if (s.roundPhase === "end" && s.gameEvent === null) this.settle();
    // HU-014: score-only round progression (see syncRoundProgression).
    this.syncRoundProgression(prevBlue, prevRed);
    s.revision += 1;
    this.emitChange();
  }

  /* --------------------- score-stream round progression --------------------- */

  /**
   * HU-015 â€” a score DECREASE is a new match taking over the score panel.
   *
   * A match score never decreases inside a match, so a lower score than the one
   * already published can only be the next game (live 2026-09-25: 13-8 at
   * 02:47:11Z, 0-0 at 02:48:08Z for the next match) â€” the same rule the capture
   * engine's own identity layer uses to emit `match_start`.
   *
   * Deliberately NOT applied once the session says `ending`: a post-game frame
   * that reports 0-0 would otherwise wipe the settlement that drives Post Game.
   */
  private scoreStartsNewMatch(prevBlue: number, prevRed: number): boolean {
    const s = this.s;
    if (prevBlue <= s.blue && prevRed <= s.red) return false;
    return s.sessionPhase !== "ending";
  }

  /**
   * HU-014 â€” round progression from the score stream.
   *
   * The fork dialect publishes NO round facts for the first rounds of a match
   * (live 2026-09-25 02:07:18 shopping â†’ 02:08:30 `1-0` â†’ 02:09:01 `2-0`, all
   * with `round 0/unknown`; the engine's first round fact was `3/shopping` at
   * 02:09:14), so nothing advanced the round: the HUD stayed on the BuyRound
   * scene through both rounds, no roundEnd/roundHistory was ever produced and
   * the round strip cells stayed empty.
   *
   * The score is the authority that survives, and it is exact:
   *   - every point == exactly one completed round (points are never deducted),
   *     so `blue + red` IS the number of the round that just ended;
   *   - the round in progress is therefore `blue + red + 1` â€” validated against
   *     the engine's own facts, whose round numbers for R3..R21 were exactly
   *     that (02:09:14 `2-0` â†’ `3/shopping`, 02:43:12 `12-7` â†’ `20/shopping`,
   *     02:45:28 `12-8` â†’ `21/shopping`).
   *
   * Nothing is fabricated: this only derives the round LIFECYCLE the engine
   * failed to describe (boundary + number). Every per-player value stays
   * whatever real telemetry provided, and a later real `round_phase` /
   * `round_number` fact simply overwrites the derived phase.
   */
  private syncRoundProgression(prevBlue: number, prevRed: number): void {
    const s = this.s;
    const pointScored = s.blue > prevBlue || s.red > prevRed;
    // A regressed score is the new match's opening frame (the boundary itself
    // was already taken by the caller): it can only seed the round number.
    const firstOfMatch = !s.scoreSeen || s.blue < prevBlue || s.red < prevRed;
    s.scoreSeen = true;
    if (s.matchWinner !== null) return; // a post-game score is not round evidence
    if (!pointScored) return; // 0-0 (or a repeated frame): nothing happened
    const winner: "blue" | "red" = s.blue > prevBlue ? "blue" : "red";
    const settledRound = s.blue + s.red;
    if (firstOfMatch) {
      // HU can join a match in progress: the first observation describes a round
      // we never watched, so nothing may be settled or re-phased from it. The
      // round number is still derivable (and is what the engine would report).
      if (s.roundNumber <= 0) s.roundNumber = settledRound + 1;
      return;
    }
    if (settledRound <= s.lastSettledRound) return; // already reconciled
    // 1. The round that just finished. It has no round fact of its own in this
    //    dialect, so the score delta is the winner evidence and the reason falls
    //    back to the spike latch / round clocks.
    this.recordRoundWinner(winner, null, null, settledRound);
    // 2. Once the engine has published a phase BEYOND the settled round it owns
    //    the lifecycle: the phase that follows is the engine's to publish.
    if (s.publishedNumber > settledRound) return;
    // 3. No fact ever named the round being played now: enter its buy phase so
    //    the scene (and the round strip) leave the previous round immediately
    //    instead of freezing until combat telemetry finally lands.
    s.roundNumber = settledRound + 1;
    s.publishedNumber = s.roundNumber;
    s.publishedPhase = "shopping";
    s.roundPhase = "shopping";
    s.roundPhaseFromFact = false;
    s.pendingPhase = null;
    s.phaseStartedAt = Date.now();
    // Round-scoped reset for the round we are entering (alive/health, spike,
    // per-round kill evidence, the roundStartScore baseline and both clocks).
    this.beginRoundBookkeeping();
  }

  /* ------------------------ internals ------------------------ */

  /**
   * Round-start bookkeeping (round-scoped state only - no invented values).
   *
   * Used by the `shopping` publish (normal path) and by the case where the
   * engine''s FIRST phase fact for a round is `combat` (hybrid R1: live
   * 2026-09-26 05:44:55 had no shopping phase at all). Without it on the combat
   * path the initial `alive:false` fact's hp=0 stayed on screen for the whole
   * round, and `roundStartScore` stayed null so the authoritative
   * `score {won:1,lost:0}` at 05:45:58 could not settle the round (no roundEnd,
   * no roundHistory[1] - the BuyRound strip cell stayed empty).
   */
  private beginRoundBookkeeping(): void {
    const s = this.s;
    // Half / overtime boundary: VALORANT resets the economy (round 13 = new
    // half, round 25 = OT start). Stale previous-half credits/spent/weapon/
    // shield must never display â€” null until fresh GEP money arrives (no
    // invented values). The computed-loadout base is cleared with them.
    if (s.roundNumber === 13 || s.roundNumber === 25) {
      for (const p of s.roster ?? []) {
        p.credits = null;
        p.spentCredits = null;
        p.weapon = null;
        p.shield = null;
        p.shieldType = null;
      }
      this.creditsAtRoundStart.clear();
    }
    // Buy-scene hygiene: players who DIED last round respawn WITHOUT gun+shield
    // (Valorant rules) - without this the buy-round cards kept showing a dead
    // player's old Vandal ("gun doesn't update"). Spent credits reset with
    // the gun; ability charges are KEPT (the engine emits `abilities` only when
    // the value CHANGES - live 2026-09-25: none between 02:12:14 and 02:21:59 -
    // so clearing them here made every skill icon render as unknown-dim).
    for (const p of s.roster ?? []) {
      if (this.diedLastRound.has(this.normalizeName(p.displayName))) {
        p.weapon = null;
        p.shield = null;
        p.shieldType = 0;
      }
    }
    
    this.shieldZeroStreak.clear();
    for (const p of s.roster ?? []) {
      p.isAlive = true;
      p.health = 100;
      p.spentCredits = null;
      if (p.credits != null) {
        this.creditsAtRoundStart.set(this.normalizeName(p.displayName), p.credits);
      }
    }
    s.spike = null;
    s.spikePlantedAt = null;
    s.plantSite = null;
    s.terminalSpike = null;
    s.roundKills.clear();
    s.roundKillVictims.clear();
    s.roundDeaths.clear();
    s.clutchMax.clear();
    // Baseline for the score-delta winner resolution - captured at the round''s
    // FIRST published phase so a round that starts in `combat` still settles.
    s.roundStartScore = { blue: s.blue, red: s.red };
    // Round clocks (both ROUND-SCOPED): the round's own start boundary is the
    // base for the timer-window timeout fallback, and the previous round's
    // combat clock must never classify this round.
    s.roundStartedAt = Date.now();
    s.roundStartedRound = s.roundNumber;
    s.combatStartedAt = null;
    s.combatStartedRound = 0;
    // The side THIS round is played on (the ATTACKER/DEFENDER label ground truth
    // for the round about to be settled) â€” round-scoped, never carried over.
    s.roundViewerSide = s.viewerSide;
  }
  private shouldWaitForNumber(nextPhase: string): boolean {
    const s = this.s;
    if (s.roundNumber <= 0) {
      // Round 1: the engine starts emitting shopping/combat before any
      // round_number fact - NEVER block (ValoSpectra parity). publishRound
      // promotes the round number to 1.
      return false;
    }
    if (s.publishedPhase === null) return false;
    if (s.roundNumber > s.publishedNumber) return false;
    const prevOrder = PHASE_ORDER[s.publishedPhase];
    const nextOrder = PHASE_ORDER[nextPhase];
    return prevOrder !== undefined && nextOrder !== undefined && nextOrder < prevOrder;
  }

  private publishRound(): void {
    const s = this.s;
    if (s.pendingPhase === null) return;
    const phase = s.pendingPhase;
    // A published round fact is per-round GAME evidence: it can only come from a
    // match that is actually being played, so it outranks the runtime's
    // session-level phase, which lags the match load (see `roundFactsSeen`).
    // Only the session phase is touched â€” no per-player value.
    s.roundFactsSeen = true;
    if (s.sessionPhase !== "live" && s.sessionPhase !== "ending") {
      s.sessionPhase = "live";
      s.sessionPhaseAt = Date.now();
    }
    // First published phase of a NEW round number. The engine can skip a
    // round's shopping phase entirely (hybrid R1: first phase fact is
    // `combat`) - that round still needs round-start bookkeeping.
    const firstPhaseOfRound = s.roundNumber !== s.publishedNumber;
    s.roundPhase = phase as HudRelayState["round"]["phase"];
    // The phase came from a real engine fact (publishRound is only reachable
    // through `round_phase` / `round_number`), unlike the score-derived sync.
    s.roundPhaseFromFact = true;
    s.phaseStartedAt = Date.now();
    if (s.roundNumber <= 0) s.roundNumber = 1;
    s.publishedNumber = s.roundNumber;
    s.publishedPhase = phase;
    s.pendingPhase = null;

    if (phase === "shopping") {
      // Round-start scoping: economy boundary wipe (rounds 13/25), respawn
      // hygiene for last round's dead, alive/health reset, per-round evidence
      // wipe, the roundStartScore baseline and both round clocks.
      this.beginRoundBookkeeping();
    } else if (phase === "end") {
      this.settle();
    } else if (phase === "combat") {
      // The engine can start a round directly in `combat` (hybrid R1: the first
      // phase fact is combat, no shopping). Live 2026-09-26 05:44:55: that left
      // the initial alive:false fact's hp=0 on screen for the whole round and
      // left roundStartScore null, so the authoritative score at 05:45:58
      // {won:1,lost:0} could not settle the round (no roundEnd, no
      // roundHistory[1]). Run the same round-start bookkeeping the shopping
      // phase runs â€” no value is invented, it is the documented round-start
      // scoping applied to the phase we actually received.
      if (firstPhaseOfRound) this.beginRoundBookkeeping();
      // Round-clock base for the timeout reason (VS parity: ~100s round time).
      // ROUND-SCOPED: it only ever classifies the round whose combat we saw.
      s.combatStartedAt = Date.now();
      s.combatStartedRound = s.roundNumber;
      // Derived loadout value from the authoritative money stream:
      // spent = buy-start credits âˆ’ credits now (clamped at 0). This is what
      // populates the Buy Round Loadout column â€” GEP never reports it.
      for (const p of s.roster ?? []) {
        const start = this.creditsAtRoundStart.get(this.normalizeName(p.displayName));
        if (start != null && p.credits != null) {
          p.spentCredits = Math.max(0, start - p.credits);
        }
      }
      // The previous round's banner/evidence is only stale once the next
      // round is actually being fought.
      s.gameEvent = null;
      s.roundEnd = null;
    }
  }

  /* --------------------- round-settlement classification --------------------- */
  /* Ported from upstream `val-round-settlement.ts` attribution(): priority
   * Clutch -> Ace (>=5 round kills) -> Team Ace (every winner >=1 kill) ->
   * Flawless (no winner died) -> Thrifty (loadout avg +2000; needs credit
   * evidence, otherwise skipped) -> Normal ("Round Win"). */

  private viewerTeamIndex(): number {
    const s = this.s;
    if (s.viewerName) {
      const hit = (s.roster ?? []).find(
        (p) => this.normalizeName(p.displayName) === this.normalizeName(s.viewerName!),
      );
      if (hit?.teamIndex != null) return hit.teamIndex;
    }
    // Fall back to the viewer's GEP team number (0 = Blue, 1 = Red in the
    // engine snapshot's team normalization). Without this the {won,lost}
    // score fact attributes rounds to the wrong side when the engine
    // snapshot hasn't populated the viewer's roster entry yet.
    if (s.viewerGepTeam !== null) return s.viewerGepTeam;
    return 0;
  }

  // Agent-select cache gate: when the session enters pregame (agent select),
  // the GEP scoreboard cache still re-reports the PREVIOUS game's agents for
  // players who haven't locked in â€” portraits would render as if already
  // selected. Stored agents are cleared and character evidence is ignored for
  // a short cache-flush window; locked-in players re-report after it.
  private agentGateUntil = 0;
  // Players observed dead this round â€” they respawn at the next buy phase
  // WITHOUT their gun+shield (Valorant rules); tracked so the buy-round cards
  // stop showing a dead player's old Vandal ("gun doesn't update").
  private diedLastRound = new Set<string>();
  /**
   * Pending shield-zero reports per player: the first zero-tier report outside
   * shopping is HELD (single spurious zero, self-damage race); a persisted
   * zero — a repeat report OR no contradictory report for4 s — is honored so
   * the icon disappears when the shield is really gone (both reported
   * directions, live 2026-10-18).
   */
  private shieldZeroStreak = new Map<string, { n: number; firstAt: number }>();
  /** Credits captured at each round's buy start â€” base for the derived loadout value. */
  private creditsAtRoundStart = new Map<string, number>();
  // Anchor hysteresis: GEP's team field can alternate between facts; only a
  // team value that persists commits a re-anchor (stops scoreline side swaps).
  private pendingAnchorTeam: number | null = null;
  private pendingAnchorSince = 0;

  private reSideRoster(): void {
    const s = this.s;
    for (const p of s.roster ?? []) {
      const gt = this.lastGepTeam.get(this.normalizeName(p.displayName));
      if (gt != null) {
        p.teamIndex = gt === s.viewerGepTeam ? 0 : 1;
        p.teamId = p.teamIndex === 0 ? "Blue" : "Red";
      }
    }
  }

  /**
   * PASS 7D â€” resolve the roster row a scoreboard frame belongs to.
   *
   * Pass 6 keys the relay board on the engine's own player id, but the merge
   * itself looked a row up by DISPLAY NAME only. The session snapshot can name a
   * player differently from the GEP scoreboard (its `name` field is the AGENT name
   * until the Name Service resolves â€” observed live as display names
   * "Jett"/"Sage"/"Raze"), so the same player could produce TWO rows: one carrying
   * the GEP telemetry (agent/weapon/shield/credits) and one carrying the
   * snapshot's (KDA). The relay then published whichever won its sort â€” the
   * reported "K/D/A updates but the agent icon, loadout, shield and credits do
   * not" â€” and the extra row cost a real player a slot in the 5-per-side cap
   * (`relay_roster_over_contract {kept:10, dropped:1, droppedNames:["Jett"]}`).
   *
   * Precedence:
   *   1. the SAME engine id â€” the only definitive identity, and what makes an
   *      agent-named snapshot row and a real-name scoreboard frame one player;
   *   2. otherwise the normalized display name â€” Pass 6's rule that WITHIN a
   *      match the established row OWNS its name: a frame whose id is unknown or
   *      disagrees still merges into that row, the FIRST id wins (never re-keyed)
   *      and no phantom identity is created;
   *   3. only when neither matches is this a player we do not have: a new row.
   *
   * The name fallback is deliberately NOT restricted to id-less rows â€” that made
   * a disagreeing id mint a phantom row and broke Pass 6's "no phantom identity".
   */
  private findRosterRow(
    rec: Record<string, unknown>,
    name: string,
  ): NonNullable<HudRelayState["roster"]>[number] | undefined {
    const roster = this.s.roster ?? [];
    const idRaw = (rec.player_id ?? rec.playerId ?? rec.puuid) as unknown;
    const id = typeof idRaw === "string" && idRaw.length > 0 ? idRaw.toLowerCase() : null;
    if (id) {
      const byId = roster.find((p) => p.puuid && String(p.puuid).toLowerCase() === id);
      if (byId) return byId;
    }
    const key = this.normalizeName(name);
    return roster.find((p) => this.normalizeName(p.displayName) === key);
  }

  private normalizeName(name: string): string {
    return name.split("#")[0]!.trim().toLowerCase();
  }

  /**
   * True when this kill fact is the engine's duplicate of the kill that was just
   * applied (see `lastKillFact`). Records the signature either way.
   *
   * The signature uses the RAW names (the tag included: `Foe#0000` and `Foe#0001`
   * are different players whose normalized names collide) plus the round number,
   * so it can only ever match the same round's byte-identical repeat.
   */
  private isDuplicateKillFact(attacker: string, victim: string, weapon: string): boolean {
    const raw = (v: string): string => v.trim().toLowerCase();
    const sig = `${this.s.roundNumber}|${raw(attacker)}>${raw(victim)}:${raw(weapon)}`;
    const now = Date.now();
    const prev = this.lastKillFact;
    this.lastKillFact = { sig, at: now };
    return prev !== null && prev.sig === sig && now - prev.at <= 500;
  }

  /**
   * Promote the current round to `combat` from DIRECT combat evidence (a kill).
   *
   * A kill can only happen while the round is being fought (the buy phase is
   * frozen and deals no damage), so a kill fact is proof the phase advanced.
   * This is exactly the fork dialect's blind spot: R1/R2 published NO round
   * facts at all (live 2026-09-25 02:07:18-02:09:14 â€” the first round fact
   * arrived with round 3, `3/shopping`), so with a score-derived buy phase the
   * scene stayed on BuyRound through the whole first combat and the kill feed
   * stopped accumulating (the guard below drops kills outside combat).
   *
   * The combat CLOCK is deliberately NOT started here: the first kill can land
   * deep into a round, so a clock based on it could only ever UNDER-measure the
   * round and would mislabel real timeouts as eliminations. Settlement falls
   * back to the round-start window (see recordRoundWinner).
   */
  private promoteToCombatFromKillEvidence(): void {
    const s = this.s;
    if (s.roundPhase === "combat" || s.roundPhase === "end") return;
    // A kill landing right after a settlement belongs to the round that just
    // ended â€” the engine's kill burst trails the score by milliseconds, and the
    // next round is in its BUY phase, not in combat.
    if (s.roundEndedAt !== null && Date.now() - s.roundEndedAt < 6000) return;
    // Derived phase with a derived round number: one score point == one
    // completed round (validated against the engine's own facts â€” its round
    // numbers for R3..R21 were exactly blue+red+1, live 2026-09-25).
    s.roundNumber = Math.max(s.roundNumber, s.blue + s.red + 1);
    s.publishedNumber = s.roundNumber;
    s.roundPhase = "combat";
    s.publishedPhase = "combat";
    s.roundPhaseFromFact = false;
    s.pendingPhase = null;
    s.phaseStartedAt = Date.now();
  }

  /**
   * The roster rows a kill/death name resolves to: an exact normalized match
   * first, otherwise a UNIQUE fuzzy match. Ambiguous names resolve to nothing
   * (identity is never guessed) â€” which is also what keeps a fabricated ACE
   * impossible from an unattributable kill.
   */
  private resolveRosterRows(name: string): NonNullable<HudRelayState["roster"]> {
    const roster = this.s.roster ?? [];
    const key = this.normalizeName(name);
    if (key.length === 0) return [];
    const exact = roster.filter((p) => this.normalizeName(p.displayName) === key);
    if (exact.length > 0) return exact;
    if (key.length <= 3) return [];
    const fuzzy = roster.filter((p) => {
      const pn = this.normalizeName(p.displayName);
      return pn.length > 3 && (pn.includes(key) || key.includes(pn));
    });
    return fuzzy.length === 1 ? fuzzy : [];
  }

  private trackRoundKill(attacker: string, victim: string, weapon?: string, assists?: unknown): void {
    const s = this.s;
    this.promoteToCombatFromKillEvidence();
    if (s.roundPhase !== "combat" && s.roundPhase !== "unknown") return;
    const aKey = this.normalizeName(attacker);
    const vKey = this.normalizeName(victim);
    // PASS 8 â€” a SELF-KILL is a death, never a credited kill.
    //
    // The engine's kill feed reports self-inflicted deaths (fall damage, spike
    // detonation, a self-nade, or a malformed frame) as attacker === victim.
    // Crediting them inflated the player's K/D and â€” because Team Ace is "every
    // winner got at least one kill" (line ~2338) â€” handed a FALSE Team Ace to a
    // team whose only "kill" was one of its own players dying to themselves.
    // Ace was already safe: `provenAce` requires every victim to be on the
    // LOSING side, so the killer's own name can never satisfy it. The death is
    // still applied below; only the attacker's credit is skipped.
    const selfKill = aKey === vKey;
    if (!selfKill) {
      s.roundKills.set(aKey, (s.roundKills.get(aKey) ?? 0) + 1);
      // ACE evidence is WHO was eliminated, by identity: an unresolvable victim can
      // never stand in for one of the five opponents, and the same victim recorded
      // twice stays one victim.
      const victimRow = this.resolveRosterRows(victim)[0];
      if (victimRow) {
        const victims = s.roundKillVictims.get(aKey) ?? new Set<string>();
        victims.add(this.normalizeName(victimRow.displayName));
        s.roundKillVictims.set(aKey, victims);
      }
    }
    s.roundDeaths.add(vKey);
    this.refreshClutchSituations();

    // Mutate s.roster to immediately update deathstate, kills, deaths, weapon
    for (const p of s.roster ?? []) {
      const pName = this.normalizeName(p.displayName);
      const isVictim = pName === vKey || pName.includes(vKey) || vKey.includes(pName);
      const isAttacker = pName === aKey || pName.includes(aKey) || aKey.includes(pName);

      if (isVictim) {
        p.isAlive = false;
        p.health = 0;
        p.deaths = (p.deaths ?? 0) + 1;
        this.diedLastRound.add(pName);
      }
      // A self-kill credits no kill to the player (see the selfKill guard above):
      // the victim's own death counter is applied, their kill counter is not.
      if (isAttacker && !selfKill) {
        p.kills = (p.kills ?? 0) + 1;
        if (weapon) {
          p.weapon = weapon;
        }
      }
    }

    // Update assists if present
    if (Array.isArray(assists)) {
      for (const ast of assists) {
        if (typeof ast === "string" && ast.trim()) {
          const astKey = this.normalizeName(ast);
          for (const p of s.roster ?? []) {
            const pName = this.normalizeName(p.displayName);
            if (pName === astKey || pName.includes(astKey) || astKey.includes(pName)) {
              p.assists = (p.assists ?? 0) + 1;
            }
          }
        }
      }
    }
  }

  private aliveByTeam(): [Set<string>, Set<string>] {
    const s = this.s;
    const alive: [Set<string>, Set<string>] = [new Set(), new Set()];
    for (const p of s.roster ?? []) {
      if (p.teamIndex !== 0 && p.teamIndex !== 1) continue;
      const name = this.normalizeName(p.displayName);
      if (!s.roundDeaths.has(name)) alive[p.teamIndex].add(name);
    }
    return alive;
  }

  private refreshClutchSituations(): void {
    const s = this.s;
    if ((s.roster ?? []).length === 0) return;
    const alive = this.aliveByTeam();
    for (const team of [0, 1] as const) {
      const enemies = alive[team === 0 ? 1 : 0];
      if (alive[team].size !== 1 || enemies.size <= 1) continue;
      const playerId = [...alive[team]][0]!;
      s.clutchMax.set(playerId, Math.max(s.clutchMax.get(playerId) ?? 0, enemies.size));
    }
  }

  private roundKillsFor(name: string): number {
    return this.s.roundKills.get(this.normalizeName(name)) ?? 0;
  }

  /**
   * ACE = the same player eliminated ALL FIVE opponents in this round.
   *
   * Every part of that sentence is required evidence:
   *   - five DISTINCT victims (a duplicate kill fact, a repeat victim or an
   *     assist can never add up to five),
   *   - each victim resolved to a known roster row (an unattributable kill
   *     proves nothing),
   *   - every one of them on the LOSING side (never a teammate, never a
   *     neutral/environmental death),
   *   - and a complete losing team (exactly five rows), because "all five
   *     opponents" is unverifiable on a partial board.
   * When the telemetry cannot prove that, the round gets the normal
   * classification instead â€” an ACE is never invented.
   */
  private provenAce(
    winners: NonNullable<HudRelayState["roster"]>,
    losers: NonNullable<HudRelayState["roster"]>,
  ): boolean {
    if (losers.length !== 5) return false;
    const opponents = new Set(losers.map((p) => this.normalizeName(p.displayName)));
    return winners.some((p) => {
      const victims = this.s.roundKillVictims.get(this.normalizeName(p.displayName));
      if (!victims || victims.size < 5) return false;
      for (const v of victims) if (!opponents.has(v)) return false;
      return true;
    });
  }

  /** The viewer's side for a given round, derived from the snapshot's start side. */
  /** Side of the WINNING team for the round â€” from the snapshot's start side. */
  private winnerSideFor(winner: 0 | 1, round: number): "attacker" | "defender" | null {
    // TEAM INDEX IS NOT A SIDE. The engine anchors the viewer to blue/left
    // for the whole match, so "viewer won" is simply winner === 0 â€” deriving
    // it from viewerStartSide (the old viewerTeamIsTeam0 conflation) inverted
    // the win side for every match where the viewer started on defense.
    const viewerWon = winner === 0;
    const viewerSide = this.viewerSideForRound(round);
    if (!viewerSide) return null;
    const side = viewerWon ? viewerSide : viewerSide === "attack" ? "defense" : "attack";
    return side === "attack" ? "attacker" : "defender";
  }

  private viewerSideForRound(round: number): "attack" | "defense" | null {
    const s = this.s;
    // 1. The side observed when the round being settled STARTED (precise: it is
    //    that round's own side, recorded at its round-start boundary).
    if (round === s.roundNumber && s.roundViewerSide) return s.roundViewerSide;
    // 2. The session's start side + the round-parity derivation.
    if (s.viewerStartSide) {
      // The viewer's side for a round: their START side for rounds 1-12, the
      // opposite side for rounds 13-24, alternating per OT round after that.
      if (round > 24) {
        const half2: "attack" | "defense" = s.viewerStartSide === "attack" ? "defense" : "attack";
        return (round - 25) % 2 === 0 ? half2 : half2 === "attack" ? "defense" : "attack";
      }
      if (round > 12) return s.viewerStartSide === "attack" ? "defense" : "attack";
      return s.viewerStartSide;
    }
    // 3. Degraded fallback: the CURRENT side, and only for the round in progress
    //    (a mid-match start whose session snapshot carried no start side). The
    //    label is then evidence-based rather than missing.
    if (round === s.roundNumber && s.viewerSide) return s.viewerSide;
    return null;
  }

  private settle(): void {
    const s = this.s;
    if (s.gameEvent !== null && s.roundEnd !== null) return;
    const winner = this.resolveWinnerTeam();
    if (winner !== null && s.roundEnd === null) {
      // LAST-resort path: the authoritative round_outcome transition and the
      // runtime's round_settled event both funnel through the same recorder.
      this.recordRoundWinner(winner === 0 ? "blue" : "red", null);
    }
    if (s.roundEnd === null) return;
    // PASS 7C: the settlement above establishes the round this classification
    // belongs to. A label left over from the PREVIOUS round must never describe
    // this winner (live 2026-09-30: the enemy's round-3 ACE was published with
    // round 4's blue win). Same rule as the round_settled path â€” never clear a
    // label that could still be this round's own (an equal-count end phase can
    // resolve the winner only after the label lands).
    this.dropStaleGameEventLabel();
    if (s.gameEvent !== null) return;
    if (winner === null) return; // keep null; a later score update retries

    const roster = s.roster ?? [];
    if (roster.length === 0) return;
    const winners = roster.filter((p) => p.teamIndex === winner);
    if (winners.length === 0) {
      this.setGameEvent("Round Win");
      return;
    }
    const aliveWinners = winners.filter(
      (p) => !s.roundDeaths.has(this.normalizeName(p.displayName)),
    );
    const losers = roster.filter((p) => p.teamIndex === (winner === 0 ? 1 : 0));
    // Ceremony classification needs a FULL board â€” with GEP rosters partially
    // populated, alive counts were garbage and CLUTCH/FLAWLESS fired randomly
    // on incomplete teams ("game event roundwinreason are complete random").
    const fullBoard = winners.length === 5 && losers.length === 5;

    // 1) Clutch: single survivor who was last alive vs >= 2 enemies.
    if (fullBoard && aliveWinners.length === 1) {
      const size = s.clutchMax.get(this.normalizeName(aliveWinners[0]!.displayName)) ?? 0;
      if (size > 1) {
        this.setGameEvent("Clutch");
        return;
      }
    }
    // 2) Ace: ONE player eliminated all FIVE opponents. A kill count is not
    //    evidence â€” this requires five DISTINCT victims that are all on the
    //    losing side (see provenAce). Live 2026-09-30: a 3-kill round displayed
    //    ACE because the engine's duplicated kill facts doubled the counter.
    if (this.provenAce(winners, losers)) {
      this.setGameEvent("Ace");
      return;
    }
    // 3) Team Ace: every winner got at least one kill.
    if (winners.length >= 5 && winners.every((p) => this.roundKillsFor(p.displayName) >= 1)) {
      this.setGameEvent("Team Ace");
      return;
    }
    // 4) Flawless: no winner died (full board only â€” same garbage-alive guard).
    if (fullBoard && winners.length > 0 && winners.every((p) => aliveWinners.includes(p))) {
      this.setGameEvent("Flawless");
      return;
    }
    // 5) Thrifty: needs loadout-credit evidence; providers without credits skip it.
    void losers;
    this.setGameEvent("Round Win");
  }

  /**
   * PASS 7C â€” drop a dangling Game Event classification.
   *
   * The label is published through the buy phase on purpose (the round-win
   * banner), so it can outlive its own settlement by one round transition. Every
   * time a settlement lands, this confirms that the label and the settlement
   * describe the SAME round; when they don't, the label is dropped (published as
   * null) rather than being paired with a different round's winner â€” the exact
   * shape of the reported "FLAWLESS/ACE shown on the enemy side".
   *
   * Two states are deliberately left untouched:
   *   - a fresh label with NO settlement yet (`gameEventRound === null` and
   *     `roundEnd === null`): the engine's `round_settled` classification can
   *     arrive BEFORE the score/phase that settles the round, and a settlement
   *     recorded from a jump in the score may legitimately describe that very
   *     round;
   *   - a label already owned by the settlement that is on the board.
   * Only a label proven to belong to an EARLIER settled round is dropped.
   */
  private dropStaleGameEventLabel(): void {
    const s = this.s;
    if (s.gameEvent === null) return;
    if (s.gameEventRound === null) return;
    if (s.roundEnd !== null && s.roundEnd.round === s.gameEventRound) return;
    s.gameEvent = null;
    s.gameEventRound = null;
  }

  /**
   * PASS 7C â€” publish a Game Event classification WITH its ownership.
   *
   * Every classification the projection derives must record which settled round
   * it describes at the same moment it is published; otherwise the label would
   * be re-attributed to whatever round settles next (that is exactly how the
   * enemy's round-3 ACE ended up on round 4's blue win). The settlement on the
   * board is the authority: `roundEnd.round`, else the last settled round.
   */
  private setGameEvent(label: string): void {
    const s = this.s;
    s.gameEvent = label;
    s.gameEventRound =
      s.roundEnd?.round ?? (s.lastSettledRound > 0 ? s.lastSettledRound : null);
  }

  private losersWiped(winner: 0 | 1): boolean {
    const roster = this.s.roster ?? [];
    if (roster.length === 0) return false;
    // The roster's isAlive persists through the buy-phase wipe (roundDeaths is
    // cleared there) â€” late score-fact settlements still see the real wipe.
    return !roster.some(
      (p) => p.teamIndex === (1 - winner) && p.isAlive !== false,
    );
  }

  /**
   * Latch the round-local terminal spike outcome (HU-013).
   *
   * Two live orderings exist for the same round (both captured from the blob
   * engine on :7413):
   *   A) terminal event BEFORE settlement â€” `spike_detonated` â†’ `round_phase
   *      end` (live 2026-09-25 02:31:54) â‡’ the latch is consumed by settle().
   *   B) terminal event AFTER settlement â€” `round_phase end` 02:13:18.950 â†’
   *      `score` .951 â†’ `spike_defused` + `planted_location` .951 â‡’ the round
   *      was already stamped `elimination` (the engine emits no plant-time
   *      frame, so the global spike state was null) and the HUD showed the
   *      generic kill icon for a defused round.
   * Ordering B is handled by RE-LABELLING only the round that is settling right
   * now (round-local: the round whose settlement was just recorded, still owned
   * by the end phase or by a buy phase WE derived from the score, and only from
   * a non-terminal fallback reason â€” never downgrades an explicit/terminal one).
   * A late event for an already-recorded PREVIOUS round never relabels anything.
   */
  private latchTerminalSpike(outcome: "defused" | "detonated"): void {
    const s = this.s;
    if (s.roundNumber <= 0) return;
    const terminal: "detonation" | "defusion" =
      outcome === "detonated" ? "detonation" : "defusion";
    // The settlement just recorded is the round the terminal event belongs to â€”
    // NOT necessarily s.roundNumber: the score-stream sync (HU-014) advances the
    // projection into the next round's buy phase the moment the score lands, and
    // the engine's spike burst arrives milliseconds later (same live ordering B).
    const settledRound = s.lastSettledRound > 0 ? s.lastSettledRound : s.roundNumber;
    const settledThisRound =
      s.roundEnd !== null && s.roundHistory.some((h) => h.round === settledRound);
    if (settledThisRound) {
      // Still legitimate while that round owns the phase: its own end phase, or
      // a buy phase WE derived from the score (no round fact had arrived yet).
      // Once the ENGINE names the next round's phase, the late event is stale.
      const ownedBySettlingRound =
        s.roundPhase === "end" || (s.roundPhase === "shopping" && !s.roundPhaseFromFact);
      if (!ownedBySettlingRound) return;
      if (s.roundEnd!.reason === "defusion" || s.roundEnd!.reason === "detonation") return;
      s.roundEnd = { ...s.roundEnd!, reason: terminal };
      const entry = s.roundHistory.find((h) => h.round === settledRound);
      if (entry) entry.reason = terminal;
      return;
    }
    s.terminalSpike = { round: s.roundNumber, outcome };
  }

  /**
   * THE authoritative round-settlement stamp. Every winner source funnels
   * through here â€” the GEP round_outcome transition, the runtime's
   * round_settled event, the end-phase settle() heuristic and the score-stream
   * round sync (HU-014) â€” so the engine emits exactly ONE roundEnd result per
   * round (single source of truth).
   */
  private recordRoundWinner(
    winner: "blue" | "red",
    explicitReason: "elimination" | "detonation" | "defusion" | "time" | null,
    winnerSide?: "attacker" | "defender" | null,
    roundOverride?: number,
  ): void {
    const s = this.s;
    // Which round is this settlement about? When the caller has no explicit
    // round number, the event describes the round the ENGINE is settling â€” which
    // is the PREVIOUS one while a phase WE derived from the score is still on the
    // board (the engine has not named the new round yet). Without this, a late
    // `round_outcome` transition for the just-settled round would be stamped onto
    // the round we derived, and that round's own settlement would then be
    // swallowed by the round-scoped guard below.
    const round =
      roundOverride ??
      (s.roundPhase === "shopping" && !s.roundPhaseFromFact && s.lastSettledRound > 0
        ? s.lastSettledRound
        : s.roundNumber);
    // Idempotence is ROUND-SCOPED: `roundEnd` outlives the round (it is the
    // evidence the buy brief renders), so "already settled" can never be decided
    // by the winner alone â€” the next round with the same winner would be
    // swallowed whole.
    if (round > 0 && s.lastSettledRound >= round) {
      // A LATE explicit reason from the runtime is still ground truth for the
      // round it names: the engine emits its score BEFORE round_settled, so the
      // score stream may have settled the round first. Only the reason may be
      // upgraded â€” never a re-settle, never a winner flip.
      if (
        explicitReason &&
        s.roundEnd !== null &&
        s.roundEnd.winner === winner &&
        s.roundEnd.reason !== explicitReason
      ) {
        s.roundEnd = { ...s.roundEnd, reason: explicitReason };
        const entry = s.roundHistory.find((h) => h.round === round);
        if (entry) entry.reason = explicitReason;
      }
      // The engine's winningSide for THIS round is ground truth and can arrive
      // AFTER the score settled the round — without this fill the
      // ATTACKER/DEFENDER win label stayed missing below the team name
      // (live 2026-10-18).
      if (
        winnerSide != null &&
        s.roundEnd !== null &&
        s.roundEnd.winner === winner &&
        s.roundEnd.winnerSide !== winnerSide
      ) {
        s.roundEnd = { ...s.roundEnd, winnerSide };
      }
      return;
    }
    if (round <= 0 && s.roundEnd !== null && s.roundEnd.winner === winner) return; // already settled this round
    // Reason priority: explicit (runtime ground truth) â†’ spike outcome â†’
    // round-clock timeout â†’ elimination.
    // GEP provides no explicit timeout event; the round clock is the timing
    // evidence we track, and both clocks below are ROUND-SCOPED.
    let reason: "elimination" | "detonation" | "defusion" | "time";
    if (explicitReason) reason = explicitReason;
    // HU-013: the round's OWN terminal spike outcome (latched at event time)
    // outranks the global spike state â€” the next round's plant can overwrite
    // `s.spike` within milliseconds of the defuse (live capture 2026-09-24).
    else if (s.terminalSpike?.round === round)
      reason = s.terminalSpike.outcome === "detonated" ? "detonation" : "defusion";
    else if (s.spike === "detonated") reason = "detonation";
    else if (s.spike === "defused") reason = "defusion";
    // Elimination evidence first: a wiped losing team can NEVER be a timeout, so
    // it must be allowed to outrank the clocks below (a round that ends with a
    // wipe can still have run longer than the timer window when the engine
    // reports the final kill late).
    else if (this.losingTeamWiped(winner)) reason = "elimination";
    // Timeout evidence (a): the round's OWN combat clock ran the full round
    // timer. Live timing: rounds are ~135-141 s wall-clock apart, i.e. the round
    // timer (~100 s) plus the pre-round transition, so a settlement â‰¥100 s after
    // a combat fact we actually saw for this round can only be the timer.
    else if (
      s.combatStartedAt !== null &&
      s.combatStartedRound === round &&
      Date.now() - s.combatStartedAt >= 100_000
    )
      reason = "time";
    // Timeout evidence (b): no combat fact for this round at all (fork R1/R2
    // stream no round facts) â€” the round's own start boundary plus the round
    // timer is still authoritative. 130 s = regulation buy (30 s) + round timer
    // (100 s): a round can only exceed it when the timer expired, because a
    // wipe (handled above) or the spike (handled above) are the only other ways
    // a round ends, and a planted spike always leaves its own evidence.
    else if (
      s.roundStartedAt !== null &&
      s.roundStartedRound === round &&
      Date.now() - s.roundStartedAt >= 130_000
    )
      reason = "time";
    else reason = "elimination";
    s.roundEnd = {
      winner,
      reason,
      winnerSide: winnerSide ?? this.winnerSideFor(winner === "blue" ? 0 : 1, round),
      // Stable event identity: the SETTLED round's number. Consumers that render a
      // round result must key on this, not on the round in progress (the result
      // stays published through the next round's buy phase on purpose).
      round: round > 0 ? round : null,
    };
    // PASS 7C: whatever label is on the board now belongs to THIS settlement.
    // Any label proven to belong to an EARLIER settled round was dropped right
    // above, so a label that survives to here describes this round and may be
    // stamped.
    this.dropStaleGameEventLabel();
    if (s.gameEvent !== null && round > 0) s.gameEventRound = round;
    // Stamp the settlement time â€” deriveScene holds the HUD (and the
    // endround banner) on screen for a grace period after this.
    s.roundEndedAt = Date.now();
    // ValoSpectra app-roundreasons parity: per-round win history for the
    // timeline strip (kills/detonated/defused/timeout icons per round).
    if (round > 0 && !s.roundHistory.some((h) => h.round === round)) {
      s.roundHistory.push({ round, winner, reason });
      if (s.roundHistory.length > 24) s.roundHistory.shift();
    }
    // Monotonic per match: the round whose settlement is now on the board.
    if (round > 0 && round > s.lastSettledRound) s.lastSettledRound = round;
  }

  /**
   * A COMPLETE losing side with nobody alive â€” elimination evidence.
   *
   * Full-board evidence only: the fork dialect publishes a single local row (the
   * relay board showed `roster: 1` for a whole live match, 2026-09-25), and "no
   * living rows on the other side" is trivially true for an opponent that has no
   * rows at all â€” that would label every round an elimination.
   */
  private losingTeamWiped(winner: "blue" | "red"): boolean {
    const s = this.s;
    const loserIndex = winner === "blue" ? 1 : 0;
    const losers = (s.roster ?? []).filter((p) => p.teamIndex === loserIndex);
    return losers.length >= 5 && losers.every((p) => p.isAlive === false);
  }

  private resolveWinnerTeam(): 0 | 1 | null {
    const s = this.s;
    if (s.roundStartScore) {
      if (s.blue > s.roundStartScore.blue) return 0;
      if (s.red > s.roundStartScore.red) return 1;
    }
    if ((s.roster ?? []).length > 0) {
      const alive = this.aliveByTeam();
      // Only trust alive counts on a FULL 5v5 board â€” partial GEP rosters
      // made garbage alive counts decide winners randomly.
      const t0 = (s.roster ?? []).filter((p) => p.teamIndex === 0).length;
      const t1 = (s.roster ?? []).filter((p) => p.teamIndex === 1).length;
      if (t0 === 5 && t1 === 5) {
        if (alive[0].size > alive[1].size) return 0;
        if (alive[1].size > alive[0].size) return 1;
      }
    }
    return null;
  }

  private build(): HudRelayState {
    const s = this.s;
    const candidate: HudRelayState = {
      revision: s.revision,
      connectedToRuntime: true,
      game: "VAL",
      sessionPhase: s.sessionPhase,
      matchId: s.matchId,
      mapKey: s.mapKey,
      mapName: s.mapName,
      match: { winner: s.matchWinner, mvp: this.computeMvp() },
      viewerRole: s.viewerRole,
      // The local-player anchor for consumers: only the viewer's own row carries
      // ability telemetry, so a site that renders "my abilities" must be able to
      // find that row. Published in the SAME spelling the roster row uses â€” the
      // identity dialects differ per source ("Viewer #TAG" from GEP scoreboard
      // rows vs "Viewer#TAG" from the engine snapshot), and an exact-match
      // consumer must not be asked to reconcile them (live 2026-09-29: the relay
      // published "Viewer #äºžâ€¦" while its only row read "Viewer#äºžâ€¦").
      viewerName: this.localRosterEntry()?.displayName ?? s.viewerName,

      // HU-001b: publish the provider-maintained side (contract fields already
      // exist in packages/contracts + the snapshot mapping; the relay literal
      // was the missing link â€” the website's winnerSideFromViewer/Start chain
      // reads as null without it).
      viewerSide: s.viewerSide,
      viewerStartSide: s.viewerStartSide,
      roster: this.relayRoster(),
      round: {
        number: s.roundNumber,
        phase: s.roundPhase,
        phaseStartedAt: s.phaseStartedAt,
        spikePlantedAt: s.spikePlantedAt,
      },
      score: { blue: s.blue, red: s.red },
      spike: s.spike,
      plantSite: s.plantSite,
      killfeed: s.killfeed,
      gameEvent: s.gameEvent,
      // PASS 7C: which round the Game Event label belongs to. Equal to
      // `roundEnd.round` while both describe the same round, null whenever they
      // do not â€” a consumer must never pair a winner with another round's
      // classification. The projection already drops a stale label here, so this
      // is the contract that makes the invariant checkable (and it is what the
      // buy scene keys on).
      gameEventRound: this.liveGameEventRound(),
      scene: this.deriveScene(),
      timeout: s.timeout,
      roundEnd: s.roundEnd,
      roundHistory: s.roundHistory,
      updatedAt: Date.now(),
      observedAt: Date.now(),
      restorePending: s.restorePending,
    };
    const parsed = hudRelayStateSchema.safeParse(candidate);
    if (parsed.success) {
      this.lastGoodRelayState = parsed.data;
      return parsed.data;
    }
    // Never let a metadata defect become fatal: this exact throw used to escape
    // through HudServer.route and freeze the entire publisher (2026-09-24).
    logger.error("projection", "relay_state_schema_rejected", {
      issues: parsed.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`),
    });
    const withoutRoster = hudRelayStateSchema.safeParse({ ...candidate, roster: [] });
    if (withoutRoster.success) {
      this.lastGoodRelayState = withoutRoster.data;
      return withoutRoster.data;
    }
    if (this.lastGoodRelayState) return this.lastGoodRelayState;
    // Nothing valid to publish yet: surface the real defect. Every caller is
    // guarded (HTTP route + process-level handlers), so this cannot wedge the app.
    return hudRelayStateSchema.parse(candidate);
  }

  /**
   * PASS 7C â€” the settled round a consumer can trust the Game Event label for.
   *
   * The single invariant every consumer needs:
   *
   *   classification.round === settledRound.round
   *
   * A label is trusted only when it is owned by the settlement currently on the
   * board; otherwise the answer is null (unknown) rather than another round's
   * classification. Nothing is invented: the state is the same fact the
   * projection uses internally to drop stale labels.
   */
  private liveGameEventRound(): number | null {
    const s = this.s;
    if (s.gameEvent === null) return null;
    // A label whose owning round is the settlement being published.
    if (s.gameEventRound !== null) {
      return s.roundEnd !== null && s.roundEnd.round === s.gameEventRound ? s.gameEventRound : null;
    }
    // A label that arrived BEFORE its settlement (the runtime's round_settled
    // fact may precede the score/phase that names the round): it is only
    // attributable once the settlement names the round, and then only if nothing
    // was recorded in between.
    if (s.roundEnd !== null && s.roundEnd.round != null) return s.lastSettledRound;
    return null;
  }

  /**
   * inventing nothing: identities dedupe first (first occurrence wins), then the
   * overflow is dropped in source order and reported once, so a provider that
   * reports extra board rows is visible in the session log instead of silently
   * breaking the publish loop.
   */
  private relayRoster(): HudRelayState["roster"] {
    const sorted = [...(this.s.roster ?? [])].sort((a, b) => {
      const ta = a.teamIndex ?? 9;
      const tb = b.teamIndex ?? 9;
      if (ta !== tb) return ta - tb;
      // Real squad members outrank observation-only rows so an extra provider
      // row can never cost a player their slot; within each group the stable
      // order (squad order, then first-seen sequence) is preserved.
      const oa = this.observedOnlyRoster.has(this.normalizeName(a.displayName)) ? 1 : 0;
      const ob = this.observedOnlyRoster.has(this.normalizeName(b.displayName)) ? 1 : 0;
      if (oa !== ob) return oa - ob;
      const sa = this.rosterSeq.get(this.normalizeName(a.displayName)) ?? 999;
      const sb = this.rosterSeq.get(this.normalizeName(b.displayName)) ?? 999;
      return sa - sb;
    });
    const kept: HudRelayState["roster"] = [];
    const dropped: string[] = [];
    const seen = new Set<string>();
    const perSide = new Map<number, number>();
    for (const entry of sorted) {
      // Identity first: two rows carrying the SAME engine player id are the same
      // player (duplicate frames), while two DIFFERENT ids with the same display
      // name are two different players and both belong on the board. Only when the
      // engine gives no id at all does the name stand in for identity.
      const key = entry.puuid
        ? `id:${String(entry.puuid).toLowerCase()}`
        : `name:${this.normalizeName(entry.displayName)}`;
      if (seen.has(key)) {
        dropped.push(entry.displayName);
        continue;
      }
      // Missing/unknown side is bucketed last: it may only fill leftover slots.
      const side = entry.teamIndex === 0 || entry.teamIndex === 1 ? entry.teamIndex : 2;
      const used = perSide.get(side) ?? 0;
      if (kept.length >= RELAY_ROSTER_MAX || (side !== 2 && used >= RELAY_ROSTER_PER_TEAM)) {
        dropped.push(entry.displayName);
        continue;
      }
      seen.add(key);
      perSide.set(side, used + 1);
      kept.push(entry);
    }
    if (dropped.length > 0 && !this.loggedRosterOverflow) {
      this.loggedRosterOverflow = true;
      logger.warn("projection", "relay_roster_over_contract", {
        kept: kept.length,
        dropped: dropped.length,
        droppedNames: dropped.slice(0, 6),
      });
    }
    return kept;
  }

  /**
   * MVP = the player (either team) with the most broadcast-round kills at match
   * end. Ties broken by fewer deaths, then assists. Only meaningful after the
   * match settles (winner known), so the site's post-game scene reads it.
   */
  private computeMvp(): { name: string; teamId: string; kills: number; deaths: number; assists: number } | null {
    const s = this.s;
    if (s.matchWinner === null) return null;
    let best: { name: string; teamId: string; kills: number; deaths: number; assists: number } | null = null;
    for (const p of s.roster ?? []) {
      const kills = p.kills ?? 0;
      if (kills <= 0) continue;
      const deaths = p.deaths ?? 0;
      const assists = p.assists ?? 0;
      if (!best || kills > best.kills || (kills === best.kills && deaths < best.deaths)) {
        best = { name: p.displayName.split("#")[0] || p.displayName, teamId: p.teamId ?? "", kills, deaths, assists };
      }
    }
    return best;
  }

  /**
   * The overlay scene the current game data implies. The website popout uses
   * this to switch scenes automatically; null keeps the URL-picked scene.
   */
  private deriveScene(): "agent-select" | "buy-round" | "ingame-hud" | "post-game" | null {
    const s = this.s;
    // Restored-from-cache data is unconfirmed: no scene until the runtime
    // streams fresh evidence (prevents a stale previous match presenting as
    // the live game on app start).
    if (s.restorePending) return null;
    // PASS 7B: a FRESH pre-game phase (agent select for the match being entered)
    // outranks the settled-match latch below â€” it is the authoritative evidence
    // that the previous match's Post Game is over. The latch still wins while the
    // popout sits in the menu/ending (no fresh pre-game evidence arrives then).
    const freshPregame =
      (s.sessionPhase === "pregame" || s.sessionPhase === "loading") &&
      s.sessionPhaseAt !== null &&
      Date.now() - s.sessionPhaseAt < 45_000;
    if (freshPregame) return "agent-select";
    // A settled match ALWAYS wins over generic idle/unknown session state â€”
    // the old order let sessionPhase 'idle' (after the match ends) erase
    // Post Game and drop the popout back to the HUD scene. Post Game stays
    // until a genuine new match resets matchWinner (or a production reset).
    if (s.matchWinner) return "post-game";
    if (s.sessionPhase === "idle") return null;
    // A KNOWN round phase is live-match evidence on its own: `round_phase` is
    // only ever emitted by a running game, so a session phase that never got
    // established must not veto it. Live 2026-09-30 (mid-match HU restart): the
    // capture engine re-published round/KDA/shield facts within seconds but its
    // session phase stayed `unknown`, and returning null here froze the popout on
    // its URL-picked scene (round 6/7 played with `scene: null`) â€” Pass 1's "R1
    // must work without complete telemetry" rule.
    const roundPhaseKnown =
      s.roundPhase === "shopping" || s.roundPhase === "combat" || s.roundPhase === "end";
    if (s.sessionPhase === "unknown" && !roundPhaseKnown) return null;
    // GEP round facts are the real-time truth for the current phase â€” they
    // override the engine snapshot's session-level phase which can be stale
    // during match transitions (pregame â†’ live).
    if (s.roundPhase === "shopping") {
      // Round-end hold: the endround banner just played â€” keep the HUD scene
      // (and the banner) on screen for a grace period before switching to the
      // buy scene, matching the roundwin-box timing of VS-class overlays.
      //
      // PASS 7D: the hold may only extend a buy phase WE derived from the score.
      // The engine's own `end` phase already holds the HUD for the whole ceremony
      // (measured 7.0-7.1s in every capture; the RoundCeremony plays 6.6s), so
      // applying an age-based hold after the ENGINE has named the next round's
      // buy phase could push BuyRound past the end of the buy phase entirely â€”
      // the reported "BuyRound occasionally failed to replace IngameHUD". An
      // authoritative round fact outranks a derived hold here exactly as it does
      // in latchTerminalSpike (line ~2443) and recordRoundWinner (line ~2477).
      const ceremonyHold =
        !s.roundPhaseFromFact && s.roundEndedAt !== null && Date.now() - s.roundEndedAt < 5500;
      if (ceremonyHold) return "ingame-hud";
      return "buy-round";
    }
    // A settled match always wins â€” never sit on the HUD after match point.
    if (s.matchWinner) return "post-game";
    if (s.roundPhase === "combat") {
      // Match-start grace: some GEP cycles skip the round-1 shopping phase and
      // jump straight to combat right after agent select. Hold the buy scene
      // briefly after the match loads so the buy phase still plays before the
      // HUD (ValoSpectra parity).
      if (
        s.liveSince !== null &&
        Date.now() - s.liveSince < 8000 &&
        s.roundNumber <= 1 &&
        s.blue === 0 &&
        s.red === 0
      ) {
        return "buy-round";
      }
      return "ingame-hud";
    }
    if (s.roundPhase === "end") return "ingame-hud";
    // No concrete round phase â€” use sessionPhase for match-level scenes.
    if (s.sessionPhase === "loading" || s.sessionPhase === "pregame") return "agent-select";
    if (s.sessionPhase === "ending" && !s.newMatchPending) return "post-game";
    if (s.blue >= 13 || s.red >= 13) return "post-game";
    // Pre-round-1 of a real match: the provider emits match_id during agent
    // select while round facts have not started yet (roundPhase stays
    // "unknown"). Once the session goes LIVE the match has loaded â€” show the
    // buy scene immediately instead of freezing on agent-select. A nonzero
    // score/round means a mid-round reconnect: show the HUD.
    if (!s.roundPhase || s.roundPhase === "unknown") {
      if (s.blue > 0 || s.red > 0) return "ingame-hud";
      if (s.roundNumber > 0) return "ingame-hud";
      if (s.matchId || s.mapKey) return "buy-round";
      return null;
    }
    return null;
  }

  private lastLoggedScene: string | null = null;

  // --- Live-board disk mirror (written for diagnostics; never read back) ---
  private static readonly CACHE_FILE = nodePath.join(nodeOs.tmpdir(), "havoc-unleash-last-state.json");
  private lastCacheWrite = 0;

  private saveCache(): void {
    const now = Date.now();
    if (now - this.lastCacheWrite < 4000) return; // throttle
    this.lastCacheWrite = now;
    try {
      const s = this.s;
      const payload = {
        savedAt: now,
        matchId: s.matchId,
        mapKey: s.mapKey,
        mapName: s.mapName,
        viewerName: s.viewerName,
        viewerGepTeam: s.viewerGepTeam,
        blue: s.blue,
        red: s.red,
        roundNumber: s.roundNumber,
        roundPhase: s.roundPhase,
        gameEvent: s.gameEvent,
        roundEnd: s.roundEnd,
        timeout: s.timeout,
        matchWinner: s.matchWinner,
        roundHistory: s.roundHistory,
        roundStartScore: s.roundStartScore,
        roster: (s.roster ?? []).map((p) => ({
          displayName: p.displayName,
          teamIndex: p.teamIndex,
          teamId: p.teamId,
          agentKey: p.agentKey,
          agentName: p.agentName,
          kills: p.kills,
          deaths: p.deaths,
          assists: p.assists,
          credits: p.credits,
          weapon: p.weapon,
          shield: p.shield,
          shieldType: p.shieldType,
        })),
      };
      nodeFs.writeFileSync(ValProjectionSession.CACHE_FILE, JSON.stringify(payload), "utf8");
    } catch {
      // best-effort â€” a cache failure must never affect the live projection
    }
  }

  private restoreCache(): void {
    try {
      if (!nodeFs.existsSync(ValProjectionSession.CACHE_FILE)) return;
      const raw = JSON.parse(
        nodeFs.readFileSync(ValProjectionSession.CACHE_FILE, "utf8"),
      ) as Record<string, unknown>;
      const savedAt = Number(raw?.savedAt ?? 0);
      const ageMs = Date.now() - savedAt;
      // Stale, clock-skewed or malformed mirrors are discarded outright.
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 2 * 60 * 60 * 1000) return;
      const roster = Array.isArray(raw.roster) ? (raw.roster as Record<string, unknown>[]) : [];
      this.bootContinuity = {
        savedAt,
        ageMs,
        matchId: typeof raw.matchId === "string" ? raw.matchId : null,
        mapKey: typeof raw.mapKey === "string" ? raw.mapKey : null,
        mapName: typeof raw.mapName === "string" ? raw.mapName : null,
        score: { blue: Number(raw.blue ?? 0) || 0, red: Number(raw.red ?? 0) || 0 },
        roundNumber: Number(raw.roundNumber ?? 0) || 0,
        roundPhase: typeof raw.roundPhase === "string" ? raw.roundPhase : null,
        rosterCount: roster.length,
        rosterNames: roster
          .map((p) => (typeof p?.displayName === "string" ? p.displayName : ""))
          .filter(Boolean)
          .slice(0, 10),
      };
      // The gate stays CLOSED until live evidence arrives (applyFact /
      // applySnapshot): quarantined continuity can never establish
      // session/match/map/score/round/scene on its own.
      this.s.restorePending = true;
      pipelineLog("boot_cache_quarantined", {
        ageMs,
        matchId: this.bootContinuity.matchId,
        mapKey: this.bootContinuity.mapKey,
        score: `${this.bootContinuity.score.blue}-${this.bootContinuity.score.red}`,
        roundNumber: this.bootContinuity.roundNumber,
        roster: this.bootContinuity.rosterCount,
      });
    } catch {
      // corrupted cache â€” start clean
    }
  }

  private clearCache(): void {
    try {
      nodeFs.unlinkSync(ValProjectionSession.CACHE_FILE);
    } catch {
      // already gone
    }
  }

  private emitChange(): void {
    this.saveCache();
    const state = this.build();
    // Boundary telemetry: the scene-switch decision (deriveScene output).
    if (state.scene !== this.lastLoggedScene) {
      pipelineLog("scene_decision", {
        scene: state.scene,
        sessionPhase: state.sessionPhase,
        round: `${state.round.number}/${state.round.phase}`,
        score: `${state.score.blue}-${state.score.red}`,
        roster: state.roster?.length ?? 0,
      });
      this.lastLoggedScene = state.scene;
    }
    for (const fn of this.listeners) {
      try {
        fn(state);
      } catch {
        // Listener failures must never break projection bookkeeping.
      }
    }
  }
}
