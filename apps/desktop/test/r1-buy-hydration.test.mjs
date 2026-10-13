/**
 * PASS 5 — R1 BuyRound hydration.
 *
 * Scope: the FIRST round's shopping state only. The question is whether HU
 * publishes the runtime's own R1 economy / loadout / ability telemetry while the
 * buy scene is up, without inventing anything, and whether a real purchase fact
 * arriving during R1 shopping is reflected immediately.
 *
 * Live reference for the fact shape (fork dialect, captured 2026-09-30):
 *   scoreboard_<n> = {name, character, teammate, team, alive, player_id, shield,
 *                     weapon, spike, ult_points, ult_max, kills, deaths, ...,
 *                     credits}          <- `credits` is the money field
 *   abilities      = {C,Q,E,X}           <- booleans or 0/1 numbers
 *   round_number   = "1" | 1
 *   round_phase    = "shopping" | "combat" | "end"
 * and the live R1 order was: round_number 1 -> round_phase shopping -> abilities
 * -> per-player scoreboard rows (observed 2026-09-30 05:19:12.845 -> 05:19:13.852,
 * 1-player custom lobby, so the relay board carries the local row).
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-r1-hydration-"));
process.env.TEMP = fixtureDir;
process.env.TMP = fixtureDir;
process.env.LOCALAPPDATA = fixtureDir;

const { ValProjectionSession } = await import("../dist/main/projection.js");
const { toGameSnapshot } = await import("../dist/main/snapshot.js");
const state = (p) => p.snapshotValue();
const snap = (p) => toGameSnapshot(p.snapshotValue());
const me = (p) => state(p).roster.find((r) => r.displayName === "Solo#0001");
const mePub = (p) => snap(p).state.players.find((r) => r.playerId === "Solo#0001");

/** Fresh match entering R1 shopping, exactly as the fork dialect delivers it. */
function r1Shopping(matchId = "r1-hyd", { economy = true } = {}) {
  fs.rmSync(path.join(fixtureDir, "havoc-unleash-last-state.json"), { force: true });
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId, mapKey: "ascent" });
  p.applyFact("scoreboard", {
    name: "Solo#0001",
    character: "Hunter",
    teammate: true,
    team: 1,
    is_local: true,
    alive: true,
    weapon: "",
    ...(economy ? { credits: 4000 } : {}),
  });
  p.applyFact("round_number", 1);
  p.applyFact("round_phase", "shopping");
  return p;
}


/* ----------------- TEST 1 — R1 shopping WITH economy telemetry ------------ */

test("R1 — shopping publishes the runtime's own economy, loadout and abilities", () => {
  const p = r1Shopping();
  // The engine reports the post-buy loadout while the buy phase is up.
  p.applyFact("scoreboard", {
    name: "Solo#0001",
    team: 1,
    is_local: true,
    alive: true,
    credits: 3600,
    weapon: "TX_Hud_Sniper_Operater",
    shield: 2,
  });
  p.applyFact("abilities", { C: 1, Q: 1, E: 1, X: 0 });

  const st = state(p);
  assert.equal(st.round.number, 1, "R1 is named");
  assert.equal(st.round.phase, "shopping");
  assert.equal(snap(p).state.scene, "buy-round", "the buy scene is up before combat");

  const row = me(p);
  assert.equal(row.credits, 3600, "credits come from the runtime fact");
  assert.equal(row.spentCredits, 400, "spend is derived from the money the runtime reported");
  assert.equal(row.weapon, "Operator", "the emitted weapon identity is published");
  assert.equal(row.shield, 50, "shield points from tier 2");
  assert.equal(row.shieldType, 2, "and the canonical tier is kept");
  assert.equal(row.health, 100);
  assert.equal(row.isAlive, true);
  assert.deepEqual(row.abilityState, { C: true, Q: true, E: true, X: false });

  const pub = mePub(p);
  assert.equal(pub.credits, 3600, "R1 BuyRound receives credits before combat");
  assert.equal(pub.spentCredits, 400);
  assert.equal(pub.weapon, "Operator");
  assert.equal(pub.shieldType, 2);
  assert.deepEqual(pub.abilityState, { C: true, Q: true, E: true, X: false });
});

