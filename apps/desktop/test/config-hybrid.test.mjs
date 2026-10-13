/**
 * Phase 1 — verified capture path selection — MUS-1 `fix(config)`.
 *
 * The previously-working production path is HU desktop + the Blob capture
 * engine (hybrid): `captureExe` configured ⇒ the desktop spawns that engine and
 * talks the upstream wire dialect on its fixed port 7413. `captureExe` absent ⇒
 * the built-in fork runtime stays available for development.
 *
 * The live machine lost `captureExe` from %LOCALAPPDATA%\havoc-unleash\config.json,
 * which silently flipped the runtime origin to the fork port. These tests pin
 * BOTH branches so the selection can never regress unnoticed.
 *
 * Runs against the compiled dist (build first: npm run build -w apps/desktop).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { loadConfig } = await import("../dist/main/config.js");

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hu-config-"));
const HYBRID = path.join(fixtureDir, "hybrid.json");
const PLAIN = path.join(fixtureDir, "plain.json");

fs.writeFileSync(
  HYBRID,
  JSON.stringify({
    bridgeOrigin: "https://hu-bridge.onrender.com",
    appBase: "https://havocunleashs.vercel.app",
    captureExe: "C:\\Programs\\blob-desktop\\resources\\game-data-runtime\\blob-game-data-runtime.exe",
  }),
  "utf8",
);
fs.writeFileSync(
  PLAIN,
  JSON.stringify({ bridgeOrigin: "https://hu-bridge.onrender.com", appBase: "https://havocunleashs.vercel.app" }),
  "utf8",
);

after(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test("captureExe configured ⇒ upstream capture engine origin (:7413)", () => {
  const cfg = loadConfig({ HAVOC_CONFIG: HYBRID });
  assert.ok(cfg.captureExe.endsWith("blob-game-data-runtime.exe"));
  assert.equal(cfg.runtimeOrigin, "http://127.0.0.1:7413");
});

test("captureExe absent ⇒ built-in fork runtime stays the dev path", () => {
  const cfg = loadConfig({ HAVOC_CONFIG: PLAIN });
  assert.equal(cfg.captureExe, "");
  assert.equal(cfg.runtimeOrigin, "http://127.0.0.1:7423");
});

test("captureExe absent honours a custom fork runtime port", () => {
  const cfg = loadConfig({ HAVOC_CONFIG: PLAIN, HAVOC_RUNTIME_PORT: "7999" });
  assert.equal(cfg.runtimeOrigin, "http://127.0.0.1:7999");
});

test("HAVOC_CAPTURE_EXE env var takes precedence over the config file", () => {
  const cfg = loadConfig({ HAVOC_CONFIG: PLAIN, HAVOC_CAPTURE_EXE: "C:/tmp/engine.exe" });
  assert.equal(cfg.captureExe, "C:/tmp/engine.exe");
  assert.equal(cfg.runtimeOrigin, "http://127.0.0.1:7413");
});

test("a blank/whitespace HAVOC_CAPTURE_EXE is treated as unset", () => {
  const cfg = loadConfig({ HAVOC_CONFIG: PLAIN, HAVOC_CAPTURE_EXE: "   " });
  assert.equal(cfg.captureExe, "");
  assert.equal(cfg.runtimeOrigin, "http://127.0.0.1:7423");
});

test("screaming-case config keys are accepted like the original app", () => {
  const scream = path.join(fixtureDir, "scream.json");
  fs.writeFileSync(
    scream,
    JSON.stringify({ HAVOC_CAPTURE_EXE: "C:\\tmp\\engine.exe" }),
    "utf8",
  );
  const cfg = loadConfig({ HAVOC_CONFIG: scream });
  assert.equal(cfg.captureExe, "C:\\tmp\\engine.exe");
  assert.equal(cfg.runtimeOrigin, "http://127.0.0.1:7413");
});

test("an explicit HAVOC_CONFIG path that does not exist falls back to defaults", () => {
  const cfg = loadConfig({ HAVOC_CONFIG: path.join(fixtureDir, "missing.json") });
  assert.equal(cfg.captureExe, "");
  assert.equal(cfg.runtimeOrigin, "http://127.0.0.1:7423");
});
