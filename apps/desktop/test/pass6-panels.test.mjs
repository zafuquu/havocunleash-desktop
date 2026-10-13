/**
 * PASS 6 — player slot mapping, stable identity, and Game Event sides.
 *
 * What this file pins (each item's boundary was established forensically):
 *
 *  - ROSTER: a normal 5v5 board is published as exactly 5 left / 5 right / 10
 *    unique players, in a STABLE order, and every row carries the engine's own
 *    stable identity (GEP `player_id`) when the provider reports one.
 *  - PLAYER DATA FOLLOWS IDENTITY, NOT THE PANEL INDEX: the 5th row on either
 *    side owns its own agent/shield/ult/weapon/credits, and the local player's
 *    abilities stay attached to the local player's row wherever it sits (row 1
 *    or row 5). Panel position is presentation only.
 *  - NO FABRICATION: a row that has an identity but no economy/loadout/ability
 *    telemetry stays null (missing ≠ zero).
 *  - GAME EVENT SIDES: the round result keeps the winner's SIDE
 *    (attacker/defender) — including when the session never reported a start
 *    side — and a team winning never turns into "attacker/defender" by identity.
 *    `roundEnd.round` is the settled round: the stable identity a consumer must
 *    key the Game Event on (keying on the round in progress replays the event).
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-pass6-"));
process.env.TEMP = fixtureDir;
process.env.TMP = fixtureDir;
process.env.LOCALAPPDATA = fixtureDir;

const { ValProjectionSession } = await import("../dist/main/projection.js");
const { toGameSnapshot } = await import("../dist/main/snapshot.js");
const state = (p) => p.snapshotValue();
const snap = (p) => toGameSnapshot(p.snapshotValue());

// GEP speaks internal agent CODENAMES ("smonk") — the provider's `character`
// field is one of these, and the projection resolves it to a display name.
const LEFT_AGENTS = ["killjoy", "vampire", "sprinter", "hunter", "smonk"];
const RIGHT_AGENTS = ["wushu", "thorne", "wraith", "gumshoe", "bountyhunter"];
const LEFT_AGENT_NAMES = ["Killjoy", "Reyna", "Neon", "Sova", "Clove"];
const RIGHT_AGENT_NAMES = ["Jett", "Sage", "Omen", "Cypher", "Fade"];

/** A complete 5v5 board; every row carries its own engine player_id. */
function board(matchId = "p6-1", localIndex = 0) {
  fs.rmSync(path.join(fixtureDir, "havoc-unleash-last-state.json"), { force: true });
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId, mapKey: "ascent" });
  for (let i = 0; i < 5; i++) {
    p.applyFact("scoreboard", {
      name: `L${i}#0001`,
      character: LEFT_AGENTS[i],
      teammate: true,
      team: 0,
      is_local: i === localIndex,
      alive: true,
      player_id: `puuid-L${i}`,
      credits: 4000 + i,
      weapon: "TX_Hud_Rifles_Volcano",
      shield: i,
      ult_points: i,
      ult_max: 8,
      kills: i,
      deaths: 0,
      assists: 0,
    });
    p.applyFact("scoreboard", {
      name: `R${i}#0002`,
      character: RIGHT_AGENTS[i],
      teammate: false,
      team: 1,
      alive: true,
      player_id: `puuid-R${i}`,
      credits: 3000 + i,
      weapon: "TX_Hud_Sniper_Operater",
      shield: 2,
      ult_points: i + 1,
      ult_max: 7,
      kills: i,
      deaths: 1,
      assists: 2,
    });
  }
  p.applyFact("round_number", 1);
  p.applyFact("round_phase", "shopping");
  return p;
}

const byPuuid = (p, puuid) => snap(p).state.players.find((r) => r.puuid === puuid);
const row = (p, name) => state(p).roster.find((r) => r.displayName === name);

/* ------------------------------ ROSTER ------------------------------------ */

