/**
 * Round lifecycle / match boundary / timeout classification / team-side
 * anchoring (2026-09-30).
 *
 * PASS 1 — the fork engine publishes NO round facts for the first rounds of a
 * match (live 2026-09-25, session log `session_2026-09-25-02-05-54.jsonl`):
 *
 *   02:07:18  live   round 0/unknown  buy-round   0-0
 *   02:08:30  live   round 0/unknown  ingame-hud  1-0   <- R1 ended, no facts
 *   02:09:01  live   round 0/unknown  ingame-hud  2-0   <- R2 ended, no facts
 *   02:09:14  live   round 3/shopping buy-round   2-0   <- FIRST round fact
 *
 * so R1/R2 never left the buy scene, produced no roundEnd and no roundHistory.
 * The score is the only surviving authority: `blue + red` is the number of the
 * completed round and the engine's own facts for R3..R21 are exactly that + 1
 * (02:43:12 `12-7` -> `20/shopping`, 02:45:28 `12-8` -> `21/shopping`).
 *
 * PASS 2 — match K/D/A boundary + timeout/elimination classification:
 *   02:46:57 match A 13-8 (post-game) -> 02:48:04 match B live -> 02:48:08 0-0.
 *   Round-to-round wall clock in that match: 135/135/136/136/137/140/140/141 s
 *   (round timer ~100 s plus the pre-round transition).
 *
 * PASS 3 — Agent Select team identity: the score panel is anchored to the
 * viewer (blue = the local player's score), so the presentation side must
 * follow TEAM IDENTITY, never the runtime's "Blue"/"Team One"/"Team Two"
 * labels or array order.
 *
 * The 100 s / 130 s / 5.5 s windows cannot be waited out in a unit test, so the
 * tests covering them back-date the documented clock field they exercise.
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-round-lifecycle-"));
process.env.TEMP = fixtureDir;
process.env.TMP = fixtureDir;
process.env.LOCALAPPDATA = fixtureDir;

const { ValProjectionSession } = await import("../dist/main/projection.js");
const { toGameSnapshot } = await import("../dist/main/snapshot.js");
const state = (p) => p.snapshotValue();
const snap = (p) => toGameSnapshot(p.snapshotValue());

/**
 * A fresh live match with the viewer identified and NO round facts at all.
 * The 0-0 score frame is part of the live session start (the runtime publishes
 * it right after the session flips live — live 2026-09-29 03:52:26, and the
 * session log for 2026-09-25 shows `0-0` at 02:07:18 before `1-0` at 02:08:30).
 */
function forkSession(matchId = "fork-1") {
  fs.rmSync(path.join(fixtureDir, "havoc-unleash-last-state.json"), { force: true });
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId, mapKey: "ascent" });
  p.applyFact("scoreboard", { name: "Solo#0001", team: 1, is_local: true, alive: true, credits: 800 });
  p.applyFact("scoreboard", { name: "Foe#0002", team: 0, alive: true, credits: 800 });
  p.applyScore(0, 0, matchId);
  return p;
}

/** A session that was already running when HU attached (no match-start 0-0). */
function joinedSession(matchId, blue, red) {
  fs.rmSync(path.join(fixtureDir, "havoc-unleash-last-state.json"), { force: true });
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId, mapKey: "ascent" });
  p.applyFact("scoreboard", { name: "Solo#0001", team: 1, is_local: true, alive: true, credits: 800 });
  p.applyFact("scoreboard", { name: "Foe#0002", team: 0, alive: true, credits: 800 });
  p.applyScore(blue, red, matchId);
  return p;
}

/* ------------------------- PASS 1: R1/R2 lifecycle ------------------------- */

test("PASS 1 — fresh R1 buys with partial telemetry (no fabricated economy)", () => {
  const p = forkSession();
  const st = state(p);
  assert.equal(st.round.phase, "unknown", "no round fact has arrived yet");
  assert.equal(snap(p).state.scene, "buy-round", "a live match with no round facts is pre-round-1");
  const me = st.roster.find((r) => r.displayName === "Solo#0001");
  assert.equal(me.credits, 800, "the provider's own money value, untouched");
  assert.equal(me.weapon ?? null, null, "no weapon evidence -> unknown, never invented");
  assert.equal(me.shieldType ?? null, null, "no shield evidence -> unknown, never invented");
});

