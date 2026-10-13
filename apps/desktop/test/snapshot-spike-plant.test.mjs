/**
 * P1 — spike plant timestamp + P2 — spike plant SITE through the snapshot
 * pipeline.
 *
 * Live defect: the projection already tracked `round.spikePlantedAt`
 * (set at plant, held stable across re-emits, cleared on defuse/detonation and
 * at the next round's buy phase), and the website already consumed
 * `snapshot.state.round.spikePlantedAt` (OverlayPopout.tsx:915 →
 * IngameHudScene `spikeRemainingSec`). The desktop's `toGameSnapshot()` dropped
 * the field, so the spike clock could never tick and the HUD rendered the
 * static "SPIKE" label while the spike was actually ticking.
 *
 * Required behaviour under test:
 *   A. planted      → the EXACT plant epoch is emitted (no rounding, no
 *                     recalculation, no Date.now() replacement) and repeated
 *                     plant facts do not skew it;
 *   B. no spike     → null (never fabricated);
 *   C. detonated / defused → cleared;
 *   D. next round   → the previous round's plant epoch is not retained;
 *   E. existing fields (bombPlanted / roundTimer / currentRound / phaseStartedAt
 *      / observedAt) are unchanged and `round` carries ONLY the plant epoch
 *      (no duplicate representation of round number/phase).
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 * No VALORANT / Overwolf / runtime process involved — synthetic facts only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The projection mirrors its board into %TEMP% and the logger writes under
// %LOCALAPPDATA% — both must be redirected BEFORE the modules are imported.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-spike-plant-"));
process.env.TEMP = fixtureDir;
process.env.TMP = fixtureDir;
process.env.LOCALAPPDATA = fixtureDir;

const { ValProjectionSession } = await import("../dist/main/projection.js");
const { toGameSnapshot } = await import("../dist/main/snapshot.js");

const CACHE = path.join(fixtureDir, "havoc-unleash-last-state.json");

/**
 * A live session mid-round with two observed players (the snapshot only
 * publishes a round number once a real roster exists).
 */
function liveSession() {
  fs.rmSync(CACHE, { force: true });
  const p = new ValProjectionSession();
  p.applySnapshot({ sessionPhase: "live", matchId: "m-1", mapKey: "jam" });
  p.applyFact("scoreboard", { name: "Blue#0001", team: 0, credits: 800 });
  p.applyFact("scoreboard", { name: "Red#0002", team: 1, credits: 800 });
  p.applyFact("round_phase", "shopping"); // round 1 buy phase → publishes round 1
  p.applyFact("round_phase", "combat");
  return p;
}

const emitted = (p) => toGameSnapshot(p.snapshotValue());

/** GEP-raw plant event (the engine's actual newEvent name). */
const plant = (p) => {
  p.applyFact("planted_location", {});
  return p.snapshotValue();
};

/**
 * GEP-raw plant event carrying the SITE — the live frame observed against the
 * running runtime is `{"feature":"match_info","key":"planted_location",
 * "value":"B"}` and the runtime client forwards `data.value` verbatim, so the
 * projection receives the plain string.
 */
const plantAt = (p, site) => {
  p.applyFact("planted_location", site);
  return p.snapshotValue();
};

test("A — planted: the exact plant epoch is emitted (no rounding, no recalculation)", () => {
  const p = liveSession();
  const before = Date.now();
  const relay = plant(p);
  const after = Date.now();
  const snap = emitted(p);

  assert.equal(typeof relay.round.spikePlantedAt, "number", "projection recorded a plant epoch");
  assert.ok(
    relay.round.spikePlantedAt >= before && relay.round.spikePlantedAt <= after,
    "the epoch is the plant moment, not a derived value",
  );
  assert.equal(
    snap.state.round.spikePlantedAt,
    relay.round.spikePlantedAt,
    "the snapshot emits the relay's exact epoch",
  );
  assert.notEqual(snap.state.round.spikePlantedAt, null);
  assert.equal(snap.state.bombPlanted, true, "the flag is published alongside it");

  // GEP re-emits the plant fact while the spike stays planted — the clock base
  // must not move (projection: "re-emits must not skew the countdown").
  p.applyFact("planted_location", {});
  p.applyFact("planted", {});
  assert.equal(
    emitted(p).state.round.spikePlantedAt,
    relay.round.spikePlantedAt,
    "held stable across re-emitted plant facts",
  );
});