test("roster — exactly 5 left / 5 right / 10 unique players, stable order", () => {
  const p = board();
  const st = state(p);
  const left = st.roster.filter((r) => r.teamIndex === 0);
  const right = st.roster.filter((r) => r.teamIndex === 1);
  assert.equal(left.length, 5, "5 left");
  assert.equal(right.length, 5, "5 right");
  assert.equal(st.roster.length, 10, "10 rows total");
  assert.equal(new Set(st.roster.map((r) => r.displayName)).size, 10, "10 unique players");
  assert.equal(new Set(st.roster.map((r) => r.puuid)).size, 10, "10 unique engine identities");
  assert.equal(
    snap(p).state.players.filter((r) => r.teamIndex === 0).length,
    5,
    "the snapshot publishes the same 5/5 split",
  );

  // Ordering is stable: an extra frame for one row must not reorder the board.
  const before = st.roster.map((r) => r.displayName);
  p.applyFact("scoreboard", { name: "L2#0001", team: 0, alive: true, player_id: "puuid-L2", credits: 1234 });
  assert.deepEqual(state(p).roster.map((r) => r.displayName), before, "row order unchanged");
});

test("roster — duplicate identity is deduped by engine id, not by array position", () => {
  const p = board("p6-dup");
  // The same player re-sent (the engine repeats rows verbatim) -> still one row.
  p.applyFact("scoreboard", { name: "L3#0001", team: 0, alive: true, player_id: "puuid-L3", credits: 4003 });
  assert.equal(state(p).roster.filter((r) => r.puuid === "puuid-L3").length, 1, "same id -> one row");
  assert.equal(state(p).roster.length, 10);

  // The SAME engine identity arriving under a second spelling (the provider's
  // dialect mismatch — one fact says "L4#0001", another says "L4b#0001") is still
  // ONE player: the published board must not grow a phantom 11th row, and the
  // surviving row is the established one (never a position-dependent pick).
  const stable = snap(p).state.players.find((r) => r.puuid === "puuid-L4");
  p.applyFact("scoreboard", { name: "L4b#0001", team: 0, alive: true, player_id: "puuid-L4", credits: 1234 });
  const withId = snap(p).state.players.filter((r) => r.puuid === "puuid-L4");
  assert.equal(withId.length, 1, "one engine identity -> one published row");
  assert.equal(
    snap(p).state.players.length,
    10,
    "the re-spelling does not grow the published board to 11 rows",
  );
  assert.equal(withId[0].name, stable.name, "the established row is the one kept");
});

test("roster — an established row never re-keys to a later id", () => {
  const p = board("p6-key");
  // A frame for the same player that disagrees about the id must not move the row.
  p.applyFact("scoreboard", { name: "L1#0001", team: 0, alive: true, player_id: "someone-else" });
  assert.equal(row(p, "L1#0001").puuid, "puuid-L1", "the first id wins (stable identity)");
  assert.equal(state(p).roster.filter((r) => r.puuid === "someone-else").length, 0, "no phantom identity");
  assert.equal(row(p, "L1#0001").agentName, LEFT_AGENT_NAMES[1], "and its telemetry is untouched");
});

test("roster — a row with only an identity never fabricates telemetry", () => {
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "p6-sparse", mapKey: "ascent" });
  p.applyFact("scoreboard", { name: "Solo#0001", teammate: true, team: 0, is_local: true, alive: true, player_id: "puuid-solo" });
  const r = row(p, "Solo#0001");
  assert.equal(r.puuid, "puuid-solo", "identity is kept");
  assert.equal(r.credits ?? null, null, "no credits reported -> unknown");
  assert.equal(r.weapon ?? null, null, "no weapon reported -> unknown");
  assert.equal(r.shieldType ?? null, null, "no shield evidence -> unknown");
  assert.equal(r.agentName ?? null, null, "no agent reported -> unknown");
  assert.equal(r.ultPoints ?? null, null, "no ult evidence -> unknown");
  assert.equal(r.abilityState ?? null, null, "no ability fact -> unknown");
});


/* -------------------- PLAYER DATA FOLLOWS IDENTITY ------------------------ */

