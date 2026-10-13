/**
 * Phase 2 — boot-cache provenance (desktop projection) — MUS-2 `fix(state)`.
 *
 * Reproduces the observed cold-boot defect: the disk mirror of the PREVIOUS
 * match (%TEMP%\havoc-unleash-last-state.json, observed on the machine carrying
 * an "0-2 / Ascent" board) was applied to authoritative state, and the FIRST
 * provider frame then cleared the unconfirmed flag — so a finished match was
 * published as the live game with no VALORANT running.
 *
 * Required behaviour under test (§4):
 *   - a restored previous match can never establish live/matchId/map/score/
 *     round/scene on its own;
 *   - status/plugin frames are not evidence about a match, so they never
 *     satisfy the boot gate;
 *   - only real live evidence (a live-ish session or a match identity) satisfies
 *     it, after which fresh telemetry owns the state.
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 * No VALORANT / Overwolf / runtime process involved — synthetic frames only.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The projection computes its cache path from os.tmpdir() when the module is
// loaded, so the fixture dir must be in the environment BEFORE the import.
// (On Windows, Node's os.tmpdir() honours TEMP.)
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-boot-cache-"));
process.env.TEMP = fixtureDir;
process.env.TMP = fixtureDir;

const { ValProjectionSession } = await import("../dist/main/projection.js");

const CACHE = path.join(fixtureDir, "havoc-unleash-last-state.json");
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/** Fresh session, no mirror on disk. */
function freshSession() {
  fs.rmSync(CACHE, { force: true });
  return new ValProjectionSession();
}

/** Writes the exact shape the live app persisted (0-2 / Ascent, no game). */
function writeMirror(overrides = {}) {
  fs.writeFileSync(
    CACHE,
    JSON.stringify({
      savedAt: Date.now(),
      matchId: null,
      mapKey: "ascent",
      mapName: "Ascent",
      viewerName: "Stale#HU",
      viewerGepTeam: 0,
      blue: 0,
      red: 2,
      roundNumber: 0,
      roundPhase: "unknown",
      gameEvent: null,
      roundEnd: null,
      matchWinner: null,
      roundHistory: [],
      roundStartScore: null,
      roster: [],
      ...overrides,
    }),
    "utf8",
  );
}

/** Boots a session WITH a valid (fresh) previous-match mirror. */
function sessionWithMirror(overrides = {}) {
  writeMirror(overrides);
  return new ValProjectionSession();
}

/**
 * The cold-boot contract: nothing from the mirror is authoritative.
 * The phase must be NON-LIVE — `idle` (HU's own default) or `unknown` (an
 * honest mirror of a provider that reports no session); it must never be a
 * live-ish phase, and no map/score/round/scene may be established.
 */
function assertColdIdle(st, label) {
  assert.ok(
    st.sessionPhase === "idle" || st.sessionPhase === "unknown",
    `${label}: session is non-live (got ${st.sessionPhase})`,
  );
  assert.equal(st.matchId, null, `${label}: no match identity`);
  assert.equal(st.mapKey, null, `${label}: no map`);
  assert.equal(st.mapName, null, `${label}: no map name`);
  assert.deepEqual(st.score, { blue: 0, red: 0 }, `${label}: no score`);
  assert.equal(st.round.number, 0, `${label}: no round`);
  assert.equal(st.scene, null, `${label}: no scene`);
}

after(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});


test("A — cold boot with no mirror: unknown → idle, empty board", () => {
  const st = freshSession().snapshotValue();
  assertColdIdle(st, "no mirror");
  assert.notEqual(st.restorePending, true, "no mirror ⇒ nothing pending");
});

test("B — stale previous match in the mirror is NOT restored as live", () => {
  const st = sessionWithMirror().snapshotValue();
  // The regression: this used to publish map=Ascent, score=0-2 as current.
  assertColdIdle(st, "stale mirror");
  assert.equal(st.restorePending, true, "continuity stays unconfirmed");
});

test("B2 — a mirror with a real roster invents no players, teams or HP", () => {
  const st = sessionWithMirror({
    matchId: "old-match",
    roster: [
      { displayName: "Old#HU", teamIndex: 0, teamId: "Blue", kills: 9, health: 100 },
      { displayName: "Foe#HU", teamIndex: 1, teamId: "Red", kills: 4 },
    ],
  }).snapshotValue();
  assertColdIdle(st, "roster mirror");
  assert.deepEqual(st.roster ?? [], [], "restored players are not authoritative");
});

test("C — provider/plugin status frames do not promote the mirror", () => {
  const p = sessionWithMirror();
  p.applyFact("provider_status", {
    key: "provider_telemetry_state",
    value: { state: "HEALTHY", previous: "ATTACHED", at: Date.now() },
  });
  const st = p.snapshotValue();
  assertColdIdle(st, "status-only");
  assert.equal(st.restorePending, true, "status is not match evidence");
});