test("PASS 1 — R1 combat is recognized from kill evidence (no round fact needed)", () => {
  const p = forkSession();
  p.applyFact("kill_feed", { attacker: "Solo#0001", victim: "Foe#0002", weapon: "Vandal" });
  const st = state(p);
  assert.equal(st.round.phase, "combat", "a kill can only happen in combat");
  assert.equal(st.round.number, 1, "the round in progress is points + 1");
  // The documented match-start grace keeps the buy scene up for 8 s after the
  // session goes live so a skipped R1 buy phase still plays (ValoSpectra parity);
  // past it the HUD is the scene for the combat we have evidence for.
  p.s.liveSince = Date.now() - 9000;
  assert.equal(snap(p).state.scene, "ingame-hud", "R1 combat shows the HUD");
  const me = st.roster.find((r) => r.displayName === "Solo#0001");
  assert.equal(me.kills, 1, "the kill feed still accumulates");
  assert.equal(me.credits, 800, "no economy value was invented by the promotion");
});

test("PASS 1 — R1 settles from the score and R2 opens in its buy phase", () => {
  const p = forkSession();
  p.applyFact("kill_feed", { attacker: "Solo#0001", victim: "Foe#0002", weapon: "Vandal" });
  p.applyScore(1, 0, "fork-1");
  const st = state(p);
  assert.equal(st.roundEnd?.winner, "blue", "the score delta is the winner evidence");
  assert.equal(st.roundEnd?.reason, "elimination", "no spike, no clock -> elimination");
  assert.deepEqual(st.roundHistory.at(-1), { round: 1, winner: "blue", reason: "elimination" });
  assert.equal(st.round.number, 2, "the round in progress is 2");
  assert.equal(st.round.phase, "shopping", "and it is in its buy phase");
  assert.equal(snap(p).state.scene, "ingame-hud", "the endround banner still holds the HUD");

  // The hold is a grace period, not a latch: the buy scene follows it.
  p.s.roundEndedAt = Date.now() - 6000;
  assert.equal(snap(p).state.scene, "buy-round", "R2 BuyRound scene");
  assert.equal(snap(p).state.roundHistory.at(-1).round, 1);
  assert.equal(snap(p).state.currentRound.roundNumber, 2, "the strip is no longer stuck at 0/unknown");
});


test("PASS 1 — R2 combat + R2 end + R3 buy (the reported stuck sequence)", () => {
  const p = forkSession();
  p.applyFact("kill_feed", { attacker: "Solo#0001", victim: "Foe#0002", weapon: "Vandal" });
  p.applyScore(1, 0, "fork-1"); // R1 -> R2
  p.s.roundEndedAt = Date.now() - 6000;
  assert.equal(snap(p).state.scene, "buy-round", "R2 buys");

  // R2's combat is visible only through its kills (the engine sends no facts).
  p.applyFact("kill_feed", { attacker: "Solo#0001", victim: "Foe#0002", weapon: "Vandal" });
  assert.equal(state(p).round.phase, "combat");
  assert.equal(snap(p).state.scene, "ingame-hud", "R2 combat shows the HUD");

  p.applyScore(2, 0, "fork-1"); // R2 -> R3
  p.s.roundEndedAt = Date.now() - 6000;
  const st = state(p);
  assert.deepEqual(st.roundHistory.map((h) => h.round), [1, 2], "both rounds recorded");
  assert.equal(st.round.number, 3, "the engine's own numbering (points + 1)");
  assert.equal(snap(p).state.scene, "buy-round", "R3 buys");
});

test("PASS 1 — a real round fact still owns the lifecycle (no double settle)", () => {
  const p = forkSession();
  p.applyScore(1, 0, "fork-1"); // derived: R2 shopping
  assert.equal(state(p).round.number, 2);
  // R2's facts arrive late (the engine's first fact of this match was R3's).
  p.applyFact("round_number", 2);
  p.applyFact("round_phase", "combat");
  assert.equal(state(p).round.phase, "combat", "the engine's phase wins over the derived one");
  p.applyScore(2, 0, "fork-1");
  assert.equal(
    state(p).roundHistory.filter((h) => h.round === 2).length,
    1,
    "the derived and the fact-driven settlement never double-count",
  );
});

