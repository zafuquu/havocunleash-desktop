# Havoc Unleash — Full Data Schema & Sync Sequence

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

## 9. Production ground truth (BLOB v1.37.5 reverse audit, 2026-10-17)

Audited against the installed original (`%LOCALAPPDATA%\Programs\blob-desktop`,
userData `%LOCALAPPDATA%\BLOB`, runtime logs `BLOB\game-data-runtime\logs\
runtime.jsonl`, app logs `BLOB\blob-desktop\logs\app\session_*.jsonl`):

- The REAL runtime (`blob-game-data-runtime.exe`, standalone pkg) uses
  **`gep.direct-addon`** — `ow-electron-gep-plugin.node` loaded directly in
  Node (`pluginVersion 0.0.0.9`) — **plus** a Riot-client local API path
  (`riot_request_*` / `valorant_api_*` dominate the logs; GEP is the
  realtime supplement). The real desktop connects to its runtime as a
  "raw client" (`rawInfoListener` / `rawGameEventListener`).
- Our Electron GepPackage mode (PackageManager emulation in
  `gep-provider/gep-renderer.js`) is the supported fallback; four
  package-mode pitfalls were found and fixed (2026-10-17):
  1. `GameStatusService.init()` fetches
     `game-events-status.overwolf.com/gamestatus_prod.json` ASYNC; the
     first `gameStatusDisabled()` call races it → null status → injection
     AND `game-detected` silently skipped. Fix: instant synthetic status
     for 21640 via `window.fetch` interception.
  2. The package's non-utility game-info lookup compares a LOWERCASED
     detection name against mixed-case `processName` table entries. Fix:
     self-healing one-line patch in provider `index.js` on load.
  3. The PM's shared utility service normally supplies `options.gameId`
     to `PluginService.connect()`; without it the addon call
     `gep.connect(undefined, pid, ...)` fails ("Expected first argument to
     be game id"). Fix: `connect` wrapper maps `VALORANT-Win64-Shipping`
     → 21640.
  4. Feature requests must be the handler's own auto-default
     `["game_info","match_info","me","kill","death","gep_internal"]` —
     NOT the narrower 3-feature set (kills kill/death events = site
     killfeed/ace tracking) and NOT the full `getFeatures()` list (can be
     rejected wholesale).
- Website/overlay contract (zafuquu/HU `OverlayPopout.tsx`): three
  whole-snapshot sources — local `ws://127.0.0.1:7103/ws/broadcast`
  (`{kind:'broadcast', observedAt, snapshot}`, `?local=1`), bridge
  `wss://<bridge>/ws/live` (`?bridgeWs=` now passed by
  `overlayPopoutUrl`), Supabase mirror `site_settings live:<roomCode>`.
  Scene selection: `forceScene` > `state.scene` (whitelist
  agent-select/buy-round/ingame-hud/post-game/map-interstitial) >
  phase-derived > URL. The site assumes the ENGINE keeps the viewer on
  LEFT/blue (projection re-anchor) and must never re-swap sides.
- Known cosmetic gap (FIXED in bridge source 2026-10-18, pending Render
  redeploy): the bridge's roundWin kill-banner team resolved via `lastFacts`,
  which is null on the fork pass-through path → banner side defaulted to
  `left`. Fixed: `teamSideOf(...) ?? huWinnerSide(data.winningCompetitorId)
  ?? 'left'` — HU producers publish `winningCompetitorId` as the color side
  ('blue'→left / 'red'→right under the engine's viewer re-anchor).

## 10. Local-first data layer (Phase 1, 2026-10-18)

Rule adopted from the original app's design: **the closest authoritative copy
wins; everything upstream is a mirror.**

```
GEP package ──► projection (boot-cached) ──► snapshot.ts ──►┬─► HUD server  ──► /api/state + /ws/broadcast  (local overlay, sub-frame)
        (250ms)      (disk-backed)                           ├─► producer client ──► bridge /live/ws  (WS ~250ms, low-latency path)
                                                             ├─► bridge ──► Supabase live:<room> mirror (async, retried)
                                                             └─► bridge-state.json + live-snapshot.json (restart-proof restore)
```

- **Desktop write-through (`hudServer.ts`)** — `publishBroadcast()` persists
  the latest `{kind:'broadcast', observedAt, snapshot}` frame to
  `%APPDATA%/@havoc-unleash-desktop/state/live-snapshot.json`
  (throttled 1/s, atomic tmp+rename, failures non-fatal). `start()`
  restores it BEFORE any live publish → overlay popouts repaint instantly
  after an app restart; `stop()` does a final flush (quit loses nothing).
  RESTORED frame is only shown until the first live publish overwrites it.
- **Bridge persistence (`game-bridge.mjs` 1.2)** — the retained `/ws/live`
  frame is written to `bridge-state.json` (throttled 1/s, atomic;
  `BRIDGE_STATE_FILE` env override). Render free-plan sleep/redeploys
  repopulate popouts instantly instead of "reconnecting" until the next
  producer snapshot. Supabase keeps its own copy — this is only for the
  low-latency /ws/live path.
- **Supabase mirror retry (1.3)** — `syncSnapshotToSupabase` no longer
  log-and-forgets: writes go through `queueMirrorWrite()` (latest-wins,
  single-flight, 3 attempts × linear backoff 500/1000/1500ms). A Supabase
  hiccup can no longer silently drop the mirror while the WS path keeps
  flowing.
- **bridge-deploy/ folder was STALE** (predated control-actions.mjs) —
  resynced from root + `control-actions.mjs` added; README-DEPLOY now lists
  5 files. Render deploys the REPO ROOT (`node game-bridge.mjs`).
- **Deferred (1.4, frozen until stability lands):** LAN-first source — the
  website preferring a raw `127.0.0.1:7103/state.json` snapshot before the
  ws/broadcast channel.
- Tests: `apps/desktop/test/local-snapshot-persistence.test.mjs` (persist →
  atomic file → fresh-server restore → no-tmp). Desktop 191/191, runtime
  24/24.