test("D — live evidence satisfies the gate, then fresh facts own the state", () => {
  const p = sessionWithMirror();
  p.applySnapshot({ sessionPhase: "live", matchId: "new-match", mapKey: "bind" });
  let st = p.snapshotValue();
  assert.notEqual(st.restorePending, true, "live session satisfies the gate");
  assert.equal(st.sessionPhase, "live");
  assert.equal(st.matchId, "new-match");
  assert.equal(st.mapKey, "bind", "fresh map replaces the quarantined one");
  assert.deepEqual(st.score, { blue: 0, red: 0 }, "no inherited score");
  // A real score for the NEW match is authoritative.
  p.applyScore(5, 2);
  st = p.snapshotValue();
  assert.deepEqual(st.score, { blue: 5, red: 2 });
  assert.equal(st.mapKey, "bind", "Ascent never resurfaces");
});

test("D2 — a different match discards the previous session's continuity", () => {
  const p = sessionWithMirror({ matchId: "old-match", blue: 11, red: 4 });
  p.applySnapshot({ sessionPhase: "pregame", matchId: "brand-new", mapKey: "haven" });
  const st = p.snapshotValue();
  assert.equal(st.matchId, "brand-new");
  assert.equal(st.mapKey, "haven");
  assert.deepEqual(st.score, { blue: 0, red: 0 });
  assert.equal(st.scene, "agent-select", "pregame is a live-evidence scene");
});

test("E — rapid restart cannot resurrect the retired session's payload", () => {
  const p = sessionWithMirror({ matchId: "session-A", blue: 0, red: 2 });
  // Session A goes live, then VALORANT closes → the runtime retires it (A5).
  p.applySnapshot({ sessionPhase: "live", matchId: "session-A", mapKey: "ascent" });
  p.applyScore(7, 5);
  p.applyFact("provider_status", { key: "game_exit", value: true });
  let st = p.snapshotValue();
  assert.equal(st.sessionPhase, "idle");
  assert.equal(st.scene, null);
  assert.deepEqual(st.score, { blue: 0, red: 0 });
  // Session B: a brand new match, still no inherited map/score.
  p.applySnapshot({ sessionPhase: "live", matchId: "session-B", mapKey: "split" });
  st = p.snapshotValue();
  assert.equal(st.matchId, "session-B");
  assert.equal(st.mapKey, "split");
  assert.deepEqual(st.score, { blue: 0, red: 0 }, "session A's 7-5 is gone");
});

test("F — expired mirror (>2h) is discarded outright", () => {
  const st = sessionWithMirror({ savedAt: Date.now() - TWO_HOURS_MS - 60_000 }).snapshotValue();
  assertColdIdle(st, "expired mirror");
  assert.notEqual(st.restorePending, true, "expired ⇒ nothing pending");
});

test("F2 — clock-skewed mirror (future stamp) is discarded", () => {
  const st = sessionWithMirror({ savedAt: Date.now() + 60_000 }).snapshotValue();
  assertColdIdle(st, "future mirror");
  assert.notEqual(st.restorePending, true);
});

test("G — corrupt mirror starts clean instead of throwing", () => {
  fs.rmSync(CACHE, { force: true });
  fs.writeFileSync(CACHE, "{ not json", "utf8");
  const st = new ValProjectionSession().snapshotValue();
  assertColdIdle(st, "corrupt mirror");
});

test("H — a wiped round reports UNKNOWN player values, never fabricated ones", () => {
  const p = freshSession();
  p.applyFact("round_number", 5);
  p.applyFact("scoreboard", { name: "Self#HU", team: 0, credits: 900, character: "wushu" });
  let st = p.snapshotValue();
  assert.equal(st.roster.length, 1, "scoreboard creates the player");
  assert.equal(st.roster[0].credits, 900);
  // Round 1 of a NEW match ⇒ match-scoped wipe (identities kept).
  p.applyFact("round_number", 1);
  st = p.snapshotValue();
  assert.equal(st.roster.length, 1, "identities survive a fresh-match wipe");
  const pl = st.roster[0];
  assert.equal(pl.credits, null, "credits are unknown after a wipe");
  assert.equal(pl.weapon ?? null, null, "weapon is unknown after a wipe");
  assert.equal(pl.health ?? null, null, "health is UNKNOWN — not 100");
  assert.equal(pl.isAlive ?? null, null, "alive is UNKNOWN — not true");
  assert.deepEqual(st.score, { blue: 0, red: 0 });
});

test("C2 — an idle session snapshot does not promote the mirror", () => {
  const p = sessionWithMirror();
  p.applySnapshot({ sessionPhase: "idle", matchId: null });
  const st = p.snapshotValue();
  assertColdIdle(st, "idle snapshot");
  assert.equal(st.restorePending, true, "idle is not live evidence");
});

test("C3 — a blank/unknown snapshot phase does not promote the mirror", () => {
  const p = sessionWithMirror();
  p.applySnapshot({ sessionPhase: "unknown" });
  const st = p.snapshotValue();
  assertColdIdle(st, "unknown snapshot");
  assert.equal(st.restorePending, true, "unknown is not live evidence");
});
