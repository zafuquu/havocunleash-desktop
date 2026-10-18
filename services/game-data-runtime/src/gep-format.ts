/**
 * Overwolf GEP -> runtime-fact formatting, ported from the audited original
 * HAVOC `FormattingService` (packages/data-schemas/.../valorant/api.ts).
 * Normalizes Overwolf internal identity keys and shapes them into the keys
 * the fork runtime + desktop projector consume:
 *   kill_feed | scoreboard | roster | round_phase | round_number | map
 */

const AGENT_INTERNAL: Record<string, string> = {
  aggrobot: "Gekko", bountyhunter: "Fade", breach: "Breach", cable: "Deadlock",
  cashew: "Tejo", clay: "Raze", deadeye: "Chamber", grenadier: "KAY/O",
  guide: "Skye", gumshoe: "Cypher", hunter: "Sova", iris: "Miks",
  killjoy: "Killjoy", mage: "Harbor", nox: "Vyse", pandemic: "Viper",
  phoenix: "Phoenix", pine: "Veto", rift: "Astra", sarge: "Brimstone",
  sequoia: "Iso", smonk: "Clove", sprinter: "Neon", stealth: "Yoru",
  terra: "Waylay", thorne: "Sage", vampire: "Reyna", wraith: "Omen",
};

const MAP_INTERNAL: Record<string, string> = {
  ascent: "Ascent", bonsai: "Split", canyon: "Fracture", duality: "Bind",
  foxtrot: "Breeze", hurm_alley: "District", hurm_bowl: "Kasbah",
  hurm_helix: "Drift", hurm_hightide: "Glitch", hurm_yard: "Piazza",
  infinity_: "Abyss", jam: "Lotus", juliett: "Sunset", pitt: "Pearl",
  plummet: "Summit", port: "Icebox", rook: "Corrode", triad: "Haven",
};

/**
 * Canonical lowercase map key from ANY upstream spelling:
 *   - GEP codenames            ("Bonsai", "Foxtrot", "Infinityy")
 *   - Riot presence map paths  ("/Game/Maps/Infinity/Infinity")
 *   - already-canonical keys   ("split", "abyss")
 * Codename table = ValoSpectra's ValorantInternalTranslator.Maps merged with
 * the fork's own rows. Riot ships the same map under several spellings —
 * "Infinity"/"Infinityy"/"Infinity_" are all Abyss — so every alias lands on
 * one canonical key that projection.ts resolves to a display name. Without
 * this the HUD/site showed raw codenames ("bonsai", "infinity") as if they
 * were map names.
 */
const MAP_KEY_BY_CODE: Record<string, string> = (() => {
  const table: Record<string, string> = {};
  for (const [code, display] of Object.entries(MAP_INTERNAL)) {
    table[code] = display.toLowerCase();
  }
  // Aliases observed in the wild that the codename table does not cover.
  table["infinity"] = "abyss";
  table["infinityy"] = "abyss";
  table["ascent-2"] = "ascent";
  table["sunset2"] = "sunset";
  return table;
})();

export const formatMapKey = (raw: unknown): string => {
  if (typeof raw !== "string") return "";
  // "/Game/Maps/Bonsai/Bonsai" -> "Bonsai"
  const seg = raw.split("/").filter(Boolean).pop() ?? "";
  const key = seg.trim().toLowerCase();
  if (!key) return "";
  return MAP_KEY_BY_CODE[key] ?? key;
};


const WEAPON_INTERNAL: Record<string, string> = {
  bounty: "Ghost", deployed: "Classic", sheriff: "Sheriff", vandal: "Vandal",
  phantom: "Phantom", bulldog: "Bulldog", guardian: "Guardian",
  operator: "Operator", marshall: "Marshal", spectre: "Spectre",
  stinger: "Stinger", smg: "SMG", judge: "Judge", bucky: "Bucky",
  shorty: "Shorty", "auto-shotgun": "Auto Shotgun", knife: "Knife",
  odin: "Odin", ares: "Ares", classic: "Classic", frenzy: "Frenzy",
};

function displayName(table: Record<string, string>, raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  const key = raw.trim().toLowerCase();
  return table[key] ?? raw.trim();
}

export const formatAgent = (raw: unknown): string => displayName(AGENT_INTERNAL, raw);
export const formatMap = (raw: unknown): string => displayName(MAP_INTERNAL, raw);
export const formatWeapon = (raw: unknown): string => displayName(WEAPON_INTERNAL, raw);
/**
 * Overwolf GEP encodes display names as base64 ("U2h1dGVuIERvamkgI0FrdW1h" =
 * "Shuten Doji #Akuma"). Decode when the string is plausibly base64 AND the
 * result is printable text; keep the raw value otherwise (roster names often
 * arrive already decoded).
 */
function decodeGepName(raw: string): string {
  if (raw.length >= 8 && raw.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    try {
      const decoded = Buffer.from(raw, "base64").toString("utf8");
      if (decoded.length > 0 && !/[\u0000-\u001f\u007f]/.test(decoded)) return decoded;
    } catch { /* keep raw */ }
  }
  return raw;
}

export function formatName(raw: unknown): { name: string; tagline: string } {
  const v = decodeGepName(typeof raw === "string" ? raw : String(raw ?? ""));
  const idx = v.indexOf(" #");
  if (idx < 0) return { name: v.trim(), tagline: "" };
  return { name: v.slice(0, idx).trim(), tagline: v.slice(idx + 2).trim() };
}

