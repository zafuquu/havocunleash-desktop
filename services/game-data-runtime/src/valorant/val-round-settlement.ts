import type {
  IFormattedValorantKillfeed,
  IFormattedValorantScore,
} from "./valorant-api";
import type { IFormattedValorantOCRRoundHistory } from "./valorant-ocr";
import { isValorantKillfeedLiveAttackerEvidence } from "./valorant-killfeed";

import { resolveValCombatTruth } from "./val-combat-truth";
import type { ValProjectionTime, ValScheduledTask } from "./val-round-clock";
import { valorantAttackerForRound } from "./val-side-ownership";

const VALORANT_ROUND_SETTLEMENT_GRACE_MS = 400;

type NativeTeam = 0 | 1;
type SpikeTerminalOutcome = "defused" | "detonated";
type WinningReason = "defused" | "elimination" | "explosion" | "timeout";
type PlayerStats = { assists: number; deaths: number; kills: number };

export interface ValNativeCombatPlayer extends PlayerStats {
  agentName: string;
  isAlive: boolean;
  loadoutValue?: number;
  observedLabels: readonly string[];
  occurrencePlayerId: string;
  startTeam: NativeTeam;
}

export interface ValNativeRoundSettlement {
  highlightOccurrencePlayerId: string | null;
  plantSite?: string;
  roundNumber: number;
  winnerStartTeam: NativeTeam;
  winningReason: WinningReason;
  winningSide: "attack" | "defense";
  winType: string;
  winTypeLabel: string;
}

interface ScoreboardDelta extends PlayerStats {
  aliveToFalse: boolean;
  aliveToTrue: boolean;
  latestAliveState: boolean | null;
}

interface RoundAnalysis {
  acceptedDeathTotals: Map<string, number>;
  aliveByTeam: Record<NativeTeam, Set<string>>;
  clutchSituations: Map<string, number>;
  diedPlayers: Set<string>;
  inferredStats: Map<string, PlayerStats>;
  loadouts: Record<NativeTeam, Map<string, number>>;
  players: Map<string, ValNativeCombatPlayer>;
  playerStartStats: Map<string, PlayerStats>;
}

interface RoundSpikeEvidence {
  plantObserved: boolean;
  plantSite?: string;
  terminalOutcome?: SpikeTerminalOutcome;
}

interface PendingSettlement {
  analysis: RoundAnalysis;
  boardAtScore: { aliveAttackers: number; aliveDefenders: number };
  spike: RoundSpikeEvidence;
  roundNumber: number;
  scoreboardDeltas: Map<string, ScoreboardDelta>;
  task: ValScheduledTask;
  winnerStartTeam: NativeTeam;
}

/**
 * Retains native combat analysis across the 400 ms settlement window. It knows occurrence
 * players and Riot start teams only; canonical attribution happens later in the addressed
 * session, which keeps binding replacement pure.
 */
export class ValRoundSettlement {
  private analyses = new Map<number, RoundAnalysis>();
  private currentRoundNumber: number | null = null;
  private latestPendingRound: number | null = null;
  private observedHistory = new Map<number, WinningReason>();
  private pending = new Map<number, PendingSettlement>();
  private currentSpikeEvidence = emptySpikeEvidence();
  private settledRounds = new Set<number>();

  public constructor(
    private readonly time: ValProjectionTime,
    private readonly settled: (result: ValNativeRoundSettlement) => void,
  ) {}

  public reset(): void {
    for (const pending of this.pending.values()) pending.task.cancel();
    this.analyses.clear();
    this.currentRoundNumber = null;
    this.latestPendingRound = null;
    this.observedHistory.clear();
    this.pending.clear();
    this.currentSpikeEvidence = emptySpikeEvidence();
    this.settledRounds.clear();
  }

  public beginRound(roundNumber: number, players: readonly ValNativeCombatPlayer[]): void {
    const previous =
      this.currentRoundNumber == null ? undefined : this.analyses.get(this.currentRoundNumber);
    const cumulativePlayers = players.map((player) => {
      const retained = previous
        ? this.projectedStats(previous, player.occurrencePlayerId)
        : undefined;
      return retained
        ? {
            ...player,
            assists: Math.max(player.assists, retained.assists),
            deaths: Math.max(player.deaths, retained.deaths),
            kills: Math.max(player.kills, retained.kills),
          }
        : player;
    });
    this.currentRoundNumber = roundNumber;
    this.currentSpikeEvidence = emptySpikeEvidence();
    this.analyses.set(roundNumber, emptyAnalysis(cumulativePlayers));
    for (const key of this.analyses.keys()) {
      if (key < roundNumber - 2 && !this.pending.has(key)) this.analyses.delete(key);
    }
  }

