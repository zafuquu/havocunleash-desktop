/**
 * Projection validation: feeds a realistic match sequence (upstream pregame,
 * fork live snapshot with stats, round facts, settlement, match end) through
 * the built ValProjectionSession and prints the HUD state at each step.
 * Run after `npm run build`:  node scripts/projection-check.cjs
 */
const { ValProjectionSession } = require("../apps/desktop/dist/main/projection.js");

const p = new ValProjectionSession();
let last = null;
let changes = 0;
p.subscribe((s) => {
  last = s;
  changes += 1;
});

const id = { displayName: "Foo#BAR", gameName: "Foo", tagLine: "BAR" };

// 1) pregame (agent select) — upstream dialect with observer role
p.applySnapshot({
  revision: 1,
  phase: "pregame",
  session: {
    matchId: "m1",
    map: { key: "ascent", name: "Ascent" },
    viewer: { player: { puuid: "p1", name: id }, role: "observer" },
    teams: [
      {
        teamId: "Blue",
        players: [
          { player: { puuid: "p1", name: id }, selection: "locked", agent: { key: "wushu", name: "Jett" } },
          { player: { puuid: "p2", name: { displayName: "Baz#QUX" } }, selection: "unselected", agent: null },
        ],
      },
      {
        teamId: "Red",
        players: [{ player: { puuid: "p3", name: { displayName: "Qux#QUUX" } }, selection: "locked", agent: { key: "thorne", name: "Sage" } }],
      },
    ],
  },
});
console.log("1 pregame:", { scene: last.scene, phase: last.sessionPhase, roster: last.roster.length });

// 2) live snapshot with per-player stats (fork runtime dialect)
p.applySnapshot({
  revision: 2,
  sessionPhase: "live",
  matchId: "m1",
  mapKey: "ascent",
  teams: [
    {
      teamId: "Blue",
      players: [
        { player: { name: id, kills: 3, deaths: 1, assists: 2, credits: 3900, isAlive: true, ultPoints: 6, ultMax: 7, weapon: "Vandal" }, teamIndex: 0, observerSlot: 0, agent: { key: "wushu", name: "Jett" } },
        { player: { name: { displayName: "Baz#QUX" }, kills: 1, deaths: 2, assists: 0, credits: 2100, isAlive: true, ultPoints: 2, ultMax: 8 }, teamIndex: 0, observerSlot: 1 },
      ],
    },
    {
      teamId: "Red",
      players: [{ player: { name: { displayName: "Qux#QUUX" }, kills: 0, deaths: 3, assists: 1, credits: 1500, isAlive: false }, teamIndex: 1, observerSlot: 5 }],
    },
  ],
});
console.log("2 live:", { scene: last.scene, score: last.score, stats0: last.roster[0].kills, alive0: last.roster[0].isAlive });

// 3) snapshot refresh without stats must NOT wipe merged stats
p.applySnapshot({
  revision: 3,
  sessionPhase: "live",
  matchId: "m1",
  mapKey: "ascent",
  teams: [
    { teamId: "Blue", players: [
      { player: { name: id }, teamIndex: 0, observerSlot: 0, agent: { key: "wushu", name: "Jett" } },
      { player: { name: { displayName: "Baz#QUX" } }, teamIndex: 0, observerSlot: 1 },
    ] },
    { teamId: "Red", players: [{ player: { name: { displayName: "Qux#QUUX" } }, teamIndex: 1, observerSlot: 5 }] },
  ],
});
console.log("3 refresh:", { statsKept: last.roster[0].kills === 3 && last.roster[0].isAlive === true });

// 4) rounds: shopping -> combat
p.applyFact("round_number", 5);
p.applyFact("round_phase", "shopping");
p.applyFact("round_phase", "combat");
console.log("4 combat:", { round: last.round, scene: last.scene });

// 5) five kills by Foo, round end -> Ace expected
for (let i = 0; i < 5; i += 1) p.applyFact("kill_feed", { attacker: "Foo", victim: "Qux", weapon: "Vandal" });
p.applyFact("round_phase", "end");
console.log("5 round end:", { gameEvent: last.gameEvent, roundEnd: last.roundEnd, killfeed: last.killfeed.length });

// 6) match end: ending phase + 13 rounds
p.applyFact("match_score", { team_0: 13, team_1: 7 });
p.applySnapshot({
  revision: 4,
  phase: "ending",
  session: { matchId: "m1", map: { key: "ascent", name: "Ascent" }, viewer: { player: { puuid: "p1", name: id }, role: "observer" }, teams: [], matchDetails: "pending" },
});
console.log("6 match end:", { scene: last.scene, sessionPhase: last.sessionPhase, winner: last.match.winner, mvp: last.match.mvp });

// 7) new round: banner cleared
p.applyFact("round_number", 25);
p.applyFact("round_phase", "shopping");
console.log("7 new round:", { gameEvent: last.gameEvent, round: last.round });

console.log("total state changes:", changes);
