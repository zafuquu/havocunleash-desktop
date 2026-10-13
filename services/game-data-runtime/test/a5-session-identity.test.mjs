/**
 * A5 — session identity + lifecycle regression tests.
 *
 * Pins the RIOT_PRESENCE_FALLBACK_CONTAMINATION fix (A5-PRE forensic):
 * a local desktop instance must NEVER project another player's match.
 * Every scenario below maps to a real observed failure from the live
 * forensic session (user in lobby, friend's match driving the HUD).
 *
 * Pure helpers under test (same pattern as the A2/A4 suites):
 *   - riot-identity.ts: selectSelfPresence / isSelfLive
 *   - gep-capture.ts:   gepDisconnectLifecycleEvent
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { selectSelfPresence, isSelfLive } from "../dist/riot-identity.js";
import { gepDisconnectLifecycleEvent } from "../dist/gep-capture.js";

/** PresenceEntry-shaped fixture factory. */
const P = (puuid, over = {}) => ({
  puuid,
  matchId: null,
  inProgress: false,
  inGame: false,
  isPregame: false,
  matchMap: null,
  scoreAlly: null,
  scoreEnemy: null,
  ...over,
});

/** Mirror of pollMatch's projection guard: would this presence emit match facts? */
const wouldProject = (presences, selfPuuid) => {
  const self = selectSelfPresence(presences, selfPuuid);
  if (!isSelfLive(self)) return null; // no projection source
  return self; // only the SELF presence can ever be projected
};

test("A — self in game, friend also in game: self is selected, friend ignored", () => {
  const presences = [
    P("puuid-A", { inGame: true, scoreAlly: 3, scoreEnemy: 1 }),
    P("puuid-B", { inGame: true, scoreAlly: 8, scoreEnemy: 8 }),
  ];
  const self = selectSelfPresence(presences, "puuid-A");
  assert.ok(self, "self presence must be found");
  assert.equal(self.puuid, "puuid-A");
  assert.ok(presences.every((p) => p.puuid !== "puuid-B" || p !== self), "friend never selected");
});

test("B — self in lobby, friend in game: session NOT live, friend ignored (the A5-PRE regression)", () => {
  const presences = [
    P("puuid-A", { inGame: false }), // user sitting in the VALORANT lobby
    P("puuid-B", { inGame: true, scoreAlly: 8, scoreEnemy: 9, matchMap: "/Game/Maps/Lotus/Lotus" }),
  ];
  const self = selectSelfPresence(presences, "puuid-A");
  assert.ok(self, "self lobby presence is still the selected identity");
  assert.equal(self.puuid, "puuid-A");
  assert.equal(isSelfLive(self), false, "lobby self => local session not live");
  assert.equal(wouldProject(presences, "puuid-A"), null, "friend's match must not be projected");
});

test("C — self absent: nothing selected, friend in game ignored; unseeded identity selects nobody", () => {
  const presences = [P("puuid-B", { inGame: true, scoreAlly: 5, scoreEnemy: 2 })];
  assert.equal(selectSelfPresence(presences, "puuid-A"), null, "foreign presence never selected");
  assert.equal(isSelfLive(null), false);
  assert.equal(
    selectSelfPresence(presences, null),
    null,
    "unseeded selfPuuid must select NOBODY (never a stranger)",
  );
  assert.equal(wouldProject(presences, "puuid-A"), null);
});

test("D — score/map contamination prevented: friend's 10:10 Lotus must not become match facts", () => {
  const friend = P("puuid-B", {
    inGame: true,
    scoreAlly: 10,
    scoreEnemy: 10,
    matchMap: "/Game/Maps/Lotus/Lotus",
  });
  const presences = [P("puuid-A"), friend]; // self in lobby
  const self = selectSelfPresence(presences, "puuid-A");
  assert.equal(isSelfLive(self), false, "self not live");
  // pollMatch only reads score/map/scene off the selected self — prove the
  // friend's fields are unreachable through the selection boundary:
  assert.notEqual(self, friend);
  assert.equal(self.scoreAlly, null, "no friend score on the selected presence");
  assert.equal(self.matchMap, null, "no friend map on the selected presence");
  assert.equal(wouldProject(presences, "puuid-A"), null, "no emission source");
});

test("E — GEP disconnected maps onto the existing game_exit lifecycle", () => {
  const ev = gepDisconnectLifecycleEvent(0);
  assert.equal(ev.key, "game_exit", "must reuse the runtime's existing reset statusKey");
  assert.equal(ev.value.reason, "gep_disconnected");
  assert.equal(ev.value.code, 0);
  const noCode = gepDisconnectLifecycleEvent(undefined);
  assert.equal(noCode.value.code, null, "missing code stays null (no fabrication)");
});

test("F — close then rapid restart: disconnect retires; reattach selects nothing foreign", () => {
  // Phase 1: PID A's GEP session disconnects → lifecycle evidence retires.
  const retire = gepDisconnectLifecycleEvent(0);
  assert.equal(retire.key, "game_exit", "retirement rides the existing game_exit path");
  // Phase 2: PID B attaches within seconds. Identity is re-derived from the
  // LOCAL chat session — the presence list (still showing old-PID party
  // members in their ongoing match) can never seed or project a session:
  const presences = [P("old-party-member", { inGame: true, scoreAlly: 11, scoreEnemy: 4 })];
  assert.equal(wouldProject(presences, "puuid-A"), null, "no live session survives the restart");
});

test("G — friend's match keeps progressing: HU stays idle poll after poll", () => {
  // Simulates consecutive presence polls while the local user stays in the
  // lobby and the friend's score climbs (8:8 → 8:9 → 10:10 in the field).
  const polls = [
    [P("puuid-A"), P("puuid-B", { inGame: true, scoreAlly: 8, scoreEnemy: 8 })],
    [P("puuid-A"), P("puuid-B", { inGame: true, scoreAlly: 8, scoreEnemy: 9 })],
    [P("puuid-A"), P("puuid-B", { inGame: true, scoreAlly: 10, scoreEnemy: 10 })],
  ];
  for (const presences of polls) {
    const self = selectSelfPresence(presences, "puuid-A");
    assert.equal(self.puuid, "puuid-A");
    assert.equal(isSelfLive(self), false, "HU remains idle every poll");
    assert.equal(wouldProject(presences, "puuid-A"), null, "friend's score never projected");
  }
});
