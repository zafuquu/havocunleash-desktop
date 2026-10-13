/**
 * Wire protocol shared with the audited havoc-game-data-runtime service.
 * Every SSE `data:` line carries {at, id, kind, protocolVersion, ...payload}.
 */
import { z } from "zod";

export const GAME_DATA_PROTOCOL_VERSION = 1;

export const GAME_DATA_RUNTIME_PATHS = {
  health: "/health",
  events: "/events",
} as const;

/* --------------------------- Health document --------------------------- */

const capabilityStateSchema = z
  .object({
    lastError: z.string().nullable(),
    state: z.enum(["ready", "starting", "error", "unavailable"]).catch("unavailable"),
    // A2: GEP telemetry-delivery state machine payload (additive, optional).
    telemetry: z
      .object({
        state: z.string(),
        previous: z.string().nullish(),
        attached: z.boolean().nullish(),
        attachedAt: z.number().nullish(),
        featuresSetAt: z.number().nullish(),
        firstInfoUpdateAt: z.number().nullish(),
        lastGameDataAt: z.number().nullish(),
        lastError: z.string().nullish(),
      })
      .nullish(),
  })
  .nullish();

/** Accepts BOTH upstream (service/runtime/ok/supportedGames) and fork-minimal. */
export const gameDataRuntimeHealthSchema = z.object({
  ok: z.boolean().optional(),
  service: z.string().nullish(),
  supportedGames: z.array(z.string()).nullish(),
  capabilities: z
    .object({ overwolf: capabilityStateSchema, valorantApi: capabilityStateSchema })
    .nullish(),
  runtimeVersion: z.string().min(1),
  uptimeMs: z.number().nonnegative().nullish(),
  runtime: z.object({
    state: z.enum(["starting", "ready", "error"]),
    detail: z.string().nullish(),
    lastError: z.string().nullish(),
  }),
});
export type GameDataRuntimeHealth = z.infer<typeof gameDataRuntimeHealthSchema>;

/* ------------------------------ Stream frames -------------------------- */

export const valorantPlayerIdentitySchema = z.object({
  displayName: z.string(),
  gameName: z.string().nullish(),
  tagLine: z.string().nullish(),
});
export type ValorantPlayerIdentity = z.infer<typeof valorantPlayerIdentitySchema>;

/**
 * Upstream viewer.player is a *reference* ({puuid, name:{gameName,tagLine,displayName}}),
 * the fork dialect uses a flat identity. Accept either shape.
 */
export const tolerantPlayerRefSchema = valorantPlayerIdentitySchema
  .extend({ puuid: z.string().nullish(), name: valorantPlayerIdentitySchema.nullish() })
  .partial()
  .nullish();

const rosterPlayerStatsSchema = z.object({
  playerId: z.string().nullish(),
  kills: z.number().int().nullish(),
  deaths: z.number().int().nullish(),
  assists: z.number().int().nullish(),
  credits: z.number().nullish(),
  spentCredits: z.number().nullish(),
  weapon: z.string().nullish(),
  health: z.number().nullish(),
  isAlive: z.boolean().nullish(),
  hasSpike: z.boolean().nullish(),
  ultPoints: z.number().int().nullish(),
  ultMax: z.number().int().nullish(),
  shield: z.number().nullish(),
  shieldType: z.number().int().nullish(),
});

const rosterPlayerSchema = z.object({
  agent: z.object({ key: z.string(), name: z.string(), riotId: z.string().nullish() }).nullish(),
  observerSlot: z.number().int().nullish(),
  player: z
    .object({
      identity: valorantPlayerIdentitySchema.nullish(),
      // Upstream dialect
      name: valorantPlayerIdentitySchema.nullish(),
      puuid: z.string().nullish(),
    })
    // Live scoreboard detail (fork runtime dialect nests these under player).
    .merge(rosterPlayerStatsSchema),
  teamIndex: z.number().int().nullish(),
});

