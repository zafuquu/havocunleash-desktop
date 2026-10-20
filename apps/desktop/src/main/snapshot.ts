/**
 * Map projected game state -> the bridge's `game` snapshot shape.
 * The bridge (server/game-bridge.mjs) reads:
 *   state.leftTeam / state.rightTeam  -> {gameScore, seriesScore, name}
 *   state.currentRound.roundNumber
 * The overlay popout reads snapshot.state.players[].{playerId,name,tagline,agentName,...}
 */
import type { HudRelayState } from "@havoc-unleash/contracts";

export interface GameTeamState {
  name: string | null;
  tag?: string | null;
  score?: number;
  gameScore?: number;
  seriesScore?: number;
  matches_won_this_series?: number;
  color?: string | null;
}

export interface GamePlayerState {
  playerId?: string;
  /**
   * The engine's stable player identity (GEP `player_id` / PUUID) when the
   * provider reports one. `playerId` stays the display name for compatibility;
   * consumers that must bind telemetry to a row (spectating, panel mapping)
   * should match on this identity, never on the panel index.
   */
  puuid?: string | null;
  name?: string;
  tagline?: string;
  agentName?: string | null;
  teamId?: string | null;
  team?: string | null;
  /** 0 = left/blue, 1 = right/red — the website's OverlayPopout filters on this. */
  teamIndex?: number | null;
  /** Same as teamIndex (the website's filter fallback reads this name). */
  startTeam?: number | null;
  isAlive?: boolean;
  health?: number | null;
  armor?: number | null;
  shield?: number | null;
  shieldType?: number | null;
  abilities?: unknown[];
  // Live scoreboard detail (passed through when the provider supplies it).
  weapon?: string | null;
  /** GEP internal agent codename (e.g. "cashew") for icon/ability asset paths. */
  agentKey?: string | null;
  /** Local player's ability charges (C/Q/E/X) from GEP. */
  abilityState?: { C?: boolean | null; Q?: boolean | null; E?: boolean | null; X?: boolean | null } | null;
  credits?: number | null;
  spentCredits?: number | null;
  kills?: number | null;
  deaths?: number | null;
  assists?: number | null;
  ultPoints?: number | null;
  ultMax?: number | null;
  hasSpike?: boolean | null;
}

export interface GameSnapshot {
  gameId?: number;
  state: {
    leftTeam: GameTeamState | null;
    rightTeam: GameTeamState | null;
    currentRound: { roundNumber: number | null; roundPhase?: string | null };
    players: GamePlayerState[];
    gameScore: { left: number; right: number };
    gameEvent?: string | null;
    /**
     * PASS 7C — the settled round `gameEvent` belongs to (see the relay contract
     * in packages/contracts/src/hud-state.ts). A winner-specific classification
     * may only be rendered when this equals `roundEnd.round`.
     */
    gameEventRound?: number | null;
    /** Overlay scene implied by live game data (drives auto scene switching). */
    scene?: string | null;
    /** Friendly map name (e.g. "Ascent"). */
    mapName?: string | null;
    /** Canonical map key (e.g. "ascent") for asset paths. */
    mapKey?: string | null;
    /**
     * Round phase the site popout's gamePhase derivation reads
     * ("shopping" | "combat" | "end" | "unknown"). Without it the popout can
     * never leave the InGameHud scene.
     */
    roundPhase?: string | null;
    /** Agent-select signal — the popout maps this to gamePhase "game_start". */
    isAgentSelectPhase?: boolean;
    /** Phase start epoch (ms) so overlays can derive a round timer. */
    phaseStartedAt?: number | null;
    /** Round timer in seconds remaining */
    roundTimer?: number | null;
    /** Spectator role for overlays that show a spectator badge. */
    viewerRole?: string | null;
    /**
     * The local player's canonical "Name#TAG" — matches `players[].playerId`.
     * Ability charges are local-player-only telemetry, so consumers need this to
     * know which row owns them (never inferred for anybody else).
     */
    viewerName?: string | null;
    /** Spike planted flag for the site's SpikeIndicator. */
    bombPlanted?: boolean;
    /**
     * Canonical spike-plant slot the site's clock reads
     * (`snapshot.state.round.spikePlantedAt` in OverlayPopout → IngameHudScene
     * `spikeRemainingSec`). Authoritative plant epoch (ms) while a spike is
     * planted, `null` otherwise — never derived, never rounded.
     *
     * Only this field is projected into `round`: round number/phase/
     * phaseStartedAt keep their existing single slots above (no duplicated
     * representation of the same value).
     */
    round?: { spikePlantedAt: number | null } | null;
    /**
     * Spike plant SITE ("A" | "B" | "C") while a spike is planted — the site's
     * existing contract field (`snapshot.state.plantSite` in OverlayPopout →
     * IngameHudScene renders "SITE X"). Raw normalized site only, `null`
     * otherwise; cleared with the spike lifecycle, never stale across rounds.
     */
    plantSite?: string | null;
    /** Post-game result (winner + MVP) when a match settles. */
    match?: {
      winner: "blue" | "red" | null;
      mvp: { name: string; teamId: string; kills: number; deaths: number; assists: number } | null;
    };
    /** Restored-from-cache data not yet confirmed by live runtime frames. */
    restorePending?: boolean;
    /** Authoritative observation epoch (ms) — monotonic staleness gate. */
    observedAt?: number;
    /** How the last round ended (winner + reason), cleared at next round start. */
    roundEnd?: { round?: number | null; winner: "blue" | "red" | null; reason: string | null; winnerSide?: "attacker" | "defender" | null; label?: string | null; highlightPlayer?: { name: string; agent: string | null; kills: number | null; deaths: number | null; assists: number | null } | null } | null;
    /** Active tactical timeout / tech pause (BLOB parity) — frame-level for TimeoutOverlay. */
    timeout?: { team: "left" | "right" | null; calledAt: number; timeoutType: "tactical" | "tech_pause" } | null;
    /** Viewer's side this round (from the snapshot's team startingSide). */
    viewerSide?: "attack" | "defense" | null;
    /** The viewer's START side (session-snapshot ground truth) — drives the side-label fallback. */
    viewerStartSide?: "attack" | "defense" | null;
    /** Per-round win history (ValoSpectra app-roundreasons parity, max 24). */
    roundHistory?: Array<{
      round: number;
      winner: "blue" | "red";
      reason: "elimination" | "detonation" | "defusion" | "time";
    }>;
  };
}

