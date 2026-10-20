# BLOB Desktop Deep Audit (app.asar, v1.37.5)

Method: `resources/app.asar` (41MB) extracted with `@electron/asar`; webpack
source maps (`*.js.map`, 3.2MB+) contain the ORIGINAL TypeScript via
`sourcesContent` — 385 source modules recovered. Extracted copies live in
`Havoc Unleash\audit\extracted\` (helper: `audit\extract-modules.js <substr> <outDir>`);
the module inventory is `audit\blob-sources.txt`.

This document records what the earlier runtime/log audit (DATA-SYNC.md §9)
could not see: the desktop app's real module structure, config contracts, and
subsystems.

---

## 1. Module map (385 modules)

| Subsystem | Modules | HU parity |
|---|---|---|
| bootstrap (module-runner, desktop-module, cleanup-registry, app-paths) | 12 | REA already mirrored (config/trpc/producer) |
| auth (desktop-auth.service, desktop-protocol, auth-ipc) | 5 | ✅ mirrored (PKCE + `havoc-desktop://`) |
| runtime-storage (desktop-runtime-storage, paths, legacy-migration) | 3 | ✅ Phase 1 mirrors the pattern (§4) |
| broadcast-session (producer, stop-coordinator, game-data-producer-connection) | ~6 | ✅ mirrored (REA) |
| rooms / realtime (current-room-access, feature gates, socket relay) | ~8 | ✅ mirrored (tRPC access flow) |
| local-gateway (config, activation-client) | 2 | ✅ port-parity (§5) |
| windows-native-host (registry, launcher, bridge, session, elevate) | 6 | partial: win32.ts (window placement only) |
| valorant network-control (observer-guard, socket-reset) | 4 | ❌ not mirrored — guard our RUNTIME socket only exists in fork path |
| valorant screen-reading (glyph/visual samples, screen-reading.service) | 4 | ❌ not mirrored — OCR path is premium (ocrVALORANT gate) |
| valorant recording/replay (valorant-recording, replay-playback, recorded-game-clock, input-capture) | 7 | ❌ not mirrored — match record & replay pipeline |
| discord-voice-capture (discord API, captcha, provisioning, voice ingress, credential store) | ~30 | ❌ not mirrored — auto-provisions Discord apps, captures voice |
| counter-strike (GSI adapter, projection session, observer bindings) | ~10 | ❌ not mirrored (CS2 out of scope) |
| rocket-league (stats-api client, projection) | ~4 | ❌ not mirrored |
| deadlock (observer-source, decoder exes, projection) | ~10 | ❌ not mirrored (ships 76MB observer exe) |
| overlay-configs (val-v2/classic/bean/ccl/scc/giblet/kazo/noona, cs2, rl, scc) | ~20 | △ our site has its own scene system; presets are dashboard-side |
| access/capability catalog + room feature gates | 6 | △ informational (§3) |
| ipc contracts (typed router, 30+ domains) | ~40 | partial (REA mirrored the ones HU needs) |
| app-shell (main-window, tray, updater, announcements, shutdown) | ~10 | △ no auto-updater/tray in HU |
| discord session, hotkeys, debug overlay, security, logger/redaction | ~15 | ✅ logger/redaction mirrored |

Key insight: BLOB is a MULTI-GAME platform where every game = one
`data-source adapter` + one `projection session`. This is exactly the Phase 3
hybrid-adapter shape HU is adopting (§6).

## 2. state/config.json — the USER-STATE store (runtime, `%LOCALAPPDATA%\BLOB\blob-desktop\state\config.json`)

It is NOT the launch config (that is `main-config.ts`, env-driven). It is a
per-user state store written by the renderer:

```
{
  userProfiles: { [userId]: {
    quickJoinRooms: [],
    roomData: {
      overlayId: "ingame-hud" | "val-classic" | ...,   // preset chosen in dashboard
      roomId, roomName, roomGame: "VAL", requestId, status: "accepted",
      accessExpiresAt?: iso,
      roomLimits?: { specialLimits: {}, features: {...}, maxFileSize,
                     maxPlayersPerTeam, maxRooms, maxSeats, maxSponsors,
                     maxTeams, seatsPerRoom }
    },
    roomHudModes: { [roomId]: hudMode },
    userRooms: [{ id, name, game, eventOrganizer }]
  }},
  appIdentity: { machineId },
  appPreferences: { hasSeenDesktopTour, hideHudWindowedFullscreenWarning,
                    launchGameFromBlob,
                    overlayAnchor: { displayId, type: "display", useWorkArea } },
  userData: { userId, userEmail, userName },
  __desktopAuth: "<safeStorage-encrypted token blob>"
}
```

