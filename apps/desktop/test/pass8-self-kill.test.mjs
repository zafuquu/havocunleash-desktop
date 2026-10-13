/**
 * PASS 8 — self-kill frames must never inflate kills or Team Ace.
 *
 * BLOB's kill-feed contract treats the attacker as OPTIONAL and only credits a
 * kill on resolved, live attacker evidence
 * (`isValorantKillfeedLiveAttackerEvidence` = the cause is a WEAPON, so
 * objective/environmental causes like `fall_damage`/`spike`/`bomb` are not
 * attacker evidence). HU's `trackRoundKill` had NO such guard: an
 * attacker === victim frame credited the victim with a kill of themselves.
 *
 * Consequences found in HU:
 *   - K/D inflation (BuyRound, IngameHUD scoreboard and `computeMvp` all read
 *     the dead player's `kills` counter);
 *   - FALSE TEAM ACE: Team Ace is "every winner got at least one kill"
 *     (`projection.ts` ~2338, reading `roundKills`), so a team whose only
 *     "kill" was one of its own players dying to themselves was labelled
 *     Team Ace.
 *   - Ace was ALREADY safe: `provenAce` requires every victim to be on the
 *     LOSING side, so a killer's own name can never satisfy it. Pinned here.
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-p8-"));
process.env.TEMP = fixtureDir;
process.env.TMP = fixtureDir;
process.env.LOCALAPPDATA = fixtureDir;

const { ValProjectionSession } = await import("../dist/main/projection.js");

const CACHE = path.join(fixtureDir, "havoc-unleash-last-state.json");
const state = (p) => p.snapshotValue();
const row = (p, name) => state(p).roster.find((r) => r.displayName === name);

/** A live match whose 5v5 board comes from the engine's scoreboard frames. */
function board(matchId = "m-p8") {
  fs.rmSync(CACHE, { force: true });
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId, mapKey: "ascent" });
  for (let i = 1; i <= 5; i++) {
    p.applyFact("scoreboard", { name: `Blue${i}#0001`, team: 0, is_local: i === 1, alive: true, credits: 4000 });
    p.applyFact("scoreboard", { name: `Red${i}#0001`, team: 1, alive: true, credits: 4000 });
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

const kill = (p, attacker, victim, weapon = "Vandal") =>
  p.applyFact("kill_feed", { attacker, victim, weapon, headshot: false });

/** The runtime's AUTHORITATIVE settlement (round_settled) — drives classification. */
const engineSettle = (p, roundNumber, winnerStartTeam, winType = "elimination") =>
  p.applyFact("round_settled", {
    roundNumber,
    winnerStartTeam,
    winningSide: "attack",
    winningReason: "elimination",
    winType,
  });

/* --------------------------- self-kill: no kill credit --------------------------- */

test("8-1 — a self-kill kills the player but credits them no kill", () => {
  const p = board();
  startRound(p, 1);
  kill(p, "Blue1#0001", "Blue1#0001", "fall_damage");

  const me = row(p, "Blue1#0001");
  assert.equal(me.isAlive, false, "the death still applies");
  assert.equal(me.health, 0, "and so does the health wipe");
  assert.equal(me.deaths, 1, "exactly one death is recorded");
  assert.equal(me.kills ?? 0, 0, "NO kill is credited for killing yourself");
  assert.equal(p.s.roundKills.get("blue1") ?? 0, 0, "no round-kill evidence either");
});

test("8-2 — a real kill is unaffected by the self-kill guard", () => {
  const p = board();
  startRound(p, 1);
  kill(p, "Blue1#0001", "Red1#0001");

  assert.equal(row(p, "Red1#0001").isAlive, false, "the victim dies");
  assert.equal(row(p, "Red1#0001").deaths, 1);
  assert.equal(row(p, "Blue1#0001").kills, 1, "a normal kill is still credited");
  assert.equal(p.s.roundKills.get("blue1"), 1);
  assert.equal(p.s.roundKillVictims.get("blue1").size, 1, "the opponent is the ACE evidence");
});

/* ------------------------------ Team Ace integrity ------------------------------ */

/** Blue sweeps Red, but Blue5's ONLY "kill" is a self-kill. */
function teamAceScenario(matchId = "m-teamace") {
  const p = board(matchId);
  startRound(p, 1);
  kill(p, "Blue1#0001", "Red1#0001");
  kill(p, "Blue2#0001", "Red2#0001");
  kill(p, "Blue3#0001", "Red3#0001");
  kill(p, "Blue4#0001", "Red4#0001");
  kill(p, "Blue1#0001", "Red5#0001");
  kill(p, "Blue5#0001", "Blue5#0001", "fall_damage"); // self-inflicted
  return p;
}

test("8-3 — a self-kill cannot hand a team a false Team Ace", () => {
  const p = teamAceScenario();
  assert.equal(row(p, "Blue5#0001").kills ?? 0, 0, "Blue5 has no credited kill");

  engineSettle; // (documented below for the engine-winType path)
  p.applyFact("round_phase", "end"); // the end phase settles AND classifies

  const st = state(p);
  assert.equal(st.roundEnd?.winner, "blue", "Blue did win the round");
  assert.notEqual(st.gameEvent, "Team Ace", "a team whose 5th player only self-killed is NOT a Team Ace");
  assert.equal(st.gameEvent, "Round Win", "it degrades to the honest Round Win");
});

test("8-4 — a genuine Team Ace (every winner really killed someone) still classifies", () => {
  const p = board("m-realace");
  startRound(p, 1);
  kill(p, "Blue1#0001", "Red1#0001");
  kill(p, "Blue2#0001", "Red2#0001");
  kill(p, "Blue3#0001", "Red3#0001");
  kill(p, "Blue4#0001", "Red4#0001");
  kill(p, "Blue5#0001", "Red5#0001");

  p.applyFact("round_phase", "end");
  assert.equal(state(p).gameEvent, "Team Ace", "five real killers still earn Team Ace");
});

/* --------------------------------- Ace safety --------------------------------- */

test("8-5 — four opponents plus a self-kill is never an Ace", () => {
  const p = board("m-ace");
  startRound(p, 1);
  kill(p, "Blue1#0001", "Red1#0001");
  kill(p, "Blue1#0001", "Red2#0001");
  kill(p, "Blue1#0001", "Red3#0001");
  kill(p, "Blue1#0001", "Red4#0001");
  kill(p, "Blue1#0001", "Blue1#0001", "Spike"); // Blue1 then dies to their own utility
  kill(p, "Blue2#0001", "Red5#0001");

  p.applyFact("round_phase", "end");
  const st = state(p);
  assert.equal(st.roundEnd?.winner, "blue");
  assert.notEqual(st.gameEvent, "Ace", "four opponents + a self-kill is not an Ace");
});
