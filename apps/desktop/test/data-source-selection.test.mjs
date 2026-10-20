/**
 * Phase 3 — hybrid data-source adapter selection.
 *
 * `selectDataSource` is the pure discriminator behind every capture path:
 *   captureExe set   ⇒ native-runtime  (original capture engine, :7413 dialect)
 *   captureExe absent ⇒ builtin-runtime (fork GEP emulator, :7423)
 *
 * Pins both branches so the adapter identity can never drift silently from
 * config-hybrid.test.mjs's port assertions.
 */
import assert from "node:assert";
import test from "node:test";

const { selectDataSource } = await import("../dist/main/dataSource.js");

test("captureExe configured ⇒ native-runtime with engine path", () => {
  const sel = selectDataSource({
    captureExe: "C:\\blob\\resources\\game-data-runtime\\blob-game-data-runtime.exe",
    runtimeOrigin: "http://127.0.0.1:7413",
  });
  assert.equal(sel.kind, "native-runtime");
  assert.equal(sel.runtimeOrigin, "http://127.0.0.1:7413");
  assert.ok(sel.enginePath.endsWith(".exe"));
});

test("captureExe absent/blank ⇒ builtin-runtime without engine path", () => {
  for (const captureExe of ["", "   "]) {
    const sel = selectDataSource({ captureExe, runtimeOrigin: "http://127.0.0.1:7423" });
    assert.equal(sel.kind, "builtin-runtime");
    assert.equal(sel.enginePath, "");
  }
});

test("runtimeOrigin always passes through (selection never rewrites the wire)", () => {
  const sel = selectDataSource({ captureExe: "", runtimeOrigin: "http://127.0.0.1:7999" });
  assert.equal(sel.runtimeOrigin, "http://127.0.0.1:7999");
});
