export const ValorantWeaponMap = {
  // Melee
  knife: "Melee",
  tx_hud_hmg: "Odin",
  // Machine Guns
  tx_hud_lmg: "Ares",
  tx_hud_pistol_autopistol: "Frenzy",
  // Pistols
  tx_hud_pistol_classic: "Classic",
  tx_hud_pistol_compact: "Compact",

  tx_hud_pistol_luger: "Ghost",
  tx_hud_pistol_sheriff: "Sheriff",

  tx_hud_pistol_slim: "Shorty",
  // Rifles
  tx_hud_rifles_burst: "Bulldog",

  tx_hud_rifles_dmr: "Guardian",
  tx_hud_rifles_ghost: "Phantom",
  tx_hud_rifles_volcano: "Vandal",
  tx_hud_shotguns_persuader: "Judge",

  // Shotguns
  tx_hud_shotguns_pump: "Bucky",
  tx_hud_smgs_ninja: "Spectre",
  // SMGs
  tx_hud_smgs_vector: "Stinger",

  // Snipers
  tx_hud_sniper_bolt: "Marshal",
  tx_hud_sniper_doublesniper: "Outlaw",

  tx_hud_sniper_operater: "Operator",
} as const;

export type ValorantWeaponInternal = keyof typeof ValorantWeaponMap;
export type ValorantWeaponName = (typeof ValorantWeaponMap)[ValorantWeaponInternal];

const normalizeValorantInternalKey = (value: unknown): null | string => {
  if (typeof value !== "string") {
    return null;
  }

  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue.length > 0 ? normalizedValue : null;
};

export function isValorantWeaponInternal(value: unknown): value is ValorantWeaponInternal {
  return normalizeValorantWeaponInternal(value) !== null;
}

export function normalizeValorantWeaponIdentity(value: unknown): null | ValorantWeaponInternal {
  const internalName = normalizeValorantWeaponInternal(value);
  if (internalName) {
    return internalName;
  }

  const normalizedDisplayName = normalizeValorantInternalKey(value);
  if (!normalizedDisplayName) {
    return null;
  }

  const entry = Object.entries(ValorantWeaponMap).find(
    ([, displayName]) => displayName.toLowerCase() === normalizedDisplayName,
  );

  return entry ? (entry[0] as ValorantWeaponInternal) : null;
}

export function normalizeValorantWeaponInternal(value: unknown): null | ValorantWeaponInternal {
  const normalizedValue = normalizeValorantInternalKey(value);

  if (normalizedValue && Object.hasOwn(ValorantWeaponMap, normalizedValue)) {
    return normalizedValue as ValorantWeaponInternal;
  }

  return null;
}