test("player rows — the 5th row on each side owns its own telemetry", () => {
  const p = board("p6-p5");
  // Player 5 on the LEFT (row 5) — resolved by ENGINE IDENTITY, not by index.
  const l4 = byPuuid(p, "puuid-L4");
  assert.equal(l4.name, "L4", "identity");
  assert.equal(l4.agentName, LEFT_AGENT_NAMES[4], "the 5th left player's own agent");
  assert.equal(byPuuid(p, "puuid-L0").agentName, LEFT_AGENT_NAMES[0], "row 1 keeps its own agent");
  assert.equal(l4.weapon, "Vandal", "own weapon");
  assert.equal(l4.credits, 4004, "own credits");
  assert.equal(l4.shield, 25, "own shield points");
  assert.equal(l4.shieldType, 4, "own shield tier (regen preserved)");
  assert.equal(l4.ultPoints, 4, "own ultimate charge");
  assert.equal(l4.ultMax, 8);
  assert.equal(l4.kills, 4, "own K/D/A");
  // Player 5 on the RIGHT (row 10).
  const r4 = byPuuid(p, "puuid-R4");
  assert.equal(r4.name, "R4");
  assert.equal(r4.agentName, RIGHT_AGENT_NAMES[4]);
  assert.equal(r4.weapon, "Operator");
  assert.equal(r4.credits, 3004);
  assert.equal(r4.shieldType, 2);
  assert.equal(r4.ultPoints, 5);
  assert.equal(r4.teamIndex, 1, "still the right side");
  // And the two rows are not sharing values.
  assert.notEqual(l4.credits, r4.credits);
  assert.notEqual(l4.weapon, r4.weapon);
});

test("player rows — the runtime snapshot's playerId becomes the row identity", () => {
  // The live dialect: the runtime's session snapshot carries each player's GEP
  // `player_id` as `player.playerId` (server.ts playerToSnapshot). This is the
  // identity the live 2026-09-30 session reported for the local player
  // (fdc0d872-...), so it must survive into the published row.
  const p = new ValProjectionSession();
  p.applySnapshot({
    sessionPhase: "live",
    matchId: "p6-snap",
    mapKey: "ascent",
    session: { viewer: { player: { name: { displayName: "Solo#0001" } } } },
    teams: [
      {
        teamId: "Blue",
        startingSide: "defense",
        players: [
          {
            player: {
              playerId: "fdc0d872-660a-5a28-975a-1ac8e6858dbb",
              identity: { displayName: "Solo#0001", gameName: "Solo", tagLine: "0001" },
            },
            agent: { key: "cashew", name: "Tejo", riotId: "Solo" },
            observerSlot: 0,
          },
        ],
      },
      {
        teamId: "Red",
        startingSide: "attack",
        players: [
          {
            player: {
              playerId: "11111111-2222-3333-4444-555555555555",
              identity: { displayName: "Foe#0002", gameName: "Foe", tagLine: "0002" },
            },
          },
        ],
      },
    ],
  });
  const solo = state(p).roster.find((r) => r.displayName === "Solo#0001");
  assert.equal(solo.puuid, "fdc0d872-660a-5a28-975a-1ac8e6858dbb", "snapshot identity -> row identity");
  assert.equal(solo.slot, 0, "the observer slot travels with the same row");
  // An identity-LESS fact for the same player must not clear it.
  p.applyFact("scoreboard", { name: "Solo#0001", team: 0, is_local: true, alive: true, credits: 800 });
  assert.equal(row(p, "Solo#0001").puuid, "fdc0d872-660a-5a28-975a-1ac8e6858dbb", "identity is sticky");
  assert.equal(snap(p).state.players.find((r) => r.name === "Solo").puuid, "fdc0d872-660a-5a28-975a-1ac8e6858dbb");
});

test("player rows — the local player's abilities follow their row wherever it sits", () => {
  // The local player is the LAST left row here (row 5) — the panel index must
  // never decide whose charges a row carries.
  const p = board("p6-local5", 4);
  p.applyFact("abilities", { C: true, Q: false, E: true, X: false });
  assert.deepEqual(
    byPuuid(p, "puuid-L4").abilityState,
    { C: true, Q: false, E: true, X: false },
    "the 5th row carries the local charges",
  );
  assert.equal(byPuuid(p, "puuid-L4").abilities.join(""), "CE", "and the slot list");
  assert.equal(byPuuid(p, "puuid-L0").abilityState ?? null, null, "row 1 stays unknown");
  assert.equal(byPuuid(p, "puuid-R4").abilityState ?? null, null, "the opponent stays unknown");
  // Every other player has no ability telemetry at all (the provider only
  // reports the local player's charges) — unknown, never all-false.
  assert.deepEqual(
    snap(p).state.players.filter((r) => r.puuid !== "puuid-L4" && r.abilityState != null),
    [],
    "nobody else is given fabricated charges",
  );
});

/* --------------------------- GAME EVENT SIDES ----------------------------- */