test("PASS 1 — joining mid-match never invents the rounds that were missed", () => {
  const p = joinedSession("fork-mid", 4, 2); // first observation: a match already in progress
  const st = state(p);
  assert.equal(st.roundEnd ?? null, null, "a round we never watched is never settled");
  assert.deepEqual(st.roundHistory, [], "and never enters the timeline strip");
  assert.equal(st.round.number, 7, "the round in progress is derivable: 4 + 2 + 1");
  assert.equal(snap(p).state.scene, "ingame-hud", "mid-match join stays on the HUD");
/* -------------------- PASS 2A: match boundary (K/D/A) ---------------------- */

test("PASS 2A — a new match starts K/D/A fresh and accumulates exactly once", () => {
  const p = forkSession("match-A");
  p.applyFact("round_phase", "combat");
  for (let i = 0; i < 5; i++) p.applyFact("kill_feed", { attacker: "Solo#0001", victim: `Foe#000${i}` });
  p.applyFact("kill_feed", { attacker: "Foe#0002", victim: "Solo#0001" });
  const before = state(p).roster.find((r) => r.displayName === "Solo#0001");
  assert.equal(before.kills, 5, "sanity: match A accumulated 5 kills");
  assert.equal(before.deaths, 1);

  // Match B opens at 0-0 in a live session (live 2026-09-25: 13-8 -> 0-0).
  p.applyScore(0, 0, "match-B");
  const after = state(p).roster.find((r) => r.displayName === "Solo#0001");
  assert.equal(after.displayName, "Solo#0001", "identity survives the boundary");
  assert.equal(after.kills ?? null, null, "match A's kills are gone");
  assert.equal(after.deaths ?? null, null, "match A's deaths are gone");
  assert.equal(after.assists ?? null, null, "match A's assists are gone");

  // One kill in match B must be exactly K=1, never K=6.
  p.applyFact("round_phase", "combat");
  p.applyFact("kill_feed", { attacker: "Solo#0001", victim: "Foe#0002" });
  assert.equal(state(p).roster.find((r) => r.displayName === "Solo#0001").kills, 1);
});

test("PASS 2A — the runtime's match_start / match_id facts are the same boundary", () => {
  const p = forkSession("match-A");
  p.applyFact("round_phase", "combat");
  p.applyFact("kill_feed", { attacker: "Solo#0001", victim: "Foe#0002" });
  assert.equal(state(p).roster.find((r) => r.displayName === "Solo#0001").kills, 1);

  p.applyFact("match_start", true);
  assert.equal(state(p).roster.find((r) => r.displayName === "Solo#0001").kills ?? null, null);
  assert.equal(state(p).round.number, 0, "round state reset with the stats");
  assert.equal(state(p).score.blue, 0);
  assert.equal(state(p).roundHistory.length, 0);

  p.applyFact("match_id", "match-C");
  assert.equal(state(p).matchId, "match-C", "the authoritative identity is adopted");
  assert.equal(state(p).round.number, 0);
});

test("PASS 2A — a post-game score frame never erases the settled result", () => {
  const p = forkSession("match-A");
  p.applyScore(13, 8, "match-A");
  assert.equal(state(p).match.winner, "blue", "match point reached");
  assert.equal(snap(p).state.scene, "post-game");
  p.applySnapshot({ sessionPhase: "ending", matchId: "match-A", mapKey: "ascent" });
  p.applyScore(0, 0, "match-A");
  assert.equal(state(p).match.winner, "blue", "the retirement frame does not wipe the result");
  assert.equal(snap(p).state.scene, "post-game");
});

/* ------------------ PASS 2B: timeout classification ------------------------ */

/**
 * A round the engine gave a combat fact for: the settlement is ≥100 s after that
 * clock started. Live rounds are ~135-141 s wall clock (round timer ~100 s plus
 * the pre-round transition), so the timer ran out.
 */
test("PASS 2B — the round's own combat clock classifies a TIMEOUT", () => {
  const p = forkSession();
  p.applyScore(2, 0, "fork-1"); // join at 2-0 -> the round in progress is 3
  p.applyFact("round_number", 3);
  p.applyFact("round_phase", "combat");
  p.s.combatStartedAt = Date.now() - 103_000;
  p.applyFact("round_phase", "end");
  p.applyScore(2, 1, "fork-1");
  const st = state(p);
  assert.equal(st.roundEnd.reason, "time", "the full round timer elapsed with no wipe");
  assert.deepEqual(st.roundHistory.at(-1), { round: 3, winner: "red", reason: "time" });
  assert.equal(snap(p).state.roundHistory.at(-1).reason, "time", "published to the strip");
});

/** No combat fact at all (fork R1/R2): the round's own start window decides. */
test("PASS 2B — without any round fact the start window still classifies it", () => {
  const p = forkSession();
  p.applyScore(1, 0, "fork-1"); // R1 -> R2 (derived buy boundary stamped)
  p.s.roundStartedAt = Date.now() - 140_000; // observed full-round wall clock
  p.applyScore(2, 0, "fork-1"); // R2 ends with no round fact whatsoever
  assert.equal(state(p).roundEnd.reason, "time");
  assert.deepEqual(state(p).roundHistory.at(-1), { round: 2, winner: "blue", reason: "time" });
});

test("PASS 2B — a short round is never a timeout", () => {
  const p = forkSession();
  p.applyScore(1, 0, "fork-1");
  p.s.roundStartedAt = Date.now() - 40_000;
  p.applyScore(2, 0, "fork-1");
  assert.equal(state(p).roundEnd.reason, "elimination", "40 s of round time is not the timer");
});

test("PASS 2B — a wiped team is elimination evidence, never a timeout", () => {
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "wipe-1", mapKey: "ascent" });
  for (let i = 0; i < 5; i++) {
    p.applyFact("scoreboard", { name: `Blue${i}#0001`, team: 0, is_local: i === 0, alive: true, credits: 800 });
    p.applyFact("scoreboard", { name: `Red${i}#0002`, team: 1, alive: true, credits: 800 });
  }
  p.applyScore(0, 0, "wipe-1");
  p.applyFact("round_number", 1);
  p.applyFact("round_phase", "combat");
  p.s.combatStartedAt = Date.now() - 103_000; // even a long clock...
  for (let i = 0; i < 5; i++) {
    p.applyFact("kill_feed", { attacker: "Blue0#0001", victim: `Red${i}#0002` });
  }
  p.applyFact("round_phase", "end");
  p.applyScore(1, 0, "wipe-1");
  assert.equal(
    state(p).roundEnd.reason,
    "elimination",
    "...a five-man wipe is elimination evidence and outranks the clock",
  );
});

