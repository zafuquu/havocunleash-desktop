/**
 * PASS 7B — cross-match lifecycle: Post Game must end when a NEW match's
 * agent-select evidence arrives, even when the engine keeps the same match_id
 * (GEP reuses it — the reported "new match detected but the HUD stayed on
 * Post Game"), while a settled match still latches Post Game until then.
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-p7b-cross-"));
process.env.TEMP = dir;
process.env.TMP = dir;
process.env.LOCALAPPDATA = dir;

const { ValProjectionSession } = await import("../dist/main/projection.js");
const { toGameSnapshot } = await import("../dist/main/snapshot.js");
const state = (p) => p.snapshotValue();
const snap = (p) => toGameSnapshot(p.snapshotValue());
const CACHE = path.join(dir, "havoc-unleash-last-state.json");
const row = (p, id) => state(p).roster.find((r) => r.puuid === id);

function fresh() {
  fs.rmSync(CACHE, { force: true });
  return new ValProjectionSession();
}

/** A 5v5 board; identical in shape to the live GEP scoreboard dialect. */
function board(p, { kills = 20, tag = "A" } = {}) {
  for (let i = 0; i < 5; i++) {
    p.applyFact("scoreboard", {
      name: `L${i}#0001`, team: 0, is_local: i === 0, alive: true,
      player_id: `puuid-${tag}-L${i}`, credits: 4000 + i, kills, deaths: 5, assists: 3,
    });
    p.applyFact("scoreboard", {
      name: `R${i}#0002`, team: 1, alive: true,
      player_id: `puuid-${tag}-R${i}`, credits: 3000 + i, kills: 10, deaths: 12, assists: 2,
    });
  }
}

/** MATCH A: played and settled 13-11 with a tracked round history. */
function settledMatchA() {
  const p = fresh();
  p.applySnapshot({ sessionPhase: "live", matchId: "same-id", mapKey: "ascent" });
  board(p, { kills: 20, tag: "A" });
  p.applyFact("round_number", 21);
  p.applyFact("round_phase", "combat");
  p.applyFact("match_score", { team_0: 13, team_1: 11 });
  // The engine reports the round end, then the match end.
  p.applyFact("round_phase", "end");
  p.applyFact("round_phase", "game_end");
  return p;
}

test("a settled match latches Post Game and keeps its stats", () => {
  const p = settledMatchA();
  const st = state(p);
  assert.equal(st.scene, "post-game");
  // The winner follows the published score mapping (the engine's team_0/team_1
  // are mapped through the viewer anchor) — the latch is what matters here.
  assert.equal(st.match?.winner, st.score.blue >= st.score.red ? "blue" : "red");
  assert.equal(row(p, "puuid-A-L0").kills, 20, "Match A stats are published");
  assert.equal(st.roster.length, 10);
});

test("a NEW match's agent select (same match_id) releases Post Game — the reported bug", () => {
  const p = settledMatchA();
  assert.equal(state(p).scene, "post-game");
  // The runtime reports the new match's agent select with the SAME match id
  // (GEP reuses match_id across games) — the previous behaviour kept the latch.
  p.applySnapshot({ sessionPhase: "pregame", matchId: "same-id", mapKey: "ascent" });
  const st = state(p);
  assert.equal(st.scene, "agent-select", "Agent Select outranks the settled latch");
  assert.equal(st.match?.winner ?? null, null, "the settled latch is released");
  assert.equal(st.roundEnd ?? null, null, "the previous match's roundEnd is cleared");
  assert.deepEqual(st.roundHistory ?? [], [], "the previous match's round history is cleared");
  assert.equal(st.score.blue, 0, "the new match starts 0-0");
  assert.equal(st.score.red, 0);
  assert.equal(row(p, "puuid-A-L0"), undefined, "Match A identities are retired with their telemetry");
  assert.equal(state(p).roster.length, 0, "the new match rehydrates its own roster");
});

test("a GEP characterselect scene fact releases Post Game too", () => {
  const p = settledMatchA();
  p.applyFact("scene", "CharacterSelectPersistentLevel");
  const st = state(p);
  assert.equal(st.scene, "agent-select");
  assert.equal(st.match?.winner ?? null, null);
  assert.equal(row(p, "puuid-A-L0"), undefined, "Match A's identities are retired");
});

test("a late old-match end frame cannot re-latch Post Game", () => {
  const p = settledMatchA();
  p.applyFact("scene", "CharacterSelectPersistentLevel");
  assert.equal(state(p).scene, "agent-select");
  // A trailing MATCH A frame (game_end) arrives after the reset: the score is
  // already 0-0, so no winner may be invented from it.
  p.applyFact("round_phase", "game_end");
  const st = state(p);
  assert.equal(st.match?.winner ?? null, null, "no winner is re-latched from a stale end frame");
  assert.notEqual(st.scene, "post-game", "Post Game must not reappear");
});

test("the new match's own settle still latches Post Game (no regression)", () => {
  const p = settledMatchA();
  p.applyFact("scene", "CharacterSelectPersistentLevel");
  p.applySnapshot({ sessionPhase: "live", matchId: "same-id", mapKey: "bind" });
  board(p, { kills: 7, tag: "B" });
  p.applyFact("round_number", 1);
  p.applyFact("round_phase", "shopping");
  p.applyFact("round_phase", "combat");
  p.applyFact("match_score", { team_0: 13, team_1: 9 });
  p.applyFact("round_phase", "game_end");
  const st = state(p);
  assert.equal(st.scene, "post-game", "Match B's own settled state latches normally");
  assert.equal(st.match?.winner, st.score.blue >= st.score.red ? "blue" : "red");
  assert.equal(row(p, "puuid-B-L0").kills, 7, "Match B telemetry is its own");
  assert.equal(row(p, "puuid-A-L0"), undefined, "Match A identities do not persist into Match B");
});

test("Match A KDA cannot leak into a same-name player of Match B (identity-first merge)", () => {
  const p = settledMatchA();
  p.applyFact("scene", "CharacterSelectPersistentLevel");
  board(p, { kills: 4, tag: "B" });
  const b = row(p, "puuid-B-L0");
  assert.equal(b.kills, 4, "the new identity carries the new telemetry");
  assert.equal(b.deaths, 5);
  const a = row(p, "puuid-A-L0");
  assert.equal(a?.kills ?? null, null, "Match A's row is not fed Match B telemetry");
  assert.equal(
    new Set(state(p).roster.map((r) => r.puuid)).size,
    state(p).roster.length,
    "no duplicate identity on the board",
  );
});
