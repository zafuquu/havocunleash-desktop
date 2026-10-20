/**
 * Tactical-timeout detection (BLOB timeoutStarted parity) — ValRoundEngine.
 *
 * GEP gives the engine only the phase fact, so a tactical timeout is the BUY
 * phase persisting past TIMEOUT_DETECT_MS (75s) in round >= 2 (round-1 buys
 * run ~100s and are guarded out). BLOB's native-clock freeze detector
 * (VALORANT_TIMER_FREEZE_MS=3s on the game timer) has no direct GEP
 * equivalent — phase persistence is it.
 *
 * Date.now is monkey-patched: the engine stamps phase entries with wall time.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ValRoundEngine } from "../dist/val-engine.js";

const realNow = Date.now;
let now = realNow();
Date.now = () => now;
after(() => {
  Date.now = realNow;
});

function withEngine(fn) {
  const engine = new ValRoundEngine();
  try {
    fn(engine);
  } finally {
    engine.reset();
  }
}

test("shopping >75s in round >= 2 detects a tactical timeout", () => {
  withEngine((engine) => {
    engine.onRoundNumber(2);
    engine.onRoundPhase("shopping");
    now += 76_000;
    const snap = engine.snapshot();
    assert.ok(snap.timeout, "timeout detected");
    assert.equal(snap.timeout.timeoutType, "tactical");
    assert.equal(snap.timeout.team, null, "GEP never attributes the caller");
    assert.equal(snap.timeout.calledAt, now, "calledAt is the detection stamp");
  });
});

test("a normal buy phase (<=75s shopping) never detects", () => {
  withEngine((engine) => {
    engine.onRoundNumber(5);
    engine.onRoundPhase("shopping");
    now += 74_000;
    assert.equal(engine.snapshot().timeout, null);
  });
});

test("any phase transition clears an active timeout (buy resumed)", () => {
  withEngine((engine) => {
    engine.onRoundNumber(3);
    engine.onRoundPhase("shopping");
    now += 76_000;
    assert.ok(engine.snapshot().timeout);
    engine.onRoundPhase("combat");
    assert.equal(engine.snapshot().timeout, null);
  });
});

test("round 1 never detects (~100s first buy must not false-fire)", () => {
  withEngine((engine) => {
    engine.onRoundNumber(1);
    engine.onRoundPhase("shopping");
    now += 90_000;
    assert.equal(engine.snapshot().timeout, null);
  });
});

test("a timeout cannot outlive TIMEOUT_MAX_MS without a transition", () => {
  withEngine((engine) => {
    engine.onRoundNumber(4);
    engine.onRoundPhase("shopping");
    now += 76_000;
    assert.ok(engine.snapshot().timeout);
    now += 66_000; // > 60s tactical + 5s grace
    assert.equal(engine.snapshot().timeout, null);
  });
});

test("a new timeout can be detected again after a resume", () => {
  withEngine((engine) => {
    engine.onRoundNumber(6);
    engine.onRoundPhase("shopping");
    now += 76_000;
    assert.ok(engine.snapshot().timeout);
    engine.onRoundPhase("combat");
    engine.onRoundPhase("shopping");
    now += 76_000;
    assert.ok(engine.snapshot().timeout, "second timeout in the same match");
  });
});

test("reset() clears the timeout and the phase stamp", () => {
  withEngine((engine) => {
    engine.onRoundNumber(7);
    engine.onRoundPhase("shopping");
    now += 76_000;
    assert.ok(engine.snapshot().timeout);
    engine.reset();
    assert.equal(engine.snapshot().timeout, null);
  });
});