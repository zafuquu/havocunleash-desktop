/**
 * Phase 3 — runtime stream resilience — live incident 2026-09-24.
 *
 * Live evidence: `runtime-client stream_reconnecting {attempt: 2, message:
 * "[{code: too_big, maximum: 10, path: [roster]}]"}` — the projection's
 * `snapshotValue()` threw while a frame was being consumed, and because the
 * consumer callback ran unprotected inside the SSE read loop, the WHOLE
 * subscription was torn down and the reconnect budget burned. Telemetry then
 * stopped even though the capture engine (`:7413`) stayed healthy.
 *
 * Required behaviour under test:
 *   - a consumer callback that throws is logged, and the stream survives it;
 *   - every later frame is still delivered on the SAME subscription (no
 *     reconnect, no `connected:false` status);
 *   - the failure is visible in the session log instead of being swallowed.
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-stream-resilience-"));
process.env.TEMP = fixtureDir;
process.env.TMP = fixtureDir;
process.env.LOCALAPPDATA = fixtureDir;

const { GameDataRuntimeClient } = await import("../dist/main/runtimeClient.js");

const LOG_DIR = path.join(fixtureDir, "havoc-unleash", "desktop", "logs", "app");

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/** Newest session-log record for an event name (the app's own evidence trail). */
function logRecord(event) {
  if (!fs.existsSync(LOG_DIR)) return null;
  const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return null;
  const text = fs.readFileSync(path.join(LOG_DIR, files[files.length - 1]), "utf8");
  return (
    text
      .split("\n")
      .filter(Boolean)
      .map((raw) => JSON.parse(raw))
      .find((entry) => entry.event === event) ?? null
  );
}

const frame = (revision) => ({
  kind: "valorant_session_snapshot",
  snapshot: { revision, sessionPhase: "live", matchId: "m-1", mapKey: "jam", teams: [] },
});

test("E1 — a throwing consumer callback cannot tear the telemetry stream down", async () => {
  const port = await freePort();
  const frames = [frame(0), frame(1), frame(2)];
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, runtimeVersion: "0.1.0", runtime: { state: "ready" } }));
      return;
    }
    if (req.url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      frames.forEach((f, index) => {
        setTimeout(() => {
          if (!res.writableEnded) res.write(`event: ${f.kind}\ndata: ${JSON.stringify(f)}\n\n`);
        }, 30 * index);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  const delivered = [];
  const statuses = [];
  const client = new GameDataRuntimeClient(`http://127.0.0.1:${port}`, {
    onFact: () => {},
    onScore: () => {},
    onGameState: () => {},
    onStatus: (status) => statuses.push(status),
    onSnapshot: (snapshot) => {
      delivered.push(snapshot.revision);
      // The exact live failure mode: the projection throws while consuming.
      if (snapshot.revision === 0) {
        throw new Error('ZodError: [{ "code": "too_big", "path": ["roster"] }]');
      }
    },
  });
  void client.start();

  try {
    await waitFor(() => delivered.length >= frames.length);
    assert.deepEqual(
      delivered,
      [0, 1, 2],
      "frames after the consumer throw are still delivered",
    );
    assert.equal(
      statuses.some((status) => status.connected === false),
      false,
      "the subscription was never torn down (no reconnecting status)",
    );
  } finally {
    client.stop();
    await new Promise((resolve) => server.close(resolve));
  }

  const record = await waitFor(() => logRecord("callback_failed"));
  assert.ok(record, "the swallowed callback error is logged, not silent");
  assert.equal(record.context.label, "onSnapshot");
  assert.match(String(record.context.error), /too_big/);
});