test("B — no spike: the field is null and never fabricated", () => {
  const p = liveSession();
  const snap = emitted(p);
  assert.equal(snap.state.round.spikePlantedAt, null);
  assert.equal(snap.state.bombPlanted, false);
});

test("C — detonated and defused clear the plant epoch (both engine dialects)", () => {
  const det = liveSession();
  plant(det);
  det.applyFact("detonated", {});
  let snap = emitted(det);
  assert.equal(snap.state.round.spikePlantedAt, null, "detonated → cleared");
  assert.equal(snap.state.bombPlanted, false);

  const def = liveSession();
  plant(def);
  def.applyFact("defused", {});
  snap = emitted(def);
  assert.equal(snap.state.round.spikePlantedAt, null, "defused → cleared");
  assert.equal(snap.state.bombPlanted, false);

  // Prefixed spellings the fork runtime uses must behave identically.
  const prefixedDet = liveSession();
  plant(prefixedDet);
  prefixedDet.applyFact("spike_detonated", {});
  assert.equal(emitted(prefixedDet).state.round.spikePlantedAt, null);

  const prefixedDef = liveSession();
  plant(prefixedDef);
  prefixedDef.applyFact("spike_defused", {});
  assert.equal(emitted(prefixedDef).state.round.spikePlantedAt, null);
});

test("D — the next round does not retain the previous plant epoch", () => {
  const p = liveSession();
  const planted = plant(p).round.spikePlantedAt;
  assert.ok(planted, "round 1 had a plant epoch");

  p.applyFact("round_number", 2);
  p.applyFact("round_phase", "shopping"); // new round's buy phase (per-round wipe)

  const snap = emitted(p);
  assert.equal(snap.state.round.spikePlantedAt, null, "stale plant time cleared at the new round");
  assert.equal(snap.state.bombPlanted, false);
});

/**
 * P2 — spike plant SITE through the snapshot pipeline (data-loss fix).
 *
 * Live evidence (2026-09-24): GEP delivers the site with the plant event
 * (`{"feature":"match_info","key":"planted_location","value":"B"}`) but the
 * projection discarded the value, so no site ever reached the website even
 * though OverlayPopout already reads `snapshot.state.plantSite` and
 * IngameHudScene renders "SITE X".
 *
 * Required behaviour under test:
 *   A/B/C. "A" / "B" / "C" → published raw (never rewritten into a
 *          presentation string, never an A→B mismatch);
 *   D.     plant → defused   → cleared (existing spike lifecycle);
 *   E.     plant → detonated → cleared (existing spike lifecycle);
 *   F.     plant → next round's buy phase → no stale site;
 *   plus:  no plant at all → null (never fabricated).
 */

test("P2-A/B/C — the plant site is published raw for A, B and C", () => {
  for (const site of ["A", "B", "C"]) {
    const p = liveSession();
    const relay = plantAt(p, site);
    const snap = emitted(p);

    assert.equal(relay.plantSite, site, `relay publishes the raw site ${site}`);
    assert.equal(snap.state.plantSite, site, `snapshot publishes the raw site ${site}`);
    assert.equal(snap.state.bombPlanted, true, "published alongside the plant flag");
    assert.equal(typeof snap.state.round.spikePlantedAt, "number", "P1 clock still intact");
    // The desktop publishes DATA — presentation ("SITE X") belongs to the overlay.
    assert.notEqual(snap.state.plantSite, `SITE ${site}`);
    assert.equal(snap.state.plantSite, snap.state.plantSite.toUpperCase(), "normalized, not decorated");
  }
});

