/**
 * PASS 7D — live state sync / scene lifecycle / roster hydration.
 *
 * Three defects found in the phase-1 read-through, each with a live symptom:
 *
 * A. SNAPSHOT HYDRATION. `applySnapshot` rebuilt `s.roster` from scratch every
 *    heartbeat and skipped its carry-over block whenever the snapshot supplied
 *    ANY stat. The snapshot supplies KDA, so agent / weapon / shield / credits —
 *    kept current by the GEP scoreboard frames between heartbeats — were WIPED on
 *    every heartbeat. Reported as "K/D/A updated but the agent icon, loadout,
 *    shield and credits did not" (panels rendering "-"), the round-start alive
 *    reset being undone (greyed cards) and a revived player flipping back to
 *    dead. The merge is now by identity, "snapshot value if provided, else the
 *    live value", with alive/health always keeping the freshest GEP reading.
 *
 * B. DUPLICATE ROWS. The scoreboard merge looked a row up by DISPLAY NAME only,
 *    while Pass 6 keys the relay on the engine's own player id. A snapshot that
 *    names a player by AGENT while the scoreboard reports their real name (both
 *    carrying the same puuid) produced TWO rows — live session log:
 *    `relay_roster_over_contract {kept:10, dropped:1, droppedNames:["Jett"]}`,
 *    i.e. the duplicate was only shed by the relay's puuid dedupe, and while it
 *    sits ahead of a real row it costs that player a slot in the 5-per-side cap.
 *
 * C. SCENE HOLD. `deriveScene` held the HUD for 5.5s after a settlement for
 *    EVERY shopping phase. The engine's own `end` phase already holds the HUD
 *    for the whole ceremony (7.0-7.1s measured in every capture; the ceremony
 *    plays 6.6s), so applying that age-based hold after the ENGINE named the next
 *    round's buy phase could push BuyRound past the end of the buy phase — the
 *    reported "BuyRound occasionally failed to replace IngameHUD". A round FACT
 *    now outranks the hold, matching the existing rule in latchTerminalSpike and
 *    recordRoundWinner; a SCORE-DERIVED buy phase still holds the HUD (the HU-014
 *    dialect has no `end` phase at all, so the ceremony needs it).
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 * Synthetic frames only — no VALORANT / Overwolf / runtime process involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-p7d-"));
process.env.TEMP = fixtureDir;
process.env.TMP = fixtureDir;
process.env.LOCALAPPDATA = fixtureDir;

const { ValProjectionSession } = await import("../dist/main/projection.js");
const { hudRelayStateSchema } = await import("@havoc-unleash/contracts");

const CACHE = path.join(fixtureDir, "havoc-unleash-last-state.json");
const state = (p) => p.snapshotValue();
const row = (p, name) => state(p).roster.find((r) => r.displayName === name);

function fresh(matchId = "m-7d") {
  fs.rmSync(CACHE, { force: true });
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId, mapKey: "ascent" });
  return p;
}

/**
 * A provider squad. Every player carries a stable engine id — the identity the
 * relay keys rows on — and the display name is what the Name Service resolves.
 * `kda` toggles the stat block the snapshot heartbeat DOES carry.
 */
function squad(teamId, prefix, { kda = false } = {}) {
  return {
    teamId,
    startingSide: "defense",
    players: Array.from({ length: 5 }, (_, i) => ({
      teamIndex: teamId === "Blue" ? 0 : 1,
      player: {
        name: { displayName: `${prefix}${i + 1}#0001` },
        playerId: `${prefix}-PUUID-${i + 1}`,
        ...(kda ? { kills: 3, deaths: 1, assists: 2 } : {}),
      },
    })),
  };
}

/** A full 5v5 provider board, optionally carrying the KDA-only heartbeat. */
function board(matchId, { kda = false } = {}) {
  return {
    sessionPhase: "live",
    matchId,
    mapKey: "ascent",
    teams: [squad("Blue", "Blue", { kda }), squad("Red", "Red", { kda })],
  };
}