test("PASS 2B — a previous round's clock never classifies the next round", () => {
  const p = forkSession();
  p.applyScore(1, 0, "fork-1"); // R1 -> R2
  p.s.combatStartedAt = Date.now() - 150_000; // stale clock, left over from round 1
  p.s.combatStartedRound = 1;
  p.s.roundStartedAt = null; // and no start-window evidence for round 2
  p.s.roundStartedRound = 0;
  p.applyScore(2, 0, "fork-1");
  assert.equal(
    state(p).roundEnd.reason,
    "elimination",
    "round 2 has no clock of its own -> the round-1 clock must not leak",
  );
});

/* ----------------- PASS 3: Agent Select team side + score ------------------ */

/**
 * A custom-lobby Agent Select where the runtime lists the OPPONENT first and
 * labels it "Red" while the viewer's squad is second and labelled "Blue". The
 * old mapping ("Blue" -> left) put the opponent on the left while the score
 * (anchored to the viewer) stayed on the viewer's side, and the blocks flipped
 * as soon as GEP's team numbers landed.
 */
const SELECT_SWAPPED = {
  sessionPhase: "pregame",
  matchId: "select-1",
  mapKey: "ascent",
  session: {
    viewer: { player: { name: { displayName: "Viewer#TAG" } }, role: "player" },
    teams: [
      {
        teamId: "Red",
        startingSide: "attack",
        players: [
          { player: { name: { displayName: "Foe#0001" } } },
          { player: { name: { displayName: "Foe2#0001" } } },
        ],
      },
      {
        teamId: "Blue",
        startingSide: "defense",
        players: [
          { player: { name: { displayName: "Viewer#TAG" } } },
          { player: { name: { displayName: "Mate#0001" } } },
        ],
      },
    ],
  },
};

test("PASS 3 — the viewer's squad is presented left regardless of squad order", () => {
  const p = new ValProjectionSession();
  p.applySnapshot(SELECT_SWAPPED);
  const st = state(p);
  const idx = (name) => st.roster.find((r) => r.displayName === name).teamIndex;
  assert.equal(idx("Viewer#TAG"), 0, "the viewer's squad is left");
  assert.equal(idx("Mate#0001"), 0, "and so is their team mate");
  assert.equal(idx("Foe#0001"), 1, "the opponent is right even though the runtime listed it first");
  assert.equal(idx("Foe2#0001"), 1);
  assert.equal(st.viewerStartSide, "defense", "the start side still comes from the viewer's own squad");
});

