import { normalizeValorantAgentKey, type ValorantAgentKey } from "./game-identity";

import type { ValorantKillfeedUltValue, ValorantKillfeedWeaponValue } from "./valorant-killfeed";
import { VALORANT_SHIELD_PRICES, VALORANT_WEAPON_PRICES } from "./valorant-prices";
import type { ValorantRankKey } from "./valorant-ranks";
import {
  type IFormattedValorantData,
  normalizeValorantRawRoundPhase,
  normalizeValorantTeamIdentity,
  ValorantDataTypes,
  type ValorantObserverSlot,
  type ValorantObserverSlotOrder,
  type ValorantRawRoundPhase,
} from "./valorant-shared";
import { normalizeValorantWeaponIdentity, type ValorantWeaponInternal } from "./valorant-weapons";

const normalizeFallbackValorantId = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

export interface IFormattedValorantKillfeed {
  assists: string[];
  attacker: string;
  headshotKill: boolean;
  isTeamkill: boolean;
  ultName?: ValorantKillfeedUltValue;
  victim: string;
  weaponName: ValorantKillfeedWeaponValue;
}

export interface IFormattedValorantPlayer {
  /**
   * Internal agent name (e.g., "phoenix", "wushu").
   */
  agentName: ValorantAgentKey;
  assists: number;
  currUltPoints: number;

  deaths: number;

  hasSpike: boolean;
  isAlive: boolean;

  isLocalPlayer?: boolean;

  isTeammate?: boolean;
  kills: number;
  loadoutValue?: number;
  maxUltPoints: number;
  money: number;
  name: string;
  observerSlot?: ValorantObserverSlot;

  observerSlotOrder?: ValorantObserverSlotOrder;

  playerId: string;
  /**
   * Shield type:
   * - 0 = no shield
   * - 1 = light shield (25)
   * - 2 = heavy shield (50)
   * - 3 = enemy shield (unknown type)
   * - 4 = regen shield (25)
   */
  shieldType?: 0 | 1 | 2 | 3 | 4;
  /**
   * 0 for team that starts on attack, 1 for team that starts on defense.
   * The team IDs remain consistent even after sides switch.
   */
  startTeam: 0 | 1;
  tagline: string;

  weaponName: ValorantWeaponInternal;
}

export interface IFormattedValorantRosterPlayer {
  agentName: "" | ValorantAgentKey;
  locked: boolean;

  name: string;
  observerSlot?: ValorantObserverSlot;
  observerSlotOrder?: ValorantObserverSlotOrder;
  playerId: string;
  position: number;
  rank: ValorantRankKey;
  startTeam: 0 | 1;

  tagline: string;
}

export interface IFormattedValorantRoundInfo {
  roundNumber: number;
  roundPhase: ValorantRawRoundPhase;
}

export interface IFormattedValorantScore {
  team_0: number;
  team_1: number;
}

export class FormattingService {
  private static instance: FormattingService;

  private constructor() {}

  public static getInstance(): FormattingService {
    if (FormattingService.instance == null) FormattingService.instance = new FormattingService();
    return FormattingService.instance;
  }

  public formatKillfeedData(data: any): IFormattedValorantData {
    const assists: string[] = [];
    if (typeof data.assist1 === "string" && data.assist1 !== "") {
      assists.push(data.assist1);
    }
    if (typeof data.assist2 === "string" && data.assist2 !== "") {
      assists.push(data.assist2);
    }
    if (typeof data.assist3 === "string" && data.assist3 !== "") {
      assists.push(data.assist3);
    }
    if (typeof data.assist4 === "string" && data.assist4 !== "") {
      assists.push(data.assist4);
    }

    const formatted: IFormattedValorantKillfeed = {
      assists: assists,
      attacker: typeof data.attacker === "string" ? data.attacker : "",
      headshotKill: data.headshot === true,
      isTeamkill: data.is_victim_teammate === true,
      ultName: typeof data.ult === "string" && data.ult !== "" ? data.ult : undefined,
      victim: typeof data.victim === "string" ? data.victim : "",
      weaponName: this.formatWeaponIdentity(data.weapon),
    };

    return {
      data: formatted,
      event: ValorantDataTypes.KILLFEED,
    };
  }

  public formatRoundData(data: any, roundNum: number): IFormattedValorantData {
    const formatted: IFormattedValorantRoundInfo = {
      roundNumber: roundNum,
      roundPhase: normalizeValorantRawRoundPhase(data),
    };

    return {
      data: formatted,
      event: ValorantDataTypes.ROUND_INFO,
    };
  }

  public formatScoreboardData(data: any): IFormattedValorantData {
    const nameSplit = data.name.split(" #");

    let hasSpike = data.spike;
    if (typeof hasSpike !== "boolean") {
      hasSpike = data.spike === "TX_Hud_Bomb_S";
    }

    let armorNum: 0 | 1 | 2 | 3 | 4 = 0;
    if (data.armor != undefined) {
      armorNum = data.armor;
    } else {
      armorNum = data.shield;
    }

    const shieldType = [0, 1, 2, 3, 4].includes(armorNum) ? armorNum : 0;

    const weaponName = this.formatWeaponIdentity(data.weapon);
    const weaponValue = VALORANT_WEAPON_PRICES[weaponName] || 0;
    const armorValue = VALORANT_SHIELD_PRICES[shieldType] || 0;
    const totalLoadoutValue = weaponValue + armorValue;

    const formatted: IFormattedValorantPlayer = {
      agentName: this.formatAgentIdentity(data.character),
      assists: data.assists,
      currUltPoints: data.ult_points,

      deaths: data.deaths,

      hasSpike: hasSpike,
      isAlive: data.alive,

      kills: data.kills,

      loadoutValue: totalLoadoutValue,
      maxUltPoints: data.ult_max,
      money: data.money,
      name: nameSplit[0],
      playerId: data.player_id,
      shieldType: shieldType,
      startTeam: normalizeValorantTeamIdentity(data.team),

      tagline: nameSplit[1],

      weaponName,
    };

    return {
      data: formatted,
      event: ValorantDataTypes.PLAYER_SCOREBOARD,
    };
  }

  private formatAgentIdentity(value: unknown): ValorantAgentKey {
    return (normalizeValorantAgentKey(value) ??
      normalizeFallbackValorantId(value)) as ValorantAgentKey;
  }

  private formatWeaponIdentity(value: unknown): ValorantWeaponInternal {
    return (normalizeValorantWeaponIdentity(value) ??
      normalizeFallbackValorantId(value)) as ValorantWeaponInternal;
  }
}
