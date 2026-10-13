import { ValorantWeaponMap } from "./valorant-weapons";

export type ValorantKillfeedCauseClassification =
  | "ability"
  | "objective"
  | "support"
  | "unknown"
  | "weapon";
export interface ValorantKillfeedCauseInput {
  ultName?: null | ValorantKillfeedUltValue;
  weaponName?: null | ValorantKillfeedWeaponValue;
}

export type ValorantKillfeedUltValue = string;

export type ValorantKillfeedWeaponValue = string;

const CANONICAL_SCOREBOARD_WEAPON_KEYS = new Set<string>(Object.keys(ValorantWeaponMap));
const CANONICAL_SCOREBOARD_WEAPON_NAMES = new Set<string>(
  Object.values(ValorantWeaponMap).map((weaponName) => weaponName.toLowerCase()),
);

const OBJECTIVE_OR_ENVIRONMENT_WEAPONS = new Set<string>([
  "bomb",
  "fall_damage",
  "falldamage",
  "fall damage",
  "spike",
  "tx_hud_bomb_s",
]);

const KILLFEED_WEAPON_PREFIXES = [
  "tx_hud_pistol_",
  "tx_hud_autopistol",
  "tx_hud_shotguns_",
  "tx_hud_pump",
  "tx_hud_vector",
  "tx_hud_smgs_",
  "tx_hud_smg_",
  "tx_hud_burst",
  "tx_hud_rifles_",
  "tx_hud_assault_",
  "tx_hud_volcano",
  "tx_hud_sniper_",
  "tx_hud_operator",
  "tx_hud_doublesniper",
  "tx_hud_lmg",
  "tx_hud_hmg",
  "tx_hud_knife_",
  "tx_hud_deadeye_q_",
  "tx_hud_deadeye_x_",
  "tx_hud_wushu_x_",
];

const normalizeKillfeedCauseValue = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

export const classifyValorantKillfeedCause = ({
  ultName,
  weaponName,
}: ValorantKillfeedCauseInput): ValorantKillfeedCauseClassification => {
  const normalizedWeaponName = normalizeKillfeedCauseValue(weaponName);
  const normalizedUltName = normalizeKillfeedCauseValue(ultName);

  if (!normalizedWeaponName) {
    if (normalizedUltName) {
      return "support";
    }

    return "unknown";
  }

  if (
    OBJECTIVE_OR_ENVIRONMENT_WEAPONS.has(normalizedWeaponName) ||
    normalizedWeaponName.includes("spike") ||
    normalizedWeaponName.includes("bomb") ||
    normalizedWeaponName.includes("fall")
  ) {
    return "objective";
  }

  if (
    CANONICAL_SCOREBOARD_WEAPON_KEYS.has(normalizedWeaponName) ||
    CANONICAL_SCOREBOARD_WEAPON_NAMES.has(normalizedWeaponName)
  ) {
    return "weapon";
  }

  if (
    KILLFEED_WEAPON_PREFIXES.some((prefix) => normalizedWeaponName.startsWith(prefix)) ||
    normalizedWeaponName === "knife"
  ) {
    return "weapon";
  }

  if (normalizedWeaponName.startsWith("tx_")) {
    return "ability";
  }

  return "unknown";
};

export const isValorantKillfeedLiveAttackerEvidence = (
  cause: ValorantKillfeedCauseInput,
): boolean => classifyValorantKillfeedCause(cause) === "weapon";
