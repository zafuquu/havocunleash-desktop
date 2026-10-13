import type { IFormattedValorantScore } from "./valorant-api";

import type { ValNativeRoundSettlement } from "./val-round-settlement";
import { valorantAttackerForRound } from "./val-side-ownership";
import { valorantScoreTotal } from "./val-standard-score-policy";

type NativeTeam = 0 | 1;
export const MAX_VALORANT_ROUND_HISTORY_ENTRIES = 256;
type ObservedRound = Omit<ValNativeRoundSettlement, "roundNumber"> & {
  provenance: "observed";
};
type InferredRound = {
  provenance: "score-inferred";
  winnerStartTeam: NativeTeam;
  winningReason: "elimination";
  winningSide: "attack" | "defense";
};

export type ValNativeRoundHistoryEntry = ObservedRound | InferredRound;

/**
 * Owns deterministic presentation backfill from score checkpoints. Synthetic rounds always retain
 * their score-inferred provenance and never emit events. A score has no round chronology, so
 * inferred wins use stable team blocks rather than fabricating an alternating narrative; exact
 * native settlement remains the only round-win event source.
 */
export class ValRoundHistory {
  readonly #entries = new Map<number, ValNativeRoundHistoryEntry>();
  #scoreCheckpoint: IFormattedValorantScore | null = null;

  public acceptScore(next: IFormattedValorantScore): void {
    const previous = this.#scoreCheckpoint;
    const nextTotal = valorantScoreTotal(next);
    if (!Number.isSafeInteger(nextTotal)) {
      this.#scoreCheckpoint = { ...next };
      return;
    }
    if (!previous) {
      this.#backfillThrough(next);
      this.#scoreCheckpoint = { ...next };
      return;
    }

    const previousTotal = valorantScoreTotal(previous);
    if (!Number.isSafeInteger(previousTotal)) {
      this.#backfillThrough(next);
      this.#scoreCheckpoint = { ...next };
      return;
    }
    if (nextTotal === previousTotal) {
      this.#reconcileInferredWinners(next);
      this.#scoreCheckpoint = { ...next };
      return;
    }
    if (nextTotal < previousTotal) return;

    const team0Delta = next.team_0 - previous.team_0;
    const team1Delta = next.team_1 - previous.team_1;
    const firstRetainedRound = Math.max(
      previousTotal + 1,
      nextTotal - MAX_VALORANT_ROUND_HISTORY_ENTRIES + 1,
    );
    this.#fillInferredSpan({
      firstRound: firstRetainedRound,
      lastRound: nextTotal,
      team0Wins: team0Delta,
      team1Wins: team1Delta,
    });
    this.#trimToCapacity();
    this.#scoreCheckpoint = { ...next };
  }

  public correctObservedWinner(roundNumber: number, winnerStartTeam: NativeTeam): void {
    const retained = this.#entries.get(roundNumber);
    if (retained?.provenance !== "observed") return;
    this.#entries.set(roundNumber, {
      ...retained,
      winnerStartTeam,
      winningSide:
        valorantAttackerForRound(roundNumber) === `team_${winnerStartTeam}` ? "attack" : "defense",
    });
  }

  public entries(): ReadonlyMap<number, ValNativeRoundHistoryEntry> {
    return new Map(this.#entries);
  }

  public recordObserved(result: ValNativeRoundSettlement): void {
    const { roundNumber, ...round } = result;
    this.#entries.set(roundNumber, { ...round, provenance: "observed" });
    if (this.#scoreCheckpoint && roundNumber <= valorantScoreTotal(this.#scoreCheckpoint)) {
      this.#reconcileInferredWinners(this.#scoreCheckpoint);
    }
    this.#trimToCapacity();
  }

  public reset(): void {
    this.#entries.clear();
    this.#scoreCheckpoint = null;
  }

  #backfillThrough(score: IFormattedValorantScore): void {
    const total = valorantScoreTotal(score);
    const firstRetainedRound = Math.max(1, total - MAX_VALORANT_ROUND_HISTORY_ENTRIES + 1);
    this.#fillInferredSpan({
      firstRound: firstRetainedRound,
      lastRound: total,
      team0Wins: score.team_0,
      team1Wins: score.team_1,
    });
    this.#reconcileInferredWinners(score);
    this.#trimToCapacity();
  }

  #fillInferredSpan({
    firstRound,
    lastRound,
    team0Wins,
    team1Wins,
  }: {
    firstRound: number;
    lastRound: number;
    team0Wins: number;
    team1Wins: number;
  }): void {
    if (team0Wins < 0 || team1Wins < 0) return;
    let remainingTeam0 = team0Wins;
    let remainingTeam1 = team1Wins;
    for (let roundNumber = firstRound; roundNumber <= lastRound; roundNumber += 1) {
      const existing = this.#entries.get(roundNumber);
      if (existing?.provenance !== "observed") continue;
      if (existing.winnerStartTeam === 0) remainingTeam0 -= 1;
      else remainingTeam1 -= 1;
    }
    if (remainingTeam0 < 0 || remainingTeam1 < 0) return;
    for (let roundNumber = firstRound; roundNumber <= lastRound; roundNumber += 1) {
      if (this.#entries.get(roundNumber)?.provenance === "observed") continue;
      if (remainingTeam0 === 0 && remainingTeam1 === 0) return;
      const winnerStartTeam: NativeTeam = remainingTeam0 > 0 ? 0 : 1;
      if (winnerStartTeam === 0) remainingTeam0 -= 1;
      else remainingTeam1 -= 1;
      this.#entries.set(roundNumber, this.#inferredEntry(roundNumber, winnerStartTeam));
    }
  }

  #reconcileInferredWinners(score: IFormattedValorantScore): void {
    const total = valorantScoreTotal(score);
    if (!Number.isSafeInteger(total)) return;
    const inferred = [...this.#entries.entries()]
      .filter(
        ([roundNumber, entry]) => roundNumber <= total && entry.provenance === "score-inferred",
      )
      .sort(([left], [right]) => left - right);
    const observedTeam0 = [...this.#entries.entries()].filter(
      ([roundNumber, entry]) =>
        roundNumber <= total && entry.provenance === "observed" && entry.winnerStartTeam === 0,
    ).length;
    const targetInferredTeam0 = score.team_0 - observedTeam0;
    if (targetInferredTeam0 < 0 || targetInferredTeam0 > inferred.length) return;
    for (const [index, [roundNumber, entry]] of inferred.entries()) {
      const replacementWinner: NativeTeam = index < targetInferredTeam0 ? 0 : 1;
      if (entry.winnerStartTeam === replacementWinner) continue;
      this.#entries.set(roundNumber, this.#inferredEntry(roundNumber, replacementWinner));
    }
  }

  #inferredEntry(roundNumber: number, winnerStartTeam: NativeTeam): InferredRound {
    return {
      provenance: "score-inferred",
      winnerStartTeam,
      winningReason: "elimination",
      winningSide:
        valorantAttackerForRound(roundNumber) === `team_${winnerStartTeam}` ? "attack" : "defense",
    };
  }

  #trimToCapacity(): void {
    while (this.#entries.size > MAX_VALORANT_ROUND_HISTORY_ENTRIES) {
      const oldestRound = this.#entries.keys().next().value;
      if (oldestRound === undefined) return;
      this.#entries.delete(oldestRound);
    }
  }
}
