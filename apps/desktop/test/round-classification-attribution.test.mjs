/**
 * PASS 7C — round-result classification & winner attribution.
 *
 * THE INVARIANT (the whole point of this pass):
 *
 *   one settled round  ->  ONE authoritative round identity, ONE authoritative
 *                          winner/team, ONE classification
 *
 * and every consumer of that classification (Game Event ceremony + BuyRound
 * round reason) must see the SAME round and the SAME team.
 *
 * Live defect reproduced here (relay capture 2026-09-30, watch-live.log):
 *
 *   03:27:13.759  round 3 settled  winner=red   (the ENEMY's round)
 *   03:27:13.759  phase -> r3/end  gameEvent="Ace"      <- the enemy ACE, correct
 *   03:28:13.391  round 4 settled  winner=blue  (the viewer's round)
 *   03:28:13.397  phase -> r4/end  gameEvent="Ace"      <- r3's ACE on r4's win
 *
 * `gameEvent` was a bare string with no round and no team, so the website paired
 * it with whatever `roundEnd.winner` happened to be on the board — the reported
 * "my team won the round but FLAWLESS/ACE appeared on the enemy side" (Game
 * Event AND BuyRound both read the same shared winner, which is why they moved
 * together). The same capture showed a round-9 label surviving into rounds
 * 10-16 (eco-pass5 replay: `06:06:06.861` settled r15 while still publishing
 * r12's "Round Win").
 *
 * The fix records WHO the label belongs to (`gameEventRound`, published in the
 * relay contract) and drops any label that does not describe the settlement on
 * the board, so a classification can never migrate to another round or team.
 * Nothing is invented: when the label cannot be attributed it is published as
 * null (unknown), never as another round's classification.
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-p7c-"));
process.env.TEMP = fixtureDir;
process.env.TMP = fixtureDir;
process.env.LOCALAPPDATA = fixtureDir;

const { ValProjectionSession } = await import("../dist/main/projection.js");
const { toGameSnapshot } = await import("../dist/main/snapshot.js");

const CACHE = path.join(fixtureDir, "havoc-unleash-last-state.json");
const state = (p) => p.snapshotValue();
const snap = (p) => toGameSnapshot(p.snapshotValue());

/** A live match with a complete 5v5 board; the viewer's squad is Blue/left. */
function liveSession(matchId = "p7c-1", localTeam = 0) {
  fs.rmSync(CACHE, { force: true });
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId, mapKey: "haven" });
  for (let i = 0; i < 5; i++) {
    p.applyFact("scoreboard", {
      name: `Blue${i}#0001`,
      team: localTeam,
      is_local: i === 0,
      alive: true,
      credits: 800,
    });
    p.applyFact("scoreboard", {
      name: `Red${i}#0002`,
      team: localTeam === 0 ? 1 : 0,
      alive: true,
      credits: 800,
    });
  }
  p.applyScore(0, 0, matchId);
  return p;
}

/** Round start through the engine's own phase facts. */
function startRound(p, n) {
  p.applyFact("round_number", n);
  p.applyFact("round_phase", "shopping");
  p.applyFact("round_phase", "combat");
}

/** Kill facts exactly as the engine emits them (observed payload shape). */
const kill = (p, attacker, victim, weapon = "Vandal") =>
  p.applyFact("kill_feed", { attacker, victim, weapon, headshot: false, assist1: "", assist2: "" });

/** The runtime's AUTHORITATIVE settlement fact (round_settled). */
const engineSettle = (
  p,
  roundNumber,
  winnerStartTeam,
  winType,
  winningReason = "elimination",
  winningSide = "attack",
) =>
  p.applyFact("round_settled", {
    roundNumber,
    winnerStartTeam,
    winningSide,
    winningReason,
    winType,
  });

/**
 * The pass invariant, asserted against BOTH published layers (relay state and
 * the bridge snapshot the website consumes).
 */