  public observeScoreboardDelta(
    roundNumber: number,
    previous: ValNativeCombatPlayer | undefined,
    next: ValNativeCombatPlayer,
  ): void {
    const analysis = this.analyses.get(roundNumber);
    if (!analysis) return;
    const existingPlayer = analysis.players.get(next.occurrencePlayerId);
    const mergedPlayer: ValNativeCombatPlayer = {
      ...(existingPlayer ?? next),
      ...next,
      assists: Math.max(existingPlayer?.assists ?? next.assists, next.assists),
      deaths: Math.max(existingPlayer?.deaths ?? next.deaths, next.deaths),
      kills: Math.max(existingPlayer?.kills ?? next.kills, next.kills),
      observedLabels: uniqueLabels(existingPlayer?.observedLabels ?? [], next.observedLabels),
    };
    analysis.players.set(next.occurrencePlayerId, mergedPlayer);
    if (!analysis.playerStartStats.has(next.occurrencePlayerId)) {
      analysis.playerStartStats.set(next.occurrencePlayerId, stats(next));
    }
    const pending = this.pending.get(roundNumber);
    if (pending && previous) {
      const delta = pending.scoreboardDeltas.get(next.occurrencePlayerId) ?? emptyDelta();
      delta.kills += Math.max(0, next.kills - previous.kills);
      delta.deaths += Math.max(0, next.deaths - previous.deaths);
      delta.assists += Math.max(0, next.assists - previous.assists);
      delta.latestAliveState = next.isAlive;
      if (previous.isAlive && !next.isAlive) {
        delta.aliveToFalse = true;
      } else if (!previous.isAlive && next.isAlive) {
        delta.aliveToTrue = true;
      }
      pending.scoreboardDeltas.set(next.occurrencePlayerId, delta);
      return;
    }
    this.applyPlayerLife(analysis, mergedPlayer);
    analysis.loadouts[next.startTeam].set(
      next.occurrencePlayerId,
      Math.max(0, next.loadoutValue ?? 0),
    );
    this.refreshClutchSituations(analysis);
  }

  public observeKillfeed(roundNumber: number, kill: IFormattedValorantKillfeed): void {
    const analysis = this.analyses.get(roundNumber);
    if (!analysis) return;
    const attacker = this.resolvePlayer(analysis, kill.attacker);
    const victim = this.resolvePlayer(analysis, kill.victim);
    if (!victim) return;
    const truth = resolveValCombatTruth({
      attackerId: attacker?.occurrencePlayerId,
      attackerTeamId: attacker?.startTeam,
      killfeed: kill,
      victimId: victim.occurrencePlayerId,
      victimTeamId: victim.startTeam,
    });
    if (!truth.countsForCombatBoardDeath) return;
    analysis.aliveByTeam[victim.startTeam].delete(victim.occurrencePlayerId);
    analysis.diedPlayers.add(victim.occurrencePlayerId);
    const victimInference = this.inferredStats(analysis, victim.occurrencePlayerId);
    victimInference.deaths += 1;
    const projectedVictim = this.projectedStats(analysis, victim.occurrencePlayerId);
    if (projectedVictim) {
      analysis.acceptedDeathTotals.set(victim.occurrencePlayerId, projectedVictim.deaths);
    }
    if (attacker && truth.creditsAttackerKill) {
      this.inferredStats(analysis, attacker.occurrencePlayerId).kills += 1;
      if (isValorantKillfeedLiveAttackerEvidence(kill)) {
        analysis.aliveByTeam[attacker.startTeam].add(attacker.occurrencePlayerId);
      }
    }
    if (truth.countsForAssistCredit) {
      for (const label of kill.assists) {
        const assist = this.resolvePlayer(analysis, label);
        if (!assist || assist.startTeam === victim.startTeam) continue;
        this.inferredStats(analysis, assist.occurrencePlayerId).assists += 1;
      }
    }
    this.refreshClutchSituations(analysis);
  }

  public observePlant(site?: string): void {
    const target = this.targetPending();
    const evidence = target?.spike ?? this.currentSpikeEvidence;
    evidence.plantObserved = true;
    if (site) evidence.plantSite = site;
  }

