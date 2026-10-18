/**
 * ValRoundEngine — drives the ported original round-state engine
 * (settlement, history, score policy, side ownership, round clock) from the
 * runtime's fact stream. Produces the authoritative per-round overlay state:
 * winner, winning side, win type/label, round clock, score-attributed history.
 */
import { ValRoundClock, type ValProjectionTime } from "./valorant/val-round-clock";
import { ValRoundHistory } from "./valorant/val-round-history";
import {
  ValRoundSettlement,
  type ValNativeCombatPlayer,
  ValNativeRoundSettlement,
} from "./valorant/val-round-settlement";
import { planValorantStandardScore } from "./valorant/val-standard-score-policy";
import { valorantAttackerForRound } from "./valorant/val-side-ownership";
import type { IFormattedValorantKillfeed } from "./valorant/valorant-api";
import type { ValorantRawRoundPhase } from "./valorant/valorant-shared";

export type { ValNativeRoundSettlement };

/** Display-only durations (standard VALORANT timers). */
const ROUND_DURATION_SECONDS: Record<string, number> = {
  shopping: 30,
  combat: 100,
  end: 7,
};

interface EnginePlayer {
  playerId: string;
  name: string;
  agent: string | null;
  team: number | null;
  kills: number;
  deaths: number;
  assists: number;
  isAlive: boolean;
  credits: number | null;
}

function combatPlayer(p: EnginePlayer): ValNativeCombatPlayer {
  const startTeam: 0 | 1 = p.team === 1 ? 1 : 0;
  const normalized = (p.name || p.playerId).replace(/\s+#/g, "#").trim().toLowerCase();
  return {
    agentName: (p.agent ?? "").toLowerCase(),
    assists: p.assists,
    deaths: p.deaths,
    isAlive: p.isAlive ?? true,
    kills: p.kills,
    loadoutValue: p.credits ?? 0,
    observedLabels: normalized ? [normalized] : [],
    occurrencePlayerId: p.playerId,
    startTeam,
  };
}

const projectionTime: ValProjectionTime = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const t = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(t) };
  },
};

export interface ValRoundEngineSnapshot {
  roundNumber: number;
  roundPhase: string | null;
  score: { team_0: number; team_1: number };
  roundClockSeconds: number;
  attackForRound: "team_0" | "team_1";
  rounds: Array<{
    roundNumber: number;
    winnerStartTeam: 0 | 1;
    winningSide: "attack" | "defense";
    winningReason: string;
    provenance: string;
  }>;
}

export class ValRoundEngine {
  private readonly clock: ValRoundClock;
  private readonly history = new ValRoundHistory();
  private readonly settlement: ValRoundSettlement;
  private roundNumber = 0;
  private roundPhase: string | null = null;
  private previousScore: { team_0: number; team_1: number } = { team_0: 0, team_1: 0 };
  private score: { team_0: number; team_1: number } = { team_0: 0, team_1: 0 };
  private players = new Map<string, EnginePlayer>();
  private lastClockSeconds = 0;

  public constructor(private readonly onSettled?: (result: ValNativeRoundSettlement) => void) {
    this.clock = new ValRoundClock(projectionTime, (seconds) => {
      this.lastClockSeconds = seconds;
    });
    this.settlement = new ValRoundSettlement(projectionTime, (result) => {
      this.history.recordObserved(result);
      this.onSettled?.(result);
    });
  }

  public reset(): void {
    this.roundNumber = 0;
    this.roundPhase = null;
    this.previousScore = { team_0: 0, team_1: 0 };
    this.score = { team_0: 0, team_1: 0 };
    this.players.clear();
    this.history.reset();
    this.settlement.reset();
    this.clock.stop();
  }

  public onRoundNumber(roundNumber: number): void {
    if (!Number.isFinite(roundNumber) || roundNumber <= 0) return;
    const next = Math.floor(roundNumber);
    if (next === this.roundNumber) return;
    this.roundNumber = next;
    this.settlement.beginRound(next, this.combatPlayers());
  }