/** One GEP scoreboard frame: the loadout/agent telemetry only GEP keeps current. */
function gep(name, playerId, extra = {}) {
  return {
    name,
    player_id: playerId,
    team: 0,
    teammate: true,
    is_local: false,
    alive: true,
    health: 150,
    character: "Sage",
    weapon: "Vandal",
    shield: 50,
    shieldType: 2,
    credits: 4400,
    kills: 7,
    deaths: 2,
    assists: 5,
    ...extra,
  };
}

/* ----------------- 7D-A — the heartbeat must hydrate, never erase ----------------- */

test("7D-A — a KDA heartbeat keeps the GEP loadout, shield and agent instead of wiping them", () => {
  const p = fresh();
  p.applySnapshot(board("m-7d"));
  p.applyFact("scoreboard", gep("Blue1#0001", "BLUE-PUUID-1"));

  const before = row(p, "Blue1#0001");
  assert.equal(before.weapon, "Vandal", "GEP supplied the loadout");
  assert.equal(before.credits, 4400, "GEP supplied the credits");
  assert.equal(before.shield, 50, "GEP supplied the shield");
  assert.equal(before.agentKey, "sage", "GEP supplied the agent");
  assert.equal(before.kills, 7, "GEP supplied the KDA");

  // The heartbeat carries KDA but NOT the loadout/agent — the live dialect.
  p.applySnapshot(board("m-7d", { kda: true }));

  const after = row(p, "Blue1#0001");
  assert.equal(after.weapon, "Vandal", "loadout survives the heartbeat");
  assert.equal(after.credits, 4400, "credits survive the heartbeat");
  assert.equal(after.shield, 50, "shield survives the heartbeat");
  assert.equal(after.shieldType, 2, "shield tier survives the heartbeat");
  assert.equal(after.agentKey, "sage", "agent key survives the heartbeat (Sage icon)");
  assert.equal(after.kills, 3, "the heartbeat's OWN KDA is adopted — both sources coexist");

  assert.equal(hudRelayStateSchema.safeParse(state(p)).success, true);
});

test("7D-A — the heartbeat cannot re-kill a revived player or undo the round-start reset", () => {
  const p = fresh();
  p.applySnapshot(board("m-7d"));
  // GEP reports the revived player: positive health is definitive alive evidence.
  p.applyFact("scoreboard", gep("Blue1#0001", "BLUE-PUUID-1", { health: 150, alive: true }));
  assert.equal(row(p, "Blue1#0001").isAlive, true);

  // A coarser heartbeat still describing the pre-revive state.
  p.applySnapshot({
    sessionPhase: "live",
    matchId: "m-7d",
    mapKey: "ascent",
    teams: [
      {
        teamId: "Blue",
        startingSide: "defense",
        players: Array.from({ length: 5 }, (_, i) => ({
          teamIndex: 0,
          player: {
            name: { displayName: `Blue${i + 1}#0001` },
            playerId: `BLUE-PUUID-${i + 1}`,
            ...(i === 0 ? { isAlive: false, health: 0 } : {}),
          },
        })),
      },
      squad("Red", "Red"),
    ],
  });

  const after = row(p, "Blue1#0001");
  assert.equal(after.isAlive, true, "the freshest GEP reading wins over a coarse heartbeat");
  assert.equal(after.health, 150, "a revived player stays revived (greyed-card fix)");
});

/* ---------------------- 7D-B — identity, not display name ---------------------- */

test("7D-B — the same engine id never becomes two rows (the cap keeps every real player)", () => {
  const p = fresh();
  p.applySnapshot(board("m-7d"));
  // The snapshot named the player by AGENT while the scoreboard reports the
  // real name — both carrying the SAME engine id. Name-only lookup created a
  // second row here, which is what the relay then shed as
  // `relay_roster_over_contract {kept:10, dropped:1, droppedNames:["Jett"]}`.
  p.applyFact("scoreboard", gep("Viewer #NA1", "BLUE-PUUID-1"));

  const st = state(p);
  // The published board is bounded to the contract's 10, so assert the INTERNAL
  // roster — that is where a duplicate row would actually exist.
  assert.equal(p.s.roster.length, 10, "no duplicate row was created");
  assert.equal(st.roster.length, 10, "the published board is still a clean 5v5");
  const owned = p.s.roster.filter((r) => String(r.puuid).toLowerCase() === "blue-puuid-1");
  assert.equal(owned.length, 1, "one engine id owns exactly one row");

  const merged = owned[0];
  assert.equal(merged.credits, 4400, "the GEP telemetry landed on the existing row");
  assert.equal(merged.agentKey, "sage", "and so did the agent");
  assert.equal(merged.kills, 7, "and the scoreboard KDA");

  // Still a clean 5v5 for the contract's per-side cap.
  assert.equal(st.roster.filter((r) => r.teamIndex === 0).length, 5);
  assert.equal(st.roster.filter((r) => r.teamIndex === 1).length, 5);
  assert.equal(hudRelayStateSchema.safeParse(st).success, true);
});