  public observeSpikeOutcome(outcome: SpikeTerminalOutcome): void {
    const target = this.targetPending();
    const evidence = target?.spike ?? this.currentSpikeEvidence;
    evidence.terminalOutcome = outcome;
  }

  public observeOcrHistory(history: IFormattedValorantOCRRoundHistory): void {
    for (const [roundText, item] of Object.entries(history)) {
      const roundNumber = Number(roundText);
      if (Number.isInteger(roundNumber) && roundNumber > 0) {
        this.observedHistory.set(roundNumber, item.winningReason);
      }
    }
  }

  public score(
    roundNumber: number,
    previous: IFormattedValorantScore,
    next: IFormattedValorantScore,
    players: readonly ValNativeCombatPlayer[],
  ): void {
    if (this.pending.has(roundNumber) || this.settledRounds.has(roundNumber)) return;
    const winnerStartTeam: NativeTeam | null =
      next.team_0 === previous.team_0 + 1 && next.team_1 === previous.team_1
        ? 0
        : next.team_1 === previous.team_1 + 1 && next.team_0 === previous.team_0
          ? 1
          : null;
    if (winnerStartTeam == null) return;
    const analysis = this.analyses.get(roundNumber) ?? emptyAnalysis(players);
    this.analyses.set(roundNumber, analysis);
    const attackerTeam = valorantAttackerForRound(roundNumber) === "team_0" ? 0 : 1;
    const pending: PendingSettlement = {
      analysis,
      boardAtScore: {
        aliveAttackers: analysis.aliveByTeam[attackerTeam].size,
        aliveDefenders: analysis.aliveByTeam[attackerTeam === 0 ? 1 : 0].size,
      },
      spike: { ...this.currentSpikeEvidence },
      roundNumber,
      scoreboardDeltas: new Map(),
      task: this.time.schedule(
        () => this.finalize(roundNumber),
        VALORANT_ROUND_SETTLEMENT_GRACE_MS,
      ),
      winnerStartTeam,
    };
    this.pending.set(roundNumber, pending);
    this.latestPendingRound = roundNumber;
    this.currentSpikeEvidence = emptySpikeEvidence();
  }

  public correctPendingWinner(roundNumber: number, winnerStartTeam: NativeTeam): boolean {
    const pending = this.pending.get(roundNumber);
    if (!pending) return false;
    pending.winnerStartTeam = winnerStartTeam;
    return true;
  }

  private finalize(roundNumber: number): void {
    const pending = this.pending.get(roundNumber);
    if (!pending) return;
    this.pending.delete(roundNumber);
    this.settledRounds.add(roundNumber);
    if (this.latestPendingRound === roundNumber) this.latestPendingRound = null;
    const board = this.reconcileLateEvidence(pending);
    const outcome = this.resolveRoundOutcome(pending, board);
    const winnerStartTeam = outcome.winnerStartTeam;
    // Attacker side for this round: observed spike-carrier parity first
    // (the carrier is always an attacker), hardcoded parity only as fallback.
    const attackerTeamForRound: NativeTeam = this.attackerTeamFor(roundNumber);
    const winningSide = winnerStartTeam === attackerTeamForRound ? "attack" : "defense";
    const enrichment = this.enrichment(
      pending.analysis,
      winnerStartTeam,
      winnerStartTeam === 0 ? 1 : 0,
    );
    this.settled({
      ...enrichment,
      ...(pending.spike.plantSite ? { plantSite: pending.spike.plantSite } : {}),
      roundNumber,
      winnerStartTeam,
      winningReason: outcome.winningReason,
      winningSide,
    });
  }

