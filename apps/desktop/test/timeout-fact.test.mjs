/**
 * Tactical timeout fact path (BLOB timeoutStarted parity) — projection.
 *
 * The runtime's buy-phase freeze detector emits `timeout_changed` facts; the
 * projection stores them on relay state and the hudServer copies
 * state.timeout to the broadcast frame's `timeout` field (what the website's
 * TimeoutOverlay reads). Pins the desktop half of the chain:
 *   - active:true stores {team, calledAt, timeoutType} verbatim
 *   - team "left"/"right" passes through; anything else -> null (neutral
 *     banner — GEP never attributes the calling team)
 *   - active:false clears
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { ValProjectionSession } = await import("../dist/main/projection.js");

test("timeout_changed active:true stores and publishes the timeout", () => {
  const p = new ValProjectionSession();
  const calledAt = Date.now() - 5_000;
  p.applyFact("timeout_changed", { active: true, calledAt, timeoutType: "tactical", team: null });
  const s = p.snapshotValue();
  assert.deepEqual(s.timeout, { team: null, calledAt, timeoutType: "tactical" });
});

test("team attribution passes through; unknown values -> null", () => {
  const p = new ValProjectionSession();
  p.applyFact("timeout_changed", { active: true, calledAt: 1, timeoutType: "tactical", team: "left" });
  assert.equal(p.snapshotValue().timeout.team, "left");
  p.applyFact("timeout_changed", { active: true, calledAt: 2, timeoutType: "tactical", team: "Blue" });
  assert.equal(p.snapshotValue().timeout.team, null);
});

test("active:false clears the timeout", () => {
  const p = new ValProjectionSession();
  p.applyFact("timeout_changed", { active: true, calledAt: 1, timeoutType: "tactical", team: null });
  p.applyFact("timeout_changed", { active: false, calledAt: null, timeoutType: null, team: null });
  assert.equal(p.snapshotValue().timeout, null);
});

test("tech_pause variant is preserved for operator-triggered pauses", () => {
  const p = new ValProjectionSession();
  p.applyFact("timeout_changed", { active: true, calledAt: 9, timeoutType: "tech_pause", team: null });
  assert.equal(p.snapshotValue().timeout.timeoutType, "tech_pause");
});

test("a missing calledAt falls back to the current time", () => {
  const p = new ValProjectionSession();
  const before = Date.now();
  p.applyFact("timeout_changed", { active: true, calledAt: null, timeoutType: "tactical", team: null });
  const t = p.snapshotValue().timeout;
  assert.ok(t.calledAt >= before, "calledAt stamped now when the fact omits it");
});