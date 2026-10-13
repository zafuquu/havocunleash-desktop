/** VALORANT startTeam is stable; attack/defense swaps after round twelve. */
export function valorantAttackerForRound(roundNumber: number): "team_0" | "team_1" {
  if (roundNumber > 24) return roundNumber % 2 === 1 ? "team_0" : "team_1";
  return roundNumber <= 12 ? "team_0" : "team_1";
}
