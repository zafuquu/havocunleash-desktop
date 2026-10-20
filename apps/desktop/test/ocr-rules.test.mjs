/**
 * v11 OCR rules (A) + scene stabilization (B6) tests.
 *
 * Pure-logic tests against dist — no Electron, no captures, no OCR engine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { classifyOcrFrame, nextOcrEngagement, OCR_ENGAGE_AFTER_MS, OCR_RELEASE_AFTER_MS } = await import(
  "../dist/main/ocrRules.js"
);
const { ValProjectionSession } = await import("../dist/main/projection.js");

/* ------------------------------ classify rules ------------------------------ */

const W = 1600;
const H = 900;
const now = 1_700_000_000_000;

test("LOCK IN visible -> agent-select (no timer needed)", () => {
  const c = classifyOcrFrame({
    words: [
      { t: "LOCK", x: 700, y: 800, w: 60, h: 30 },
      { t: "IN", x: 770, y: 800, w: 30, h: 30 },
    ],
    imgW: W,
    imgH: H,
    at: now,
  });
  assert.equal(c.hint, "agent-select");
  assert.equal(c.inMatch, false);
});

test("VICTORY / DEFEAT visible -> post-game", () => {
  for (const t of ["VICTORY", "DEFEAT"]) {
    const c = classifyOcrFrame({ words: [{ t, x: 600, y: 400, w: 200, h: 60 }], imgW: W, imgH: H, at: now });
    assert.equal(c.hint, "post-game", t);
  }
});

test("top-band timer >= 0:46 -> ingame-hud (can only be live combat)", () => {
  const c = classifyOcrFrame({
    words: [{ t: "1:23", x: 760, y: 40, w: 80, h: 40 }],
    imgW: W,
    imgH: H,
    at: now,
  });
  assert.equal(c.hint, "ingame-hud");
  assert.equal(c.inMatch, true);
});

test("top-band timer <= 0:45 -> hold (buy-vs-combat ambiguous, never guess)", () => {
  for (const t of ["0:40", "0:10", "0:45"]) {
    const c = classifyOcrFrame({ words: [{ t, x: 760, y: 40, w: 80, h: 40 }], imgW: W, imgH: H, at: now });
    assert.equal(c.hint, "hold", t);
    assert.equal(c.inMatch, true);
  }
});

test("timer outside the top band is ignored -> nothing confident", () => {
  const c = classifyOcrFrame({
    words: [{ t: "1:23", x: 760, y: 500, w: 80, h: 40 }],
    imgW: W,
    imgH: H,
    at: now,
  });
  assert.equal(c.hint, null);
  assert.equal(c.inMatch, false);
});

test("score numerals flanking the timer are read raw (diagnostics only)", () => {
  const c = classifyOcrFrame({
    words: [
      { t: "7", x: 640, y: 40, w: 30, h: 40 },
      { t: "1:05", x: 760, y: 40, w: 80, h: 40 },
      { t: "5", x: 930, y: 40, w: 30, h: 40 },
    ],
    imgW: W,
    imgH: H,
    at: now,
  });
  assert.deepEqual(c.score, { left: 7, right: 5 });
  assert.equal(c.hint, "ingame-hud", "1:05 >= 0:46 -> combat");
});

test("no words at all -> nothing confident", () => {
  const c = classifyOcrFrame({ words: [], imgW: W, imgH: H, at: now });
  assert.deepEqual(c, { hint: null, inMatch: false, score: null });
});

function ctx(over = {}) {
  return {
    enabled: true,
    telemetryState: "CONNECTED_BUT_NO_TELEMETRY",
    telemetryChangedAt: now - OCR_ENGAGE_AFTER_MS - 1_000,
    sessionPhase: "live",
    now,
    ...over,
  };
}

