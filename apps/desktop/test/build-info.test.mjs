/**
 * PASS 9 (R2) — build provenance.
 *
 * The packaged artifact must be able to describe its own source revision, and
 * must answer "unknown" rather than guess when git metadata is unavailable.
 * These tests exercise the `environment` and `unknown` sources directly; the
 * `embedded` source is verified end-to-end by inspecting the packaged ASAR
 * (see dev-utils/inspect-build.mjs, which reads dist/build-info.json FROM the
 * package and cross-checks it against git HEAD).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { getBuildInfo, formatBuildInfo } = await import("../dist/main/buildInfo.js");

const ENV_KEYS = ["HU_BUILD_REVISION", "HU_BUILD_DIRTY", "HU_BUILD_BUILT_AT", "HU_APP_VERSION"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const clearEnv = () => {
  for (const k of ENV_KEYS) delete process.env[k];
};
const restoreEnv = () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
};

test("R2 — with no metadata at all the provenance is honestly unknown", () => {
  clearEnv();
  const info = getBuildInfo();
  assert.equal(info.source, "unknown");
  assert.equal(info.revision, null, "a build that cannot identify itself never claims a revision");
  assert.equal(info.revisionShort, null);
  assert.equal(info.dirty, null, "dirty/clean is unknown, never guessed clean");
  assert.match(formatBuildInfo(info), /unknown-revision/);
  assert.match(formatBuildInfo(info), /unknown/);
});

test("R2 — environment-provided revision is normalized and reported", () => {
  clearEnv();
  process.env.HU_BUILD_REVISION = "  85b93a509f93d827c17d5a29dbe33b9cb39200a9  ";
  process.env.HU_BUILD_DIRTY = "true";
  process.env.HU_APP_VERSION = "0.1.0";
  const info = getBuildInfo();
  assert.equal(info.source, "environment");
  assert.equal(info.revision, "85b93a509f93d827c17d5a29dbe33b9cb39200a9");
  assert.equal(info.revisionShort, "85b93a509f93");
  assert.equal(info.dirty, true);
  assert.equal(info.version, "0.1.0");
});

test("R2 — a malformed revision is rejected rather than trusted", () => {
  clearEnv();
  process.env.HU_BUILD_REVISION = "not-a-git-revision";
  assert.equal(getBuildInfo().revision, null, "garbage must never be reported as a revision");
  process.env.HU_BUILD_REVISION = "HEAD";
  assert.equal(getBuildInfo().revision, null, "a symbolic ref is not a revision");
  process.env.HU_BUILD_REVISION = "85b93a5";
  assert.equal(getBuildInfo().revision, "85b93a5", "short shas are accepted");
});

test("R2 — dirty accepts the documented spellings and rejects the rest", () => {
  clearEnv();
  const cases = [
    ["1", true],
    ["true", true],
    ["dirty", true],
    ["0", false],
    ["false", false],
    ["clean", false],
  ];
  for (const [raw, expected] of cases) {
    process.env.HU_BUILD_DIRTY = raw;
    assert.equal(getBuildInfo().dirty, expected, `HU_BUILD_DIRTY=${raw}`);
  }
  process.env.HU_BUILD_DIRTY = "maybe";
  assert.equal(getBuildInfo().dirty, null, "an unknown spelling stays unknown");
});

test("R2 — builtAt is only accepted as a parseable ISO instant", () => {
  clearEnv();
  process.env.HU_BUILD_BUILT_AT = "2026-10-13T03:19:36.077Z";
  assert.equal(getBuildInfo().builtAt, "2026-10-13T03:19:36.077Z");
  process.env.HU_BUILD_BUILT_AT = "yesterday";
  assert.equal(getBuildInfo().builtAt, null);
});

test("R2 — the summary line never leaks an environment value", () => {
  clearEnv();
  process.env.HU_BUILD_REVISION = "abcdef1234567890abcdef1234567890abcdef12";
  const line = formatBuildInfo(getBuildInfo());
  // Only the 12-char short form is shown anywhere.
  assert.ok(!line.includes("abcdef1234567890abcdef1234567890abcdef12"));
  assert.ok(line.includes("abcdef123456"));
});

test.after(() => restoreEnv());
