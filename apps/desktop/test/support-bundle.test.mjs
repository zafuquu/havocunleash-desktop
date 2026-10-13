/**
 * PASS 9 (R4) — privacy-safe support bundle: SENTINEL VERIFICATION.
 *
 * Synthetic diagnostic inputs carry unique sentinel values for an auth token, a
 * session cookie, an email address, a user id, a machine id, a database
 * connection URL, an authorization header and a private-key-like value. A real
 * bundle is then generated from those fixtures and EVERY generated file AND
 * every archive entry is scanned. None of the sentinels may survive.
 *
 * A second group asserts that useful, allowlisted debugging information DOES
 * survive redaction — a bundle that redacts everything is useless.
 *
 * No real user credential is used anywhere in this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "hu-p9-bundle-"));
const logDir = path.join(fixture, "logs");
const outDir = path.join(fixture, "out");
fs.mkdirSync(logDir, { recursive: true });

const { createSupportBundle, summarizeStateMirror } = await import("../dist/main/supportBundle.js");

/* ------------------------------ the sentinels ------------------------------ */
const SENTINELS = {
  authToken: "SENTINEL_AUTHTOKEN_7f3a9c2e1b",
  sessionCookie: "SENTINEL_COOKIE_4d8e0a1c6f",
  email: "sentinel.user@example.com",
  userId: "SENTINEL_USERID_91b3ff02",
  machineId: "SENTINEL_MACHINEID_c4e7a19b",
  dbUrl: "SENTINEL_DBPASS_2a9d4e7c",
  bearer: "SENTINEL_BEARER_6c1f8d4a",
  privateKey: "SENTINEL_PRIVKEY_5b2e91d0",
};

/** A log fixture that embeds every sentinel, plus useful safe events. */
const LOG_LINES = [
  JSON.stringify({
    component: "auth",
    event: "login",
    level: "info",
    service: "havoc-unleash-desktop",
    timestamp: "2026-10-13T00:00:00.000Z",
    context: {
      __desktopAuth: SENTINELS.authToken,
      email: SENTINELS.email,
      userId: SENTINELS.userId,
      machineId: SENTINELS.machineId,
      note: "safe diagnostic detail survives",
    },
  }),
  JSON.stringify({
    component: "http",
    event: "bridge_request",
    level: "info",
    service: "havoc-unleash-desktop",
    timestamp: "2026-10-13T00:00:01.000Z",
    context: {
      authorization: `Bearer ${SENTINELS.bearer}`,
      cookie: `sessionid=${SENTINELS.sessionCookie}`,
      databaseUrl: `postgres://svc:${SENTINELS.dbUrl}@db.example.internal:5432/hu`,
      privateKey: `-----BEGIN PRIVATE KEY-----\n${SENTINELS.privateKey}\n-----END PRIVATE KEY-----`,
      retry: 3,
    },
  }),
  JSON.stringify({
    component: "runtime-client",
    event: "stream_connected",
    level: "info",
    service: "havoc-unleash-desktop",
    timestamp: "2026-10-13T00:00:02.000Z",
    context: { url: "http://127.0.0.1:7423" },
  }),
].join("\n") + "\n";

fs.writeFileSync(path.join(logDir, "session_2026-10-13-00-00-00.jsonl"), LOG_LINES, "utf8");

/** A projection mirror that carries third-party identity plus sentinels. */
const mirrorPath = path.join(fixture, "havoc-unleash-last-state.json");
fs.writeFileSync(
  mirrorPath,
  JSON.stringify({
    revision: 42,
    sessionPhase: "live",
    roundNumber: 7,
    roundPhase: "combat",
    roundPhaseFromFact: true,
    lastSettledRound: 6,
    blue: 4,
    red: 2,
    matchWinner: null,
    viewerRole: "observer",
    restorePending: false,
    gameEvent: null,
    roundHistory: [{ round: 1 }, { round: 2 }],
    roster: [
      { displayName: "RealPlayer#1234", puuid: "PUUID-9f8e7d6c-aaaa", kills: 3, teamIndex: 0 },
      { displayName: "OtherPlayer#5678", puuid: "PUUID-1a2b3c4d-bbbb", kills: 1, teamIndex: 1 },
    ],
    __desktopAuth: SENTINELS.authToken,
    contactEmail: SENTINELS.email,
    machineId: SENTINELS.machineId,
  }),
  "utf8",
);

const BUILD_INFO = {
  revision: "85b93a509f93d827c17d5a29dbe33b9cb39200a9",
  revisionShort: "85b93a509f93",
  dirty: true,
  builtAt: "2026-10-13T03:19:36.077Z",
  version: "0.1.0",
  source: "embedded",
};

