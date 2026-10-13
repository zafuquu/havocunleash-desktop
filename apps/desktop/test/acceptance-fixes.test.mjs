/**
 * Pre-acceptance regression guards (2026-09-25).
 *
 *  1. the overlay popout URL must request the LOCAL authoritative stream
 *     (ws://127.0.0.1:7103/ws/broadcast) instead of the WAN bridge — the live
 *     forensic pass proved the popout ran on the remote bridge (jitter/bursts).
 *  2. the centralized weapon identity must resolve the patch-13.06 rifle
 *     (engine internal `TX_Hud_Rifle_BattleRifle`) to its real display name
 *     "Warden" while leaving every existing weapon untouched.
 *  3. a NEW match must not inherit the previous match's round-scoped state
 *     (live trace 2026-09-25 02:51:12-02:51:29: agent-select/live published
 *     round 21 / 0-1 from the previous match until 02:51:56).
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-acceptance-"));
process.env.TEMP = fixtureDir;
process.env.TMP = fixtureDir;
process.env.LOCALAPPDATA = fixtureDir;

const { ValProjectionSession } = await import("../dist/main/projection.js");
const { weaponDisplayName } = await import("../dist/main/valorant-identity.js");
const { toGameSnapshot } = await import("../dist/main/snapshot.js");
const state = (p) => p.snapshotValue();
const snap = (p) => toGameSnapshot(p.snapshotValue());

test("overlay popout URL requests the local authoritative source (local=1)", () => {
  const compiled = fs.readFileSync(new URL("../dist/main/auth.js", import.meta.url), "utf8");
  assert.ok(compiled.includes("local=1"), "compiled auth.js must carry local=1");
  assert.ok(compiled.includes("isPopout=true"), "popout flag preserved");
  const source = fs.readFileSync(new URL("../src/main/auth.ts", import.meta.url), "utf8");
  assert.match(source, /isPopout=true&local=1/);
});

test("weapon identity resolves Warden and keeps existing weapons intact", () => {
  assert.equal(weaponDisplayName("TX_Hud_Rifle_BattleRifle"), "Warden");
  assert.equal(weaponDisplayName("TX_Hud_Rifles_BattleRifle"), "Warden");
  assert.equal(weaponDisplayName("TX_Hud_Rifles_Volcano"), "Vandal");
  assert.equal(weaponDisplayName("TX_Hud_Sniper_Operater"), "Operator");
  assert.equal(weaponDisplayName("TX_Hud_Pistol_Sheriff"), "Sheriff");
  assert.equal(weaponDisplayName("TX_Hud_Pistol_Classic"), "Classic");
  assert.equal(weaponDisplayName("TX_Hud_HMG"), "Odin");
});

test("a new match never inherits the previous match's round-scoped state", () => {
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "match-A", mapKey: "ascent" });
  p.applyFact("round_number", 21);
  p.applyFact("round_phase", "combat");
  p.applyFact("score", { won: 13, lost: 8 });
  p.applyFact("round_phase", "end");
  p.applyFact("spike_detonated", null);
  const before = state(p);
  assert.equal(before.round.number, 21, "sanity: the old match tracked round 21");
  assert.equal(before.score.blue, 13);

  p.applySnapshot({ sessionPhase: "pregame", matchId: "match-B", mapKey: "ascent" });
  const after = state(p);
  assert.equal(after.matchId, "match-B");
  assert.equal(after.round.number, 0, "round number reset");
  assert.equal(after.round.phase, "unknown", "round phase reset");
  assert.equal(after.score.blue, 0, "score reset");
  assert.equal(after.score.red, 0);
  assert.equal(after.roundEnd, null, "round end cleared");
  assert.deepEqual(after.roundHistory, [], "round history cleared");
  assert.equal(after.spike, null, "spike cleared");
  assert.equal(after.plantSite, null, "plant site cleared");
  assert.equal(after.round.spikePlantedAt, null, "spike timestamp cleared");
});
/* ------------------------------------------------------------------ */
/* R1 lifecycle + canonical shield identity (2026-09-26 live forensics) */
/* ------------------------------------------------------------------ */

/**
 * Hybrid R1 starts straight in `combat` (no shopping phase) in a 1-player
 * custom lobby. Live 2026-09-26 05:44:55-05:45:58: the panel showed hp=0 for the
 * whole round and the authoritative score could not settle the round (no
 * roundEnd, no roundHistory[1], empty BuyRound strip cell).
 */