  private enrichment(
    analysis: RoundAnalysis,
    winningTeam: NativeTeam,
    losingTeam: NativeTeam,
  ): Pick<ValNativeRoundSettlement, "highlightOccurrencePlayerId" | "winType" | "winTypeLabel"> {
    const winners = [...analysis.players.values()].filter(
      (player) => player.startTeam === winningTeam,
    );
    const losers = [...analysis.players.values()].filter(
      (player) => player.startTeam === losingTeam,
    );
    const aliveWinners = winners.filter((player) =>
      analysis.aliveByTeam[winningTeam].has(player.occurrencePlayerId),
    );
    if (aliveWinners.length === 1) {
      const player = aliveWinners[0]!;
      const size = analysis.clutchSituations.get(player.occurrencePlayerId) ?? 0;
      if (size > 1) {
        return {
          highlightOccurrencePlayerId: player.occurrencePlayerId,
          winType: "Clutch",
          winTypeLabel: `1v${size}`,
        };
      }
    }
    const ace = winners.find(
      (player) => this.effectiveRoundKills(analysis, player.occurrencePlayerId) >= 5,
    );
    if (ace) {
      return {
        highlightOccurrencePlayerId: ace.occurrencePlayerId,
        winType: "Ace",
        winTypeLabel: "Ace",
      };
    }
    if (
      winners.length >= 5 &&
      winners.every((player) => this.effectiveRoundKills(analysis, player.occurrencePlayerId) >= 1)
    ) {
      return { highlightOccurrencePlayerId: null, winType: "Team Ace", winTypeLabel: "Team Ace" };
    }
    if (
      winners.length > 0 &&
      losers.length > 0 &&
      winners.every((player) => !analysis.diedPlayers.has(player.occurrencePlayerId))
    ) {
      return { highlightOccurrencePlayerId: null, winType: "Flawless", winTypeLabel: "Flawless" };
    }
    const average = (team: NativeTeam, count: number) =>
      [...analysis.loadouts[team].values()].reduce((sum, value) => sum + value, 0) /
      Math.max(1, count);
    // Both sides must be OBSERVED: with an empty winning team (solo-lobby
    // opponent rows never arrive) the winning average is 0 and any real loser
    // loadout >= 2000 produced a false "Thrifty" on EVERY opponent win
    // (live 2026-10-18 custom lobby).
    if (
      winners.length > 0 &&
      losers.length > 0 &&
      average(losingTeam, losers.length) - average(winningTeam, winners.length) >= 2_000
    ) {
      return { highlightOccurrencePlayerId: null, winType: "Thrifty", winTypeLabel: "Thrifty" };
    }
    return { highlightOccurrencePlayerId: null, winType: "Normal", winTypeLabel: "Round Win" };
  }

  /**
   * The START TEAM observed carrying the spike (the carrier is always on the
   * ATTACKING side) — per-round ground truth replacing the parity guess that
   * assumed team_0 starts attacking. That parity is lobby-dependent; when it
   * flips, timeout rounds misclassify as elimination (kills icon) and the
   * ATTACKER/DEFENDER win labels come out wrong (live 2026-10-18).
   */
  private observedAttackerStartTeam: NativeTeam | null = null;
  private observedCarrierRound = 0;
  /**
   * Records the spike carrier's start team + the round it was observed in.
   * Sides ALTERNATE every round, so the attacker side for any round in the
   * same half is derived from the observation's parity — covering defense
   * rounds where no carrier exists (solo lobbies: the enemy roster is empty).
   * A post-halftime carry refreshes the anchor automatically.
   */
  public setObservedAttackerStartTeam(team: NativeTeam, round: number): void {
    this.observedAttackerStartTeam = team;
    this.observedCarrierRound = round > 0 ? round : 0;
  }
  /** Attacker side of `round`: carrier-parity first, hardcoded parity fallback. */
  private attackerTeamFor(round: number): NativeTeam {
    if (this.observedAttackerStartTeam != null && this.observedCarrierRound > 0) {
      const sameParity = (((round - this.observedCarrierRound) % 2) + 2) % 2 === 0;
      return sameParity ? this.observedAttackerStartTeam : this.observedAttackerStartTeam === 0 ? 1 : 0;
    }
    return valorantAttackerForRound(round) === "team_0" ? 0 : 1;
  }

  private effectiveRoundKills(analysis: RoundAnalysis, playerId: string): number {
    const start = analysis.playerStartStats.get(playerId);
    const projected = this.projectedStats(analysis, playerId);
    return start && projected ? Math.max(0, projected.kills - start.kills) : 0;
  }