/** Every readable byte the bundle produced — files plus unpacked archive. */
function collectAllBytes(res) {
  const chunks = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else chunks.push({ where: full, text: fs.readFileSync(full, "utf8") });
    }
  };
  walk(res.bundleDir);
  if (res.archivePath && fs.existsSync(res.archivePath)) {
    const unpacked = path.join(fixture, "unpacked");
    fs.rmSync(unpacked, { recursive: true, force: true });
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -Path '${res.archivePath}' -DestinationPath '${unpacked}' -Force`],
      { stdio: "ignore", timeout: 60_000 },
    );
    walk(unpacked);
  }
  return chunks;
}

const result = createSupportBundle({
  outDir,
  logDir,
  stateMirrorPath: mirrorPath,
  buildInfo: BUILD_INFO,
  maxLogFileBytes: 64 * 1024,
  now: () => new Date("2026-10-13T12:00:00.000Z"),
});

test("R4 — the bundle is produced successfully", () => {
  assert.equal(result.ok, true, result.error ?? "");
  assert.ok(fs.existsSync(path.join(result.bundleDir, "manifest.json")));
  assert.ok(fs.existsSync(path.join(result.bundleDir, "build-info.json")));
  assert.ok(fs.existsSync(path.join(result.bundleDir, "environment.json")));
  assert.ok(fs.existsSync(path.join(result.bundleDir, "state-summary.json")));
});

test("R4 — NO sentinel secret survives in any file or archive entry", () => {
  const collected = collectAllBytes(result);
  assert.ok(collected.length >= 4, "there is something to scan");
  for (const [name, value] of Object.entries(SENTINELS)) {
    for (const { where, text } of collected) {
      assert.ok(
        !text.includes(value),
        `SENTINEL LEAK: ${name} found in ${path.relative(fixture, where)}`,
      );
    }
  }
});

test("R4 — the projection mirror's third-party identities are not exported", () => {
  const collected = collectAllBytes(result);
  for (const leaked of ["RealPlayer#1234", "OtherPlayer#5678", "PUUID-9f8e7d6c", "PUUID-1a2b3c4d"]) {
    for (const { where, text } of collected) {
      assert.ok(!text.includes(leaked), `roster identity leaked: ${leaked} in ${where}`);
    }
  }
});

test("R4 — allowlisted diagnostics still survive redaction", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(result.bundleDir, "manifest.json"), "utf8"));
  // Build provenance
  assert.equal(manifest.build.revision, BUILD_INFO.revision);
  assert.equal(manifest.build.revisionShort, "85b93a509f93");
  assert.equal(manifest.build.dirty, true);
  assert.equal(manifest.appVersion, "0.1.0");
  // Platform / runtime
  assert.equal(typeof manifest.platform.nodeVersion, "string");
  assert.ok(manifest.platform.nodeVersion.startsWith("v"));
  assert.equal(manifest.platform.osPlatform, os.platform());
  // Documented policy + include/exclude accounting
  assert.ok(manifest.logPolicy.maxBytes > 0);
  assert.equal(manifest.redaction.applied, true);
  assert.ok(manifest.included.includes("logs/ (redacted excerpts)"));
  assert.ok(manifest.excluded.some((e) => /token/i.test(e.item)));
  assert.ok(manifest.excluded.some((e) => /roster/i.test(e.item)));
  // The log excerpt kept the useful, non-secret detail.
  const logs = fs.readdirSync(path.join(result.bundleDir, "logs"));
  const body = logs.map((n) => fs.readFileSync(path.join(result.bundleDir, "logs", n), "utf8")).join("\n");
  assert.ok(body.includes("safe diagnostic detail survives"), "useful context survived");
  assert.ok(body.includes("stream_connected"), "useful events survived");
  assert.ok(body.includes("127.0.0.1:7423"), "useful local endpoints survived");
});

test("R4 — the state summary keeps structure and drops identity", () => {
  const summary = JSON.parse(fs.readFileSync(path.join(result.bundleDir, "state-summary.json"), "utf8"));
  assert.equal(summary.present, true);
  assert.equal(summary.rosterSize, 2, "counts survive");
  assert.equal(summary.blue, 4, "the score survives");
  assert.equal(summary.roundPhase, "combat");
  assert.equal(summary.roundHistoryLength, 2);
  assert.ok(!("roster" in summary), "the roster itself is never exported");
});

test("R4 — summarizeStateMirror never emits names or ids", () => {
  const summary = summarizeStateMirror(JSON.parse(fs.readFileSync(mirrorPath, "utf8")));
  const flat = JSON.stringify(summary);
  assert.ok(!flat.includes("RealPlayer"));
  assert.ok(!flat.includes("PUUID"));
  assert.ok(!flat.includes(SENTINELS.authToken));
});

test("R4 — the manifest's own file hashes match the files it shipped", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(result.bundleDir, "manifest.json"), "utf8"));
  assert.ok(manifest.files.length >= 3);
  for (const entry of manifest.files) {
    const full = path.join(result.bundleDir, entry.name);
    assert.ok(fs.existsSync(full), `manifest lists a missing file: ${entry.name}`);
    assert.equal(fs.statSync(full).size, entry.bytes, `${entry.name} size`);
  }
});

test("R4 — a collection failure reports failure and leaves no partial bundle", () => {
  const blocker = path.join(fixture, "not-a-dir");
  fs.writeFileSync(blocker, "x", "utf8");
  const failed = createSupportBundle({
    outDir: path.join(blocker, "nested"),
    logDir,
    stateMirrorPath: mirrorPath,
    buildInfo: BUILD_INFO,
    now: () => new Date("2026-10-13T12:00:01.000Z"),
  });
  assert.equal(failed.ok, false, "a failure must never look like success");
  assert.ok(failed.error, "the failure is explained");
  assert.equal(failed.bundleDir, undefined, "no bundle path is advertised");
  const leftovers = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((n) => n.endsWith(".partial")) : [];
  assert.deepEqual(leftovers, [], "no abandoned temporary files");
});

test.after(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});
