/**
 * PASS 7B — partial player telemetry: a new match's data arrives frame by frame
 * (identity+agent, then economy, then KDA, then abilities, then alive/health).
 * Each layer must MERGE without dropping previously valid fields, without
 * replacing valid values with nulls from partial frames, and without mixing
 * players or matches. Missing telemetry stays missing — never zero, never the
 * previous match's value.
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-p7b-partial-"));
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

function session(matchId) {
  fs.rmSync(CACHE, { force: true });
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId, mapKey: "ascent" });
  return p;
}

test("frames that carry one slice each merge without dropping earlier fields", () => {
  const p = session("partial-1");
  const id = "puuid-P-3";

  // frame 1 — identity + agent only
  p.applyFact("scoreboard", { name: "P3#0001", player_id: id, team: 0, is_local: true, character: "hunter", alive: true });
  // frame 2 — economy / loadout / ultimate charge
  p.applyFact("scoreboard", { name: "P3#0001", player_id: id, team: 0, is_local: true, credits: 4200, weapon: "TX_Hud_Rifles_Volcano", shield: 2, ult_points: 5, ult_max: 8 });
  // frame 3 — scoreline
  p.applyFact("scoreboard", { name: "P3#0001", player_id: id, team: 0, is_local: true, kills: 11, deaths: 4, assists: 6 });
  // frame 4 — abilities (LOCAL player only, in the engine's own {C,Q,E,X} shape)
  p.applyFact("abilities", { C: true, Q: false, E: true, X: false });
  // frame 5 — alive/health
  p.applyFact("scoreboard", { name: "P3#0001", player_id: id, team: 0, is_local: true, alive: false });

  const row = relayRow(p, id);
  assert.ok(row, "the row exists");
  assert.equal(row.agentName, "Sova", "agent survives every later partial frame");
  assert.equal(row.credits, 4200, "credits survive");
  assert.equal(row.weapon, "Vandal", "weapon survives");
  assert.equal(row.shieldType, 2, "shield tier survives");
  assert.deepEqual([row.kills, row.deaths, row.assists], [11, 4, 6], "KDA survives");
  assert.deepEqual(row.abilityState, { C: true, Q: false, E: true, X: false }, "abilities survive");
  assert.equal(row.ultPoints, 5, "ult points survive");
  assert.equal(row.isAlive, false, "the last alive evidence wins");
  assert.equal(row.health, 0, "the death leaves hp=0");

  const pub = pubRow(p, id);
  assert.equal(pub.agentName, "Sova");
  assert.equal(pub.credits, 4200);
  assert.deepEqual([pub.kills, pub.deaths, pub.assists], [11, 4, 6]);
  assert.deepEqual(pub.abilityState, { C: true, Q: false, E: true, X: false });
});

test("a frame that omits a field never nulls an already-valid value", () => {
  const p = session("partial-2");
  const id = "puuid-Q-1";
  p.applyFact("scoreboard", { name: "Q1#0001", player_id: id, team: 0, credits: 900, weapon: "TX_Hud_Rifles_Volcano", kills: 7 });
  // An identity/agent refresh with no economy or scoreline at all.
  p.applyFact("scoreboard", { name: "Q1#0001", player_id: id, team: 0 });
  const row = relayRow(p, id);
  assert.equal(row.credits, 900, "credits are not replaced by the partial frame");
  assert.equal(row.weapon, "Vandal", "the weapon is not replaced by the partial frame");
  assert.equal(row.kills, 7, "the scoreline is not replaced by the partial frame");
  assert.equal(row.deaths, null, "a never-reported field stays missing (not zero)");
});

test("telemetry that was never reported stays missing, never zero", () => {
  const p = session("partial-3");
  const id = "puuid-Q-2";
  p.applyFact("scoreboard", { name: "Q2#0001", player_id: id, team: 0, character: "hunter" });
  const row = relayRow(p, id);
  assert.equal(row.credits, null);
  assert.equal(row.weapon, null);
  assert.equal(row.kills, null);
  assert.equal(row.deaths, null);
  assert.equal(row.assists, null);
  assert.equal(row.ultPoints, null);
  assert.equal(pubRow(p, id).credits, null, "the snapshot keeps the missing value missing");
});

test("a new match does not inherit the previous match's telemetry", () => {
  const p = session("partial-A");
  // A tracked, finished match (round facts + scoreline).
  p.applyFact("round_number", 6);
  p.applyFact("round_phase", "end");
  p.applyFact("scoreboard", { name: "Z1#0001", player_id: "puuid-Z-1", team: 0, credits: 5000, kills: 21, weapon: "TX_Hud_Rifles_Volcano" });
  assert.equal(relayRow(p, "puuid-Z-1").kills, 21);

  // MATCH B agent select arrives on the same session.
  p.applyFact("scene", "CharacterSelectPersistentLevel");
  assert.equal(state(p).scene, "agent-select");
  assert.equal(relayRow(p, "puuid-Z-1"), undefined, "Match A's row is retired with its telemetry");

  // MATCH B's own frames rehydrate the identity from scratch — nothing inherited.
  p.applyFact("scoreboard", { name: "Z1#0001", player_id: "puuid-Z-1", team: 0, credits: 800, kills: 0 });
  assert.equal(relayRow(p, "puuid-Z-1").credits, 800, "the new match's own values land");
  assert.equal(relayRow(p, "puuid-Z-1").kills, 0);
  assert.equal(relayRow(p, "puuid-Z-1").weapon, null, "Match A's loadout is not inherited");
});

test("a disagreeing id never re-keys or duplicates an established row (Pass 6 kept)", () => {
  const p = session("partial-4");
  p.applyFact("scoreboard", { name: "Same#1111", player_id: "puuid-old", team: 0, kills: 20, credits: 5000 });
  // The provider re-sends the same display name under a different id: within a
  // match the established row owns that name (Pass 6 "no phantom identity").
  p.applyFact("scoreboard", { name: "Same#1111", player_id: "puuid-new", team: 0, kills: 2, credits: 900 });
  assert.equal(relayRow(p, "puuid-new"), undefined, "no phantom identity is created");
  assert.equal(state(p).roster.filter((r) => r.displayName === "Same#1111").length, 1, "one row for that name");
  assert.equal(relayRow(p, "puuid-old").kills, 2, "the latest frame for that name wins");
  assert.equal(relayRow(p, "puuid-old").credits, 900);
  // Cross-MATCH isolation is provided by the new-match retirement instead of the
  // name/id rule — prove the identity is dropped at the boundary.
  p.applyFact("round_number", 5);
  p.applyFact("round_phase", "end");
  p.applyFact("scene", "CharacterSelectPersistentLevel");
  assert.equal(state(p).scene, "agent-select");
  assert.equal(relayRow(p, "puuid-old"), undefined, "the retired match's identities are gone");
});

test("a name-only frame still merges into a row that has no identity yet", () => {
  const p = session("partial-5");
  p.applyFact("scoreboard", { name: "Solo#0001", team: 0, credits: 800 });
  const created = state(p).roster.find((r) => r.displayName === "Solo#0001");
  assert.ok(created, "the name-only frame creates the row");
  assert.equal(created.credits, 800);
  assert.equal(created.puuid ?? null, null, "no engine identity yet");
  // The identity arrives later and is adopted without moving the telemetry.
  p.applyFact("scoreboard", { name: "Solo#0001", player_id: "puuid-solo", team: 0, kills: 3 });
  const row = state(p).roster.find((r) => r.displayName === "Solo#0001");
  assert.equal(row.puuid, "puuid-solo", "the row adopts the engine identity");
  assert.equal(row.credits, 800, "the earlier telemetry stays with the row");
  assert.equal(row.kills, 3);
});