const toBool = (v: unknown, fallback = false): boolean =>
  typeof v === "boolean" ? v : fallback;
const toNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function formatRoster(data: Record<string, unknown>): { key: "roster"; value: Record<string, unknown> } {
  return {
    key: "roster",
    value: {
      name: formatName(data.name).name,
      tagline: formatName(data.name).tagline,
      character: formatAgent(data.character ?? data.agent ?? ""),
      player_id: String(data.player_id ?? ""),
      locked: toBool(data.locked),
      position: toNum(data.position),
      team: toNum(data.team),
      // Viewer-relative identity flags (same contract as formatPlayer).
      local: data.local === true || data.is_local === true,
      teammate: typeof data.teammate === "boolean" ? data.teammate : undefined,
    },
  };
}

export function formatPlayer(data: Record<string, unknown>): { key: string; value: Record<string, unknown> } {
  // Absent GEP fields must stay absent: GEP only reports health/alive for the
  // players it tracked this cycle. Defaulting to 0/false phantom-killed healthy
  // players the moment a scoreboard update fired (the "took damage -> death
  // state" bug on the overlay).
  // Field sources across dialects: the GEP package's match_info scoreboard rows
  // carry the TIER in `shield` (live 2026-10-18: {"shield":3} with no armor key
  // — reading `armor ?? shield_type` alone mapped EVERY row to 0, the "shield
  // never appears" defect), the VS-family dialect uses initialArmor.
  const armorRaw = toNum(data.shield ?? data.armor ?? data.shield_type ?? data.initialArmor);
  // GEP's armor field is the shield TIER enum (VS parity — ValorantInternal
  // Translator.Armor): 0 none / 1 light / 2 heavy / 3 enemy-unknown / 4 regen.
  // Map the enum to its point value; already-numeric point values (25/50)
  // pass through untouched. The raw tier rides along as shieldType so the
  // site can render the correct icon (light vs heavy vs regen).
  const SHIELD_POINTS: Record<number, number> = { 0: 0, 1: 25, 2: 50, 3: 50, 4: 25 };
  return {
    key: "scoreboard",
    value: {
      name: formatName(data.name).name,
      tagline: formatName(data.name).tagline,
      character: formatAgent(data.character ?? data.agent ?? ""),
      weapon: formatWeapon(data.weapon ?? data.weapon_name ?? ""),
      kills: toNum(data.kills),
      deaths: toNum(data.deaths),
      assists: toNum(data.assists),
      credits: toNum(data.money ?? data.credits),
      spentCredits: toNum(data.spent ?? data.spent_money),
      health: data.health == null ? undefined : toNum(data.health),
      alive: data.alive == null ? undefined : toBool(data.alive, true),
      hasSpike: toBool(data.has_spike ?? data.is_spike_carrier),
      ultPoints: data.ult_points == null ? undefined : toNum(data.ult_points),
      ultMax: data.ult_max == null ? undefined : toNum(data.ult_max),
      shield: SHIELD_POINTS[armorRaw] ?? armorRaw,
      shieldType: Number.isInteger(armorRaw) && armorRaw >= 0 && armorRaw <= 4 ? armorRaw : undefined,
      player_id: String(data.player_id ?? ""),
      team: toNum(data.team),
      // Local-player identity evidence the projection's viewer-left anchoring
      // REQUIRES (is_local -> viewerName/viewerGepTeam, teammate -> cold-start
      // side). Stripping these here left viewerName null for whole matches
      // (live 2026-10-18: team block rendered on the right, abilities never
      // attached -> grey skill icons, no YOU tag).
      is_local: data.is_local === true || data.isLocalPlayer === true,
      teammate: typeof data.teammate === "boolean" ? data.teammate : undefined,
    },
  };
}

export function formatKill(event: Record<string, unknown>): { key: string; value: Record<string, unknown> } {
  return {
    key: "kill_feed",
    value: {
      attacker: formatName(event.killer ?? event.attacker ?? "").name,
      victim: formatName(event.victim ?? "").name,
      weapon: formatWeapon(event.weapon ?? event.weapon_name ?? ""),
      modifier: event.headshot === true ? "headshot" : event.bodyshot === true ? "bodyshot" : null,
      assists: [event.assist1, event.assist2].filter((a): a is string => typeof a === "string" && a.length > 0),
    },
  };
}

export function normalizePhase(raw: unknown): "shopping" | "combat" | "end" | "unknown" {
  if (typeof raw !== "string") return "unknown";
  const v = raw.trim().toLowerCase();
  if (["game_start", "pre_shopping", "shopping", "buy_round"].includes(v)) return "shopping";
  if (v === "combat" || v === "action") return "combat";
  if (v === "end" || v === "game_end" || v === "post_round") return "end";
  return "unknown";
}

export function formatRoundInfo(data: Record<string, unknown>): {
  round_phase: { phase: string } | null;
  round_number: { number: number } | null;
} {
  const phase = normalizePhase(data.phase);
  const number = toNum(data.roundNum ?? data.round_number ?? data.round);
  return {
    round_phase: phase === "unknown" ? null : { phase },
    round_number: number > 0 ? { number } : null,
  };
}