function assertAttributionHolds(p, where) {
  const st = state(p);
  const gs = snap(p).state;
  for (const [name, s] of [
    ["relay", st],
    ["snapshot", gs],
  ]) {
    if (s.gameEvent === null || s.gameEvent === undefined) {
      assert.equal(s.gameEventRound ?? null, null, `${where} (${name}): no label -> no owner`);
      continue;
    }
    assert.notEqual(s.roundEnd ?? null, null, `${where} (${name}): a label needs a settlement`);
    assert.equal(
      s.gameEventRound,
      s.roundEnd.round,
      `${where} (${name}): the label must belong to the settled round`,
    );
  }
}

/* ------------------------- A — normal round win ---------------------------- */

test("PASS 7C — a settled round publishes one winner, one reason, one label identity", () => {
  const p = liveSession();
  startRound(p, 1);
  // The viewer's team wins by elimination; one of its players dies (so the
  // round is a plain "Round Win", not FLAWLESS/ACE/TEAM ACE).
  kill(p, "Red0", "Blue4");
  kill(p, "Blue0", "Red0");
  kill(p, "Blue0", "Red1");
  kill(p, "Blue0", "Red2");
  kill(p, "Blue0", "Red3");
  kill(p, "Blue1", "Red4");
  p.applyFact("round_phase", "end");

  const st = state(p);
  assert.equal(st.roundEnd.round, 1, "the settled round is the identity");
  assert.equal(st.roundEnd.winner, "blue", "the viewer's team won");
  assert.equal(st.roundEnd.reason, "elimination", "the wiped losing side is elimination evidence");
  assert.equal(st.gameEvent, "Round Win");
  assert.equal(st.gameEventRound, 1, "the label is owned by round 1");
  assert.deepEqual(st.roundHistory.at(-1), { round: 1, winner: "blue", reason: "elimination" });

  // Game Event and BuyRound both read this: the same winner for the same round.
  const gs = snap(p).state;
  assert.equal(gs.roundEnd.winner, "blue");
  assert.equal(gs.gameEvent, "Round Win");
  assert.equal(gs.gameEventRound, gs.roundEnd.round);
  assertAttributionHolds(p, "normal round win");
});

/* ------------------- B — the reported wrong-team FLAWLESS ------------------- */

test("PASS 7C — FLAWLESS is attributed to the team that actually won the settled round", () => {
  const p = liveSession();
  startRound(p, 3);
  // Round 3: the ENEMY aces the viewer's team (the engine reports it).
  for (let i = 0; i < 5; i++) kill(p, "Red0", `Blue${i}`);
  p.applyScore(0, 3, "p7c-1");
  engineSettle(p, 3, 1, "Ace");
  assert.equal(state(p).roundEnd.winner, "red");
  assert.equal(state(p).gameEvent, "Ace");
  assert.equal(state(p).gameEventRound, 3);

  // Round 4: the viewer's team wins with NO deaths — the engine says FLAWLESS.
  p.applyFact("round_number", 4);
  p.applyFact("round_phase", "shopping");
  p.applyFact("round_phase", "combat");
  p.applyScore(1, 3, "p7c-1");
  engineSettle(p, 4, 0, "Flawless", "elimination", "defense");

  const st = state(p);
  assert.equal(st.roundEnd.round, 4, "round 4 is the settled round");
  assert.equal(st.roundEnd.winner, "blue", "the viewer's team won it");
  assert.equal(st.gameEvent, "Flawless");
  assert.equal(
    st.gameEventRound,
    4,
    "FLAWLESS belongs to the round/team it was proven for — never to the enemy's earlier round",
  );
  assertAttributionHolds(p, "flawless attribution");
  // And the previous round's ACE is gone: it can never ride along with round 4.
  assert.notEqual(st.gameEvent, "Ace", "the enemy's round-3 ACE must not describe round 4");
});

/* ------- C — a late frame cannot move an earlier round's label ------------- */