/** Settle round 1 with the given score after the round started with `side`. */
function settleRound(p, blue, red, matchId) {
  p.applyFact("round_phase", "combat");
  p.applyFact("round_phase", "end");
  p.applyScore(blue, red, matchId);
  return state(p).roundEnd;
}

test("Game Event — the winner's side is the round's side (attacker can win, defender can win)", () => {
  // Viewer on DEFENSE: a blue (viewer) win is a DEFENDER win, a red win ATTACKER.
  const def = new ValProjectionSession();
  def.applySnapshot({ sessionPhase: "live", matchId: "p6-side-def" });
  def.applyFact("viewer_side", "defense");
  def.applyFact("round_number", 1);
  assert.equal(settleRound(def, 1, 0, "p6-side-def").winnerSide, "defender", "viewer win on defense -> DEFENDER");
  const def2 = new ValProjectionSession();
  def2.applySnapshot({ sessionPhase: "live", matchId: "p6-side-def2" });
  def2.applyFact("viewer_side", "defense");
  def2.applyFact("round_number", 1);
  assert.equal(settleRound(def2, 0, 1, "p6-side-def2").winnerSide, "attacker", "enemy win -> ATTACKER");

  // Viewer on ATTACK: mirrored, and the team identities never move.
  const att = new ValProjectionSession();
  att.applySnapshot({ sessionPhase: "live", matchId: "p6-side-att" });
  att.applyFact("viewer_side", "attack");
  att.applyFact("round_number", 1);
  const win = settleRound(att, 1, 0, "p6-side-att");
  assert.equal(win.winnerSide, "attacker", "viewer win on attack -> ATTACKER");
  assert.equal(win.winner, "blue", "the winner is still the TEAM (blue), not a side label");
});

test("Game Event — no start side: the round's own observed side still labels the win", () => {
  // A mid-match start whose snapshot carried no startingSide (live 2026-09-30:
  // `viewerSide=null/defense` — the start side is not always re-reported).
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "p6-side-late" });
  p.applyFact("viewer_side", "attack");
  p.applyFact("round_number", 4);
  const end = settleRound(p, 0, 1, "p6-side-late");
  assert.equal(p.snapshotValue().viewerStartSide, "attack", "the fact seeds the start side when it is the first evidence");
  assert.equal(
    end.winnerSide,
    "defender",
    "the viewer attacks, so the enemy's win is a DEFENDER win (never guessed from the winner)",
  );

  // A session that NEVER reported the side per round (mid-round start) still gets
  // its label from the snapshot's start side + the round's phase. NOTE: an
  // observed per-round side always OUTRANKS the parity derivation (first case
  // above), so parity is only reached when that sample is missing.
  const q = new ValProjectionSession();
  q.applySnapshot({
    sessionPhase: "live",
    matchId: "p6-side-parity",
    mapKey: "ascent",
    session: { viewer: { player: { name: { displayName: "Blue0#0001" } } } },
    teams: [
      { teamId: "Blue", startingSide: "defense", players: [{ player: { name: { displayName: "Blue0#0001" } } }] },
      { teamId: "Red", startingSide: "attack", players: [{ player: { name: { displayName: "Red0#0002" } } }] },
    ],
  });
  assert.equal(q.snapshotValue().viewerStartSide, "defense", "start side from the snapshot's viewer squad");
  assert.equal(q.snapshotValue().viewerSide ?? null, null, "no per-round side fact was reported");
  q.applyFact("round_number", 14);
  assert.equal(
    settleRound(q, 1, 0, "p6-side-parity").winnerSide,
    "attacker",
    "round 14 flips the side (defense -> attack), so the viewer's win is ATTACKER",
  );
});

test("Game Event — the settled round is the event identity, and the side reaches the snapshot", () => {
  const p = board("p6-event", 4);
  p.applyFact("viewer_side", "defense");
  p.applyFact("round_phase", "combat");
  p.applyFact("round_phase", "end");
  p.applyScore(1, 0, "p6-event");
  const st = state(p);
  assert.equal(st.roundEnd.round, 1, "the settled round is published");
  assert.equal(st.roundEnd.winner, "blue");
  assert.equal(st.roundEnd.winnerSide, "defender", "the ATTACKER/DEFENDER label survives to the snapshot");
  const published = snap(p).state.roundEnd;
  assert.equal(published.round, 1, "and the consumer receives the stable identity");
  assert.equal(published.winnerSide, "defender");
});

