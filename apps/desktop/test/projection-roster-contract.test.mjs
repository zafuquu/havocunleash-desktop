/**
 * Phase 3 — relay roster contract (desktop projection) — live incident 2026-09-24.
 *
 * Observed live failure (hybrid Blob capture engine, room HAVOC-B821F5A8-34CAF4):
 * the provider reported MORE identities than the relay contract allows
 * (`packages/contracts/src/hud-state.ts` caps `roster` at 10 because the site
 * renders a 5v5 board), so `ValProjectionSession.build()` threw
 *
 *   ZodError: [{ code: "too_big", maximum: 10, path: ["roster"] }]
 *
 * from an UNGUARDED `hudRelayStateSchema.parse`. That single throw:
 *   - tore the runtime SSE stream down (`runtime-client stream_reconnecting`
 *     burned the reconnect budget), and
 *   - escaped a `GET /api/status` handler as an UNCAUGHT exception, so Electron
 *     showed its blocking error dialog: the main thread never returned and the
 *     publisher died (bridge mirror + presence froze, website/OBS stayed empty)
 *     while the app window still painted its last frame.
 *
 * Required behaviour under test:
 *   - snapshotValue() NEVER throws for an over-contract roster;
 *   - every published relay state satisfies hudRelayStateSchema;
 *   - the relay board is bounded to 5 per side / 10 total, identities dedupe and
 *     the kept rows are the REAL provider rows in provider order (nothing is
 *     invented, nothing is silently reshuffled);
 *   - the same bounded board is what the bridge snapshot publishes;
 *   - the overflow is reported once in the session log (evidence, not silence).
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 * No VALORANT / Overwolf / runtime process involved — synthetic frames only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The projection mirrors its board into %TEMP% and the logger writes under
// %LOCALAPPDATA% — both must be redirected BEFORE the modules are imported.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-roster-contract-"));
process.env.TEMP = fixtureDir;
process.env.TMP = fixtureDir;
process.env.LOCALAPPDATA = fixtureDir;

const { ValProjectionSession } = await import("../dist/main/projection.js");
const { toGameSnapshot } = await import("../dist/main/snapshot.js");
const { hudRelayStateSchema } = await import("@havoc-unleash/contracts");

const CACHE = path.join(fixtureDir, "havoc-unleash-last-state.json");

function freshSession() {
  fs.rmSync(CACHE, { force: true });
  return new ValProjectionSession();
}

/** One provider squad row block, the way the engine snapshot reports it. */
function squad(teamId, size, prefix) {
  return {
    teamId,
    startingSide: "defense",
    players: Array.from({ length: size }, (_, index) => ({
      teamIndex: teamId === "Blue" ? 0 : 1,
      player: {
        name: { displayName: `${prefix}${index + 1}#0001` },
        kills: index,
        deaths: index,
        credits: 800,
      },
    })),
  };
}

/** A live snapshot whose board carries the given rows per side. */
function board(blueSize, redSize) {
  return {
    sessionPhase: "live",
    matchId: "m-1",
    mapKey: "jam",
    teams: [squad("Blue", blueSize, "Blue"), squad("Red", redSize, "Red")],
  };
}

const sideOf = (st, teamIndex) => st.roster.filter((p) => p.teamIndex === teamIndex);
const namesOf = (players) => players.map((p) => p.displayName.split("#")[0]);

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("R1 — an over-contract provider board no longer throws and stays 5v5", () => {
  const p = freshSession();
  // 6+6 distinct rows: the exact class of payload that killed production.
  p.applySnapshot(board(6, 6));

  const st = p.snapshotValue(); // pre-fix: ZodError too_big roster
  assert.equal(
    hudRelayStateSchema.safeParse(st).success,
    true,
    "the published relay state satisfies the contract",
  );
  assert.equal(st.roster.length, 10, "board is bounded to the contract");
  assert.equal(sideOf(st, 0).length, 5, "at most 5 per side");
  assert.equal(sideOf(st, 1).length, 5, "at most 5 per side");
  assert.deepEqual(
    namesOf(sideOf(st, 0)),
    ["Blue1", "Blue2", "Blue3", "Blue4", "Blue5"],
    "kept rows are the provider's own rows, in provider order",
  );
  assert.deepEqual(namesOf(sideOf(st, 1)), ["Red1", "Red2", "Red3", "Red4", "Red5"]);

  // The live app republishes on every change — repeating must keep working.
  p.applySnapshot(board(6, 6));
  assert.equal(p.snapshotValue().roster.length, 10);
});

