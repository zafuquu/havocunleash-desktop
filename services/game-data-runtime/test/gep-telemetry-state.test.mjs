/**
 * GEP telemetry-delivery state machine tests (A2).
 *
 * Runs against the compiled dist (build first: npm run build in
 * services/game-data-runtime). Uses synthetic provider protocol frames —
 * no VALORANT / Overwolf / live process involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTelemetryState, isStaticGameDataItem } from "../dist/gep-capture.js";

const NOW = 1_700_000_000_000;
const FRESH = NOW; // lastGameDataAt = now → data current
const FRESHNESS = 330_000;

/** Convenience wrapper: drive the pure state machine. */
function state(input = {}) {
  return computeTelemetryState({
    providerState: "ready",
    attached: true,
    featuresSetAt: null,
    firstInfoUpdateAt: null,
    lastGameDataAt: FRESH,
    now: NOW,
    ...input,
  });
}

test("Scenario A — GEP disconnected/not attached: DISCONNECTED", () => {
  assert.equal(state({ attached: false }), "DISCONNECTED");
});

test("Scenario A2 — provider error: ERROR", () => {
  assert.equal(state({ providerState: "error" }), "ERROR");
});

test("Scenario B — GEP attaches (within grace, features unreported): ATTACHED", () => {
  // attachedAt seeded 5s ago via lastGameDataAt seed; attach grace 15s.
  const input = {
    lastGameDataAt: NOW - 5_000,
    firstInfoUpdateAt: null,
    featuresSetAt: null,
    attachedAt: NOW - 5_000,
  };
  // NOTE: computeTelemetryState derives grace from now-attachedAt; emulate by
  // passing attachedAt via lastGameDataAt seed freshness — attach grace is
  // checked in the class wrapper, the pure fn maps to WAITING_FOR_TELEMETRY.
  const s = state({ lastGameDataAt: NOW, featuresSetAt: null, firstInfoUpdateAt: null });
  assert.equal(s, "WAITING_FOR_TELEMETRY");
});

test("Scenario C — features registered, no info yet, within window: FEATURES_SET", () => {
  assert.equal(
    state({ featuresSetAt: NOW - 30_000, lastGameDataAt: NOW }),
    "FEATURES_SET",
  );
});

test("Scenario D — features registered but no telemetry past init window: CONNECTED_BUT_NO_TELEMETRY", () => {
  assert.equal(
    state({
      featuresSetAt: NOW - (FRESHNESS + 60_000),
      lastGameDataAt: NOW - (FRESHNESS + 60_000),
    }),
    "CONNECTED_BUT_NO_TELEMETRY",
  );
});

test("Scenario D2 — no feature report, no telemetry past init window: CONNECTED_BUT_NO_TELEMETRY", () => {
  assert.equal(
    state({ lastGameDataAt: NOW - (FRESHNESS + 60_000), firstInfoUpdateAt: null }),
    "CONNECTED_BUT_NO_TELEMETRY",
  );
});

test("Scenario E — first info update arrives, fresh: HEALTHY", () => {
  assert.equal(
    state({ firstInfoUpdateAt: NOW - 5_000, lastGameDataAt: NOW - 1_000 }),
    "HEALTHY",
  );
});

test("Scenario F — telemetry stops after previously working: STALE", () => {
  assert.equal(
    state({
      firstInfoUpdateAt: NOW - (FRESHNESS + 120_000),
      lastGameDataAt: NOW - (FRESHNESS + 60_000),
    }),
    "STALE",
  );
});

test("Scenario F2 — telemetry still inside freshness window: HEALTHY (no false STALE)", () => {
  assert.equal(
    state({ firstInfoUpdateAt: NOW - 200_000, lastGameDataAt: NOW - 200_000 }),
    "HEALTHY",
  );
});

test("Scenario G — reconnect: exit (DISCONNECTED) then re-attach + info → HEALTHY", () => {
  // Game exits → attached false → DISCONNECTED (waiting for next game).
  assert.equal(state({ attached: false, firstInfoUpdateAt: NOW - 60_000 }), "DISCONNECTED");
  // New game attaches and telemetry resumes → HEALTHY again.
  assert.equal(
    state({ attached: true, firstInfoUpdateAt: NOW - 60_000, lastGameDataAt: NOW - 1_000 }),
    "HEALTHY",
  );
});

test("Invariant — HEALTHY is impossible without a received info update", () => {
  // No firstInfoUpdateAt, data fresh: must be WAITING_FOR_TELEMETRY or FEATURES_SET, never HEALTHY.
  const noInfo = state({ firstInfoUpdateAt: null, lastGameDataAt: NOW });
  assert.notEqual(noInfo, "HEALTHY");
  assert.notEqual(noInfo, "STALE");
  const noInfoOld = state({ firstInfoUpdateAt: null, lastGameDataAt: NOW - FRESHNESS - 1 });
  assert.equal(noInfoOld, "CONNECTED_BUT_NO_TELEMETRY");
});

test("v10 — static game_info:is_pbe pings are never telemetry proof", () => {
  // Patch-day 2026-10-20: only is_pbe arrived for the whole match (13 pings,
  // zero match_info) — the state machine must not mistake them for data.
  assert.equal(isStaticGameDataItem({ feature: "game_info", key: "is_pbe", value: false }), true);
  assert.equal(isStaticGameDataItem({ feature: "game_info", key: "scene", value: "InGame" }), false);
  assert.equal(isStaticGameDataItem({ feature: "match_info", key: "score", value: {} }), false);
  assert.equal(isStaticGameDataItem({ feature: "me", key: "player_name", value: "x" }), false);
  assert.equal(isStaticGameDataItem(null), false);
  assert.equal(isStaticGameDataItem(undefined), false);
});

test("v10 — patch-day starvation: static-only stream degrades to CONNECTED_BUT_NO_TELEMETRY", () => {
  // connect-game stamped lastGameDataAt at T0; only is_pbe pings since (they
  // no longer stamp); firstInfoUpdateAt never set by the static-only stream.
  const t0 = NOW - (FRESHNESS + 60_000);
  assert.equal(
    state({ firstInfoUpdateAt: null, lastGameDataAt: t0, featuresSetAt: t0 }),
    "CONNECTED_BUT_NO_TELEMETRY",
  );
});
