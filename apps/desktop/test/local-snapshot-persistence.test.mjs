/**
 * Local-first broadcast persistence (Phase 1):
 *
 *   publishBroadcast()  -> throttled atomic write (state/live-snapshot.json)
 *   start()             -> restore BEFORE any live publish (instant repaint)
 *   stop()              -> final flush (quit path loses nothing)
 *
 * The in-memory frame stays authoritative; disk failures are non-fatal.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-localpersist-"));
process.env.TMP = fixtureDir;
process.env.TEMP = fixtureDir;

const { HudServer } = await import("../dist/main/hudServer.js");

const PUBLIC_DIR = fs.mkdtempSync(path.join(fixtureDir, "public-"));
fs.writeFileSync(path.join(PUBLIC_DIR, "index.html"), "<html></html>");
const STATE_DIR = fs.mkdtempSync(path.join(fixtureDir, "state-"));
const stateFile = path.join(STATE_DIR, "live-snapshot.json");

const FRAME = {
  kind: "broadcast",
  revision: 7,
  observedAt: 1_700_000_000_000,
  snapshot: {
    gameId: 21640,
    state: { observedAt: 1_700_000_000_000, roundPhase: "shopping", gameScore: { left: 3, right: 2 } },
  },
};

test("publishBroadcast persists atomically; a fresh HudServer restores it", async () => {
  const a = new HudServer(0, PUBLIC_DIR, undefined, STATE_DIR);
  a.publishBroadcast(FRAME.snapshot);
  await a.stop(); // final flush writes the file
  assert.ok(fs.existsSync(stateFile), "state file written on stop");
  const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(parsed.kind, "broadcast");
  assert.equal(parsed.observedAt, FRAME.observedAt);
  assert.deepEqual(parsed.snapshot, FRAME.snapshot);
  assert.ok(!fs.existsSync(`${stateFile}.tmp`), "atomic rename leaves no tmp file");

  // Fresh instance (app restart): restore must land BEFORE any live publish.
  const port = 7300 + (process.pid % 190);
  const b = new HudServer(port, PUBLIC_DIR, undefined, STATE_DIR);
  await b.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/broadcast`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.kind, "broadcast");
    assert.equal(body.observedAt, FRAME.observedAt);
    assert.deepEqual(body.snapshot, FRAME.snapshot);
  } finally {
    await b.stop();
  }
});

test("stop() without any publish never creates a state file", async () => {
  const dir = fs.mkdtempSync(path.join(fixtureDir, "state-empty-"));
  const c = new HudServer(0, PUBLIC_DIR, undefined, dir);
  await c.stop();
  assert.ok(!fs.existsSync(path.join(dir, "live-snapshot.json")), "no file for no data");
});

test("constructor creates a missing state dir (live ENOENT regression)", async () => {
  const dir = path.join(fixtureDir, "state-missing", "nested");
  assert.ok(!fs.existsSync(dir), "precondition: dir absent");
  const d = new HudServer(0, PUBLIC_DIR, undefined, dir);
  assert.ok(fs.existsSync(dir), "state dir created up front");
  d.publishBroadcast(FRAME.snapshot);
  await d.stop();
  assert.ok(fs.existsSync(path.join(dir, "live-snapshot.json")), "write succeeds in created dir");
});