/** Tolerant snapshot shape accepting BOTH observed upstream nesting and fork dialect. */
export const valorantSessionSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  // Fork dialect uses sessionPhase; upstream uses phase.
  // Upstream (audited original) emits: unknown | idle | pregame | live | ending.
  // Fork dialect emits: idle | loading | live.
  sessionPhase: z
    .enum(["unknown", "idle", "loading", "pregame", "live", "ending"])
    .optional(),
  phase: z
    .enum(["unknown", "idle", "loading", "pregame", "live", "ending"])
    .optional(),
  // Fork dialect puts ids top-level; upstream nests them under session.
  matchId: z.string().nullish(),
  mapKey: z.string().nullish(),
  score: z.object({ blue: z.number(), red: z.number() }).nullable().nullish(),
  session: z
    .object({
      matchId: z.string().nullish(),
      map: z.object({ key: z.string().nullish(), name: z.string().nullish() }).nullish(),
      teams: z
        .array(
          z.object({
            // Upstream uses free strings (z.string().min(1)); the fork's runtime
            // also emits "Unknown" for not-yet-assigned teams. Never reject a
            // frame over team naming.
            teamId: z.string().min(1),
            startingSide: z.enum(["defense", "attack"]).nullish(),
            players: z.array(rosterPlayerSchema),
          }),
        )
        .nullish(),
      viewer: z
        .object({
          // Upstream roles: player | observer | coach | unknown.
          role: z.enum(["player", "observer", "coach", "spectator", "unknown"]),
          player: tolerantPlayerRefSchema,
        })
        .nullish(),
    })
    .nullish(),
  teams: z
    .array(
      z.object({
        teamId: z.string().min(1),
        startingSide: z.enum(["defense", "attack"]).nullish(),
        players: z.array(rosterPlayerSchema),
      }),
    )
    .nullish(),
  viewer: z
    .object({
      role: z.enum(["player", "observer", "coach", "spectator", "unknown"]),
      player: tolerantPlayerRefSchema,
    })
    .nullish(),
  observedAt: z.string().datetime().nullish(),
});
export type ValorantSessionSnapshot = z.infer<typeof valorantSessionSnapshotSchema>;

export const valorantScoreSnapshotSchema = z.object({
  matchId: z.string(),
  blue: z.number().int().nonnegative(),
  red: z.number().int().nonnegative(),
  observedAt: z.string().datetime().nullish(),
});
export type ValorantScoreSnapshot = z.infer<typeof valorantScoreSnapshotSchema>;

export const valorantMatchDetailsSchema = z.object({ matchId: z.string() }).passthrough();
export type ValorantMatchDetails = z.infer<typeof valorantMatchDetailsSchema>;

export const valorantTimeoutStartedSchema = z.object({
  matchId: z.string(),
  observedAt: z.string().datetime().nullish(),
});
export type ValorantTimeoutStarted = z.infer<typeof valorantTimeoutStartedSchema>;

/** Raw provider fact routed by the runtime. */
export const rawPayloadSchema = z.object({
  gameId: z.number().int().nullish(),
  key: z.string().min(1),
  value: z.unknown(),
});

/** Upstream-exact frame union. The mock emits the same set. */
export const streamFrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("valorant_session_snapshot"), snapshot: valorantSessionSnapshotSchema }),
  z.object({ kind: z.literal("valorant_score_snapshot"), score: valorantScoreSnapshotSchema }),
  z.object({ kind: z.literal("valorant_match_details"), details: valorantMatchDetailsSchema }),
  z.object({ kind: z.literal("valorant_timeout_started"), timeout: valorantTimeoutStartedSchema }),
  z.object({ kind: z.literal("new_info_update"), data: rawPayloadSchema }),
  z.object({ kind: z.literal("new_game_event"), data: rawPayloadSchema }),
  z.object({ kind: z.literal("game_detected"), args: z.array(z.unknown()).nullish() }),
  z.object({ kind: z.literal("game_exit"), args: z.array(z.unknown()).nullish() }),
  z.object({
    kind: z.literal("provider_error"),
    classification: z.string().nullish(),
    code: z.string().nullish(),
  }),
]);
export type StreamFrame = z.infer<typeof streamFrameSchema>;

export const runtimeGameIdentities = ["VAL"] as const;

export * from "./hud-state";