test("PASS 7C — a late engine frame cannot move an earlier round's label onto the live round", () => {
  const p = liveSession();
  startRound(p, 1);
  engineSettle(p, 1, 0, "Flawless");
  assert.equal(state(p).gameEvent, "Flawless");
  assert.equal(state(p).gameEventRound, 1);

  // The transition: the live round advances and the viewer's side changes.
  p.applyFact("viewer_side", "defense");
  p.applyFact("round_phase", "shopping");
  p.applyScore(2, 0, "p7c-1");
  // A late/duplicate frame for the ALREADY-settled round 1 arrives afterwards.
  engineSettle(p, 1, 1, "Ace");

  const st = state(p);
  assert.equal(st.roundEnd.round, 2, "the settled result is not overwritten");
  assert.equal(st.roundEnd.winner, "blue");
  assert.notEqual(st.gameEvent, "Ace", "an earlier round's label never lands on this round");
  assert.ok(
    st.gameEventRound === null || st.gameEventRound === st.roundEnd.round,
    "a published label always describes the settlement on the board",
  );
  assertAttributionHolds(p, "late frame");
});

/* --------- D — a classification never migrates to round N+1 --------------- */

test("PASS 7C — a settled classification cannot migrate to the next round", () => {
  const p = liveSession();
  startRound(p, 1);
  for (let i = 0; i < 5; i++) kill(p, "Blue0", `Red${i}`); // one player, five victims
  p.applyFact("round_phase", "end");

  assert.equal(state(p).gameEvent, "Ace", "the ACE is proven from identities");
  assert.equal(state(p).gameEventRound, 1);

  // The next round's buy: the banner is held on purpose, still owned by round 1.
  p.applyFact("round_phase", "shopping");
  assert.equal(state(p).gameEventRound, 1, "still round 1's classification");

  // The next settlement lands -> round 1's label can no longer be published.
  p.applyScore(2, 0, "p7c-1");
  const st = state(p);
  assert.equal(st.roundEnd.round, 2);
  assert.equal(st.gameEvent, null, "round 1's ACE cannot describe round 2's win");
  assert.equal(st.gameEventRound, null, "an unattributable label publishes no owner");
  assertAttributionHolds(p, "stale classification");
});

/* ------------------------------- E — ACE --------------------------------- */

test("PASS 7C — ACE stays attached to the settled round and its winner", () => {
  const blue = liveSession();
  startRound(blue, 1);
  for (let i = 0; i < 5; i++) kill(blue, "Blue0", `Red${i}`);
  blue.applyFact("round_phase", "end");
  assert.equal(state(blue).roundEnd.winner, "blue");
  assert.equal(state(blue).gameEvent, "Ace");
  assert.equal(state(blue).gameEventRound, state(blue).roundEnd.round);
  assertAttributionHolds(blue, "ace (viewer)");

  // The same round with the ace on the OTHER team must stay on that team.
  const red = liveSession();
  startRound(red, 1);
  for (let i = 0; i < 5; i++) kill(red, "Red0", `Blue${i}`);
  red.applyFact("round_phase", "end");
  assert.equal(state(red).roundEnd.winner, "red");
  assert.equal(state(red).gameEvent, "Ace", "the enemy ace is still reported as an ACE");
  assert.equal(state(red).gameEventRound, state(red).roundEnd.round);
  assertAttributionHolds(red, "ace (enemy)");
});

/* ----------------------------- F — TEAM ACE ------------------------------ */

test("PASS 7C — TEAM ACE is attributed to the settled round's winner", () => {
  const p = liveSession();
  startRound(p, 1);
  // Every winner gets exactly one kill; nobody gets five (so it is not an ACE).
  for (let i = 0; i < 5; i++) kill(p, `Blue${i}`, `Red${i}`);
  p.applyFact("round_phase", "end");

  const st = state(p);
  assert.equal(st.roundEnd.winner, "blue");
  assert.equal(st.gameEvent, "Team Ace");
  assert.equal(st.gameEventRound, st.roundEnd.round, "owned by the settled round");
  assertAttributionHolds(p, "team ace");
});

/* ------------------------------ G — CLUTCH ------------------------------- */

