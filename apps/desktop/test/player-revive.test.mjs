/**
 * PASS 7B — player revive: the panel must support ALIVE -> DEAD -> ALIVE.
 *
 * Reported bug: a revived player kept the death presentation. Layers pinned:
 *   scoreboard `alive` fact -> projection row (isAlive/health) -> bridge snapshot
 * The death leaves hp=0 (correct); the revive only carries the alive flag, and a
 * stale hp=0 must neither survive (projection) nor re-kill the player in the
 * snapshot. Missing health stays "unknown" — never a fabricated 100.
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-p7b-revive-"));
process.env.TEMP = dir;
process.env.TMP = dir;
process.env.LOCALAPPDATA = dir;

const { ValProjectionSession } = await import("../dist/main/projection.js");
const { toGameSnapshot } = await import("../dist/main/snapshot.js");
const state = (p) => p.snapshotValue();
const snap = (p) => toGameSnapshot(p.snapshotValue());
const CACHE = path.join(dir, "havoc-unleash-last-state.json");
const relayRow = (p, id) => state(p).roster.find((r) => r.puuid === id);
const pubRow = (p, id) => snap(p).state.players.find((r) => r.puuid === id);

/** 5v5 board in combat, every row carrying its own engine identity. */
function board() {
  fs.rmSync(CACHE, { force: true });
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "revive-1", mapKey: "ascent" });
  for (let i = 0; i < 5; i++) {
    p.applyFact("scoreboard", {
      name: `L${i}#0001`, team: 0, is_local: i === 0, alive: true,
      player_id: `puuid-L${i}`, credits: 4000, kills: 3, deaths: 4, assists: 1,
    });
    p.applyFact("scoreboard", {
      name: `R${i}#0002`, team: 1, alive: true,
      player_id: `puuid-R${i}`, credits: 3000, kills: 5, deaths: 6, assists: 2,
    });
  }
  p.applyFact("round_number", 1);
  p.applyFact("round_phase", "shopping");
  p.applyFact("round_phase", "combat");
  return p;
}

test("alive -> dead -> alive clears the death state at every published layer", () => {
  const p = board();
  const id = "puuid-R0";

  // --- DEAD (GEP scoreboard alive flag) --------------------------------------
  p.applyFact("scoreboard", { name: "R0#0002", player_id: id, team: 1, alive: false, kills: 5, deaths: 6, assists: 2 });
  assert.equal(relayRow(p, id).isAlive, false, "projection marks the death");
  assert.equal(relayRow(p, id).health, 0, "death evidence carries hp=0");
  assert.equal(pubRow(p, id).isAlive, false, "snapshot publishes the death");
  assert.equal(pubRow(p, id).health, 0);

  // --- REVIVED (alive flag only — the provider reports no health for others) --
  p.applyFact("scoreboard", { name: "R0#0002", player_id: id, team: 1, alive: true, kills: 5, deaths: 6, assists: 2 });
  assert.equal(relayRow(p, id).isAlive, true, "the projection accepts the revive");
  assert.equal(relayRow(p, id).health, null, "the death's hp=0 does not survive; no fabricated 100");
  assert.equal(pubRow(p, id).isAlive, true, "the snapshot no longer re-kills a revived player");
  assert.equal(pubRow(p, id).health, null, "unknown health stays unknown");

  // --- KDA never resets on a revive ------------------------------------------
  assert.deepEqual(
    [relayRow(p, id).kills, relayRow(p, id).deaths, relayRow(p, id).assists],
    [5, 6, 2],
    "reviving does not touch the scoreline",
  );
});

test("repeat alive frames stay alive (no sticky death state)", () => {
  const p = board();
  const id = "puuid-L0";
  p.applyFact("scoreboard", { name: "L0#0001", player_id: id, team: 0, is_local: true, alive: false });
  assert.equal(pubRow(p, id).isAlive, false);
  for (let frame = 0; frame < 12; frame++) {
    p.applyFact("scoreboard", { name: "L0#0001", player_id: id, team: 0, is_local: true, alive: true });
  }
  assert.equal(relayRow(p, id).isAlive, true);
  assert.equal(pubRow(p, id).isAlive, true, "no later frame re-applies the old death");
});

test("the runtime's re-emitted health frame restores the local player's HP on revive", () => {
  const p = board();
  const id = "puuid-L0";
  p.applyFact("scoreboard", { name: "L0#0001", player_id: id, team: 0, is_local: true, alive: false });
  assert.equal(relayRow(p, id).health, 0);
  // The runtime merges GEP's `local_health` into the local record and re-emits a
  // scoreboard frame (server.ts) — that frame's health is the real HP.
  p.applyFact("scoreboard", { name: "L0#0001", player_id: id, team: 0, is_local: true, alive: true, health: 100 });
  assert.equal(relayRow(p, id).health, 100, "the reported health wins");
  assert.equal(relayRow(p, id).isAlive, true);
  assert.equal(pubRow(p, id).health, 100);
});

test("positive health rescues a wounded player whose alive flag trailed", () => {
  const p = board();
  const id = "puuid-R1";
  p.applyFact("scoreboard", { name: "R1#0002", player_id: id, team: 1, alive: false, health: 40 });
  assert.equal(relayRow(p, id).isAlive, true, "a positive reading is definitive alive evidence");
  assert.equal(pubRow(p, id).isAlive, true);
  assert.equal(pubRow(p, id).health, 40);
});

test("explicit dead evidence still marks the death (no over-eager revive)", () => {
  const p = board();
  const id = "puuid-R2";
  p.applyFact("scoreboard", { name: "R2#0002", player_id: id, team: 1, alive: false, health: 0 });
  assert.equal(relayRow(p, id).isAlive, false);
  assert.equal(pubRow(p, id).isAlive, false);
  assert.equal(pubRow(p, id).health, 0);
});

test("the buy phase still treats everyone as alive", () => {
  const p = board();
  const id = "puuid-R3";
  p.applyFact("scoreboard", { name: "R3#0002", player_id: id, team: 1, alive: false });
  assert.equal(pubRow(p, id).isAlive, false);
  // The next round starts: the round-scoped reset wipes the death evidence.
  p.applyFact("round_number", 2);
  p.applyFact("round_phase", "shopping");
  p.applyFact("scoreboard", { name: "R3#0002", player_id: id, team: 1, alive: false });
  assert.equal(relayRow(p, id).isAlive, true, "a fresh buy phase carries no death evidence");
  assert.equal(relayRow(p, id).health, 100);
  assert.equal(pubRow(p, id).isAlive, true);
});
