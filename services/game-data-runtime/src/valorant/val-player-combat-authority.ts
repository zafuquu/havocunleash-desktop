import type {
  IFormattedValorantKillfeed,
  IFormattedValorantRoundInfo,
} from "./valorant-api";
import { isValorantKillfeedLiveAttackerEvidence } from "./valorant-killfeed";
import { EValorantRoundPhase } from "./valorant-shared";

import { resolveValCombatTruth } from "./val-combat-truth";

type NativeTeam = 0 | 1;
type CombatStats = { assists: number; deaths: number; isAlive: boolean; kills: number };
type RoundPhase = IFormattedValorantRoundInfo["roundPhase"];

export interface ValCombatAuthorityPlayer extends CombatStats {
  observedLabels: readonly string[];
  occurrencePlayerId: string;
  startTeam: NativeTeam;
}

export interface ValSelectedCombatStats extends CombatStats {
  source: "killfeed" | "scoreboard";
}

interface PlayerAuthorityState {
  fallback: CombatStats;
  observedLabels: Set<string>;
  scoreboard: CombatStats | null;
  source: "killfeed" | "scoreboard";
  startTeam: NativeTeam;
}

interface ShoppingWindow {
  observedPlayerIds: Set<string>;
  roundNumber: number;
}

/** Owns per-player scoreboard authority and the independent killfeed fallback ledger. */
export class ValPlayerCombatAuthority {
  private currentPhase: RoundPhase = null;
  private currentRoundNumber: number | null = null;
  private players = new Map<string, PlayerAuthorityState>();
  private rosterPlayerIds = new Set<string>();
  private shoppingWindow: ShoppingWindow | null = null;

  public reset(): void {
    this.currentPhase = null;
    this.currentRoundNumber = null;
    this.players.clear();
    this.rosterPlayerIds.clear();
    this.shoppingWindow = null;
  }

  public replaceRoster(players: readonly ValCombatAuthorityPlayer[]): void {
    const nextRosterIds = new Set(players.map((player) => player.occurrencePlayerId));
    for (const [playerId, state] of this.players) {
      if (!nextRosterIds.has(playerId)) state.source = "scoreboard";
    }
    for (const player of players) this.upsertPlayer(player);
    this.rosterPlayerIds = nextRosterIds;
  }

  public beginRound(roundNumber: number): void {
    this.currentRoundNumber = roundNumber;
    this.currentPhase = null;
    this.shoppingWindow = null;
    for (const state of this.players.values()) {
      state.fallback = { ...state.fallback, isAlive: true };
      if (state.scoreboard) state.scoreboard = { ...state.scoreboard, isAlive: true };
    }
  }

  public observeRoundPhase(
    roundNumber: number,
    phase: RoundPhase,
    source: string | undefined,
  ): number {
    if (this.currentRoundNumber !== roundNumber) this.beginRound(roundNumber);

    if (phase === EValorantRoundPhase.Shopping) {
      if (
        source === "OW" &&
        (this.shoppingWindow?.roundNumber !== roundNumber ||
          this.currentPhase !== EValorantRoundPhase.Shopping)
      ) {
        this.shoppingWindow = { observedPlayerIds: new Set(), roundNumber };
      } else if (source !== "OW") {
        this.shoppingWindow = null;
      }
    }

    let newlyFallback = 0;
    if (
      phase === EValorantRoundPhase.Combat &&
      source === "OW" &&
      this.currentPhase === EValorantRoundPhase.Shopping &&
      this.shoppingWindow?.roundNumber === roundNumber &&
      this.shoppingWindow.observedPlayerIds.size > 0
    ) {
      for (const playerId of this.rosterPlayerIds) {
        if (this.shoppingWindow.observedPlayerIds.has(playerId)) continue;
        const state = this.players.get(playerId);
        if (!state || state.source === "killfeed") continue;
        state.source = "killfeed";
        newlyFallback += 1;
      }
      this.shoppingWindow = null;
    }

    this.currentPhase = phase;
    return newlyFallback;
  }

