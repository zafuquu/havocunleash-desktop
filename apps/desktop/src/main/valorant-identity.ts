/**
 * Valorant identity tables (ported from the audited upstream identities.ts):
 * GEP speaks internal codenames ("cashew", "TX_Hud_Pistol_Classic"); overlays
 * need display names ("Tejo") and agent icons (valorant-api media URLs).
 */

const AGENTS: Record<string, { name: string; uuid: string }> = {
  aggrobot: { name: "Gekko", uuid: "e370fa57-4757-3604-3648-499e1f642d3f" },
  bountyhunter: { name: "Fade", uuid: "dade69b4-4f5a-8528-247b-219e5a1facd6" },
  breach: { name: "Breach", uuid: "5f8d3a7f-467b-97f3-062c-13acf203c006" },
  cable: { name: "Deadlock", uuid: "cc8b64c8-4b25-4ff9-6e7f-37b4da43d235" },
  cashew: { name: "Tejo", uuid: "b444168c-4e35-8076-db47-ef9bf368f384" },
  clay: { name: "Raze", uuid: "f94c3b30-42be-e959-889c-5aa313dba261" },
  deadeye: { name: "Chamber", uuid: "22697a3d-45bf-8dd7-4fec-84a9e28c69d7" },
  grenadier: { name: "KAY/O", uuid: "601dbbe7-43ce-be57-2a40-4abd24953621" },
  guide: { name: "Skye", uuid: "6f2a04ca-43e0-be17-7f36-b3908627744d" },
  gumshoe: { name: "Cypher", uuid: "117ed9e3-49f3-6512-3ccf-0cada7e3823b" },
  hunter: { name: "Sova", uuid: "320b2a48-4d9b-a075-30f1-1f93a9b638fa" },
  iris: { name: "Miks", uuid: "7c8a4701-4de6-9355-b254-e09bc2a34b72" },
  killjoy: { name: "Killjoy", uuid: "1e58de9c-4950-5125-93e9-a0aee9f98746" },
  mage: { name: "Harbor", uuid: "95b78ed7-4637-86d9-7e41-71ba8c293152" },
  nox: { name: "Vyse", uuid: "efba5359-4016-a1e5-7626-b1ae76895940" },
  pandemic: { name: "Viper", uuid: "707eab51-4836-f488-046a-cda6bf494859" },
  phoenix: { name: "Phoenix", uuid: "eb93336a-449b-9c1b-0a54-a891f7921d69" },
  pine: { name: "Veto", uuid: "92eeef5d-43b5-1d4a-8d03-b3927a09034b" },
  rift: { name: "Astra", uuid: "41fb69c1-4189-7b37-f117-bcaf1e96f1bf" },
  sarge: { name: "Brimstone", uuid: "9f0d8ba9-4140-b941-57d3-a7ad57c6b417" },
  sequoia: { name: "Iso", uuid: "0e38b510-41a8-5780-5e8f-568b2a4f2d6c" },
  smonk: { name: "Clove", uuid: "1dbf2edd-4729-0984-3115-daa5eed44993" },
  sprinter: { name: "Neon", uuid: "bb2a4828-46eb-8cd1-e765-15848195d751" },
  stealth: { name: "Yoru", uuid: "7f94d92c-4234-0a36-9646-3a87eb8b5c89" },
  terra: { name: "Waylay", uuid: "df1cb487-4902-002e-5c17-d28e83e78588" },
  thorne: { name: "Sage", uuid: "569fdd95-4d10-43ab-ca70-79becc718b46" },
  vampire: { name: "Reyna", uuid: "a3bfb853-43b2-7238-a4f1-ad90e9e46bcc" },
  wraith: { name: "Omen", uuid: "8e253930-4c05-31dd-1b6c-968525494517" },
  wushu: { name: "Jett", uuid: "add6443a-41bd-e414-f6ad-e58d267f4e95" },
};

/** Display name for a GEP internal agent codename ("cashew" -> "Tejo"). */
export function agentDisplayName(internal: unknown): string | undefined {
  if (typeof internal !== "string") return undefined;
  const key = internal.trim().toLowerCase().replace(/_pc(_c)?$/i, '');
  return AGENTS[key]?.name;
}

/** Agent icon URL for a codename OR a raw Riot agent UUID. */
export function agentIconUrl(internalOrUuid: unknown): string | undefined {
  if (typeof internalOrUuid !== "string") return undefined;
  const v = internalOrUuid.trim();
  if (/^[0-9a-f-]{36}$/i.test(v)) {
    return `https://media.valorant-api.com/agents/${v}/displayicon.png`;
  }
  const agent = AGENTS[v.toLowerCase().replace(/_pc(_c)?$/i, '')];
  return agent ? `https://media.valorant-api.com/agents/${agent.uuid}/displayicon.png` : undefined;
}