test("PASS 3 — the score stays attached to team identity, not to array order", () => {
  const p = new ValProjectionSession();
  p.applySnapshot(SELECT_SWAPPED);
  p.applyFact("match_score", { won: 3, lost: 5 }); // the viewer's record: 3 won, 5 lost
  const s = snap(p).state;
  assert.deepEqual({ left: s.gameScore.left, right: s.gameScore.right }, { left: 3, right: 5 });
  assert.deepEqual(
    s.players.filter((pl) => pl.teamIndex === 0).map((pl) => pl.name).sort(),
    ["Mate", "Viewer"],
    "left = the viewer's squad",
  );
  assert.deepEqual(
    s.players.filter((pl) => pl.teamIndex === 1).map((pl) => pl.name).sort(),
    ["Foe", "Foe2"],
    "right = the opponent",
  );
});

test("PASS 3 — the same semantic holds with the squads listed in the other order", () => {
  const p = new ValProjectionSession();
  const swapped = {
    ...SELECT_SWAPPED,
    session: { ...SELECT_SWAPPED.session, teams: [SELECT_SWAPPED.session.teams[1], SELECT_SWAPPED.session.teams[0]] },
  };
  p.applySnapshot(swapped);
  const st = state(p);
  const idx = (name) => st.roster.find((r) => r.displayName === name).teamIndex;
  assert.equal(idx("Viewer#TAG"), 0, "the viewer's squad is STILL left");
  assert.equal(idx("Foe#0001"), 1, "the opponent is STILL right");
  p.applyFact("match_score", { won: 3, lost: 5 });
  assert.deepEqual(snap(p).state.gameScore, { left: 3, right: 5 });
});

test("PASS 3 — a GEP team number still wins over the snapshot anchor", () => {
  const p = new ValProjectionSession();
  p.applySnapshot(SELECT_SWAPPED);
  // The provider's own scoreboard rows carry the GEP team numbers ("is_local"
  // rows are the viewer's team) — that stays the authoritative re-anchor.
  p.applyFact("scoreboard", { name: "Viewer#TAG", team: 1, is_local: true, alive: true, credits: 800 });
  p.applyFact("scoreboard", { name: "Foe#0001", team: 0, alive: true, credits: 800 });
  const st = state(p);
  const idx = (name) => st.roster.find((r) => r.displayName === name).teamIndex;
  assert.equal(idx("Viewer#TAG"), 0, "the viewer keeps the left side");
  assert.equal(idx("Foe#0001"), 1, "the opponent keeps the right side");
});

test("PASS 3 — the viewer's side flip never moves a team", () => {
  const p = new ValProjectionSession();
  p.applySnapshot(SELECT_SWAPPED);
  const before = state(p).roster.map((r) => `${r.displayName}:${r.teamIndex}`).sort();
  p.applyFact("viewer_side", "attack");
  p.applyFact("viewer_side", "defense");
  const after = state(p).roster.map((r) => `${r.displayName}:${r.teamIndex}`).sort();
  assert.deepEqual(after, before, "side is a label, never a team identity");
  assert.equal(state(p).viewerSide, "defense");
  assert.equal(state(p).viewerStartSide, "defense");
});


/* ------------------- live-evidence replay (2026-09-25) --------------------- */

/**
 * The observed fork-dialect sequence, step for step, from the desktop's own
 * session log `session_2026-09-25-02-05-54.jsonl`:
 *
 *   02:07:18  live, buy-round,     round 0/unknown, 0-0
 *   02:08:30  ingame-hud,          round 0/unknown, 1-0   <- no round fact
 *   02:09:01  ingame-hud,          round 0/unknown, 2-0   <- no round fact
 *   02:09:14  buy-round,           round 3/shopping      <- first round fact
 *   02:09:35  ingame-hud,          round 3/combat
 *   02:10:20  ingame-hud,          round 3/end, 3-0
 *   02:10:27  buy-round,           round 4/shopping
 *
 * The pre-fix behaviour is the failure mode this asserts against: rounds 1 and 2
 * ran with `round 0/unknown` (no roundEnd, empty strip cells) and the strip only
 * started at round 3. Afterwards the derived rounds must line up exactly with
 * the engine's own numbering.
 */
