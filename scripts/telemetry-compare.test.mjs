/**
 * A3 comparison-logic tests (fixtures per the A3 spec §26). No VALORANT
 * required — pure fixture comparison against the exported functions.
 * Run: node --test scripts/telemetry-compare.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLASSIFICATIONS,
  compareNormalized,
  expectedSceneForPhase,
} from "./telemetry-compare.mjs";

function mkPlayer(over = {}) {
  return {
    playerId: over.playerId ?? "pid-1",
    name: over.name ?? "Player One",
    teamId: over.teamId ?? "Blue",
    teamIndex: over.teamIndex ?? 0,
    agent: over.agent ?? "Jett",
    alive: over.alive ?? true,
    health: "health" in over ? over.health : 100,
    shield: "shield" in over ? over.shield : 25,
    shieldType: over.shieldType ?? 1,
    credits: "credits" in over ? over.credits : 4000,
    weapon: over.weapon ?? "Vandal",
    abilities: over.abilities ?? null,
    hasSpike: over.hasSpike ?? false,
  };
}

function mkState(players, over = {}) {
  return {
    phase: over.phase ?? "live",
    matchId: over.matchId ?? "m-1",
    mapKey: over.mapKey ?? "ascent",
    scene: over.scene ?? null,
    roundPhase: over.roundPhase ?? "combat",
    roundNumber: over.roundNumber ?? 3,
    score: over.score ?? { blue: 2, red: 1 },
    players,
    telemetryState: over.telemetryState ?? "HEALTHY",
    updates: over.updates ?? 5,
    lastUpdateAt: over.lastUpdateAt ?? 1_700_000_000_000,
    revisionChanges: over.revisionChanges ?? 3,
  };
}

test("Test A — identical states: MATCH", () => {
  const r = compareNormalized(mkState([mkPlayer()]), mkState([mkPlayer()]), { ignoreQuality: true });
  for (const f of Object.values(r.fields)) assert.equal(f.status, CLASSIFICATIONS.MATCH, JSON.stringify(f));
  assert.equal(r.mismatch, false);
});

test("Test B — HU missing health (blob 87, HU null): HU_MISSING", () => {
  const r = compareNormalized(
    mkState([mkPlayer({ health: 87 })]),
    mkState([mkPlayer({ health: null })]),
    { ignoreQuality: true },
  );
  const hp = r.players.find((f) => f.field === "health");
  assert.equal(hp.status, CLASSIFICATIONS.HU_MISSING);
});

test("Test C — fake HP regression (blob 87, HU 100): VALUE_MISMATCH", () => {
  const r = compareNormalized(
    mkState([mkPlayer({ health: 87 })]),
    mkState([mkPlayer({ health: 100 })]),
    { ignoreQuality: true },
  );
  const hp = r.players.find((f) => f.field === "health");
  assert.equal(hp.status, CLASSIFICATIONS.VALUE_MISMATCH);
});

test("Test D — weapon mismatch (Vandal vs Classic): VALUE_MISMATCH", () => {
  const r = compareNormalized(
    mkState([mkPlayer({ weapon: "Vandal" })]),
    mkState([mkPlayer({ weapon: "Classic" })]),
    { ignoreQuality: true },
  );
  const w = r.players.find((f) => f.field === "weapon");
  assert.equal(w.status, CLASSIFICATIONS.VALUE_MISMATCH);
});

test("Test E — credits missing (blob 4500, HU null): HU_MISSING", () => {
  const r = compareNormalized(
    mkState([mkPlayer({ credits: 4500 })]),
    mkState([mkPlayer({ credits: null })]),
    { ignoreQuality: true },
  );
  const c = r.players.find((f) => f.field === "credits");
  assert.equal(c.status, CLASSIFICATIONS.HU_MISSING);
});
test("Test F — phase mismatch (combat vs shopping): PHASE_MISMATCH", () => {
  const r = compareNormalized(
    mkState([], { roundPhase: "combat" }),
    mkState([], { roundPhase: "shopping" }),
    { ignoreQuality: true },
  );
  assert.equal(r.fields.roundPhase.status, CLASSIFICATIONS.PHASE_MISMATCH);
});

test("Test G — null versus zero (blob 0, HU null): HU_MISSING", () => {
  const r = compareNormalized(
    mkState([mkPlayer({ shield: 0 })]),
    mkState([mkPlayer({ shield: null })]),
    { ignoreQuality: true },
  );
  const s = r.players.find((f) => f.field === "shield");
  assert.equal(s.status, CLASSIFICATIONS.HU_MISSING);
});

test("Test H — stale HU (blob HEALTHY, HU STALE): fields gated STALE_HU", () => {
  const ref = mkState([mkPlayer()], { telemetryState: "HEALTHY" });
  const hu = mkState([mkPlayer()], { telemetryState: "STALE" });
  const r = compareNormalized(ref, hu, { ignoreQuality: false });
  for (const f of r.players) assert.equal(f.status, CLASSIFICATIONS.STALE_HU, JSON.stringify(f));
});

test("Test I — HU telemetry not comparable: HU_NOT_COMPARABLE (no mismatch explosion)", () => {
  const ref = mkState([mkPlayer({ weapon: "Vandal", credits: 4000, health: 80 })]);
  const hu = mkState([mkPlayer({ weapon: null, credits: null, health: null })], {
    telemetryState: "CONNECTED_BUT_NO_TELEMETRY",
  });
  const r = compareNormalized(ref, hu, { ignoreQuality: false });
  for (const f of r.players) assert.equal(f.status, CLASSIFICATIONS.HU_NOT_COMPARABLE);
  assert.equal(r.mismatch, false);
});

test("Test J — roster mismatch (blob A/B/C, HU A/B): C is HU_MISSING", () => {
  const ref = mkState([
    mkPlayer({ playerId: "a", name: "Alpha" }),
    mkPlayer({ playerId: "b", name: "Bravo" }),
    mkPlayer({ playerId: "c", name: "Charlie" }),
  ]);
  const hu = mkState([
    mkPlayer({ playerId: "a", name: "Alpha" }),
    mkPlayer({ playerId: "b", name: "Bravo" }),
  ]);
  const r = compareNormalized(ref, hu, { ignoreQuality: true });
  const missing = r.players.find((f) => f.status === CLASSIFICATIONS.HU_MISSING);
  assert.ok(missing, "expected an HU_MISSING roster entry");
  assert.equal(missing.player, "Charlie");
});

test("Test K — abilities numeric form preserved (0/1 ≠ false/true): TYPE_MISMATCH", () => {
  const r = compareNormalized(
    mkState([mkPlayer({ abilities: { C: 1, Q: 0 } })]),
    mkState([mkPlayer({ abilities: { C: true, Q: false } })]),
    { ignoreQuality: true },
  );
  const a = r.players.find((f) => f.field === "abilities");
  assert.equal(a.status, CLASSIFICATIONS.TYPE_MISMATCH);
});

test("Test K2 — abilities identical numeric form: MATCH", () => {
  const r = compareNormalized(
    mkState([mkPlayer({ abilities: { C: 1, Q: 0 } })]),
    mkState([mkPlayer({ abilities: { C: 1, Q: 0 } })]),
    { ignoreQuality: true },
  );
  const a = r.players.find((f) => f.field === "abilities");
  assert.equal(a.status, CLASSIFICATIONS.MATCH);
});

test("Test L — static revision diagnostic: POSSIBLE_STATIC_STATE", () => {
  const now = 1_700_001_200_000;
  const ref = mkState([mkPlayer()], {
    updates: 40,
    lastUpdateAt: now - 5_000,
    revisionChanges: 5,
  });
  const hu = mkState([mkPlayer()], {
    telemetryState: "HEALTHY",
    updates: 1,
    lastUpdateAt: now - 90_000,
    revisionChanges: 0,
  });
  const r = compareNormalized(ref, hu, { now, ignoreQuality: true });
  const diag = r.diagnostics.find((d) => d.kind === "POSSIBLE_STATIC_STATE");
  assert.ok(diag, "expected POSSIBLE_STATIC_STATE diagnostic");
});

test("Expected scene mapping (§15)", () => {
  assert.equal(expectedSceneForPhase("shopping", "live"), "buy-round");
  assert.equal(expectedSceneForPhase("combat", "live"), "ingame-hud");
  assert.equal(expectedSceneForPhase("game_start", "pregame"), "agent-select");
  assert.equal(expectedSceneForPhase("game_end", "ending"), "post-game");
});

test("Test M — side inversion (same player, opposing team): team mismatch surfaced", () => {
  const ref = mkState([mkPlayer({ playerId: "p", name: "Solo", teamId: "Blue", teamIndex: 0 })]);
  const hu = mkState([mkPlayer({ playerId: "p", name: "Solo", teamId: "Red", teamIndex: 1 })]);
  const r = compareNormalized(ref, hu, { ignoreQuality: true });
  const t = r.players.find((f) => f.field === "team");
  assert.equal(t.status, CLASSIFICATIONS.VALUE_MISMATCH);
});

