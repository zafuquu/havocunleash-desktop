# Architecture — audit hand-off map

How this fork mirrors the audited HAVOC Desktop (v1.28.38) component-for-component.

| Audited upstream | This repo | Notes |
|---|---|---|
| `havoc-game-data-runtime.exe` (Bun; ow-electron + GEP 312) | `services/game-data-runtime` | Same HTTP+SSE contract (`/health`, `/events`, bootstrap-first `valorant_session_snapshot`). Swap `MockValorantSource` for an `@overwolf/ow-electron` adapter. |
| `GameDataRuntimeClient` (health gate, SSE parse, revision monotonicity, exp. backoff 1→30s ×6, invalid_bootstrap fatal) | `apps/desktop/src/main/runtimeClient.ts` | Accepts both observed upstream dialect (`phase`, nested `session.matchId/map.key/teams/viewer`) and fork dialect. |
| `ValObservationProcessor` + `ValorantProjectionSession` round pairing | `apps/desktop/src/main/projection.ts` | Backwards-phase-holds-for-number rule, stale-`end` drop, match-scoped score repair, killfeed ring, spike state machine. |
| LocalGateway `:7150` (CS2 GSI ingest w/ token+body cap; `/activate`; `/debug` WS) | `apps/desktop/src/main/gateway.ts` | Adds port-collision hop (+0..9) so it coexists with a running upstream app. |
| HUD origin `havocunleashs.vercel.app` / dev `:7103` | `apps/hud` served by `hudServer.ts` | `/api/state` REST + `/ws` retained-latest push; val-classic-style components (score-line/game-events/alive, team colors #28D091/#FF3549). |
| `havoc-windows-native-host.exe` (named pipe; window bounds, place-window-above, priorities, UDP reset) | `apps/desktop/src/main/win32.ts` (koffi/user32) | In-process subset: FindWindow/GetWindowRect/IsIconic/SetWindowPos insert-after. Priorities & UDP-handle reset are TODO follow-ups (need privileged helper). |
| `AnchoredTransparentWindow` (poll 1000ms, click-through forward, hide-on-minimized/missing, show-delay) | `index.ts followGameWindow()` | Poll interval parity at 1 s; z-order insert directly above game hwnd. |
| Tray/tokens/Discord/OCR/observer-guard | not replicated | Out of Path-B scope; contracts remain in `packages/contracts` if needed later. |

## Ports

| Port | Owner |
|---|---|
| 7423 | fork runtime API/SSE (upstream uses 7413) |
| 7150–7159 | local gateway (first free; upstream owns 7150 while running) |
| 7103 | HUD pages (same as upstream dev overlays port) |
| 7180 | the replica Node bridge (`G:\HU\server\game-bridge.mjs` / bridge-deploy) |
| 7190 | local mock bridge (CI smoke only, `scripts/mock-bridge.cjs`) |

## Path A — HAVOC production-producer replica

The desktop app now implements the full producer pipeline that the audited
original used against the cloud, wired to your replica pieces:

| Desktop module | Talks to | Contract |
|---|---|---|
| `auth.ts` | `{appBase}/auth/login` + `{bridge}/electron/token` | PKCE S256 + `havoc-desktop://` deep link; bridge mints session cookie |
| `trpc.ts` | `{bridge}/api/trpc/*` | `realtime.desktopRooms` / `desktopRequestAccess` / `desktopProducerTicket` / `rooms.getLimitsOfRoom` (batch `[{result:{data:{json}}}]`) |
| `producer.ts` | `{bridge}/api/socket/io` (Socket.IO, `auth:{ticket}`) | `game-data:producer:claim` `protocolVersion:3` → ack; publishes `game-data:fallback` snapshots |
| `snapshot.ts` | bridge fallback | maps `HudRelayState` → `state.leftTeam/rightTeam/currentRound/players` (what `extractScores` + `OverlayPopout` read) |
| `index.ts` | orchestration | register protocol, PKCE sign-in, restore session (safeStorage), connect producer, publish on change, overlay windows to `{appBase}/<room>/<overlay>?isPopout=true` |

The bridge (not the desktop) write presence (`desktop:<room>` @5s) and the live
mirror (`live:<room>`) + `tournament_matches` into Supabase — matching real
HAVOC's separation. So the desktop only needs auth + producer.

Follow the repo's `scripts/mock-bridge.cjs` + `HAVOC_DEV_SESSION=1` to run
the whole loop locally against a fake bridge; point `HAVOC_BRIDGE_ORIGIN`
at `G:\HU\server\game-bridge.mjs` for a real, Supabase-backed run.

## Known limitations / next steps

1. `win32Bridge:false` inside Electron: koffi prebuilt targets Node ABI;
   run `@electron/rebuild -f -w koffi` or move the user32 calls into an
   Electron-ABI napi module.
2. WebRTC path (channel `havoc-overlay-v3-reliable`) is available in the bridge
   but the desktop currently publishes via `game-data:fallback` (same Supabase
   effect, no native wrtc dependency). Add `@roamhq/wrtc` + the answer flow if
   frame-exact RTC delivery is needed.
3. Alive pips are static until roster live-data drives the HUD render path.
4. OCR data source and observer/UDP socket-reset have no equivalent yet.


## Repro commands

```powershell
npm install
npm run build            # contracts -> runtime -> desktop
npm run dev              # GUI loop (auto-spawned mock capture service)
npx electron .           # after build, from apps/desktop
node scripts/integration.mjs http://127.0.0.1:7423 15000   # headless E2E vs own runtime
node scripts/integration.mjs http://127.0.0.1:7413 20000   # E2E against a REAL capture service
HAVOC_SMOKE_QUIT_MS=12000 npx electron .               # CI-style boot smoke
```