test("live 2026-09-25 replay — the derived rounds match the engine's own numbers", () => {
  const p = forkSession("fc-replay");
  assert.deepEqual(
    { scene: snap(p).state.scene, round: state(p).round.number, phase: state(p).round.phase },
    { scene: "buy-round", round: 0, phase: "unknown" },
    "02:07:18 — R1 buy, no round fact yet",
  );

  p.applyScore(1, 0, "fc-replay"); // 02:08:30
  assert.equal(state(p).round.number, 2, "R1 settled; R2 is the round in progress");

  p.applyScore(2, 0, "fc-replay"); // 02:09:01
  const st = state(p);
  assert.deepEqual(st.roundHistory.map((h) => [h.round, h.winner]), [[1, "blue"], [2, "blue"]]);
  assert.equal(st.round.number, 3, "and 3 is what the engine reports next");

  // 02:09:14 — the engine's FIRST round fact of the match agrees exactly.
  p.applyFact("round_number", 3);
  p.applyFact("round_phase", "shopping");
  assert.equal(state(p).round.number, 3, "fact and derivation agree");
  assert.equal(state(p).round.phase, "shopping");
  assert.equal(state(p).roundHistory.length, 2, "the fact does not duplicate R1/R2");

  p.applyFact("round_phase", "combat"); // 02:09:35
  assert.equal(snap(p).state.scene, "ingame-hud");
  p.applyFact("round_phase", "end"); // 02:10:20
  p.applyScore(3, 0, "fc-replay");
  assert.equal(state(p).roundHistory.at(-1).round, 3);
  assert.equal(state(p).roundHistory.length, 3, "R3 recorded exactly once");
  // 02:10:27 — the engine names round 4 itself and owns the phase from here on.
  p.applyFact("round_number", 4);
  p.applyFact("round_phase", "shopping");
  assert.equal(state(p).round.number, 4, "exactly as the engine reports");
  p.s.roundEndedAt = Date.now() - 6000;
  assert.equal(snap(p).state.scene, "buy-round", "02:10:27 — R4 buy");
});

});


test("PASS 3 — the engine's viewer-relative `teammate` flag splits a cold start", () => {
  // Live 2026-09-30 03:25:51: the engine emits the ENEMY rows first
  // (scoreboard_0..2, teammate:false) and the local squad afterwards
  // (teammate:true), while the viewer's own `is_local` row is not known yet.
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "cold-1", mapKey: "ascent" });
  p.applyFact("scoreboard", { name: "Shir0 #Eli", character: "Phoenix", teammate: false, team: 0, alive: true, credits: 800 });
  p.applyFact("scoreboard", { name: "Reyna", character: "Vampire", teammate: false, team: 0, alive: true, credits: 800 });
  const st0 = state(p);
  const idx0 = (name) => st0.roster.find((r) => r.displayName === name).teamIndex;
  assert.equal(idx0("Shir0 #Eli"), 1, "an opponent is right even before the local row is known");
  assert.equal(idx0("Reyna"), 1);

  p.applyFact("scoreboard", { name: "mikaerys #000", character: "Killjoy", teammate: true, team: 1, alive: true, credits: 800 });
  p.applyFact("scoreboard", { name: "Viewer #TAG", character: "Hunter", teammate: true, team: 1, is_local: true, alive: true, credits: 800 });
  const st = state(p);
  const idx = (name) => st.roster.find((r) => r.displayName === name).teamIndex;
  assert.equal(idx("mikaerys #000"), 0, "the viewer's squad is left");
  assert.equal(idx("Viewer #TAG"), 0);
  assert.equal(idx("Shir0 #Eli"), 1, "and the opponent stays right");
  assert.deepEqual(
    st.roster.filter((r) => r.teamIndex === 1).map((r) => r.displayName).sort(),
    ["Reyna", "Shir0 #Eli"],
  );
});


test("PASS 1 — round facts alone drive the scene when the session phase never lands", () => {
  // Live 2026-09-30: after a mid-match HU restart the engine re-published round
  // facts within seconds while its session phase stayed `unknown`; the popout
  // froze on its URL-picked scene for the whole round. A round fact is live-match
  // evidence, so it also settles the session phase itself (Pass 5: the runtime's
  // session phase lags the match load — live 05:41:10 `round 1/shopping` with
  // `pregame` still being reported for ~19 s).
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "unknown", matchId: "mid-restart", mapKey: "ascent" });
  p.applyFact("round_number", 6);
  p.applyFact("round_phase", "shopping");
  assert.equal(state(p).sessionPhase, "live", "a published round fact proves the match is live");
  p.s.roundEndedAt = Date.now() - 6000;
  assert.equal(snap(p).state.scene, "buy-round", "a known round phase is live evidence on its own");
  p.applyFact("round_phase", "combat");
  assert.equal(snap(p).state.scene, "ingame-hud");
});