test("R1 that starts in combat still normalizes the panel and settles", () => {
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "r1-match", mapKey: "ascent" });
  p.applyFact("scoreboard", {
    name: "Solo#0001",
    team: 1,
    is_local: true,
    alive: false, // the provider's pre-round roster state
    shield: 3,
    weapon: "",
    credits: 800,
  });

  // The provider repeats the fact; the update path stores the dead evidence.
  p.applyFact('scoreboard', { name: 'Solo#0001', team: 1, is_local: true, alive: false, shield: 3, weapon: '', credits: 800 });
  assert.equal(state(p).roster[0].isAlive, false, 'pre-round dead evidence is stored');
  assert.equal(state(p).roster[0].health, 0, 'dead evidence carries hp 0 (the value R1 used to keep all round)');


  // The engine's FIRST phase fact for round 1 is `combat`.
  p.applyFact("round_number", 1);
  p.applyFact("round_phase", "combat");
  const mid = state(p).roster[0];
  assert.equal(mid.isAlive, true, "round start restores alive");
  assert.equal(mid.health, 100, "round start restores full health (no dead-looking bar)");

  // Authoritative settlement: end phase then the viewer-perspective score.
  p.applyFact("round_phase", "end");
  p.applyFact("score", { won: 1, lost: 0 });
  const after = state(p);
  assert.equal(after.roundEnd?.winner, "blue", "score delta resolves the partial-roster round");
  assert.equal(after.roundEnd?.reason, "elimination", "<100s, no spike outcome -> elimination");
  assert.equal(after.roundHistory.length, 1);
  assert.deepEqual(after.roundHistory[0], { round: 1, winner: "blue", reason: "elimination" });
  const snap1 = snap(p);
  assert.equal(snap1.state.roundEnd?.winner, "blue");
  assert.equal(snap1.state.roundHistory?.[0]?.round, 1, "published to the broadcast strip");
});

/**
 * The raw scoreboard reports GEP armor as the TIER enum (0/1/2/3/4) and has no
 * shieldType/armor field. Dropping the tier made snapshot.ts derive it from
 * points (25 -> 1 light), so a Regen Shield (tier 4) rendered as Light in both
 * scenes (live 2026-09-26).
 */
test("shield tier is canonical: light/heavy/regen/unknown stay distinct", () => {
  const cases = [
    { tier: 0, points: 0, type: 0 },
    { tier: 1, points: 25, type: 1 },
    { tier: 2, points: 50, type: 2 },
    { tier: 3, points: 50, type: 3 },
    { tier: 4, points: 25, type: 4 }, // REGEN - must never collapse to light
  ];
  for (const c of cases) {
    const p = new ValProjectionSession();
    p.applySnapshot({ sessionPhase: "live", matchId: "shield-" + c.tier, mapKey: "ascent" });
    p.applyFact("scoreboard", { name: "Solo#0001", team: 1, is_local: true, alive: true, shield: c.tier, credits: 800 });
    const me = state(p).roster[0];
    assert.equal(me.shield, c.points, `tier ${c.tier} -> ${c.points} points`);
    assert.equal(me.shieldType, c.type, `tier ${c.tier} preserved as shieldType`);
    const published = snap(p).state.players[0];
    assert.equal(published.shieldType, c.type, `tier ${c.tier} reaches the broadcast unchanged`);
    assert.equal(published.shield, c.points);
  }
});

test("points-only dialect still derives a shield type (no tier evidence)", () => {
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "shield-points", mapKey: "ascent" });
  p.applyFact("scoreboard", { name: "Solo#0001", team: 1, is_local: true, alive: true, shield: 50, credits: 800 });
  const me = state(p).roster[0];
  assert.equal(me.shield, 50);
  assert.equal(me.shieldType ?? null, null, "no tier evidence -> projection leaves it unset");
  assert.equal(snap(p).state.players[0].shieldType, 2, "broadcast derives heavy from 50 points");
});

/**
 * Live 2026-09-26: the round-start `me|abilities` frame can arrive BEFORE any
 * scoreboard row identifies the local player, while the handler required an
 * already-anchored `viewerName` — so the only ability frame of the round was
 * dropped and every skill icon stayed grey. The payload is retained and applied
 * the moment the local player is identified from their `is_local` row (which does
 * not have to carry a team number).
 */
test("abilities — a payload that arrives before the local identity is retained", () => {
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "abil-race", mapKey: "ascent" });
  assert.equal(state(p).viewerName ?? null, null, "sanity: no explicit viewer identity yet");

  p.applyFact("abilities", { C: 0, Q: 0, E: 1, X: 0 }); // the provider sends NUMBERS
  p.applyFact("scoreboard", { name: "Solo#0001", is_local: true, alive: true, credits: 800 }); // no team field

  assert.equal(state(p).viewerName, "Solo#0001", "the is_local row anchors viewer identity");
  const me = state(p).roster[0];
  assert.deepEqual(
    me.abilityState,
    { C: false, Q: false, E: true, X: false },
    "the retained payload lands on the local row",
  );
  assert.deepEqual(me.abilities, ["E"], "the reported slots reach the relay abilities slot");
  const pub = snap(p).state.players[0];
  assert.deepEqual(pub.abilityState, { C: false, Q: false, E: true, X: false }, "and the broadcast unchanged");
  assert.deepEqual(pub.abilities, ["E"]);
});