/* ------------- TEST 2 — R1 shopping WITHOUT economy telemetry ------------- */

test("R1 — no economy telemetry means no values, never fabricated ones", () => {
  const p = r1Shopping("r1-cold", { economy: false });
  const st = state(p);
  assert.equal(st.round.number, 1);
  assert.equal(st.round.phase, "shopping");
  assert.equal(snap(p).state.scene, "buy-round", "the buy scene still opens");
  const row = me(p);
  assert.equal(row.credits ?? null, null, "no credits reported -> unknown");
  assert.equal(row.spentCredits ?? null, null, "no loadout spend -> unknown");
  assert.equal(row.weapon ?? null, null, "no weapon -> unknown");
  assert.equal(row.shieldType ?? null, null, "no shield evidence -> unknown (never 0)");
  assert.equal(row.abilityState ?? null, null, "no ability fact -> unknown (never all-false)");
  const pub = mePub(p);
  assert.equal(pub.credits ?? null, null);
  assert.equal(pub.weapon ?? null, null);
  assert.equal(pub.abilityState ?? null, null);
  assert.equal(st.round.phase, "shopping", "and the phase is still the real one");
});

/* -------------------- TEST 3 — R1 purchase WITH a change ------------------ */

test("R1 — a real post-purchase fact during R1 shopping is reflected immediately", () => {
  const p = r1Shopping("r1-buy");
  assert.equal(me(p).credits, 4000, "pre-buy money is published while shopping");
  assert.equal(
    me(p).spentCredits ?? null,
    null,
    "no money report inside the buy phase yet -> spend unknown (never invented)",
  );

  // The player buys an ability: the engine re-reports the same row with less money.
  p.applyFact("scoreboard", { name: "Solo#0001", team: 1, is_local: true, alive: true, credits: 3800 });
  assert.equal(me(p).credits, 3800, "the new credits are published");
  assert.equal(me(p).spentCredits, 200, "and the loadout spend follows");

  // A second purchase plus the ability charges the round started with.
  p.applyFact("scoreboard", { name: "Solo#0001", team: 1, is_local: true, alive: true, credits: 3000 });
  p.applyFact("abilities", { C: 1, Q: 0, E: 1, X: 0 });
  assert.equal(me(p).credits, 3000);
  assert.equal(me(p).spentCredits, 1000);
  assert.deepEqual(me(p).abilityState, { C: true, Q: false, E: true, X: false }, "the charge change is published");
  assert.deepEqual(mePub(p).abilityState, { C: true, Q: false, E: true, X: false });
  assert.equal(state(p).round.phase, "shopping", "still the same round, still shopping");
});

/* ------------------- TEST 4 — R1 purchase WITHOUT a change ---------------- */

test("R1 — no runtime change means no fabricated credit movement", () => {
  const p = r1Shopping("r1-nofact");
  const before = me(p).credits;
  // A repeated frame with the SAME money (the engine re-sends rows verbatim).
  p.applyFact("scoreboard", { name: "Solo#0001", team: 1, is_local: true, alive: true, credits: before });
  assert.equal(me(p).credits, before, "the runtime's own value, unchanged");
  assert.equal(
    me(p).spentCredits,
    0,
    "spend is the runtime's own report (base - reported money), never a guessed cost",
  );
  // No purchase happened, so the credits never move on HU's side.
  assert.equal(me(p).credits, before);
});

/* ------------------------ TEST 5 — R1 -> R2 isolation --------------------- */

