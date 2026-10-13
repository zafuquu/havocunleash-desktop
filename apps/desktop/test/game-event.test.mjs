/**
 * PASS 4 — Game Event forensics.
 *
 * A) ACE classification. Live evidence (2026-09-30, competitive match on Haven):
 *    the capture engine emits EVERY kill twice — byte-identical `kill_feed`
 *    payloads a couple of milliseconds apart
 *      raw fact dump 03:26:38.352 `kill_feed {attacker:Hizamazuke, victim:Sova,
 *      weapon:TX_Hud_Assault_AR10A2_S}` ... twice
 *      relay kill feed showed every kill as a pair: seq 2/3, 4/5, 6/7 ... 14/15
 *    so the per-round kill counter doubled and the old `roundKills >= 5`
 *    predicate displayed ACE for rounds nobody aced (R1: the winning player had
 *    3 real kills -> 6 counted -> ACE; same again in rounds 16 and 17).
 *    An ACE is now only claimed on proven evidence: one player, five DISTINCT
 *    victims, all of them on a complete losing side.
 *
 * B) ONE completed round = ONE Game Event. The round-win event used to be keyed
 *    on the round CURRENTLY in progress and the marker was re-armed whenever that
 *    number changed, while the just-settled result deliberately stays on the
 *    board through the buy phase — so the next round's buy republished the same
 *    round win under the new round number and the site replayed the sequence from
 *    stage 1. The identity is now the COMPLETED round.
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-game-event-"));
process.env.TEMP = fixtureDir;
process.env.TMP = fixtureDir;
process.env.LOCALAPPDATA = fixtureDir;

const { ValProjectionSession } = await import("../dist/main/projection.js");
const { deriveBridgeEvents, initialBridgeEventState } = await import("../dist/main/gameEvents.js");

const state = (p) => p.snapshotValue();
const types = (events) => events.map((e) => e.type);
const roundWins = (events) => events.filter((e) => e.type === "roundWin");

/** A live match with a complete 5v5 board (the viewer's squad is Blue/left). */
function fullBoard(matchId = "ace-1") {
  fs.rmSync(path.join(fixtureDir, "havoc-unleash-last-state.json"), { force: true });
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId, mapKey: "ascent" });
  for (let i = 0; i < 5; i++) {
    p.applyFact("scoreboard", { name: `Blue${i}#0001`, team: 0, is_local: i === 0, alive: true, credits: 800 });
    p.applyFact("scoreboard", { name: `Red${i}#0001`, team: 1, alive: true, credits: 800 });
  }
  p.applyScore(0, 0, matchId);
  return p;
}

/** Kill facts exactly as the engine emits them (observed payload shape). */
function kill(p, attacker, victim, weapon = "Vandal") {
  p.applyFact("kill_feed", { attacker, victim, weapon, headshot: false, assist1: "", assist2: "" });
}


/* ------------------------------- A) ACE ----------------------------------- */

test("ACE — one player eliminating all five opponents is an ACE", () => {
  const p = fullBoard();
  combat(p, 5, 0, 0);
  for (let i = 0; i < 5; i++) kill(p, "Blue0#0001", `Red${i}#0001`);
  p.applyFact("round_phase", "end");
  p.applyScore(1, 0);
  assert.equal(state(p).gameEvent, "Ace");
  // No start-side evidence in this fixture, so the side label stays unknown
  // (the projection never invents one) — the winner/reason/identity are what
  // matter here. `round` is the settled round (the stable event identity).
  assert.deepEqual(state(p).roundEnd, {
    winner: "blue",
    reason: "elimination",
    winnerSide: null,
    round: 5,
  });
});

test("ACE — the engine's own winType is still authoritative", () => {
  const p = fullBoard("ace-engine");
  combat(p, 5, 0, 0);
  p.applyFact("round_settled", {
    roundNumber: 5,
    winnerStartTeam: 0,
    winningSide: "attack",
    winningReason: "elimination",
    winType: "Ace",
  });
  assert.equal(state(p).gameEvent, "Ace", "ground truth from the runtime is preserved");
});

test("ACE — a 3-kill round delivered TWICE (live duplicate facts) is never an ACE", () => {
  const p = fullBoard("ace-dup");
  combat(p, 16, 3, 6);
  // Live 2026-09-30: the engine emits each kill twice, byte-identical.
  for (let i = 0; i < 3; i++) {
    kill(p, "Blue0#0001", `Red${i}#0001`);
    kill(p, "Blue0#0001", `Red${i}#0001`);
  }
  assert.equal(state(p).killfeed.length, 3, "the duplicate facts are not applied twice");
  p.applyFact("round_phase", "end");
  p.applyScore(4, 6);
  const st = state(p);
  assert.notEqual(st.gameEvent, "Ace", "3 real kills can never be an ACE (old code counted 6)");
  assert.equal(st.roundEnd.winner, "blue");
});