test("R2 — the provider's extra scoreboard-only identity cannot break the publish", () => {
  const p = freshSession();
  p.applySnapshot(board(5, 5));
  for (let i = 1; i <= 5; i++) {
    p.applyFact("scoreboard", { name: `Blue${i}#0001`, team: 0, credits: 900, kills: i });
  }
  for (let i = 1; i <= 5; i++) {
    p.applyFact("scoreboard", { name: `Red${i}#0001`, team: 1, credits: 900, kills: i });
  }
  // Rows the provider reports that are NOT part of either 5-player squad.
  p.applyFact("scoreboard", { name: "ExtraBlue#0009", team: 0, credits: 0 });
  p.applyFact("scoreboard", { name: "ExtraRed#0010", team: 1, credits: 0 });

  const st = p.snapshotValue();
  assert.equal(hudRelayStateSchema.safeParse(st).success, true);
  assert.equal(st.roster.length, 10, "extra rows are dropped, not published");
  assert.equal(sideOf(st, 0).length, 5);
  assert.equal(sideOf(st, 1).length, 5);
  assert.equal(
    st.roster.some((row) => row.displayName.startsWith("ExtraBlue")),
    false,
    "the overflow row is the dropped one",
  );
  // Real per-player detail still lands on the rows that ARE published.
  const blue1 = st.roster.find((row) => row.displayName === "Blue1#0001");
  assert.equal(blue1?.credits, 900);
});

test("R3 — a duplicated identity never occupies two board slots", () => {
  const p = freshSession();
  const blue = squad("Blue", 5, "Blue");
  // The engine has been observed listing the same player under both squads.
  blue.players.push({ teamIndex: 0, player: { name: { displayName: "Red1#0001" } } });
  p.applySnapshot({ ...board(5, 5), teams: [blue, squad("Red", 5, "Red")] });

  const st = p.snapshotValue();
  assert.equal(hudRelayStateSchema.safeParse(st).success, true);
  assert.ok(st.roster.length <= 10, "bounded even when the provider contradicts itself");
  for (const identity of new Set(st.roster.map((row) => row.displayName))) {
    assert.equal(
      st.roster.filter((row) => row.displayName === identity).length,
      1,
      `${identity} occupies exactly one board slot`,
    );
  }
});

test("R4 — the bridge snapshot publishes the same bounded board", () => {
  const p = freshSession();
  p.applySnapshot(board(6, 6));
  const snapshot = toGameSnapshot(p.snapshotValue());
  assert.ok(snapshot.state.players.length <= 10, "bridge payload is bounded too");
  assert.equal(
    snapshot.state.players.filter((pl) => (pl.teamIndex ?? pl.startTeam ?? 0) === 0).length,
    5,
  );
});

test("R5 — the overflow is reported once in the session log", async () => {
  const p = freshSession();
  for (let i = 0; i < 3; i++) {
    p.applySnapshot(board(6, 6));
    p.snapshotValue();
  }
  const logDir = path.join(fixtureDir, "havoc-unleash", "desktop", "logs", "app");
  const record = await waitFor(() => {
    if (!fs.existsSync(logDir)) return null;
    const files = fs.readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) return null;
    const text = fs.readFileSync(path.join(logDir, files[files.length - 1]), "utf8");
    return (
      text
        .split("\n")
        .filter(Boolean)
        .map((raw) => JSON.parse(raw))
        .find((entry) => entry.event === "relay_roster_over_contract") ?? null
    );
  });
  assert.ok(record, "the dropped rows are visible evidence, not silent truncation");
  assert.equal(record.context.kept, 10);
  assert.equal(record.context.dropped, 2);
});