test("P2 — no plant: the site is null and never fabricated", () => {
  const p = liveSession();
  const snap = emitted(p);
  assert.equal(snap.state.plantSite, null);
  assert.equal(p.snapshotValue().plantSite, null);

  // A site-less plant dialect (`planted`) must not invent one either.
  p.applyFact("planted", {});
  assert.equal(emitted(p).state.plantSite, null, "no site value → no site published");
  assert.equal(emitted(p).state.bombPlanted, true, "the plant itself is still recorded");

  // And a non-location value must not leak through as a site.
  const weird = liveSession();
  weird.applyFact("planted_location", "MID");
  assert.equal(emitted(weird).state.plantSite, null, "only A/B/C are accepted");
});

test("P2-D — plant then defuse clears the site (both engine dialects)", () => {
  const def = liveSession();
  plantAt(def, "B");
  assert.equal(emitted(def).state.plantSite, "B", "site present while planted");
  def.applyFact("defused", {});
  let snap = emitted(def);
  assert.equal(snap.state.plantSite, null, "defused → site cleared");
  assert.equal(snap.state.round.spikePlantedAt, null, "timestamp cleared with it");

  const prefixed = liveSession();
  plantAt(prefixed, "A");
  prefixed.applyFact("spike_defused", {});
  snap = emitted(prefixed);
  assert.equal(snap.state.plantSite, null, "spike_defused → site cleared");
  assert.equal(prefixed.snapshotValue().plantSite, null, "relay field cleared too");
});

test("P2-E — plant then detonation clears the site (both engine dialects)", () => {
  const det = liveSession();
  plantAt(det, "C");
  assert.equal(emitted(det).state.plantSite, "C");
  det.applyFact("detonated", {});
  let snap = emitted(det);
  assert.equal(snap.state.plantSite, null, "detonated → site cleared");
  assert.equal(snap.state.round.spikePlantedAt, null, "timestamp cleared with it");

  const prefixed = liveSession();
  plantAt(prefixed, "B");
  prefixed.applyFact("spike_detonated", {});
  snap = emitted(prefixed);
  assert.equal(snap.state.plantSite, null, "spike_detonated → site cleared");
  assert.equal(prefixed.snapshotValue().plantSite, null, "relay field cleared too");
});

test("P2-F — the next round never carries the previous site", () => {
  const p = liveSession();
  plantAt(p, "B");
  assert.equal(emitted(p).state.plantSite, "B", "round 1 planted on B");

  p.applyFact("round_number", 2);
  p.applyFact("round_phase", "shopping"); // new round's buy phase (per-round wipe)

  const snap = emitted(p);
  assert.equal(snap.state.plantSite, null, "no stale site in the next round");
  assert.equal(p.snapshotValue().plantSite, null, "relay field cleared at the round reset");
  assert.equal(snap.state.bombPlanted, false, "spike lifecycle unchanged");

  // The site of the NEW round is the new event's value, not a leftover.
  plantAt(p, "A");
  assert.equal(emitted(p).state.plantSite, "A", "round 2 reports its own site");
});
test("E — the restored field adds no duplicate slot and changes nothing else", () => {


  const p = liveSession();
  const relay = plant(p);
  // ONE build for both sides: `updatedAt`/`observedAt` are the same instant of a
  // single publish. Reading them from two separate `snapshotValue()` calls made
  // this assertion a 1 ms timing flake (it compared two different Date.now()s).
  const snap = toGameSnapshot(relay);

  assert.deepEqual(
    Object.keys(snap.state.round ?? {}),
    ["spikePlantedAt"],
    "`round` carries only the plant epoch (no duplicated number/phase)",
  );
  assert.equal(snap.state.bombPlanted, true, "bombPlanted unchanged");
  assert.equal(typeof snap.state.roundTimer, "number", "roundTimer still published");
  assert.equal(
    snap.state.currentRound.roundNumber,
    relay.round.number,
    "currentRound.roundNumber unchanged",
  );
  assert.equal(
    snap.state.currentRound.roundPhase,
    relay.round.phase,
    "currentRound.roundPhase unchanged",
  );
  assert.equal(snap.state.roundPhase, relay.round.phase, "roundPhase unchanged");
  assert.equal(snap.state.phaseStartedAt, relay.round.phaseStartedAt, "phaseStartedAt unchanged");
  assert.equal(snap.state.observedAt, relay.updatedAt, "observedAt untouched");
  assert.ok(Array.isArray(snap.state.players), "roster still published");
});