  private resolveRoundOutcome(
    pending: PendingSettlement,
    board: PendingSettlement["boardAtScore"],
  ): { winnerStartTeam: NativeTeam; winningReason: WinningReason } {
    const attackerStartTeam: NativeTeam = this.attackerTeamFor(pending.roundNumber);
    const terminalOutcome = pending.spike.terminalOutcome;

    // A terminal spike event owns both the winner and reason. Blast deaths and scoreboard timing
    // may enrich the settled round, but they cannot turn a detonation into an elimination.
    if (terminalOutcome === "detonated") {
      return { winnerStartTeam: attackerStartTeam, winningReason: "explosion" };
    }
    if (terminalOutcome === "defused") {
      return {
        winnerStartTeam: attackerStartTeam === 0 ? 1 : 0,
        winningReason: "defused",
      };
    }

    const winnerStartTeam = pending.winnerStartTeam;
    const winningSide = winnerStartTeam === attackerStartTeam ? "attack" : "defense";
    const scannerReason = this.observedHistory.get(pending.roundNumber);
    if (scannerReason) return { winnerStartTeam, winningReason: scannerReason };
    const planted = pending.spike.plantSite != null || pending.spike.plantObserved;
    if (!planted) {
      // A defense win with no plant can ONLY be the clock when NO attacker
      // rows were observed at all (solo/incomplete lobbies: aliveAttackers is
      // vacuously 0 because the opposing roster never arrived — every such
      // round was misclassified "elimination", showing the kills icon for
      // out-of-time wins; live 2026-10-18 custom lobby).
      const observedAttackers = [...pending.analysis.players.values()].filter(
        (player) => player.startTeam === attackerStartTeam,
      ).length;
      return {
        winnerStartTeam,
        winningReason:
          winningSide === "defense" && (board.aliveAttackers > 0 || observedAttackers === 0)
            ? "timeout"
            : "elimination",
      };
    }
    if (winningSide === "defense") return { winnerStartTeam, winningReason: "defused" };
    return {
      winnerStartTeam,
      winningReason: board.aliveDefenders === 0 ? "elimination" : "explosion",
    };
  }

  private reconcileLateEvidence(pending: PendingSettlement): PendingSettlement["boardAtScore"] {
    const analysis = pending.analysis;
    for (const [playerId, delta] of pending.scoreboardDeltas) {
      const player = analysis.players.get(playerId);
      if (!player) continue;
      const wasAliveAtScore = analysis.aliveByTeam[player.startTeam].has(playerId);
      const acceptedDeaths = analysis.acceptedDeathTotals.get(playerId) ?? player.deaths;
      const phoenixFalseWithoutDeath =
        player.agentName === "phoenix" && delta.deaths === 0 && player.deaths <= acceptedDeaths;
      const shouldApplyDeath =
        wasAliveAtScore &&
        (delta.deaths > 0 || delta.aliveToFalse) &&
        !phoenixFalseWithoutDeath &&
        this.isScoreboardCombatDeath(pending, player.startTeam);
      if (shouldApplyDeath) {
        analysis.diedPlayers.add(playerId);
        analysis.aliveByTeam[player.startTeam].delete(playerId);
        const projectedDeaths = this.projectedStats(analysis, playerId)?.deaths ?? player.deaths;
        analysis.acceptedDeathTotals.set(
          playerId,
          Math.max(acceptedDeaths, player.deaths, projectedDeaths),
        );
      } else if (delta.latestAliveState === true || delta.aliveToTrue) {
        this.applyPlayerAliveEvidence(analysis, player);
      }
    }
    this.refreshClutchSituations(analysis);
    const attackerTeam = valorantAttackerForRound(pending.roundNumber) === "team_0" ? 0 : 1;
    return {
      aliveAttackers: analysis.aliveByTeam[attackerTeam].size,
      aliveDefenders: analysis.aliveByTeam[attackerTeam === 0 ? 1 : 0].size,
    };
  }

  private isScoreboardCombatDeath(pending: PendingSettlement, playerTeam: NativeTeam): boolean {
    if (pending.spike.terminalOutcome !== "detonated") return true;
    const opposingTeam = playerTeam === 0 ? 1 : 0;
    return [...pending.scoreboardDeltas.entries()].some(([playerId, delta]) => {
      const player = pending.analysis.players.get(playerId);
      return player?.startTeam === opposingTeam && delta.kills > 0;
    });
  }

  private refreshClutchSituations(analysis: RoundAnalysis): void {
    for (const team of [0, 1] as const) {
      const alive = analysis.aliveByTeam[team];
      const enemies = analysis.aliveByTeam[team === 0 ? 1 : 0];
      if (alive.size !== 1 || enemies.size <= 1) continue;
      const playerId = [...alive][0]!;
      analysis.clutchSituations.set(
        playerId,
        Math.max(analysis.clutchSituations.get(playerId) ?? 0, enemies.size),
      );
    }
  }