  public onRoundPhase(phase: string): void {
    this.roundPhase = phase;
    const duration = ROUND_DURATION_SECONDS[phase];
    if (duration) this.clock.start(duration, phase as ValorantRawRoundPhase);
  }

  public onScoreboard(
    players: Array<{
      player_id: string;
      name: string;
      agent: string | null;
      team: number | null;
      kills: number | null;
      deaths: number | null;
      assists: number | null;
      alive: boolean | null;
      credits: number | null;
      spike?: boolean | null;
    }>,
  ): void {
    for (const p of players) {
      if (!p.player_id && !p.name) continue;
      const key = p.player_id || p.name;
      // Spike carrier = the ATTACKING side for this round (absolute truth —
      // only attackers carry the spike). Round number included so the
      // settlement can derive the attacker side on PARITY-OPPOSITE rounds
      // too (sides alternate each round; solo lobbies never observe the
      // enemy carrying), live 2026-10-18.
      if (p.spike === true && (p.team === 0 || p.team === 1) && this.roundNumber > 0) {
        this.settlement.setObservedAttackerStartTeam(p.team, this.roundNumber);
      }
      const prev = this.players.get(key);
      const next: EnginePlayer = {
        playerId: p.player_id || p.name,
        name: p.name,
        agent: p.agent ?? prev?.agent ?? null,
        team: p.team ?? prev?.team ?? null,
        kills: p.kills ?? prev?.kills ?? 0,
        deaths: p.deaths ?? prev?.deaths ?? 0,
        assists: p.assists ?? prev?.assists ?? 0,
        isAlive: p.alive ?? prev?.isAlive ?? true,
        credits: p.credits ?? prev?.credits ?? null,
      };
      this.players.set(key, next);
      const combat = combatPlayer(next);
      const prevCombat = prev ? combatPlayer(prev) : undefined;
      this.settlement.observeScoreboardDelta(this.roundNumber, prevCombat, combat);
    }
  }

  public onScore(score: { team_0: number; team_1: number }): void {
    const next = { team_0: score.team_0, team_1: score.team_1 };
    const plan = planValorantStandardScore({
      currentRoundNumber: this.roundNumber > 0 ? this.roundNumber : null,
      next,
      presenceConfirmedRound: this.roundNumber,
      previous: this.score,
      role: "primary",
    });
    if (!plan.apply) return;
    this.previousScore = { ...this.score };
    this.score = next;
    this.history.acceptScore(next);
    if (plan.settle) {
      this.settlement.score(this.roundNumber, this.previousScore, next, this.combatPlayers());
    }
  }

  public onKillfeed(kill: IFormattedValorantKillfeed): void {
    this.settlement.observeKillfeed(this.roundNumber, kill);
  }

  public onSpikePlanted(site?: string): void {
    this.settlement.observePlant(site);
  }

  public onSpikeOutcome(outcome: "defused" | "detonated"): void {
    this.settlement.observeSpikeOutcome(outcome);
  }

  public onRoundClockPause(snapbackSeconds = 0): void {
    this.clock.pause(snapbackSeconds);
  }

  public onRoundClockResume(): void {
    this.clock.resume();
  }

  private combatPlayers(): ValNativeCombatPlayer[] {
    return [...this.players.values()].map(combatPlayer);
  }

  public snapshot(): ValRoundEngineSnapshot {
    const rounds = [...this.history.entries().entries()]
      .sort(([a], [b]) => a - b)
      .map(([roundNumber, entry]) => ({
        roundNumber,
        winnerStartTeam: entry.winnerStartTeam,
        winningSide: entry.winningSide,
        winningReason: entry.winningReason,
        provenance: entry.provenance,
      }));
    return {
      roundNumber: this.roundNumber,
      roundPhase: this.roundPhase,
      score: { ...this.score },
      roundClockSeconds: this.lastClockSeconds,
      attackForRound: valorantAttackerForRound(Math.max(1, this.roundNumber)),
      rounds,
    };
  }
}