test("A4 — engages only after 30s of bad telemetry (disabled = never)", () => {
  assert.equal(nextOcrEngagement(false, ctx()), true, "bad + old change + session live");
  assert.equal(nextOcrEngagement(false, ctx({ enabled: false })), false, "toggle off (v11 default)");
  assert.equal(
    nextOcrEngagement(false, ctx({ telemetryChangedAt: now - 5_000 })),
    false,
    "within the 30s grace",
  );
  assert.equal(nextOcrEngagement(false, ctx({ sessionPhase: "idle" })), false, "no session -> no capture");
  assert.equal(nextOcrEngagement(false, ctx({ telemetryState: "HEALTHY" })), false, "healthy -> off");
});

test("A4 — releases 60s after recovery (never fights a live GEP stream)", () => {
  const justHealthy = ctx({ telemetryState: "HEALTHY", telemetryChangedAt: now - 5_000 });
  assert.equal(nextOcrEngagement(true, justHealthy), true, "grace period hands back smoothly");
  const longHealthy = ctx({ telemetryState: "HEALTHY", telemetryChangedAt: now - OCR_RELEASE_AFTER_MS - 1 });
  assert.equal(nextOcrEngagement(true, longHealthy), false, "recovered for 60s -> release");
  assert.equal(nextOcrEngagement(true, ctx({ sessionPhase: "idle" })), false, "session ended -> release now");
});

test("A4 — an engaged controller keeps capturing through telemetry blips", () => {
  const freshBad = ctx({ telemetryChangedAt: now - 5_000 });
  assert.equal(nextOcrEngagement(true, freshBad), true, "prev stays true within the bad state");
});

/* --------------------------- B6 scene stabilization --------------------------- */

test("B6 — default (0ms): every scene transition is immediate (historical contract)", () => {
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "stab-0", mapKey: "ascent" });
  p.applyFact("round_number", 6);
  p.applyFact("round_phase", "combat");
  assert.equal(p.snapshotValue().scene, "ingame-hud", "immediate switch with stabilization off");
});

test("B6 — production dwell: an oscillating candidate cannot flip the published scene", () => {
  const p = new ValProjectionSession(700);
  p.applySnapshot({ sessionPhase: "live", matchId: "stab-1", mapKey: "ascent" });
  p.applyFact("round_number", 1);
  p.applyFact("round_phase", "shopping");
  const first = p.snapshotValue().scene;
  assert.equal(first, "buy-round", "first commit lands instantly (no prior scene)");
  // Oscillate inputs the way a provider re-arm burst does, within the dwell.
  p.applyFact("round_phase", "combat");
  assert.equal(p.snapshotValue().scene, "buy-round", "candidate younger than 700ms is held back");
  p.applyFact("round_phase", "shopping");
  assert.equal(p.snapshotValue().scene, "buy-round", "oscillation back to committed -> stable");
});

test("B6 — a sustained candidate commits after the dwell", async () => {
  const p = new ValProjectionSession(100);
  p.applySnapshot({ sessionPhase: "live", matchId: "stab-2", mapKey: "ascent" });
  p.applyFact("round_number", 3);
  p.applyFact("round_phase", "shopping");
  assert.equal(p.snapshotValue().scene, "buy-round");
  p.applyFact("round_phase", "combat");
  assert.equal(p.snapshotValue().scene, "buy-round", "held");
  await new Promise((r) => setTimeout(r, 130));
  assert.equal(p.snapshotValue().scene, "ingame-hud", "same candidate after 130ms -> commits");
});

/* --------------------------- A5 OCR reading channel --------------------------- */

test("A5 — fresh OCR readings drive the scene; clearing restores GEP logic", () => {
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "ocr-1", mapKey: "ascent" });
  p.applyOcrReading({ hint: "ingame-hud", at: Date.now() });
  assert.equal(p.snapshotValue().scene, "ingame-hud", "fresh OCR hint wins over the identity-only fallback");
  p.applyOcrReading(null);
  const st = p.snapshotValue();
  assert.notEqual(st.scene, "ingame-hud", "cleared OCR falls back to deriveScene evidence");
});

test("A5 — an OCR hint older than 30s expires (never stale-control the scene)", () => {
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "ocr-2", mapKey: "ascent" });
  p.applyOcrReading({ hint: "post-game", at: Date.now() - 31_000 });
  assert.notEqual(p.snapshotValue().scene, "post-game", "expired hint ignored");
});
