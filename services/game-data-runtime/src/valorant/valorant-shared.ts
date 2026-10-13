import type { ValorantMapKey } from "./game-identity";
import { z } from "zod";

import type {
  IFormattedValorantKillfeed,
  IFormattedValorantPlayer,
  IFormattedValorantRoundInfo,
  IFormattedValorantScore,
} from "./valorant-api";
import type {
  IFormattedValorantOCRPlayersScoreline,
  IFormattedValorantOCRRoundInfoScoreboard,
  IFormattedValorantOCRRoundPhase,
  IFormattedValorantOCRScore,
  IFormattedValorantOCRScoreboardPlayer,
} from "./valorant-ocr";

export const valorantGameModeSchema = z.enum(["skirmish", "standard"]);
export type ValorantGameMode = z.output<typeof valorantGameModeSchema>;

export function resolveValorantGameMode(modeId: null | string): ValorantGameMode {
  const normalizedModeId = modeId?.trim().toLowerCase();

  return normalizedModeId === "skirmish" ||
    normalizedModeId?.includes("/gamemodes/skirmish/") === true
    ? "skirmish"
    : "standard";
}

export enum EValorantRoundPhase {
  Combat = "combat",
  End = "end",
  GameEnd = "game_end",
  Shopping = "shopping",
}

export const VALORANT_PRE_SHOPPING_ROUND_PHASE = "game_start";

export type ValorantActiveRoundPhase = `${EValorantRoundPhase}`;

export type ValorantObserverSlot = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type ValorantObserverSlotOrder = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type ValorantRawRoundPhase =
  | null
  | typeof VALORANT_PRE_SHOPPING_ROUND_PHASE
  | ValorantActiveRoundPhase;

const VALORANT_ACTIVE_ROUND_PHASE_BY_VALUE = {
  [EValorantRoundPhase.Combat]: EValorantRoundPhase.Combat,
  [EValorantRoundPhase.End]: EValorantRoundPhase.End,
  [EValorantRoundPhase.GameEnd]: EValorantRoundPhase.GameEnd,
  [EValorantRoundPhase.Shopping]: EValorantRoundPhase.Shopping,
} as const satisfies Record<ValorantActiveRoundPhase, EValorantRoundPhase>;

const isValorantActiveRoundPhaseValue = (phase: unknown): phase is ValorantActiveRoundPhase =>
  typeof phase === "string" && Object.hasOwn(VALORANT_ACTIVE_ROUND_PHASE_BY_VALUE, phase);

export const isValorantActiveRoundPhase = (
  phase: ValorantRawRoundPhase,
): phase is EValorantRoundPhase => isValorantActiveRoundPhaseValue(phase);

export const normalizeValorantRawRoundPhase = (phase: unknown): ValorantRawRoundPhase => {
  if (isValorantActiveRoundPhaseValue(phase)) {
    return VALORANT_ACTIVE_ROUND_PHASE_BY_VALUE[phase];
  }

  switch (phase) {
    case null:
      return null;
    case VALORANT_PRE_SHOPPING_ROUND_PHASE:
      return VALORANT_PRE_SHOPPING_ROUND_PHASE;
    default:
      console.warn(
        `[VAL Formatting] Unexpected roundPhase value "${String(phase)}"; normalizing to null.`,
      );
      return null;
  }
};

export const normalizeValorantTeamIdentity = (team: unknown): 0 | 1 => {
  switch (team) {
    case 0:
    case "0":
      return 0;
    case 1:
    case "1":
      return 1;
    default:
      console.warn(
        `[VAL Formatting] Unexpected startTeam value "${String(team)}"; defaulting to 0.`,
      );
      return 0;
  }
};

/**
 * Desktop VALORANT gameplay-ingress event names. `OCR_*` members are
 * screen-reading packets; raw OW provider keys and public overlay event names
 * are separate contracts.
 */
export enum ValorantDataTypes {
  KILLFEED = "val:killfeed",

  OBSERVING = "val:observing",

  OCR_HEALTHS = "val:ocr_healths",

  OCR_PHASE = "val:ocr_phase",
  OCR_ROUND_INFO = "val:ocr_round_info",

  OCR_SCORE = "val:ocr_score",
  OCR_SCOREBOARD = "val:ocr_scoreboard",
  PLAYER_SCOREBOARD = "val:scoreboard",

  ROUND_INFO = "val:round_info",
  SCORE = "val:score",
  SPIKE_DEFUSED = "val:spike_defused",
  SPIKE_DETONATED = "val:spike_detonated",
  SPIKE_PLANTED = "val:spike_planted",
}

export enum ValorantSides {
  ATTACK = "attack",
  DEFENSE = "defense",
}
export interface IFormattedValorantData {
  data:
    | boolean
    | IFormattedValorantKillfeed
    | IFormattedValorantOCRPlayersScoreline
    | IFormattedValorantOCRRoundInfoScoreboard
    | IFormattedValorantOCRRoundPhase
    | IFormattedValorantOCRScore
    | IFormattedValorantOCRScoreboardPlayer
    | IFormattedValorantOCRScoreboardPlayer[]
    | IFormattedValorantPlayer
    | IFormattedValorantRoundInfo
    | IFormattedValorantScore
    | number
    | string;
  event: ValorantDataTypes;
}

export type TFullValorantGameStateData = {
  currentlyObserving: string;
  currentRound: IFormattedValorantRoundInfo;
  map: "" | ValorantMapKey;
  players: {
    [key: string]: IFormattedValorantPlayer;
  };
  score: IFormattedValorantScore;
};

export type ValorantRoundWinType =
  | "Ace"
  | "Clutch"
  | "Flawless"
  | "Normal"
  | "Team Ace"
  | "Thrifty";
