import type { ValorantWeaponInternal } from "./valorant-weapons";

// Add this near your imports
const VALORANT_WEAPON_PRICES: Record<ValorantWeaponInternal, number> = {
  // Melee
  knife: 0,
  tx_hud_hmg: 3200,
  // Machine Guns
  tx_hud_lmg: 1600,
  tx_hud_pistol_autopistol: 450,
  // Sidearms
  tx_hud_pistol_classic: 0,
  tx_hud_pistol_compact: 600,

  tx_hud_pistol_luger: 500,
  tx_hud_pistol_sheriff: 800,

  tx_hud_pistol_slim: 300,
  // Rifles
  tx_hud_rifles_burst: 2050,

  tx_hud_rifles_dmr: 2250,
  tx_hud_rifles_ghost: 2900,
  tx_hud_rifles_volcano: 2900,
  tx_hud_shotguns_persuader: 1850,

  // Shotguns
  tx_hud_shotguns_pump: 850,
  tx_hud_smgs_ninja: 1600,
  // SMGs
  tx_hud_smgs_vector: 1100,

  // Snipers
  tx_hud_sniper_bolt: 950,
  tx_hud_sniper_doublesniper: 2400,

  tx_hud_sniper_operater: 4700,
};

const VALORANT_SHIELD_PRICES: Record<0 | 1 | 2 | 3 | 4, number> = {
  0: 0, // No Shield
  1: 400, // Light Shield
  2: 1000, // Heavy Shield
  3: 0, // Enemy Shield (Assume Heavy for calc)
  4: 650, // Regen Shield (Assume Light cost equivalent or 0 depending on mode, usually 400 for value calc)
};

export { VALORANT_SHIELD_PRICES, VALORANT_WEAPON_PRICES };