test("ACE — a team wipe split across players is not an ACE", () => {
  const p = fullBoard("ace-split");
  combat(p, 7, 2, 3);
  for (let i = 0; i < 5; i++) kill(p, `Blue${i}#0001`, `Red${i}#0001`);
  // PASS 7C: the live ordering is SCORE FIRST, then the end-phase fact (the
  // engine delivers match_score ~0.4 s before round_phase end — watch-live.log
  // 03:28:13.391/.397). The classification is now owned by the settlement on the
  // board, so it must be produced after that settlement names its round;
  // producing it first would bind the label to a round the next score frame
  // replaces (and it would be dropped, correctly, as unattributable).
  p.applyScore(3, 3);
  p.applyFact("round_phase", "end");
  assert.notEqual(state(p).gameEvent, "Ace", "each player eliminated one opponent");
  assert.equal(state(p).gameEvent, "Team Ace", "the existing team-wide label still applies");
  assert.equal(
    state(p).gameEventRound,
    state(p).roundEnd.round,
    "and it is owned by the settled round",
  );
});

test("ACE — four kills by one player and the fifth by another is not an ACE", () => {
  const p = fullBoard("ace-four");
  combat(p, 8, 3, 3);
  for (let i = 0; i < 4; i++) kill(p, "Blue0#0001", `Red${i}#0001`);
  kill(p, "Blue1#0001", "Red4#0001");
  p.applyFact("round_phase", "end");
  p.applyScore(4, 3);
  assert.notEqual(state(p).gameEvent, "Ace");
});

test("ACE — the same victim killed twice counts once", () => {
  const p = fullBoard("ace-repeat");
  combat(p, 9, 4, 3);
  kill(p, "Blue0#0001", "Red0#0001", "Vandal");
  p.s.lastKillFact = null; // a legit re-kill is seconds later (revive/re-engage)
  kill(p, "Blue0#0001", "Red0#0001", "Phantom");
  p.applyFact("round_phase", "end");
  p.applyScore(5, 3);
  assert.notEqual(state(p).gameEvent, "Ace", "one victim is not five opponents");
});

test("ACE — an incomplete board can never prove an ACE", () => {
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "ace-partial", mapKey: "ascent" });
  p.applyFact("scoreboard", { name: "Solo#0001", team: 0, is_local: true, alive: true, credits: 800 });
  for (let i = 0; i < 3; i++) {
    p.applyFact("scoreboard", { name: `Red${i}#0001`, team: 1, alive: true, credits: 800 });
  }
  p.applyScore(0, 0, "ace-partial");
  p.applyFact("round_number", 10);
  p.applyFact("round_phase", "combat");
  for (let i = 0; i < 3; i++) kill(p, "Solo#0001", `Red${i}#0001`);
  p.applyFact("round_phase", "end");
  p.applyScore(1, 0, "ace-partial");
  assert.notEqual(state(p).gameEvent, "Ace", "only three opponents are known -> UNKNOWN, never invented");
});

test("ACE — a previous round's ACE never leaks into the next round", () => {
  const p = fullBoard("ace-carry");
  combat(p, 4, 0, 0, "ace-carry");
  for (let i = 0; i < 5; i++) kill(p, "Blue0#0001", `Red${i}#0001`);
  p.applyFact("round_phase", "end");
  p.applyScore(1, 0, "ace-carry");
  assert.equal(state(p).gameEvent, "Ace", "sanity: round 4 really was an ACE");

  // Round 5: no kills at all.
  p.applyFact("round_number", 5);
  p.applyFact("round_phase", "shopping");
  p.applyFact("round_phase", "combat");
  p.applyFact("round_phase", "end");
  p.applyScore(2, 0, "ace-carry");
  const st = state(p);
  assert.notEqual(st.gameEvent, "Ace", "round 5 must not inherit round 4's ACE condition");
  assert.equal(st.roundHistory.filter((h) => h.round === 5).length, 1);
});

function combat(p, round, blue, red, matchId = undefined) {
  p.applyFact("round_number", round);
  p.applyFact("round_phase", "combat");
  p.applyScore(blue, red, matchId);
}

/* -------------------- B) ONE round = ONE Game Event ------------------------ */

/** Round 5 settled on the board (its result stays visible through the buy phase). */
function settledRound(matchId = "ge-1") {
  const p = fullBoard(matchId);
  p.applyFact("round_number", 5);
  p.applyFact("round_phase", "combat");
  kill(p, "Blue0#0001", "Red0#0001");
  p.applyFact("round_phase", "end");
  p.applyScore(1, 0, matchId);
  return p;
}

test("Game Event — one completed round emits exactly ONE roundWin", () => {
  const p = settledRound();
  const a = deriveBridgeEvents(state(p), initialBridgeEventState());
  assert.equal(roundWins(a.events).length, 1);
  assert.equal(roundWins(a.events)[0].data.roundNumber, 5);
  assert.equal(roundWins(a.events)[0].data.winningCompetitorId, "blue");
  assert.ok(types(a.events).includes("roundStart"), "the round start still flows");

  // Repeated identical snapshots must not re-emit anything.
  const b = deriveBridgeEvents(state(p), a.next);
  assert.equal(roundWins(b.events).length, 0);
  const b2 = deriveBridgeEvents(state(p), b.next);
  assert.deepEqual(b2.events, []);
});

