/**
 * HU-001b (winner ATTACK/DEFENDER side) + HU-013 (defuse round reason).
 *
 * HU-001b — the GEP provider maintains `match_info.info.team` ("attack" /
 * "defense" for the local player, flipped by the provider at halftime/OT);
 * `gep-capture.ts` normalizes it to the `viewer_side` fact (still present) and
 * `projection.ts` consumed it until the 6e9236e revert removed the consumer
 * (verbatim source: 0511dc7:539-552). The consumer is restored — side must
 * NEVER be derived from team index, roster order or round parity.
 *
 * HU-013 — GEP `spike_defused` is the authoritative terminal event, but the
 * live capture (2026-09-24) shows the NEXT round's plant arriving 2 ms later:
 *   04:37:26.471 spike_defused → 04:37:26.473 planted_location "B"
 *   04:39:42.862 spike_defused → 04:39:42.862 planted_location "A"
 * so the global `s.spike` no longer holds the round's own outcome at settlement
 * (observed reasons: r16 "time", r17 "elimination"; `defusion` 0/19). A
 * ROUND-LOCAL terminal latch (set at event time, applied only to its own round,
 * cleared at every round/match reset) restores the documented precedence.
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-side-defuse-"));
process.env.TEMP = fixtureDir;
process.env.TMP = fixtureDir;
process.env.LOCALAPPDATA = fixtureDir;

const { ValProjectionSession } = await import("../dist/main/projection.js");
const { toGameSnapshot } = await import("../dist/main/snapshot.js");

const CACHE = path.join(fixtureDir, "havoc-unleash-last-state.json");

/** Live session with a full 5v5 board, round 1 in its combat phase. */
function liveSession() {
  fs.rmSync(CACHE, { force: true });
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "m-1", mapKey: "ascent" });
  for (let i = 0; i < 5; i++) {
    p.applyFact("scoreboard", { name: `Blue${i}#0001`, team: 0, is_local: i === 0, credits: 800 });
    p.applyFact("scoreboard", { name: `Red${i}#0002`, team: 1, credits: 800 });
  }
  p.applyFact("round_number", 1);
  p.applyFact("round_phase", "shopping");
  p.applyFact("round_phase", "combat");
  return p;
}

/**
 * Settle the current round through the viewer-authoritative round_outcome fact
 * (its consumer requires a *change*, so a baseline fact is sent first).
 */
function settle(p, winner) {
  const prev = state(p).roundOutcome ?? { won: 0, lost: 0 };
  if (!state(p).roundOutcome) p.applyFact("round_outcome", { won: 0, lost: 0 });
  const next =
    winner === "blue"
      ? { won: prev.won + 1, lost: prev.lost }
      : { won: prev.won, lost: prev.lost + 1 };
  p.applyFact("round_outcome", next);
  return p;
}

const state = (p) => p.snapshotValue();
const snap = (p) => toGameSnapshot(p.snapshotValue());

/* --------------------------- HU-001b: viewer side --------------------------- */

test("HU-001b — provider side fact seeds the start side and the current side", () => {
  const p = liveSession();
  p.applyFact("viewer_side", "attack");
  assert.equal(state(p).viewerSide, "attack");
  assert.equal(state(p).viewerStartSide, "attack", "first observation seeds the start side");

  // Halftime: the PROVIDER flips the fact; the seed stays the round-1 side.
  p.applyFact("viewer_side", "defense");
  assert.equal(state(p).viewerSide, "defense", "current side refreshed from the provider fact");
  assert.equal(state(p).viewerStartSide, "attack", "start side is the seed, not the current side");
  assert.equal(snap(p).state.viewerSide, "defense", "published through the snapshot");
});

test("HU-001b — defense start is consumed the same way (no orientation assumption)", () => {
  const p = liveSession();
  p.applyFact("viewer_side", "defense");
  assert.equal(state(p).viewerSide, "defense");
  assert.equal(state(p).viewerStartSide, "defense");
});

