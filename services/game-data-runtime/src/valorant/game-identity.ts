import { z } from "zod";


export const VALORANT_AGENT_NAMES = {
  aggrobot: "Gekko",
  bountyhunter: "Fade",
  breach: "Breach",
  cable: "Deadlock",
  cashew: "Tejo",
  clay: "Raze",
  deadeye: "Chamber",
  grenadier: "KAY/O",
  guide: "Skye",
  gumshoe: "Cypher",
  hunter: "Sova",
  iris: "Miks",
  killjoy: "Killjoy",
  mage: "Harbor",
  nox: "Vyse",
  pandemic: "Viper",
  phoenix: "Phoenix",
  pine: "Veto",
  rift: "Astra",
  sarge: "Brimstone",
  sequoia: "Iso",
  smonk: "Clove",
  sprinter: "Neon",
  stealth: "Yoru",
  terra: "Waylay",
  thorne: "Sage",
  vampire: "Reyna",
  wraith: "Omen",
  wushu: "Jett",
} as const;

export const VALORANT_AGENT_RIOT_IDS = {
  aggrobot: "e370fa57-4757-3604-3648-499e1f642d3f",
  bountyhunter: "dade69b4-4f5a-8528-247b-219e5a1facd6",
  breach: "5f8d3a7f-467b-97f3-062c-13acf203c006",
  cable: "cc8b64c8-4b25-4ff9-6e7f-37b4da43d235",
  cashew: "b444168c-4e35-8076-db47-ef9bf368f384",
  clay: "f94c3b30-42be-e959-889c-5aa313dba261",
  deadeye: "22697a3d-45bf-8dd7-4fec-84a9e28c69d7",
  grenadier: "601dbbe7-43ce-be57-2a40-4abd24953621",
  guide: "6f2a04ca-43e0-be17-7f36-b3908627744d",
  gumshoe: "117ed9e3-49f3-6512-3ccf-0cada7e3823b",
  hunter: "320b2a48-4d9b-a075-30f1-1f93a9b638fa",
  iris: "7c8a4701-4de6-9355-b254-e09bc2a34b72",
  killjoy: "1e58de9c-4950-5125-93e9-a0aee9f98746",
  mage: "95b78ed7-4637-86d9-7e41-71ba8c293152",
  nox: "efba5359-4016-a1e5-7626-b1ae76895940",
  pandemic: "707eab51-4836-f488-046a-cda6bf494859",
  phoenix: "eb93336a-449b-9c1b-0a54-a891f7921d69",
  pine: "92eeef5d-43b5-1d4a-8d03-b3927a09034b",
  rift: "41fb69c1-4189-7b37-f117-bcaf1e96f1bf",
  sarge: "9f0d8ba9-4140-b941-57d3-a7ad57c6b417",
  sequoia: "0e38b510-41a8-5780-5e8f-568b2a4f2d6c",
  smonk: "1dbf2edd-4729-0984-3115-daa5eed44993",
  sprinter: "bb2a4828-46eb-8cd1-e765-15848195d751",
  stealth: "7f94d92c-4234-0a36-9646-3a87eb8b5c89",
  terra: "df1cb487-4902-002e-5c17-d28e83e78588",
  thorne: "569fdd95-4d10-43ab-ca70-79becc718b46",
  vampire: "a3bfb853-43b2-7238-a4f1-ad90e9e46bcc",
  wraith: "8e253930-4c05-31dd-1b6c-968525494517",
  wushu: "add6443a-41bd-e414-f6ad-e58d267f4e95",
} as const satisfies Record<keyof typeof VALORANT_AGENT_NAMES, string>;

export const VALORANT_MAP_NAMES = {
  ascent: "Ascent",
  bonsai: "Split",
  canyon: "Fracture",
  duality: "Bind",
  foxtrot: "Breeze",
  hurm_alley: "District",
  hurm_bowl: "Kasbah",
  hurm_helix: "Drift",
  hurm_hightide: "Glitch",
  hurm_yard: "Piazza",
  infinity_: "Abyss",
  jam: "Lotus",
  juliett: "Sunset",
  pitt: "Pearl",
  plummet: "Summit",
  port: "Icebox",
  rook: "Corrode",
  skirmish_a: "Skirmish A",
  skirmish_b: "Skirmish B",
  skirmish_c: "Skirmish C",
  skirmish_d: "Skirmish D",
  skirmish_e: "Skirmish E",
  triad: "Haven",
} as const;