  public observeScoreboard(
    player: ValCombatAuthorityPlayer,
    source: string | undefined,
    roundNumber: number,
    phase: RoundPhase,
  ): boolean {
    const state = this.upsertPlayer(player);
    const checkpoint = this.stats(player);
    const recovered = state.source === "killfeed";
    state.scoreboard = checkpoint;
    state.fallback = { ...checkpoint };
    state.source = "scoreboard";
    if (
      source === "OW" &&
      phase === EValorantRoundPhase.Shopping &&
      this.shoppingWindow?.roundNumber === roundNumber
    ) {
      this.shoppingWindow.observedPlayerIds.add(player.occurrencePlayerId);
    }
    return recovered;
  }

  public observeKillfeed(kill: IFormattedValorantKillfeed): void {
    const attacker = this.resolvePlayer(kill.attacker);
    const victim = this.resolvePlayer(kill.victim);
    if (!victim) return;
    const truth = resolveValCombatTruth({
      attackerId: attacker?.playerId,
      attackerTeamId: attacker?.state.startTeam,
      killfeed: kill,
      victimId: victim.playerId,
      victimTeamId: victim.state.startTeam,
    });
    if (!truth.countsForCombatBoardDeath) return;

    victim.state.fallback = {
      ...victim.state.fallback,
      deaths: victim.state.fallback.deaths + 1,
      isAlive: false,
    };
    if (attacker && truth.creditsAttackerKill) {
      attacker.state.fallback = {
        ...attacker.state.fallback,
        isAlive: isValorantKillfeedLiveAttackerEvidence(kill)
          ? true
          : attacker.state.fallback.isAlive,
        kills: attacker.state.fallback.kills + 1,
      };
    }
    if (!truth.countsForAssistCredit) return;
    const creditedAssists = new Set<string>();
    for (const label of kill.assists) {
      const assist = this.resolvePlayer(label);
      if (
        !assist ||
        assist.state.startTeam === victim.state.startTeam ||
        creditedAssists.has(assist.playerId)
      ) {
        continue;
      }
      creditedAssists.add(assist.playerId);
      assist.state.fallback = {
        ...assist.state.fallback,
        assists: assist.state.fallback.assists + 1,
      };
    }
  }

  public project(playerId: string): ValSelectedCombatStats | null {
    const state = this.players.get(playerId);
    if (!state) return null;
    const selected = state.source === "killfeed" ? state.fallback : state.scoreboard;
    return {
      ...(selected ?? { assists: 0, deaths: 0, isAlive: true, kills: 0 }),
      source: state.source,
    };
  }

  private upsertPlayer(player: ValCombatAuthorityPlayer): PlayerAuthorityState {
    const existing = this.players.get(player.occurrencePlayerId);
    if (existing) {
      existing.startTeam = player.startTeam;
      for (const label of player.observedLabels) existing.observedLabels.add(this.label(label));
      return existing;
    }
    const fallback = this.stats(player);
    const state: PlayerAuthorityState = {
      fallback,
      observedLabels: new Set(player.observedLabels.map((label) => this.label(label))),
      scoreboard: null,
      source: "scoreboard",
      startTeam: player.startTeam,
    };
    state.observedLabels.add(this.label(player.occurrencePlayerId));
    this.players.set(player.occurrencePlayerId, state);
    return state;
  }

  private resolvePlayer(
    label: string,
  ): { playerId: string; state: PlayerAuthorityState } | undefined {
    const normalized = this.label(label);
    const matches = [...this.players.entries()].filter(([, state]) =>
      state.observedLabels.has(normalized),
    );
    if (matches.length !== 1) return undefined;
    const [playerId, state] = matches[0]!;
    return { playerId, state };
  }

  private stats(player: CombatStats): CombatStats {
    return {
      assists: player.assists,
      deaths: player.deaths,
      isAlive: player.isAlive,
      kills: player.kills,
    };
  }

  private label(value: string): string {
    return value.replace(/\s+#/g, "#").trim().toLowerCase();
  }
}