test("HU-001b — unknown/invalid viewer_side never fabricates a side", () => {
  const p = liveSession();
  for (const bad of [null, undefined, "", "mid", 0, 1, {}, [], "ATTACKER"]) {
    p.applyFact("viewer_side", bad);
    assert.equal(state(p).viewerSide ?? null, null, `viewer_side=${JSON.stringify(bad)} must not set a side`);
    assert.equal(state(p).viewerStartSide ?? null, null);
  }
  p.applyFact("viewer_side", "DEFENSE");
  assert.equal(state(p).viewerSide, "defense", "case-normalized acceptance");
});

test("HU-001b — winner side follows the viewer side (both orientations)", () => {
  const blue = liveSession();
  blue.applyFact("viewer_side", "attack");
  settle(blue, "blue");
  assert.equal(state(blue).roundEnd.winnerSide, "attacker", "viewer on attack won → ATTACKER");
  assert.equal(snap(blue).state.roundEnd.winnerSide, "attacker");

  const blueDef = liveSession();
  blueDef.applyFact("viewer_side", "defense");
  settle(blueDef, "blue");
  assert.equal(state(blueDef).roundEnd.winnerSide, "defender", "viewer on defense won → DEFENDER");

  const redWon = liveSession();
  redWon.applyFact("viewer_side", "attack");
  settle(redWon, "red");
  assert.equal(state(redWon).roundEnd.winnerSide, "defender", "enemy won while viewer attacked → DEFENDER");

  const redWonDef = liveSession();
  redWonDef.applyFact("viewer_side", "defense");
  settle(redWonDef, "red");
  assert.equal(state(redWonDef).roundEnd.winnerSide, "attacker", "enemy won while viewer defended → ATTACKER");
});

test("HU-001b — team index / round number never determine the side", () => {
  const p = liveSession();
  p.applyFact("viewer_side", "attack");
  // Flip every GEP team number (rows + the local anchor) and advance rounds.
  for (let i = 0; i < 5; i++) {
    p.applyFact("scoreboard", { name: `Blue${i}#0001`, team: 1, credits: 800 });
    p.applyFact("scoreboard", { name: `Red${i}#0002`, team: 0, is_local: true, credits: 800 });
  }
  p.applyFact("round_number", 13);
  assert.equal(state(p).viewerSide, "attack", "team re-index must not touch the side");
  assert.equal(state(p).viewerStartSide, "attack");

  // No provider fact at all → no fabricated side, however many rounds pass.
  const bare = liveSession();
  bare.applyFact("round_number", 13);
  settle(bare, "blue");
  assert.equal(state(bare).roundEnd.winnerSide ?? null, null, "no side source → winnerSide stays null");
  assert.equal(snap(bare).state.viewerStartSide ?? null, null);
});

test("HU-001b — an explicit runtime winningSide still wins (Model B intact)", () => {
  const p = liveSession();
  p.applyFact("scoreboard", { name: "Blue0#0001", team: 0, is_local: true, credits: 800 });
  p.applyFact("viewer_side", "attack");
  p.applyFact("round_settled", {
    roundNumber: 1,
    winnerStartTeam: 0,
    winningSide: "defense",
    winningReason: "timeout",
  });
  assert.equal(state(p).roundEnd.winner, "blue");
  assert.equal(state(p).roundEnd.reason, "time", "explicit reason preserved");
  assert.equal(state(p).roundEnd.winnerSide, "defender", "explicit winningSide is authoritative");
});

/* ------------------------ HU-013: defuse round reason ----------------------- */

test("HU-013 — the captured 2 ms race still settles as DEFUSION (round 1)", () => {
  const p = liveSession();
  p.applyFact("planted_location", "B"); // plant
  p.applyFact("spike_defused", true); // GEP terminal event (captured 04:37:26.471Z)
  p.applyFact("planted_location", "A"); // NEXT round's plant, +2 ms (captured .473Z)
  assert.equal(state(p).spike, "planted", "global spike state is legitimately the new plant");

  settle(p, "blue"); // the round's settlement (captured 04:37:26.855Z)
  assert.equal(state(p).roundEnd.reason, "defusion", "the round's own defuse is the reason");
  assert.equal(state(p).roundHistory.at(-1).reason, "defusion", "roundHistory matches");
  assert.equal(state(p).roundHistory.at(-1).round, 1);
});