test("abilities — the charges persist into the next BuyRound (identity from is_local)", () => {
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "abil-persist", mapKey: "ascent" });
  p.applyFact("abilities", { C: true, Q: false, E: true, X: false });
  p.applyFact("scoreboard", { name: "Solo#0001", is_local: true, alive: true, credits: 800 });
  p.applyFact("round_number", 1);
  p.applyFact("round_phase", "shopping");
  assert.deepEqual(
    state(p).roster[0].abilityState,
    { C: true, Q: false, E: true, X: false },
    "a round boundary never reverts charges to unknown",
  );
  p.applyFact("abilities", { C: false, Q: false, E: false, X: false });
  assert.deepEqual(
    state(p).roster[0].abilityState,
    { C: false, Q: false, E: false, X: false },
    "a genuine runtime update still wins",
  );
});

test("viewer identity — the fork engine's nested viewer dialect is read", () => {
  const p = new ValProjectionSession();
  p.applySnapshot({
    sessionPhase: "live",
    matchId: "abil-nested",
    mapKey: "ascent",
    session: {
      viewer: {
        player: { name: { displayName: "Viewer#TAG", gameName: "Viewer", tagLine: "TAG" } },
        role: "player",
      },
    },
  });
  assert.equal(
    state(p).viewerName,
    "Viewer#TAG",
    "session.viewer.player.name.displayName is the identity the capture engine sends",
  );
});

test("viewer identity — published in the local roster row's own spelling", () => {
  const p = new ValProjectionSession();
  p.applySnapshot({
    sessionPhase: "live",
    matchId: "abil-dialect",
    mapKey: "ascent",
    session: {
      viewer: { player: { name: { displayName: "Viewer#TAG", gameName: "Viewer", tagLine: "TAG" } } },
    },
  });
  p.applyFact("abilities", { C: true, Q: false, E: false, X: false });
  // The GEP scoreboard dialect spells the SAME player with a space before the tag.
  p.applyFact("scoreboard", { name: "Viewer #TAG", team: 0, is_local: true, alive: true, credits: 800 });
  const st = state(p);
  assert.equal(st.viewerName, "Viewer #TAG", "the anchor is the spelling of the published row");
  assert.ok(
    st.roster.some((r) => r.displayName === st.viewerName),
    "viewerName always names a row the consumer can actually see",
  );
  assert.deepEqual(st.roster[0].abilityState, { C: true, Q: false, E: false, X: false });
});

test("abilities — attached by snapshot identity alone (no is_local row at all)", () => {
  const p = new ValProjectionSession();
  p.applySnapshot({
    sessionPhase: "live",
    matchId: "abil-snapshot-id",
    mapKey: "ascent",
    session: {
      viewer: { player: { name: { displayName: "Viewer#TAG" } } },
      teams: [
        {
          teamId: "Blue",
          players: [{ player: { name: { displayName: "Viewer#TAG" } } }, { player: { name: { displayName: "Mate#TAG" } } }],
        },
      ],
    },
  });
  p.applyFact("abilities", { C: false, Q: true, E: false, X: false });
  const st = state(p);
  assert.equal(st.viewerName, "Viewer#TAG");
  const me = st.roster.find((r) => r.displayName === "Viewer#TAG");
  const mate = st.roster.find((r) => r.displayName === "Mate#TAG");
  assert.deepEqual(me.abilityState, { C: false, Q: true, E: false, X: false });
  assert.equal(mate.abilityState ?? null, null, "a teammate never borrows the viewer's charges");
});

test("abilities — only the local row carries them (opponents stay unknown)", () => {
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "abil-scope", mapKey: "ascent" });
  p.applyFact("scoreboard", { name: "Solo#0001", team: 0, is_local: true, alive: true, credits: 800 });
  p.applyFact("scoreboard", { name: "Foe#0002", team: 1, alive: true, credits: 800 });
  p.applyFact("abilities", { C: true, Q: false, E: false, X: true });
  const [me, foe] = state(p).roster;
  assert.deepEqual(me.abilityState, { C: true, Q: false, E: false, X: true });
  assert.equal(foe.abilityState ?? null, null, "no opponent ability telemetry exists -> unknown");
  assert.equal(foe.abilities, undefined, "unknown is never published as unbought");
  assert.equal(snap(p).state.viewerName, "Solo#0001", "the broadcast names the local row");
});
