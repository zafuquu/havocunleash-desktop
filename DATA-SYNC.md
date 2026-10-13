# HAVOC Desktop Replica — Full Data Schema & Sync Sequence

This document is the authoritative contract that ties the desktop app, the
game-data (Overwolf GEP) runtime, the bridge, and the website overlay together.
Every field the site's `OverlayPopout` / scenes read, and every value the
desktop produces, is defined here.

---

## 1. The pipeline (end to end)

```
Valorant
  └─ Overwolf GEP (gep_valorant.dll via @overwolf/ow-electron)   [real capture]
        │   info updates + new events (game_info, match_info, kill,
        │   roster, player, round, score, spike)
        ▼
   game-data-runtime (HTTP service :7423)                        [src/server.ts]
        │   gep-capture.ts normalizes OW → runtime facts
        │   mock-source.ts  (deterministic feed when Overwolf absent)
        ▼  SSE /events   (bootstrap frame = valorant_session_snapshot)
   desktop main (Electron)                                        [src/main]
        │   runtimeClient.ts → projection.ts (round pairing, settlement
        │   classification, MVP, scene derivation)
        ▼  state.scene + per-player detail
   bridge (server/game-bridge.mjs)  →  Supabase live:<room>
        ▼
   website OverlayPopout  →  scene components (agent-select/buy-round/ingame-hud/post-game)
```

## 2. Relay state schema (the single source of truth the site reads)

The desktop publishes `state` into the live snapshot. The site reads it as
`liveScores.snapshot.state`. Workers:

```ts
{
  game: "VAL",
  sessionPhase: "idle" | "loading" | "live",
  matchId: string | null,
  mapKey: string | null,          // internal e.g. "ascent"
  mapName: string | null,         // friendly e.g. "Ascent"
  scene: "agent-select" | "buy-round" | "ingame-hud" | "post-game" | null,
  gameEvent: string | null,       // "Ace"|"Clutch"|"Flawless"|"Team Ace"|"Thrifty"|"Round Win"
  match: { winner: "blue"|"red"|null, mvp: Mvp | null },
  score: { blue: number, red: number },          // current in-game score
  currentRound: { roundNumber: number },
  players: Player[],                              // both teams, per-player
  killfeed: KillFeedEntry[],
}
```

## 3. Per-player detail (weapon / gun / skill / currency / scoreline)

The site's `OverlayPopout` maps each player via `agentName, weapon, credits,
spentCredits, kills, deaths, assists, isAlive, health, ultPoints/ultMax,
abilities, hasSpike` (with fallbacks). The desktop produces these from
scoreboard observations:

| Site field | Publish source | Provider (real GEP field) |
|---|---|---|
| `agentName` | session roster | `roster.character` / `player.character` |
| `weapon`/`loadout` | scoreboard `weapon` | `player.weapon` / weapon_name |
| `credits`/`spentCredits` | scoreboard credits/spentCredits | `player.money` / `player.spent` |
| `kills/deaths/assists` | scoreboard k/d/a | `player.kills/deaths/assists` |
| `isAlive`/`health` | scoreboard | `player.alive` / `player.health` |
| `ultPoints`/`ultMax` | scoreboard | `player.ult_points/ult_max` |
| `hasSpike` | scoreboard | `player.has_spike` |
| `abilities` | (UI) | static kit list |

## 4. Round-end / match events

- **Round win types** (Ace/Clutch/Team Ace/Flawless/Thrifty) are classified in
  `projection.ts → settle()` from round kill data (ported from the original
  `val-round-settlement.ts`).
- **MVP**: at match end (score ≥ 13) the player with the most kills is emitted
  as `match.mvp`; `match.winner` is the side that reached 13. The site's
  post-game scene reads both.

## 5. Scene switching

`projection.ts → deriveScene()`:

| game phase | scene |
|---|---|
| `sessionPhase === "loading"` / agent select | `agent-select` |
| `roundPhase === "shopping"` | `buy-round` |
| `roundPhase === "combat"` | `ingame-hud` |
| score ≥ 13 | `post-game` |

The site (`OverlayPopout.tsx`) lets `liveSnapshot.state.scene` override the
URL `?screen=` so OBS sources auto-follow the match.

## 6. GEP ↔ runtime fact mapping (gep-format.ts)

FormattingService was ported as `gep-format.ts`. It normalizes Overwolf's
internal identity keys (agents/weapons/maps) and converts raw info rows into
the exact runtime keys the projector consumes. `gep-capture.ts` subscribes to
`@overwolf/ow-electron` (`getRunningGameInfo`, `setRequiredFeatures`,
`registerInfoUpdates2`, `registerNewEvents`) and routes facts through the same
SSE pipeline.

## 7. Sequence (one match)

1. `sessionPhase=loading` → scene `agent-select`.
2. `map`/`match_id` arrive → `sessionPhase=live`, `mapKey/mapName` set.
3. `round_phase=shopping` → scene `buy-round`; player scoreboard rows feed
   weapon/credits/ult.
4. `round_phase=combat` → scene `ingame-hud`; killfeed + live score updates.
5. `round_phase=end` → classify round win type → `gameEvent`.
6. `score≥13` → scene `post-game`, `match.winner` + `match.mvp`, player stats.

## 8. Env grep the desktop honors (matching the original app)

`HAVOC_DESKTOP_API_ORIGIN`, `HAVOC_DESKTOP_REALTIME_ORIGIN`,
`HAVOC_DESKTOP_LOGIN_ORIGIN`, `HAVOC_DESKTOP_OVERLAY_ORIGIN`,
`HAVOC_DESKTOP_SKIP_LOGIN` (bypass), plus fork-specific
`HAVOC_ROOM_ID`, `HAVOC_SCENARIO` (mock event),
`HAVOC_SOURCE=overwolf` (use real GEP when available).