test("HU-013 — the GEP-raw null payload works the same as the adapter's `true`", () => {
  const p = liveSession();
  p.applyFact("planted_location", "A");
  p.applyFact("spike_defused", null); // raw GEP payload observed in the capture
  p.applyFact("planted_location", "B");
  settle(p, "red");
  assert.equal(state(p).roundEnd.reason, "defusion");
});

test("HU-013 — detonation uses the same round-local latch", () => {
  const p = liveSession();
  p.applyFact("planted_location", "C");
  p.applyFact("spike_detonated", true);
  p.applyFact("planted_location", "A");
  settle(p, "red");
  assert.equal(state(p).roundEnd.reason, "detonation");
});

test("HU-013 — the latch never leaks into the next round", () => {
  const p = liveSession();
  p.applyFact("planted_location", "B");
  p.applyFact("spike_defused", true);
  p.applyFact("planted_location", "A"); // next plant, same burst
  settle(p, "blue");
  assert.equal(state(p).roundEnd.reason, "defusion", "round 1 defused");

  p.applyFact("round_number", 2);
  p.applyFact("round_phase", "shopping");
  p.applyFact("round_phase", "combat");
  settle(p, "red");
  assert.equal(state(p).roundHistory.at(-1).round, 2);
  assert.equal(state(p).roundEnd.reason, "elimination", "round 2 must not inherit the defuse");
});

test("HU-013 — a late defuse for an already-settled round cannot relabel the next one", () => {
  const p = liveSession();
  settle(p, "blue"); // round 1 settles as elimination
  assert.equal(state(p).roundHistory.at(-1).reason, "elimination");
  p.applyFact("spike_defused", true); // late event, round 1 already in the history
  p.applyFact("round_number", 2);
  p.applyFact("round_phase", "shopping");
  p.applyFact("round_phase", "combat");
  settle(p, "red");
  assert.equal(state(p).roundEnd.reason, "elimination", "no cross-round contamination");
});

test("HU-013 — reason precedence: explicit > round-latch > global spike > time > elimination", () => {
  const explicit = liveSession();
  explicit.applyFact("planted_location", "A");
  explicit.applyFact("spike_defused", true);
  explicit.applyFact("round_settled", {
    roundNumber: 1,
    winnerStartTeam: 1,
    winningSide: "attack",
    winningReason: "elimination",
  });
  assert.equal(state(explicit).roundEnd.reason, "elimination", "explicit runtime reason wins");

  const latch = liveSession();
  latch.applyFact("planted_location", "A");
  latch.applyFact("spike_defused", true);
  latch.applyFact("planted_location", "B");
  settle(latch, "blue");
  assert.equal(state(latch).roundEnd.reason, "defusion", "latch wins over the overwritten global state");

  const plain = liveSession();
  settle(plain, "blue");
  assert.equal(state(plain).roundEnd.reason, "elimination", "no spike evidence → elimination");
});


/* ------------------- HU-013: live POST-settlement ordering ------------------- */

/**
 * Live ordering B — captured 2026-09-25 02:13:18.9xx from the blob engine:
 *   round_phase end 02:13:18.950 → score {won:4,lost:1} .951
 *   → spike_defused .951 + planted_location "B" .951
 * The engine emits NO plant-time frame, so at settlement the global spike state
 * was null and the round was stamped `elimination`: the HUD showed the generic
 * kill icon for a defused round. The round-local revision must re-label exactly
 * that round (still in its end phase) as defusion.
 */