test("7D-B — an unknown engine id never steals or duplicates an established row (Pass 6 kept)", () => {
  const p = fresh();
  p.applySnapshot(board("m-7d"));
  // Same display name, DISAGREEING id. Pass 6: within a match the established
  // row owns its name — the first id wins, no phantom identity, and the frame's
  // telemetry still lands on that row.
  p.applyFact("scoreboard", gep("Blue1#0001", "SOMEONE-ELSE"));
  assert.equal(p.s.roster.length, 10, "no phantom row was created");
  assert.equal(
    p.s.roster.filter((r) => r.puuid === "SOMEONE-ELSE").length,
    0,
    "a disagreeing id never mints an identity",
  );
  assert.equal(row(p, "Blue1#0001").puuid, "Blue-PUUID-1", "the first id wins (never re-keyed)");
  assert.equal(row(p, "Blue1#0001").kills, 7, "and the frame's telemetry still lands on it");
  assert.equal(row(p, "Blue1#0001").agentKey, "sage", "identity and agent untouched");
});

/* ------------------------ 7D-C — the scene must not be masked ------------------------ */

/** A live match whose R1 just settled from the score (HU-014: score-only dialect). */
function settledFromScore(matchId = "fork-7d") {
  const p = fresh(matchId);
  p.applyFact("scoreboard", { name: "Solo#0001", team: 1, is_local: true, alive: true, credits: 800 });
  p.applyFact("scoreboard", { name: "Foe#0002", team: 0, alive: true, credits: 800 });
  p.applyScore(0, 0, matchId);
  p.applyScore(1, 0, matchId); // R1 -> R2, sets roundEnd + roundEndedAt = now
  return p;
}

test("7D-C — a buy phase the ENGINE named is never masked by the round-end hold", () => {
  const p = settledFromScore();
  assert.equal(state(p).round.phase, "shopping", "the derived buy phase is on the board");
  assert.equal(p.s.roundPhaseFromFact, false, "the score-derived phase is provisional");
  assert.equal(state(p).scene, "ingame-hud", "the hold still covers a SCORE-DERIVED buy phase");

  // The engine now publishes its own facts for the round in progress: this is
  // authoritative evidence that the end phase is over.
  p.applyFact("round_number", 2);
  p.applyFact("round_phase", "shopping");
  assert.equal(state(p).round.phase, "shopping", "still the buy phase");
  assert.equal(p.s.roundPhaseFromFact, true, "the phase now comes from a real engine fact");

  // roundEndedAt is a few ms old, so the old 5.5s age-based hold would still
  // have suppressed the buy scene — that is the reported masking.
  assert.ok(Date.now() - p.s.roundEndedAt < 5500, "the settlement is well inside the old hold window");
  assert.equal(
    state(p).scene,
    "buy-round",
    "an authoritative round fact outranks the derived hold (BuyRound replaces IngameHUD)",
  );
});

test("7D-C — a SCORE-DERIVED buy phase still holds the HUD for the ceremony (no regression)", () => {
  const p = settledFromScore();
  // HU-014: no `end` phase exists in this dialect, so the 5.5s grace is what
  // keeps the endround ceremony on screen before BuyRound.
  assert.equal(p.s.roundPhaseFromFact, false, "no engine fact named this phase");
  assert.equal(state(p).scene, "ingame-hud", "the ceremony grace period still holds the HUD");

  p.s.roundEndedAt = Date.now() - 6000;
  assert.equal(state(p).scene, "buy-round", "and it is a grace period, not a latch");
});
