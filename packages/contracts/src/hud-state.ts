/** HUD relay state (delivered by /api/state and the /ws push channel). */
import { z } from "zod";

export const roundPhaseSchema = z.enum(["shopping", "combat", "end", "unknown"]);
export type RoundPhase = z.infer<typeof roundPhaseSchema>;

export const killfeedEntrySchema = z.object({
  seq: z.number().int().positive(),
  attacker: z.string(),
  victim: z.string(),
  weapon: z.string(),
  modifier: z.string().nullable(),
  at: z.number(),
});
export type KillfeedEntry = z.infer<typeof killfeedEntrySchema>;

export const spikeStatusSchema = z.enum(["carried", "dropped", "planted", "defused", "detonated"]);

export const hudRelayStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  connectedToRuntime: z.boolean(),
  game: z.string().nullable(),
  // Upstream phases (pregame/ending/unknown) pass through after normalization
  // in the desktop projection; the HUD renders non-live as "menu / <phase>".
  sessionPhase: z.enum(["unknown", "idle", "loading", "pregame", "live", "ending"]),
  matchId: z.string().nullable(),
  mapKey: z.string().nullable(),
  /** Friendly map name (e.g. "Ascent") resolved from the map identity. */
  mapName: z.string().nullable().default(null),
  viewerRole: z.enum(["player", "observer", "coach", "spectator", "unknown"]).default("unknown"),
  /**
   * The viewer's own display name ("Game#TAG") — the local-player anchor for
   * consumers. Ground truth from the authoritative session snapshot, else from
   * the scoreboard row the engine flags `is_local`. Local-player telemetry
   * (ability charges) exists ONLY on that row, so without this field the relay
   * published the charges with no way to tell which roster entry they belong to
   * (live 2026-09-26: the website could not show the viewer's abilities).
   */
  viewerName: z.string().nullable().default(null),

  /** Post-game result when a match settles (winner + MVP). */
  match: z
    .object({
      winner: z.enum(["blue", "red"]).nullable(),
      mvp: z
        .object({
          name: z.string(),
          teamId: z.string(),
          kills: z.number().int(),
          deaths: z.number().int(),
          assists: z.number().int(),
        })
        .nullable(),
    })
    .default({ winner: null, mvp: null }),
  roster: z
    .array(
      z.object({
        displayName: z.string(),
        agentName: z.string().nullable(),
        teamId: z.string().nullish(),
        teamIndex: z.number().int().nullish(),
        /**
         * The engine's STABLE player identity (GEP `player_id` / PUUID).
         *
         * Panel position must never decide which player's telemetry a row owns:
         * the rows are keyed by this identity when the engine provides it, so a
         * reorder/reconnect can never hand one player's agent/loadout/abilities
         * to another row. Display-only consumers keep using displayName.
         */
        puuid: z.string().nullish(),
        slot: z.number().int().nullish(),
        // Per-player detail evidence (weapon/credits/ults/scoreline) when the
        // provider supplies scoreboard observations.
        agentIcon: z.string().nullish(),
        agentKey: z.string().nullish(),
        abilityState: z
          .object({
            C: z.boolean().nullish(),
            Q: z.boolean().nullish(),
            E: z.boolean().nullish(),
            X: z.boolean().nullish(),
          })
          .nullish(),
        kills: z.number().int().nullish(),
        deaths: z.number().int().nullish(),
        assists: z.number().int().nullish(),
        weapon: z.string().nullish(),
        credits: z.number().nullish(),
        spentCredits: z.number().nullish(),
        shield: z.number().nullish(),
        /** GEP shield TIER enum (0 none / 1 light / 2 heavy / 3 enemy-unknown / 4 regen). */
        shieldType: z.number().int().nullish(),
        health: z.number().nullish(),
        isAlive: z.boolean().nullish(),
        ultPoints: z.number().int().nullish(),
        ultMax: z.number().int().nullish(),
        abilities: z.array(z.string()).nullish(),
        hasSpike: z.boolean().nullish(),
      }),
    )
    .max(10)
    .nullish(),
  round: z.object({
    number: z.number().int().nonnegative(),
    phase: roundPhaseSchema,
    phaseStartedAt: z.number().nullable(),
    spikePlantedAt: z.number().nullable().default(null),
  }),
  score: z.object({ blue: z.number(), red: z.number() }),
  spike: z.union([spikeStatusSchema, z.null()]),
  /**
   * Spike plant SITE ("A" | "B" | "C") while a spike is planted — the site
   * overlay already reads `snapshot.state.plantSite` and renders "SITE X"
   * (presentation stays in the website). GEP delivers it with the plant event
   * (`match_info` / `planted_location` / value "B" — verified live 2026-09-24);
   * cleared together with the spike lifecycle (defuse / detonation / round
   * reset), never carried into the next round.
   */
  plantSite: z.string().nullable().default(null),
  killfeed: z.array(killfeedEntrySchema).max(25),
  /** Round-settlement banner: "Ace" | "Clutch" | "Flawless" | "Team Ace" | "Thrifty" | "Round Win" | null. */
  gameEvent: z.string().nullable().default(null),
  /**
   * PASS 7C — the settled round the `gameEvent` label belongs to.
   *
   * The label stays published through the next round's buy phase (the round-win
   * banner is deliberately held on screen), so it is the ONE field that can
   * outlive its own settlement. This is the attribution authority:
   *
   *   gameEventRound === roundEnd.round   -> the label describes that winner
   *   gameEventRound === null             -> the label is not attributable
   *                                          (never pair it with a winner)
   *
   * A consumer that renders a winner-specific classification must require
   * `gameEventRound === roundEnd.round`; a mismatch would be another round's
   * label (live 2026-09-30: the enemy's round-3 ACE published with round 4's
   * blue win, and a round-9 label surviving into rounds 10+).
   */
  gameEventRound: z.number().int().positive().nullable().default(null),
  /** Overlay scene the current game data implies (drives auto scene switching). */
  scene: z.enum(["agent-select", "buy-round", "ingame-hud", "post-game"]).nullable().default(null),
  /**
   * How the most recent round ended (settled round + winner side + reason).
   * `round` is the ROUND THE RESULT BELONGS TO — the stable identity a consumer
   * must key its Game Event on (a consumer that keys on "current round + winner"
   * replays the same event when the next round starts, because the settled result
   * intentionally stays on the board through the buy phase).
   */
  roundEnd: z
    .object({
      /** The settled round's number (null only when the round was never named). */
      round: z.number().int().positive().nullable().optional(),
      winner: z.enum(["blue", "red"]).nullable(),
      reason: z.enum(["elimination", "detonation", "defusion", "time"]).nullable(),
      winnerSide: z.enum(["attacker", "defender"]).nullable().optional(),
      /** The settlement's ceremony label for THIS round (mirrors roundHistory[].label). */
      label: z.string().nullish(),
      /**
       * The round's highlight/clutch player (original-desktop parity): the agent
       * + K/D/A the ceremony card shows instead of the plain attacker/defender
       * line on a 1vX clutch.
       */
      highlightPlayer: z
        .object({
          name: z.string(),
          agent: z.string().nullable(),
          kills: z.number().nullable(),
          deaths: z.number().nullable(),
          assists: z.number().nullable(),
        })
        .nullish(),
    })
    .nullable()
    .default(null),
  /** Viewer's side this round (snapshot team startingSide ground truth). */
  viewerSide: z.enum(["attack", "defense"]).nullable().optional(),
  /** The viewer's START side (session-snapshot ground truth) — drives the side-label fallback. */
  viewerStartSide: z.enum(["attack", "defense"]).nullable().optional(),
  /** Per-round win history (ValoSpectra app-roundreasons parity, max 24). */
  roundHistory: z
    .array(
      z.object({
        round: z.number().int().positive(),
        winner: z.enum(["blue", "red"]),
        reason: z.enum(["elimination", "detonation", "defusion", "time"]),
        /**
         * Ceremony classification for THIS round when the engine settled it
         * ("Ace" | "Team Ace" | "Clutch" | "Flawless" | "Thrifty"), else null.
         * The site's round-history strip icons key on this — `reason` alone
         * (elimination/time/...) can never express a ceremony, which is why
         * history icons rendered wrong before.
         */
        label: z.string().nullish(),
      }),
    )
    .max(24)
    .default([]),
  restorePending: z.boolean().nullish(),
  updatedAt: z.number(),
  /** Authoritative observation epoch (ms) — monotonic staleness gate for consumers. */
  observedAt: z.number().default(0),
});
export type HudRelayState = z.infer<typeof hudRelayStateSchema>;

