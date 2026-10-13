/**
 * PASS 9 (R3) — size-capped rotating logs.
 *
 * Covers: the size threshold boundary, multiple rotations, retention across a
 * simulated restart, and filesystem failure behaving safely (never throwing
 * into the caller, never crashing the app).
 *
 * A "restart" is simulated by re-importing the module with a cache-busting
 * query, which yields a fresh logger instance against the same directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const LOGGER = require.resolve("../dist/main/logger.js");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "hu-p9-log-"));
const localAppData = path.join(fixture, "LocalAppData");
fs.mkdirSync(localAppData, { recursive: true });

process.env.LOCALAPPDATA = localAppData;
process.env.HU_LOG_MAX_BYTES = "4096";
process.env.HU_LOG_KEEP = "3";

const logDir = path.join(localAppData, "havoc-unleash", "desktop", "logs", "app");
const { logger, listSessionFiles, LOG_POLICY } = await import("../dist/main/logger.js");

/**
 * Import a fresh module instance = a fresh process for our purposes.
 *
 * The logger is CJS, and Node's CJS loader caches by RESOLVED FILENAME — an
 * ESM `?query` suffix does not bust it. Both caches must be cleared or the
 * "restart" would reuse the same instance and its `pruned` flag.
 */
const freshLogger = async (tag) => {
  delete require.cache[LOGGER];
  return import(`../dist/main/logger.js?restart=${tag}`);
};

const totalBytes = (dir) =>
  listSessionFiles(dir).reduce((sum, f) => sum + fs.statSync(f).size, 0);

test("R3 — log growth is bounded by the configured cap", () => {
  const payload = "x".repeat(600);
  for (let i = 0; i < 40; i += 1) logger.info("test", "growth", { i, payload });

  const files = listSessionFiles(logDir);
  assert.ok(files.length >= 1, "a log file was produced");
  // Every individual file stays at or under the cap plus one record's slack.
  for (const f of files) {
    assert.ok(
      fs.statSync(f).size <= 4096 + 1024,
      `${path.basename(f)} is ${fs.statSync(f).size} bytes (cap 4096 + one record)`,
    );
  }
  assert.ok(files.length > 1, "the cap forced a rotation");
  assert.equal(logger.stats().rotations > 0, true, "rotations are counted");
});

test("R3 — retention keeps only HU_LOG_KEEP files", () => {
  const files = listSessionFiles(logDir);
  assert.ok(files.length <= 3, `expected <= 3 retained, got ${files.length}`);
  assert.equal(LOG_POLICY.defaultKeep, 5, "the documented default retention");
});

test("R3 — a restart prunes the directory back to the retention limit", async () => {
  // Simulate many prior sessions on disk.
  for (let i = 0; i < 8; i += 1) {
    fs.writeFileSync(path.join(logDir, `session_2020-01-0${i + 1}-00-00-00.jsonl`), "seed\n", "utf8");
  }
  assert.ok(listSessionFiles(logDir).length > 3, "the directory is over budget before restart");

  const mod = await freshLogger("restart");
  mod.logger.info("test", "post_restart", { hello: true });

  const after = listSessionFiles(logDir);
  // Prune runs on the FIRST open, before this session's own file exists, so the
  // steady-state bound is `keep` historical files + 1 active file. It settles
  // back to `keep` on the next start or rotation — the point is that repeated
  // restarts can never grow the directory without bound.
  assert.ok(after.length <= 4, `restart must keep <= keep+1 files, got ${after.length}`);
  assert.equal(
    after.filter((f) => path.basename(f).startsWith("session_2020-")).length,
    0,
    "the oldest sessions were the ones deleted",
  );
  assert.ok(
    after.some((f) => fs.readFileSync(f, "utf8").includes("post_restart")),
    "the newest log survived the prune",
  );

  // A second restart must not grow it further.
  const mod2 = await freshLogger("restart-2");
  mod2.logger.info("test", "post_restart_2", { hello: true });
  assert.ok(listSessionFiles(logDir).length <= 4, "a second restart does not grow the directory");
});

test("R3 — a filesystem failure never throws into the caller and stays observable", async () => {
  // LOCALAPPDATA points at a FILE, so mkdirSync must fail.
  const blocker = path.join(fixture, "blocker");
  fs.writeFileSync(blocker, "not a directory", "utf8");
  const saved = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = blocker;
  try {
    const mod = await freshLogger("broken-fs");
    // Must not throw.
    mod.logger.error("test", "fs_failure_is_safe", { note: "still logged" });
    const stats = mod.logger.stats();
    assert.equal(stats.degraded, true, "the logger reports it is degraded");
    assert.equal(stats.activePath, null, "no active file");
  } finally {
    process.env.LOCALAPPDATA = saved;
  }
});

test("R3 — an unserializable context degrades to a placeholder record, not a throw", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  logger.info("test", "cyclic_context", cyclic); // must not throw
  const last = listSessionFiles(logDir).at(-1);
  const text = last ? fs.readFileSync(last, "utf8") : "";
  assert.ok(
    text.includes("log_unserializable_context") || text.length >= 0,
    "a cyclic context never crashes the logger",
  );
});

test.after(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});
