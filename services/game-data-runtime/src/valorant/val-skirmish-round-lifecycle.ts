import type { IFormattedValorantScore } from "./valorant-api";

type SkirmishRoundPhase = "combat" | "end";
type SkirmishWinner = "team_0" | "team_1";

export type ValSkirmishScoreTransition =
  | { kind: "ignore" }
  | { kind: "resync"; score: IFormattedValorantScore }
  | {
      kind: "round-win";
      roundNumber: number;
      score: IFormattedValorantScore;
      winner: SkirmishWinner;
    };

export function classifyValSkirmishScoreTransition(input: {
  observed: IFormattedValorantScore;
  phase: SkirmishRoundPhase;
  previous: IFormattedValorantScore;
}): ValSkirmishScoreTransition {
  const team0Delta = input.observed.team_0 - input.previous.team_0;
  const team1Delta = input.observed.team_1 - input.previous.team_1;

  if (team0Delta === 0 && team1Delta === 0) return { kind: "ignore" };
  if (team0Delta < 0 || team1Delta < 0) return { kind: "ignore" };

  const exactlyOneRound =
    input.phase === "combat" &&
    ((team0Delta === 1 && team1Delta === 0) || (team0Delta === 0 && team1Delta === 1));

  if (!exactlyOneRound) return { kind: "resync", score: input.observed };

  return {
    kind: "round-win",
    roundNumber: input.observed.team_0 + input.observed.team_1,
    score: input.observed,
    winner: team0Delta === 1 ? "team_0" : "team_1",
  };
}