export type ValorantAgentKey = keyof typeof VALORANT_AGENT_NAMES;
export type ValorantMapKey = keyof typeof VALORANT_MAP_NAMES;

export const VALORANT_AGENTS_BY_KEY = Object.fromEntries(
  (Object.keys(VALORANT_AGENT_NAMES) as ValorantAgentKey[]).map((key) => [
    key,
    {
      riotId: VALORANT_AGENT_RIOT_IDS[key],
      key,
      name: VALORANT_AGENT_NAMES[key],
    },
  ]),
) as Readonly<Record<ValorantAgentKey, ValorantAgentIdentity>>;

export const VALORANT_MAPS_BY_KEY = Object.fromEntries(
  (Object.keys(VALORANT_MAP_NAMES) as ValorantMapKey[]).map((key) => [
    key,
    {
      riotId: key,
      key,
      name: VALORANT_MAP_NAMES[key],
    },
  ]),
) as Readonly<Record<ValorantMapKey, ValorantMapIdentity>>;

export const valorantMapIdentitySchema = z.object({
  riotId: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
});

export const valorantAgentIdentitySchema = z.object({
  riotId: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
});

export const valorantPlayerNameSchema = z.object({
  gameName: z.string().min(1),
  tagLine: z.string().min(1),
  displayName: z.string().min(1),
});

export const valorantPlayerReferenceSchema = z.object({
  puuid: z.string().min(1),
  name: valorantPlayerNameSchema,
});

export const valorantObserverSlotSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
  z.literal(9),
]);

export const valorantObserverSlotOrderSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
  z.literal(9),
  z.literal(10),
]);

const agentKeyByRiotId = Object.fromEntries(
  Object.entries(VALORANT_AGENT_RIOT_IDS).map(([key, riotId]) => [riotId, key]),
) as Record<string, ValorantAgentKey>;

export function normalizeValorantAgentKey(value: unknown): ValorantAgentKey | null {
  const normalized = normalizeIdentityInput(value);
  if (!normalized) return null;
  if (Object.hasOwn(VALORANT_AGENT_NAMES, normalized)) return normalized as ValorantAgentKey;

  const riotKey = agentKeyByRiotId[normalized];
  if (riotKey) return riotKey;

  const displayEntry = Object.entries(VALORANT_AGENT_NAMES).find(
    ([, name]) => name.toLowerCase() === normalized,
  );
  return (displayEntry?.[0] as ValorantAgentKey | undefined) ?? null;
}

export function normalizeValorantAgentIdentity(value: unknown): ValorantAgentIdentity | null {
  if (typeof value !== "string") return null;
  const key = normalizeValorantAgentKey(value);
  return key ? { riotId: value.trim(), key, name: VALORANT_AGENT_NAMES[key] } : null;
}

export function resolveValorantAgentIdentity(riotId: string): ValorantAgentIdentity | null {
  return normalizeValorantAgentIdentity(riotId);
}

export function normalizeValorantMapKey(value: unknown): ValorantMapKey | null {
  const normalized = normalizeIdentityInput(value);
  if (!normalized) return null;
  const candidate = normalized.split("/").filter(Boolean).at(-1) ?? normalized;
  const key = candidate === "infinity" ? "infinity_" : candidate;
  if (Object.hasOwn(VALORANT_MAP_NAMES, key)) return key as ValorantMapKey;

  const displayEntry = Object.entries(VALORANT_MAP_NAMES).find(
    ([, name]) => name.toLowerCase() === normalized,
  );
  return (displayEntry?.[0] as ValorantMapKey | undefined) ?? null;
}

export function normalizeValorantMapIdentity(value: unknown): ValorantMapIdentity | null {
  if (typeof value !== "string") return null;
  const key = normalizeValorantMapKey(value);
  return key ? { riotId: value.trim(), key, name: VALORANT_MAP_NAMES[key] } : null;
}

export function resolveValorantMapIdentity(riotId: string): ValorantMapIdentity | null {
  return normalizeValorantMapIdentity(riotId);
}

function normalizeIdentityInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export type ValorantAgentIdentity = z.infer<typeof valorantAgentIdentitySchema>;
export type ValorantAgentName = (typeof VALORANT_AGENT_NAMES)[ValorantAgentKey];
export type ValorantMapIdentity = z.infer<typeof valorantMapIdentitySchema>;
export type ValorantMapName = (typeof VALORANT_MAP_NAMES)[ValorantMapKey];
export type ValorantObserverSlot = z.infer<typeof valorantObserverSlotSchema>;
export type ValorantObserverSlotOrder = z.infer<typeof valorantObserverSlotOrderSchema>;
export type ValorantPlayerName = z.infer<typeof valorantPlayerNameSchema>;
export type ValorantPlayerReference = z.infer<typeof valorantPlayerReferenceSchema>;


