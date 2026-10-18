# Havoc Unleash

Havoc Unleash desktop app — self-contained:

```
services/game-data-runtime   :7423  /health + /events SSE
      (mock Valorant provider; swap in Overwolf GEP adapter here)
apps/desktop                 Electron shell
      GameDataRuntimeClient  -> consumes :7423 SSE (bootstrap-first, revision gate)
      ValProjectionSession   -> facts -> HUD state (round pairing rules)
      LocalGateway    :7150  -> CS2 GSI ingest point (POST /gsi/cs2)
      HudServer       :7103  -> static HUD + /api/state + WS /ws push
      Anchored overlay       -> transparent click-through window that follows the
                                "VALORANT" window via koffi/user32 and inserts itself
                                directly above it in z-order; hides when minimized/absent
apps/hud                     OBS-ready page (score-line / game-events / alive)
packages/contracts           shared zod wire schemas
```

## Run

```powershell
npm install            # workspaces; downloads Electron + koffi prebuilts
npm run dev            # runtime child is auto-spawned by the desktop app
# desktop flags:
#   --show-hud                 open a normal preview window of the HUD
# env:
#   HAVOC_EXTERNAL_RUNTIME=1     attach to an ALREADY-RUNNING runtime
#   HAVOC_RUNTIME_PORT=7413      e.g. point at a real capture service
#   HAVOC_GAME_WINDOW_TITLE="VALORANT"
#   HAVOC_SMOKE_QUIT_MS=8000     headless CI smoke exit
#   HAVOC_APP_WINDOW=hidden      boot in the background (shell appears on
#                                second launch); also "visible" (default) | "overlay"
#   HAVOC_APP_PORT=7103          alias for HAVOC_HUD_PORT (reference name)
```

For OBS: add a browser source -> `http://127.0.0.1:7103/` sized to your canvas.
The in-game overlay appears only while a live VALORANT session exists and hides otherwise.

Parity map to the audited upstream lives in `/docs` after the audit hand-off;
wire envelopes (`valorant_session_snapshot`, `new_info_update`, ...) match the
shapes observed on the real service so either can feed this stack.