test("R1 — hydration never depends on a previous round (fresh-match isolation)", () => {
  const p = r1Shopping("r1-iso");
  assert.equal(me(p).credits, 4000, "R1 has its own economy, no earlier round needed");
  assert.equal(
    me(p).spentCredits ?? null,
    null,
    "no purchase fact yet -> the spend column stays UNKNOWN (never a fabricated 0)",
  );
  // The purchase base is captured inside R1 itself, from R1's own money.
  p.applyFact("scoreboard", { name: "Solo#0001", team: 1, is_local: true, alive: true, credits: 3500 });
  assert.equal(me(p).spentCredits, 500, "the R1 base is the R1 value");
});

/* ------------------- TEST 6 — R2 shopping regression ---------------------- */

test("R2 — normal shopping behaviour is unchanged (carried money, fresh spend)", () => {
  const p = r1Shopping("r2-reg");
  p.applyFact("round_phase", "combat");
  p.applyFact("scoreboard", { name: "Solo#0001", team: 1, is_local: true, alive: true, credits: 2000 });
  p.applyFact("round_phase", "end");

  // R2 opens: the round-start routine clears the per-round spend only.
  p.applyFact("round_number", 2);
  p.applyFact("round_phase", "shopping");
  const st = state(p);
  assert.equal(st.round.number, 2);
  assert.equal(st.round.phase, "shopping");
  assert.equal(me(p).credits, 2000, "the last authoritative money carries into the new buy phase");
  assert.equal(me(p).spentCredits, null, "and the new round's spend starts unknown");

  p.applyFact("scoreboard", { name: "Solo#0001", team: 1, is_local: true, alive: true, credits: 1200 });
  assert.equal(me(p).spentCredits, 800, "R2 spend is measured against R2's own base");
});

/* ---------------- TEST 7 — the lagging session phase (live 05:41) ---------- */

test("R1 — a published round fact marks the session live (the R1 buy is presented)", () => {
  // Live 2026-09-30 05:41:10: the engine published `round 1/shopping` while the
  // session snapshot still said `pregame` for ~19 s, so HU presented the
  // agent-select scene (and isAgentSelectPhase) through the first part of R1's buy.
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "pregame", matchId: "r1-lag", mapKey: "ascent" });
  assert.equal(snap(p).state.scene, "agent-select", "sanity: pregame presents agent select");
  assert.equal(snap(p).state.isAgentSelectPhase, true);

  p.applyFact("scoreboard", { name: "Solo#0001", team: 0, is_local: true, alive: true, credits: 800 });
  p.applyFact("round_number", 1);
  p.applyFact("round_phase", "shopping");

  assert.equal(state(p).sessionPhase, "live", "a real round fact proves the match is live");
  assert.equal(snap(p).state.scene, "buy-round", "so the R1 buy is presented");
  assert.equal(snap(p).state.isAgentSelectPhase, false, "and the site is not told agent-select");

  // A LATE, stale pregame frame cannot pull it back (the runtime keeps sending it).
  p.applySnapshot({ sessionPhase: "pregame", matchId: "r1-lag", mapKey: "ascent" });
  assert.equal(state(p).sessionPhase, "live", "the lagging frame is ignored");
  assert.equal(snap(p).state.scene, "buy-round");

  // But a genuine retirement still applies.
  p.applySnapshot({ sessionPhase: "idle", matchId: "r1-lag", mapKey: "ascent" });
  assert.equal(state(p).sessionPhase, "idle", "idle is not treated as a lag");
});

test("R1 — a genuinely NEW match still presents agent select", () => {
  const p = r1Shopping("r1-next");
  p.applyFact("round_phase", "combat");
  const st = state(p);
  assert.equal(st.sessionPhase, "live", "sanity: the round facts made it live");

  p.applySnapshot({ sessionPhase: "pregame", matchId: "r1-next-2", mapKey: "bind" });
  assert.equal(state(p).sessionPhase, "pregame", "a new match id resets the round-fact evidence");
  assert.equal(snap(p).state.scene, "agent-select", "and its agent select is presented");
  assert.equal(snap(p).state.isAgentSelectPhase, true);
});

