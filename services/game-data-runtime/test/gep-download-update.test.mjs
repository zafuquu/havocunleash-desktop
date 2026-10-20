/**
 * GEP package update-check tests (v10 — patch-day 2026-10-20).
 *
 * The old ensureGepPackage returned any valid cached extraction without ever
 * consulting Overwolf's manifest, freezing the cache at whatever was current
 * at the last successful download — after a game patch broke the installed
 * GEP build, a corrective package could never be picked up. These tests pin
 * the new semantics: manifest-first with numeric version compare, offline
 * fallback to cache, update failures that never brick the launch.
 *
 * Runs against the compiled dist (build first). All network/tar I/O is
 * injected — no sockets, no tar.exe, no VALORANT.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareGepVersions, ensureGepPackage } from "../dist/gep-download.js";

function makeDataDir() {
  return mkdtempSync(join(tmpdir(), "havoc-gep-dl-"));
}

/** Seed a verified cached extraction for `version` (plugin + hashes meta). */
function seedCached(dataDir, version) {
  const extracted = join(dataDir, "packages", "gep", version, "extracted");
  mkdirSync(join(extracted, "_metadata"), { recursive: true });
  const payload = Buffer.from(`plugin bytes ${version}`);
  writeFileSync(join(extracted, "ow-electron-gep-plugin.node"), payload);
  writeFileSync(
    join(extracted, "_metadata", "verified_contents.json"),
    JSON.stringify({ hashes: { "ow-electron-gep-plugin.node": createHash("sha256").update(payload).digest("hex") } }),
  );
  return extracted;
}

function manifestFor(version, url = `https://example.test/gep-${version}.owepk`) {
  return { packages: [{ name: "gep", channels: { production: { version, url } } }] };
}

/** extract stub: materialize a verifiable package as if tar.exe ran. */
function extractStub(archive, destDir) {
  mkdirSync(join(destDir, "_metadata"), { recursive: true });
  const payload = Buffer.from(`extracted from ${archive}`);
  writeFileSync(join(destDir, "ow-electron-gep-plugin.node"), payload);
  writeFileSync(
    join(destDir, "_metadata", "verified_contents.json"),
    JSON.stringify({ hashes: { "ow-electron-gep-plugin.node": createHash("sha256").update(payload).digest("hex") } }),
  );
  return Promise.resolve();
}

test("compareGepVersions — numeric segments (localeCompare would rank 315.3.5 above 315.3.10)", () => {
  assert.ok(compareGepVersions("315.3.10", "315.3.5") > 0);
  assert.ok(compareGepVersions("315.3.5", "315.3.10") < 0);
  assert.equal(compareGepVersions("315.3.6", "315.3.6"), 0);
  assert.ok(compareGepVersions("316", "315.3.99") > 0);
  assert.ok(compareGepVersions("315.3.6", "315.3") > 0);
});

test("offline manifest failure — newest NUMERIC cached version wins", async () => {
  const dir = makeDataDir();
  seedCached(dir, "315.3.5");
  seedCached(dir, "315.3.10");
  const info = await ensureGepPackage(dir, {
    fetchJsonImpl: () => Promise.reject(new Error("offline")),
  });
  assert.equal(info.version, "315.3.10");
  assert.ok(existsSync(join(info.directory, "ow-electron-gep-plugin.node")));
});

test("manifest publishes a new version — downloads, verifies, prunes the old cache", async () => {
  const dir = makeDataDir();
  seedCached(dir, "315.3.5");
  const downloads = [];
  const info = await ensureGepPackage(dir, {
    fetchJsonImpl: () => Promise.resolve(manifestFor("315.3.6")),
    downloadToImpl: (url, dest) => {
      downloads.push(url);
      writeFileSync(dest, "archive-stub");
      return Promise.resolve();
    },
    extractTarImpl: extractStub,
  });
  assert.equal(info.version, "315.3.6");
  assert.equal(downloads.length, 1);
  assert.ok(existsSync(join(dir, "packages", "gep", "315.3.6", "extracted", "ow-electron-gep-plugin.node")));
  assert.ok(!existsSync(join(dir, "packages", "gep", "315.3.5")), "old cache should be pruned after the update");
});

test("latest already cached — reused without any download", async () => {
  const dir = makeDataDir();
  seedCached(dir, "315.3.6");
  const info = await ensureGepPackage(dir, {
    fetchJsonImpl: () => Promise.resolve(manifestFor("315.3.6")),
    downloadToImpl: () => Promise.reject(new Error("download must not happen")),
    extractTarImpl: () => Promise.reject(new Error("extract must not happen")),
  });
  assert.equal(info.version, "315.3.6");
});

test("update download failure — valid older cache still launches the provider", async () => {
  const dir = makeDataDir();
  seedCached(dir, "315.3.5");
  const info = await ensureGepPackage(dir, {
    fetchJsonImpl: () => Promise.resolve(manifestFor("315.3.6")),
    downloadToImpl: () => Promise.reject(new Error("download failed")),
    extractTarImpl: extractStub,
  });
  assert.equal(info.version, "315.3.5");
});

test("no cache and manifest failure — rejects (same contract as before)", async () => {
  const dir = makeDataDir();
  await assert.rejects(
    ensureGepPackage(dir, { fetchJsonImpl: () => Promise.reject(new Error("offline")) }),
    /offline/,
  );
});