  private resolvePlayer(analysis: RoundAnalysis, label: string): ValNativeCombatPlayer | undefined {
    const normalized = normalizeLabel(label);
    const matches = [...analysis.players.values()].filter((player) =>
      player.observedLabels.some((candidate) => normalizeLabel(candidate) === normalized),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  private applyPlayerLife(analysis: RoundAnalysis, player: ValNativeCombatPlayer): void {
    if (player.isAlive) {
      this.applyPlayerAliveEvidence(analysis, player);
      return;
    }

    const playerId = player.occurrencePlayerId;
    const acceptedDeaths = analysis.acceptedDeathTotals.get(playerId) ?? player.deaths;
    if (player.deaths < acceptedDeaths) return;
    if (player.agentName === "phoenix" && player.deaths === acceptedDeaths) return;

    analysis.acceptedDeathTotals.set(playerId, player.deaths);
    analysis.aliveByTeam[player.startTeam].delete(playerId);
    analysis.diedPlayers.add(playerId);
  }

  private applyPlayerAliveEvidence(analysis: RoundAnalysis, player: ValNativeCombatPlayer): void {
    const acceptedDeaths =
      analysis.acceptedDeathTotals.get(player.occurrencePlayerId) ?? player.deaths;
    if (player.deaths < acceptedDeaths) return;
    analysis.aliveByTeam[player.startTeam].add(player.occurrencePlayerId);
  }

  private targetPending(): PendingSettlement | undefined {
    if (this.latestPendingRound != null) return this.pending.get(this.latestPendingRound);
    return this.currentRoundNumber == null ? undefined : this.pending.get(this.currentRoundNumber);
  }

  private inferredStats(analysis: RoundAnalysis, playerId: string): PlayerStats {
    const inferred = analysis.inferredStats.get(playerId) ?? { assists: 0, deaths: 0, kills: 0 };
    analysis.inferredStats.set(playerId, inferred);
    return inferred;
  }

  private projectedStats(analysis: RoundAnalysis, playerId: string): PlayerStats | undefined {
    const latest = analysis.players.get(playerId);
    const start = analysis.playerStartStats.get(playerId);
    if (!latest || !start) return undefined;
    const inferred = analysis.inferredStats.get(playerId) ?? { assists: 0, deaths: 0, kills: 0 };
    return {
      assists: Math.max(latest.assists, start.assists + inferred.assists),
      deaths: Math.max(latest.deaths, start.deaths + inferred.deaths),
      kills: Math.max(latest.kills, start.kills + inferred.kills),
    };
  }
}

function emptyAnalysis(players: readonly ValNativeCombatPlayer[]): RoundAnalysis {
  const analysis: RoundAnalysis = {
    acceptedDeathTotals: new Map(),
    aliveByTeam: { 0: new Set(), 1: new Set() },
    clutchSituations: new Map(),
    diedPlayers: new Set(),
    inferredStats: new Map(),
    loadouts: { 0: new Map(), 1: new Map() },
    players: new Map(),
    playerStartStats: new Map(),
  };
  for (const player of players) {
    analysis.acceptedDeathTotals.set(player.occurrencePlayerId, player.deaths);
    analysis.players.set(player.occurrencePlayerId, structuredClone(player));
    analysis.playerStartStats.set(player.occurrencePlayerId, stats(player));
    analysis.loadouts[player.startTeam].set(
      player.occurrencePlayerId,
      Math.max(0, player.loadoutValue ?? 0),
    );
    if (player.isAlive) analysis.aliveByTeam[player.startTeam].add(player.occurrencePlayerId);
    else analysis.diedPlayers.add(player.occurrencePlayerId);
  }
  return analysis;
}

function emptyDelta(): ScoreboardDelta {
  return {
    aliveToFalse: false,
    aliveToTrue: false,
    assists: 0,
    deaths: 0,
    kills: 0,
    latestAliveState: null,
  };
}

function emptySpikeEvidence(): RoundSpikeEvidence {
  return { plantObserved: false };
}

function stats(player: PlayerStats): PlayerStats {
  return { assists: player.assists, deaths: player.deaths, kills: player.kills };
}

function uniqueLabels(left: readonly string[], right: readonly string[]): readonly string[] {
  return [...new Set([...left, ...right].map((value) => value.trim()).filter(Boolean))];
}

function normalizeLabel(value: string): string {
  return value.replace(/\s+#/g, "#").trim().toLowerCase();
}