const TEAM_NAMES: Record<string, string> = {
  blue: "Team A",
  red: "Team B",
};

/** Build a bridge-compatible snapshot from the projected relay state. */
export function toGameSnapshot(state: HudRelayState): GameSnapshot {
  const roundNumber = state.round?.number ?? 0;
  const leftScore = state.score.blue ?? 0;
  const rightScore = state.score.red ?? 0;

  const leftTeamBase: GameTeamState = {
    name: TEAM_NAMES.blue,
    tag: "B",
    gameScore: leftScore,
    seriesScore: 0,
    score: leftScore,
    color: "#28D091",
  };
  const rightTeamBase: GameTeamState = {
    name: TEAM_NAMES.red,
    tag: "A",
    gameScore: rightScore,
    seriesScore: 0,
    score: rightScore,
    color: "#FF3549",
  };

  const players: GamePlayerState[] = (state.roster ?? []).map((p) => {
    const [name, tagline] = p.displayName.split("#");
    return {
      playerId: p.displayName,
      puuid: p.puuid ?? null,
      name: name || p.displayName,
      tagline: tagline ?? "",
      agentName: p.agentName ?? null,
      teamId: p.teamId ?? null,
      team: p.teamId ?? null,
      // Critical: the website's OverlayPopout splits left/right on this.
      teamIndex: p.teamIndex ?? null,
      startTeam: p.teamIndex ?? null,
      agentKey: p.agentKey ?? undefined,
      abilityState: p.abilityState ?? null,
      // Health is published ONLY from real telemetry evidence. The previous
      // `p.health ?? 100` fabricated a full-HP bar for every player the
      // provider has not reported (Regression C: fake HP mistaken for live
      // data). null means "unknown — no telemetry yet"; the site renders
      // dim-unknown for null (IngameHudScene healthNum == null path).
      // PASS 7B: an explicit projection alive flag is authoritative — a stale
      // hp=0 left over from a death was re-killing every revived player here.
      // Health is only consulted when the projection has no alive evidence.
      isAlive:
        p.isAlive === true || p.isAlive === false
          ? p.isAlive
          : p.health == null
            ? true
            : p.health > 0,
      health: p.isAlive === false ? 0 : (p.health ?? null),
      // Real shield from GEP: `shield` = points (0/25/50), `shieldType` = the
      // GEP tier enum (0 none / 1 light / 2 heavy / 3 enemy-unknown / 4 regen)
      // so the site can render the correct armor icon (VS parity).
      // armor: null-safe (unknown ≠ zero) — the site's getShieldImg treats
      // null/undefined armor as "no shield evidence" via Number(null)=0 -> None;
      // shield points stay null when the provider has not reported (Regression E).
      armor: p.shield ?? null,
      shield: p.shield ?? null,
      shieldType:
        p.shieldType != null
          ? p.shieldType
          : p.shield != null
            ? p.shield >= 50
              ? 2
              : p.shield > 0
                ? 1
                : 0
            : undefined,
      abilities: p.abilities ?? [],
      weapon: p.weapon ?? null,
      credits: p.credits ?? null,
      spentCredits: p.spentCredits ?? null,
      kills: p.kills ?? 0,
      deaths: p.deaths ?? 0,
      assists: p.assists ?? 0,
      ultPoints: p.ultPoints ?? null,
      ultMax: p.ultMax ?? null,
      hasSpike: p.hasSpike ?? null,
    };
  });

  // Only publish team blocks when real players exist for that side.
  const hasLeftPlayers = players.some((p) => (p.teamIndex ?? p.startTeam ?? 0) === 0);
  const hasRightPlayers = players.some((p) => (p.teamIndex ?? p.startTeam) === 1);
  const leftTeam = hasLeftPlayers || players.length > 0 ? { ...leftTeamBase } : null;
  const rightTeam = hasRightPlayers ? { ...rightTeamBase } : null;

  // Compute live round timer in seconds remaining
  let roundTimer: number | null = null;
  if (state.round?.phaseStartedAt && typeof state.round.phaseStartedAt === "number") {
    const elapsed = Math.max(0, Math.floor((Date.now() - state.round.phaseStartedAt) / 1000));
    const total = state.spike === "planted" ? 45 : state.round.phase === "shopping" ? 30 : 100;
    roundTimer = Math.max(0, total - elapsed);
  }

  return {
    gameId: 21640,
    state: {
      leftTeam,
      rightTeam,
      currentRound: {
        roundNumber: players.length > 0 && roundNumber > 0 ? roundNumber : null,
        roundPhase: state.round?.phase ?? null,
      },
      players,
      gameScore: { left: leftScore, right: rightScore },
      gameEvent: state.gameEvent ?? null,
      gameEventRound: state.gameEventRound ?? null,
      scene: state.scene ?? null,
      mapName: state.mapName ?? null,
      mapKey: state.mapKey ?? null,
      roundPhase: state.round?.phase ?? null,
      isAgentSelectPhase: state.sessionPhase === "loading" || state.sessionPhase === "pregame",
      phaseStartedAt: state.round?.phaseStartedAt ?? null,
      roundTimer,
      viewerRole: state.viewerRole ?? null,
      viewerName: state.viewerName ?? null,
      bombPlanted: state.spike === "planted",
      // Spike clock (VS parity): the HUD needs the PLANT TIME, not just the
      // flag. The projection publishes `round.spikePlantedAt` (set on plant,
      // held stable across re-emits, cleared on defuse/detonation and at the
      // next round's buy phase) and the popout reads exactly
      // `snapshot.state.round.spikePlantedAt`; dropping it here left the site
      // with no countdown (static "SPIKE" label) while the spike was ticking.
      round: { spikePlantedAt: state.round?.spikePlantedAt ?? null },
      // Spike SITE (GEP `planted_location` value, published raw): the popout
      // reads `snapshot.state.plantSite` and renders "SITE X" while planted.
      plantSite: state.plantSite ?? null,
      restorePending: state.restorePending === true ? true : undefined,
      observedAt: state.updatedAt,
      match: {
        winner: state.match?.winner ?? null,
        mvp: state.match?.mvp ?? null,
      },
      roundEnd: state.roundEnd ?? null,
      // Tactical timeout / tech pause (BLOB timeoutStarted parity) — the site's
      // TimeoutOverlay consumes it via the broadcast frame's `timeout` field.
      timeout: state.timeout ?? null,
      // Viewer's side this round (snapshot startingSide ground truth) — the
      // site uses it as the ATTACKER/DEFENDER WIN label fallback.
      viewerSide: state.viewerSide ?? null,
      viewerStartSide: state.viewerStartSide ?? null,
      // ValoSpectra app-roundreasons parity: per-round win history for the
      // site's timeline strip (kills/detonated/defused/timeout icons).
      roundHistory: state.roundHistory ?? [],
    },
  };
}