test("HU-013 — post-settlement defuse re-labels the settled round (live ordering)", () => {
  const p = liveSession();
  p.applyFact("viewer_side", "defense");
  p.applyFact("round_phase", "end"); // settlement trigger, ~1 ms BEFORE the defuse
  p.applyFact("score", { won: 1, lost: 0 });
  assert.equal(state(p).roundEnd.reason, "elimination", "settled before the spike event");
  p.applyFact("spike_defused", null); // captured raw payload
  p.applyFact("planted_location", "B"); // captured in the same burst
  assert.equal(state(p).roundEnd.reason, "defusion", "the round's own defuse wins");
  assert.equal(state(p).roundHistory.at(-1).reason, "defusion");
  assert.equal(state(p).roundHistory.at(-1).round, 1);
  assert.equal(snap(p).state.roundEnd.reason, "defusion", "published through the snapshot");
  assert.equal(snap(p).state.roundHistory.at(-1).reason, "defusion");
});

test("HU-013 — post-settlement detonation re-labels the same way", () => {
  const p = liveSession();
  p.applyFact("round_phase", "end");
  p.applyFact("score", { won: 0, lost: 1 });
  assert.equal(state(p).roundEnd.reason, "elimination");
  p.applyFact("spike_detonated", null);
  assert.equal(state(p).roundEnd.reason, "detonation");
  assert.equal(state(p).roundHistory.at(-1).reason, "detonation");
});

test("HU-013 — a terminal reason is never downgraded by a later spike event", () => {
  const p = liveSession();
  p.applyFact("spike_detonated", null); // latch BEFORE settlement
  p.applyFact("round_phase", "end");
  p.applyFact("score", { won: 1, lost: 0 });
  assert.equal(state(p).roundEnd.reason, "detonation", "latched outcome settles the round");
  p.applyFact("spike_defused", null); // contradictory late event in the same end phase
  assert.equal(state(p).roundEnd.reason, "detonation", "terminal reason is not overwritten");
});

test("HU-013 — the revision stops once the next round owns the phase", () => {
  const p = liveSession();
  p.applyFact("round_phase", "end");
  p.applyFact("score", { won: 1, lost: 0 });
  p.applyFact("round_number", 2);
  p.applyFact("round_phase", "shopping"); // round 2's buy phase is live now
  p.applyFact("spike_defused", null); // stale terminal event from the previous round
  assert.equal(
    state(p).roundHistory.find((h) => h.round === 1).reason,
    "elimination",
    "the settled round is never rewritten after its phase ended",
  );
});

/* ------------------- ability state across round boundaries ------------------ */

/**
 * Live 2026-09-25: the engine emits `abilities` ONLY when the value changes —
 * there was no abilities fact between 02:12:14 and 02:21:59 (rounds 6-9). The
 * per-round wipe therefore left abilityState undefined and the website rendered
 * every skill icon at 0.35 opacity ("abilities greyed out") for whole rounds.
 */
test("abilities — the last authoritative state survives the round rollover", () => {
  const p = liveSession();
  p.applyFact("abilities", { C: true, Q: false, E: true, X: false });
  assert.deepEqual(
    state(p).roster[0].abilityState,
    { C: true, Q: false, E: true, X: false },
    "engine booleans are normalized onto the local roster entry",
  );
  p.applyFact("round_number", 2);
  p.applyFact("round_phase", "shopping"); // the per-round hygiene runs here
  assert.deepEqual(
    state(p).roster[0].abilityState,
    { C: true, Q: false, E: true, X: false },
    "round start must not discard the last authoritative value",
  );
  assert.deepEqual(
    snap(p).state.players[0].abilityState,
    { C: true, Q: false, E: true, X: false },
    "and it stays published to the consumers",
  );
});

test("abilities — a fresh match still wipes them (per-match hygiene intact)", () => {
  const p = liveSession();
  p.applyFact("abilities", { C: true, Q: true, E: true, X: false });
  settle(p, "blue"); // round 1 lands in the history
  p.applyFact("round_number", 1); // new game starts while a match was tracked
  assert.equal(
    state(p).roster[0].abilityState,
    undefined,
    "a new match never inherits the previous game's charges",
  );
});

