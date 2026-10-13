/**
 * Phase 3 — HUD route crash containment — live incident 2026-09-24.
 *
 * Captured live from the frozen app's own modal dialog (PID 24720, hwnd #32770):
 *
 *   Uncaught Exception:
 *   ZodError: [{ code: "too_big", maximum: 10, path: ["roster"] }]
 *       at _ValProjectionSession.build
 *       at _ValProjectionSession.snapshotValue
 *       at Object.status                       ← shellControls.status()
 *       at HudServer.route                     ← GET /api/status
 *       at Server.<anonymous>                  ← http request listener
 *
 * The throw escaped the HTTP request listener as an UNCAUGHT exception, so
 * Electron showed its blocking "A JavaScript error occurred in the main
 * process" dialog: the main thread never returned, publishing stopped, the
 * bridge mirror/presence froze and the website/OBS stayed empty while the app
 * still painted its last frame.
 *
 * Required behaviour under test:
 *   - a throwing handler answers HTTP 500 instead of taking the process down;
 *   - the server keeps serving every other route afterwards;
 *   - a healthy handler is unaffected (200 + JSON).
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-hud-crash-"));
process.env.LOCALAPPDATA = fixtureDir;
process.env.TEMP = fixtureDir;
process.env.TMP = fixtureDir;

const { HudServer } = await import("../dist/main/hudServer.js");

const PUBLIC_DIR = fs.mkdtempSync(path.join(fixtureDir, "public-"));

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const noopControls = () => ({
  status: () => ({ signedIn: false }),
  startSignIn: () => {},
  listRooms: async () => [],
  joinRoom: async () => ({ ok: true }),
  leaveRoom: async () => ({ ok: true }),
  resetNetwork: async () => ({ ok: true }),
  toggleOverlay: async () => ({ on: false }),
});

test("H1 — a throwing handler answers 500 and the server keeps serving", async () => {
  const port = await freePort();
  const controls = {
    ...noopControls(),
    // The exact live shape: the projection threw while the status was built.
    status() {
      throw new Error('ZodError: [{ "code": "too_big", "path": ["roster"] }]');
    },
  };
  const hud = new HudServer(port, PUBLIC_DIR, controls);
  await hud.start();
  try {
    const failed = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(failed.status, 500, "the defect is contained as a 500 response");
    assert.deepEqual(await failed.json(), { ok: false, error: "internal" });

    // The uncaught-throw path used to wedge the whole app: prove the server
    // survived and still answers other routes.
    const after = await fetch(`http://127.0.0.1:${port}/api/broadcast`);
    assert.equal(after.status, 200, "the server still serves after the failure");
  } finally {
    await hud.stop();
  }
});

test("H2 — a healthy status route is unaffected", async () => {
  const port = await freePort();
  const hud = new HudServer(port, PUBLIC_DIR, noopControls());
  await hud.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { signedIn: false });
  } finally {
    await hud.stop();
  }
});