const valorantStartingSideSchema = z.enum(["attack", "defense"]).nullable();

export const valorantPregameTeamSchema = z.object({
  teamId: z.string().min(1),
  startingSide: valorantStartingSideSchema,
  players: z
    .array(
      z.discriminatedUnion("selection", [
        z.object({
          player: valorantPlayerReferenceSchema,
          competitiveTier: z.number().int().nonnegative(),
          captain: z.boolean(),
          selection: z.literal("unselected"),
          agent: z.null(),
        }),
        z.object({
          player: valorantPlayerReferenceSchema,
          competitiveTier: z.number().int().nonnegative(),
          captain: z.boolean(),
          selection: z.enum(["selected", "locked"]),
          agent: valorantAgentIdentitySchema,
        }),
      ]),
    )
    .readonly(),
});

export const valorantCurrentGamePlayerSchema = z.object({
  player: valorantPlayerReferenceSchema,
  agent: valorantAgentIdentitySchema,
  teamIndex: z.number().int().nonnegative(),
  observerSlot: valorantObserverSlotSchema.nullable(),
  observerSlotOrder: valorantObserverSlotOrderSchema.nullable(),
});

export const valorantCurrentGameTeamSchema = z.object({
  teamId: z.string().min(1),
  startingSide: valorantStartingSideSchema,
  players: z.array(valorantCurrentGamePlayerSchema).readonly(),
});

export const valorantActiveSessionSchema = z.object({
  matchId: z.string().min(1),
  map: valorantMapIdentitySchema,
  queueId: z.string().nullable(),
  modeId: z.string().nullable(),
  ranked: z.boolean().nullable(),
  viewer: z.object({
    player: valorantPlayerReferenceSchema,
    role: z.enum(["player", "observer", "coach", "unknown"]),
  }),
});

const valorantSessionSnapshotBaseShape = {
  revision: z.number().int().nonnegative(),
  observedAt: z.string().datetime(),
};

export const valorantSessionSnapshotSchema = z.discriminatedUnion("phase", [
  z.object({
    ...valorantSessionSnapshotBaseShape,
    phase: z.literal("unknown"),
    session: z.null(),
  }),
  z.object({
    ...valorantSessionSnapshotBaseShape,
    phase: z.literal("idle"),
    session: z.null(),
  }),
  z.object({
    ...valorantSessionSnapshotBaseShape,
    phase: z.literal("pregame"),
    session: valorantActiveSessionSchema.extend({
      teams: z.array(valorantPregameTeamSchema).readonly(),
    }),
  }),
  z.object({
    ...valorantSessionSnapshotBaseShape,
    mapReady: z.boolean(),
    phase: z.literal("live"),
    session: valorantActiveSessionSchema.extend({
      teams: z.array(valorantCurrentGameTeamSchema).readonly(),
    }),
  }),
  z.object({
    ...valorantSessionSnapshotBaseShape,
    mapReady: z.boolean(),
    phase: z.literal("ending"),
    session: valorantActiveSessionSchema.extend({
      teams: z.array(valorantCurrentGameTeamSchema).readonly(),
      matchDetails: z.enum(["pending", "published", "unavailable"]),
    }),
  }),
]);

export type ValorantActiveSession = z.infer<typeof valorantActiveSessionSchema>;
export type ValorantCurrentGamePlayer = z.infer<typeof valorantCurrentGamePlayerSchema>;
export type ValorantCurrentGameTeam = z.infer<typeof valorantCurrentGameTeamSchema>;
export type ValorantPregamePlayer = ValorantPregameTeam["players"][number];
export type ValorantPregameTeam = z.infer<typeof valorantPregameTeamSchema>;
export type ValorantSessionSnapshot = z.infer<typeof valorantSessionSnapshotSchema>;

/** Game identity tag used across the runtime (recovered from @havoc-game-data/contracts usage). */
export type GameIdentity = "VAL" | "CS" | "RL";

/** Provider game id for VALORANT (recovered from the original's runtime logs: gameId 21640). */
export const VALORANT_PROVIDER_GAME_ID = 21640;
