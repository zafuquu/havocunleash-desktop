/**
 * OCR-derived Valorant observation shapes (screen-reading pipeline).
 * Field shapes recovered from the original's type guards in
 * val-observation-normalizer.ts — every field verified against its guard.
 */

export interface IFormattedValorantOCRScoreboardPlayer {
  agentName: string;
  playerId: string;
  startTeam: 0 | 1;
  tagline: string;
  assists?: number;
  currUltPoints?: number | "READY";
  deaths?: number;
  hasSpike?: boolean;
  isAlive?: boolean;
  kills?: number;
  loadoutValue?: number;
  money?: number;
  name?: string;
  observerSlot?: number;
  observerSlotOrder?: number;
  shieldType?: number;
  weaponName?: string;
}

/** Per-team health scoreline: { "0": { [playerId]: { health } }, "1": {...} } */
export interface IFormattedValorantOCRPlayersScoreline {
  "0"?: Record<string, { health: number }>;
  "1"?: Record<string, { health: number }>;
}

export interface IFormattedValorantOCRScore {
  team_0_score: number;
  team_1_score: number;
}

export type IFormattedValorantOCRRoundHistoryItem = {
  team: "team_0" | "team_1";
  winningReason: "defused" | "elimination" | "explosion" | "timeout";
};

export interface IFormattedValorantOCRRoundHistory {
  [roundNumber: string]: IFormattedValorantOCRRoundHistoryItem;
}

export interface IFormattedValorantOCRRoundInfoScoreboard {
  currentRound: number;
  roundHistory: IFormattedValorantOCRRoundHistory;
}

export interface IFormattedValorantOCRRoundPhase {
  phase?: "combat" | "end" | "shopping";
  isSpikePlanted?: boolean;
}