test("Game Event — a score update after the settlement does not re-emit", () => {
  const p = settledRound("ge-2");
  const a = deriveBridgeEvents(state(p), initialBridgeEventState());
  p.applyScore(1, 0, "ge-2"); // duplicate score frame
  const b = deriveBridgeEvents(state(p), a.next);
  assert.equal(roundWins(b.events).length, 0);
});

test("Game Event — the next round's buy never replays the completed one (the reported stage-1 restart)", () => {
  const p = settledRound("ge-3");
  const a = deriveBridgeEvents(state(p), initialBridgeEventState());
  // Round 6 opens in its buy phase while round 5's result is still on the board
  // — exactly the window in which the old key replayed the Game Event.
  p.applyFact("round_number", 6);
  p.applyFact("round_phase", "shopping");
  const st = state(p);
  assert.equal(st.roundEnd.winner, "blue", "round 5's result is deliberately still published");
  assert.deepEqual(st.roundHistory.at(-1), { round: 5, winner: "blue", reason: "elimination" });

  const b = deriveBridgeEvents(st, a.next);
  assert.deepEqual(types(b.events), ["roundStart"], "round 6 starts; the round win is NOT replayed");
  assert.equal(roundWins(b.events).length, 0);

  // Stay in the buy phase: still nothing.
  const c = deriveBridgeEvents(state(p), b.next);
  assert.deepEqual(c.events, []);
});

test("Game Event — round 6 settles once, and a late terminal event never duplicates it", () => {
  const p = settledRound("ge-4");
  const a = deriveBridgeEvents(state(p), initialBridgeEventState());
  p.applyFact("round_number", 6);
  p.applyFact("round_phase", "shopping");
  const b = deriveBridgeEvents(state(p), a.next);
  p.applyFact("round_phase", "combat");
  const c = deriveBridgeEvents(state(p), b.next);
  assert.deepEqual(c.events, [], "combat adds no event for the same round");

  p.applyFact("round_phase", "end");
  p.applyScore(2, 0, "ge-4");
  const d = deriveBridgeEvents(state(p), c.next);
  assert.deepEqual(roundWins(d.events).map((e) => e.data.roundNumber), [6]);

  // Late terminal correction: the completed round's reason may be corrected...
  p.applyFact("spike_defused", null);
  assert.equal(state(p).roundEnd.reason, "defusion");
  const e = deriveBridgeEvents(state(p), d.next);
  assert.equal(roundWins(e.events).length, 0, "...but the Game Event is never emitted twice");

  // ...and the round history never carries a duplicate entry (Step 9).
  const rounds = state(p).roundHistory.map((h) => h.round);
  assert.deepEqual(rounds, [...new Set(rounds)], "no duplicate round settlement");
});

test("Game Event — the match end is emitted once, and a new match re-arms the stream", () => {
  const p = settledRound("ge-5");
  const a = deriveBridgeEvents(state(p), initialBridgeEventState());
  p.applyScore(13, 0, "ge-5");
  const b = deriveBridgeEvents(state(p), a.next);
  assert.deepEqual(types(b.events), ["matchEnd"]);
  const c = deriveBridgeEvents(state(p), b.next);
  assert.equal(c.events.filter((e) => e.type === "matchEnd").length, 0);

  // New match: the projection wipes the previous match, the stream re-arms.
  p.applySnapshot({ sessionPhase: "live", matchId: "ge-6", mapKey: "bind" });
  const d = deriveBridgeEvents(state(p), c.next);
  assert.equal(d.events.filter((e) => e.type === "matchEnd").length, 0);
  p.applyFact("round_number", 1);
  p.applyFact("round_phase", "combat");
  p.applyFact("round_phase", "end");
  p.applyScore(0, 1, "ge-6");
  const e = deriveBridgeEvents(state(p), d.next);
  assert.deepEqual(roundWins(e.events).map((x) => x.data.roundNumber), [1]);
});

test("Game Event — the score-derived (no round fact) path also emits exactly one roundWin", () => {
  // Same invariant for the fork dialect where the round boundary is derived from
  // the score: the settle and the next round's buy boundary land together, and
  // the settled result stays on the board afterwards.
  const p = fullBoard("ge-synth");
  p.applyFact("round_phase", "combat");
  kill(p, "Blue0#0001", "Red0#0001");
  const a = deriveBridgeEvents(state(p), initialBridgeEventState());
  p.applyScore(1, 0, "ge-synth"); // R1 settles; R2's buy boundary is derived
  const st = state(p);
  assert.equal(st.round.number, 2, "the derived round boundary is on the board");
  assert.equal(st.roundEnd.winner, "blue", "together with the settled result");

  const b = deriveBridgeEvents(st, a.next);
  assert.deepEqual(roundWins(b.events).map((e) => e.data.roundNumber), [1], "exactly one event for round 1");
  assert.deepEqual(types(b.events), ["roundStart", "roundWin"], "round 2 starts, round 1 wins once");

  const c = deriveBridgeEvents(state(p), b.next);
  assert.equal(roundWins(c.events).length, 0, "no replay while the next round is being played");
});