Notes:
- `overlayId` is the per-room OVERLAY PRESET (`ingame-hud` = live HUD,
  `val-classic` = classic scoreboard). HU's website picks scenes from the
  snapshot instead — equivalent behavior, different owner (site vs desktop).
- `roomHudModes[roomId]` = HUD mode per room (empty on this machine — the
  feature exists but stayed default).
- `__desktopAuth` is safeStorage-encrypted in the same file — matches HU's
  safeStorage session store. ✅
- `appPreferences.overlayAnchor` PERSISTS the last overlay anchor (display id
  + work-area mode). HU has `HAVOC_ANCHOR_OVERLAY` env only — optional
  follow-up: persist the anchor choice the same way.

## 3. roomLimits / feature gates (entitlement tree)

`roomFeatureGates.ts`: gates resolve from `roomLimits` —
`specialLimits.{discordVoiceComms, gameDataReplay, hotkeys, screenSwitching,
ocrVALORANT}`, arbitrary path booleans, and all/any combinators. The live
tree (seen in config.json) covers per-game component entitlements
(`features.val.ingameHud.{scoreline,teamStats,economyInsight,...}`, overlays,
transitions, customAssets) plus `max*` caps. HU reads limits through
`rooms.getLimitsOfRoom` (REA-parity ✅); the full entitlement tree is
informational for now — the site gates components itself.

## 4. Local-first storage pattern (validated)

`DesktopRuntimeStorage` owns `%LOCALAPPDATA%\BLOB\blob-desktop\{state,
chromium,logs,run,updates,crashes}`; `app.setPath('userData', state)` before
anything can observe a partial layout; legacy `%APPDATA%\blob-desktop`
migration is staged (tmp + rename + rollback) and validated (JSON/UUID)
before one-way cleanup. HU Phase 1 (DATA-SYNC.md §10) follows the same
principle at its layer: closest authoritative copy on disk (broadcast frame,
bridge frame), atomic tmp+rename, throttled, restore-before-publish.

## 5. Ports & identity (desktop-identity.ts)

| Port | BLOB stable | BLOB canary | HU |
|---|---|---|---|
| game-data-runtime | 7413 | 7414 | 7423 (built-in), 7413 when `HAVOC_CAPTURE_EXE` hybrid |
| local gateway | 7150 | 7151 | 7155 (`HAVOC_GATEWAY_PORT`; fork value, REA-approved) |
| devtools debugging | 7191 | 7192 | n/a |
| renderer | (rendererPort) | — | 7103 (`HAVOC_APP_PORT`/`HAVOC_HUD_PORT` — website local source) |

Protocol `blob-desktop` ↔ `havoc-desktop`; storage name `blob-desktop` ↔
`@havoc-unleash-desktop`. Canary = fully separate identity (ports, storage,
protocol) — HU single-channel, N/A.

## 6. Config/security patterns worth keeping

- **Env allowlist for child processes** (`createElectronChildEnvironment`):
  children inherit ONLY OS/session plumbing keys, app secrets never. HU's GEP
  launcher currently passes a filtered env (ELECTRON_* strip) — adopting the
  explicit-allowlist form is a cheap hardening follow-up.
- **Public-env schema** (`desktop-public-config.ts`): only TURN credentials
  cross build→install, zod-validated, absent values never inherit.
- **Diagnostic capture policy** (`raw-game-data-capture-policy.ts` +
  `--capture-raw-game-data`): per-game opt-in raw packet capture for support.
- **Multi-source adapter shape**: per game, `data-source adapter` →
  `projection session` → relay. Valorant adapters: direct-addon (riot client
  API), OCR screen-reading (premium), recording/replay. HU equivalent:
  GEP-package emulator / hybrid native runtime / mock — see ARCHITECTURE.md
  §Data sources.

## 7. Follow-ups adopted / deferred

- ✅ No parity FIXES required by this audit — REA + Phase 1 stand.
- Optional: persist `overlayAnchor` like `appPreferences.overlayAnchor`.
- Optional: child-env explicit allowlist for the GEP host launcher.
- Deferred: valorant observer-guard/socket-reset semantics only matter if the
  runtime path regresses (Phase 4 test will reveal).
- HU does not mirror: discord-voice-capture, CS2/RL/Deadlock, OCR,
  recording/replay, auto-updater, tray, announcements, hotkeys.