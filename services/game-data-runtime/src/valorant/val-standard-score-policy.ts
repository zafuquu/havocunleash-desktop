import type { IFormattedValorantScore } from "./valorant-api";

export type StandardScoreDecision =
  | "confirmed"
  | "corrected"
  | "presence_confirmed"
  | "resynchronized"
  | "settled"
  | "stale"
  | "team_regression";

export interface StandardScorePlan {
  apply: boolean;
  decision: StandardScoreDecision;
  settle: boolean;
}

export interface StandardScorePolicyInput {
  currentRoundNumber: number | null;
  next: IFormattedValorantScore;
  presenceConfirmedRound: number;
  previous: IFormattedValorantScore;
  role: "presence" | "primary";
}

/**
 * Classifies one score observation against the round progression we actually observed.
 * A one-point delta settles only the current round (or the immediately preceding round
 * when packets arrive out of order). Other forward movement updates current truth without
 * inventing round history for rounds that predate this projection session.
 */
export function planValorantStandardScore({
  currentRoundNumber,
  next,
  presenceConfirmedRound,
  previous,
  role,
}: StandardScorePolicyInput): StandardScorePlan {
  const previousTotal = valorantScoreTotal(previous);
  const nextTotal = valorantScoreTotal(next);
  if (next.team_0 === previous.team_0 && next.team_1 === previous.team_1) {
    return { apply: false, decision: "confirmed", settle: false };
  }
  if (nextTotal < previousTotal) return { apply: false, decision: "stale", settle: false };
  if (nextTotal === previousTotal) {
    // Presence may repair round ownership. A replayed primary tuple cannot
    // reverse that correction at or behind its confirmed round.
    if (role === "primary" && nextTotal <= presenceConfirmedRound) {
      return { apply: false, decision: "presence_confirmed", settle: false };
    }
    return { apply: true, decision: "corrected", settle: false };
  }
  const team0Increase = next.team_0 - previous.team_0;
  const team1Increase = next.team_1 - previous.team_1;
  if (team0Increase < 0 || team1Increase < 0) {
    return { apply: false, decision: "team_regression", settle: false };
  }
  const settlesOneRound =
    (team0Increase === 1 && team1Increase === 0) || (team0Increase === 0 && team1Increase === 1);
  const scoreRoundIsObserved =
    currentRoundNumber !== null &&
    (nextTotal === currentRoundNumber || nextTotal === currentRoundNumber - 1);
  return settlesOneRound && scoreRoundIsObserved
    ? { apply: true, decision: "settled", settle: true }
    : { apply: true, decision: "resynchronized", settle: false };
}

export function valorantScoreTotal(score: IFormattedValorantScore): number {
  return score.team_0 + score.team_1;
}