test("PASS 7C — CLUTCH is attributed to the settled round's winner", () => {
  const p = liveSession();
  startRound(p, 1);
  // The viewer's team is reduced to one player against five, then that player
  // eliminates the whole enemy team — a 1v5 clutch.
  for (let i = 1; i < 5; i++) kill(p, `Red${i}`, `Blue${i}`);
  for (let i = 0; i < 5; i++) kill(p, "Blue0", `Red${i}`);
  p.applyFact("round_phase", "end");

  const st = state(p);
  assert.equal(st.roundEnd.winner, "blue", "the surviving player's team won");
  assert.equal(st.gameEvent, "Clutch");
  assert.equal(st.gameEventRound, st.roundEnd.round, "owned by the settled round");
  assertAttributionHolds(p, "clutch");
});

/* ------------------------------ H — THRIFTY ------------------------------ */

test("PASS 7C — THRIFTY comes only from the engine and is owned by its round", () => {
  const p = liveSession();
  startRound(p, 1);
  p.applyScore(1, 0, "p7c-1");
  engineSettle(p, 1, 0, "Thrifty");
  let st = state(p);
  assert.equal(st.roundEnd.winner, "blue");
  assert.equal(st.gameEvent, "Thrifty");
  assert.equal(st.gameEventRound, 1);
  assertAttributionHolds(p, "thrifty");

  // The projection never invents THRIFTY: the same round without the engine's
  // winType classifies from its own evidence instead.
  const q = liveSession();
  startRound(q, 1);
  for (let i = 0; i < 5; i++) kill(q, "Blue0", `Red${i}`);
  q.applyFact("round_phase", "end");
  assert.notEqual(state(q).gameEvent, "Thrifty", "THRIFTY needs loadout-credit evidence");

  // ...and the label cannot ride into the next round's result.
  p.applyFact("round_number", 2);
  p.applyFact("round_phase", "shopping");
  p.applyScore(1, 1, "p7c-1");
  st = state(p);
  assert.equal(st.roundEnd.round, 2);
  assert.equal(st.gameEvent, null, "round 1's THRIFTY cannot describe round 2");
});

/* ------------------------ I — revive interaction ------------------------- */

test("PASS 7C — explicit alive evidence never re-attributes the settled classification", () => {
  const p = liveSession();
  startRound(p, 1);
  // The viewer's team wipes the enemy — but one of its own players is killed
  // first and then REVIVED (Pass 7B: the engine reports him alive again).
  kill(p, "Red0", "Blue4");
  for (let i = 0; i < 5; i++) kill(p, "Blue0", `Red${i}`);
  p.applyFact("scoreboard", {
    name: "Blue4#0001",
    team: 0,
    alive: true,
    health: 100,
    player_id: "p-blue4",
  });
  p.applyFact("round_phase", "end");

  const st = state(p);
  assert.equal(st.roundEnd.winner, "blue", "the winner is the settled round's own");
  assert.equal(st.gameEventRound, st.roundEnd.round, "the classification stays owned by it");
  // The revive must not fabricate a classification: a winner that actually died
  // (the round's own death evidence) can never produce FLAWLESS.
  assert.notEqual(st.gameEvent, "Flawless", "a revived winner is not a deathless round");
  assertAttributionHolds(p, "revive");
});

/* --------------------------- J — match boundary -------------------------- */

test("PASS 7C — a new match never inherits the previous match's classification", () => {
  const p = liveSession("match-a");
  startRound(p, 1);
  for (let i = 0; i < 5; i++) kill(p, "Blue0", `Red${i}`);
  p.applyFact("round_phase", "end");
  assert.equal(state(p).gameEvent, "Ace");

  // Match A ends, Match B starts (fresh score -> the authoritative boundary).
  p.applyScore(13, 3, "match-a");
  p.applyFact("round_phase", "game_end");
  p.applyScore(0, 0, "match-b");

  const st = state(p);
  assert.equal(st.gameEvent, null, "Match A's ACE never appears in Match B");
  assert.equal(st.gameEventRound, null);
  assert.equal(st.roundEnd, null);
  assert.equal(st.roundHistory.length, 0);
  assertAttributionHolds(p, "match boundary");
});