const WEAPON_WORDS: Record<string, string> = {
  knife: "Knife",
  classic: "Classic",
  shorty: "Shorty",
  frenzy: "Frenzy",
  ghost: "Ghost",
  sheriff: "Sheriff",
  stinger: "Stinger",
  spectre: "Spectre",
  bucker: "Bucky",
  judge: "Judge",
  bulldog: "Bulldog",
  guardian: "Guardian",
  phantom: "Phantom",
  vandal: "Vandal",
  marshal: "Marshal",
  outlaw: "Outlaw",
  operator: "Operator",
  ares: "Ares",
  odin: "Odin",
  fallendamage: "Fall Damage",
  suicide: "Suicide",
};

/**
 * Exact VS-family internal weapon codenames (Spectra-Server
 * ValorantInternalTranslator.WeaponsAndAbilities). The engine sends these for
 * `scoreboardWeaponInternal`; generic tail-split heuristics cannot map them
 * (e.g. "Volcano" -> Vandal), so resolve them first.
 */
const WEAPON_TX: Record<string, string> = {
  tx_hud_pistol_classic: "Classic",
  tx_hud_pistol_glock_s: "Classic",
  tx_hud_pistol_slim: "Shorty",
  tx_hud_pistol_sawedoff_s: "Shorty",
  tx_hud_pistol_autopistol: "Frenzy",
  tx_hud_autopistol: "Frenzy",
  tx_hud_pistol_luger: "Ghost",
  tx_hud_pistol_luger_s: "Ghost",
  tx_hud_pistol_sheriff: "Sheriff",
  tx_hud_pistol_revolver_s: "Sheriff",
  tx_hud_pistol_compact: "Bandit",
  tx_hud_pistol_compact_s: "Bandit",
  tx_hud_shotguns_pump: "Bucky",
  tx_hud_pump: "Bucky",
  tx_hud_shotguns_persuader: "Judge",
  tx_hud_shotguns_spas12_s: "Judge",
  tx_hud_smgs_vector: "Stinger",
  tx_hud_vector: "Stinger",
  tx_hud_smgs_ninja: "Spectre",
  tx_hud_smg_mp5_s: "Spectre",
  tx_hud_rifles_burst: "Bulldog",
  tx_hud_burst: "Bulldog",
  tx_hud_rifles_dmr: "Guardian",
  tx_hud_dmr: "Guardian",
  tx_hud_rifles_ghost: "Phantom",
  tx_hud_assault_ar10a2_s: "Phantom",
  tx_hud_rifles_volcano: "Vandal",
  // Patch 13.06 rifle: the engine's internal `BattleRifle` is the live Warden
  // (valorant-api: displayName Warden, Rifle, 2900, 18/36, 6.5 rps, medium
  // wall penetration; assetPath .../Rifles/BattleRifle/BattleRifle_PrimaryAsset).
  // Captured live 2026-09-25 02:24:49 the engine sent TX_Hud_Rifle_BattleRifle
  // and the old tail heuristic rendered it as the wrong name "Battle Rifle"
  // (with no matching website icon).
  tx_hud_rifle_battlerifle: "Warden",
  tx_hud_rifles_battlerifle: "Warden",
  tx_hud_volcano: "Vandal",
  tx_hud_sniper_bolt: "Marshal",
  tx_hud_sniper_boltaction_s: "Marshal",
  tx_hud_sniper_operater: "Operator",
  tx_hud_operator: "Operator",
  tx_hud_sniper_doublesniper: "Outlaw",
  tx_hud_doublesniper: "Outlaw",
  tx_hud_lmg: "Ares",
  tx_hud_hmg: "Odin",
  tx_hud_knife_standard_s: "Knife",
};

/**
 * Human weapon name from GEP internals like "TX_Hud_Pistol_Classic",
 * "TX_Icon_FallenDamage_S" or "knife".
 */
export function weaponDisplayName(internal: unknown): string | undefined {
  if (typeof internal !== "string") return undefined;
  let s = internal.trim();
  if (!s) return undefined;
  if (WEAPON_WORDS[s.toLowerCase()]) return WEAPON_WORDS[s.toLowerCase()];
  const tx = WEAPON_TX[s.toLowerCase()];
  if (tx) return tx;
  s = s.replace(/^TX_(Hud|Icon|Shy)_/i, "").replace(/_S$/i, "");
  const tail = s.split("_").pop() ?? s;
  return WEAPON_WORDS[tail.toLowerCase()] ?? tail.replace(/([a-z])([A-Z])/g, "$1 $2");
}
