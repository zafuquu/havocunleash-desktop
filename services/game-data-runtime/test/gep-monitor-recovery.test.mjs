/**
 * A4 monitor-loss recovery tests. Pure logic only — no live process, no
 * VALORANT required. Run: npm test (services/game-data-runtime)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  monitorRecoveryDecision,
  isOrphanGepProviderCommandLine,
  MONITOR_RECOVERY_MAX_ATTEMPTS,
} from "../dist/provider-recovery.js";

const T0 = 1_700_000_000_000;

test("Test 1 — monitor failure with Overwolf present: recovery proceeds", () => {
  const d = monitorRecoveryDecision({ attempts: 0, windowStart: 0 }, T0);
  assert.equal(d.restart, true);
  assert.equal(d.attempts, 1);
});

test("Test 2 — monitor failure with Overwolf ABSENT: recovery STILL proceeds (A3 regression)", () => {
  // overwolfFound is not an input to the decision — recovery is unconditional.
  // This test pins that contract: the same state yields restart=true whether
  // Overwolf was found or not (the A3-LIVE failure was the resolved=false gap).
  const withOverwolf = monitorRecoveryDecision({ attempts: 0, windowStart: 0 }, T0);
  const withoutOverwolf = monitorRecoveryDecision({ attempts: 0, windowStart: 0 }, T0);
  assert.equal(withOverwolf.restart, true);
  assert.equal(withoutOverwolf.restart, true);
  assert.equal(withOverwolf.restart, withoutOverwolf.restart);
});

test("Test 3/4 — orphan identification: only gep-provider command lines match", () => {
  const providerNodeMode =
    '"C:\\app\\resources\\ow-electron\\dist\\electron.exe" --run-as-node "C:\\app\\resources\\gep-provider\\index.js" --session "C:\\data\\run\\gep-provider-session.json"';
  const providerElectronMode =
    '"C:\\app\\resources\\ow-electron\\dist\\electron.exe" "C:\\app\\resources\\gep-provider"';
  assert.equal(isOrphanGepProviderCommandLine(providerNodeMode), true);
  assert.equal(isOrphanGepProviderCommandLine(providerElectronMode), true);
  // Unrelated processes must NOT match:
  assert.equal(isOrphanGepProviderCommandLine("node server.js --port 7180"), false);
  assert.equal(isOrphanGepProviderCommandLine("node vite.config.ts --host"), false);
  assert.equal(isOrphanGepProviderCommandLine("npm run build --workspaces"), false);
  assert.equal(isOrphanGepProviderCommandLine("node node_modules/esbuild/install.js"), false);
  assert.equal(isOrphanGepProviderCommandLine(null), false);
  assert.equal(isOrphanGepProviderCommandLine(""), false);
});

test("Test 5 — recovery sequence: attempts advance and stay within the window", () => {
  let s = { attempts: 0, windowStart: 0 };
  for (let i = 1; i <= MONITOR_RECOVERY_MAX_ATTEMPTS; i += 1) {
    const d = monitorRecoveryDecision(s, T0 + i * 5_000);
    assert.equal(d.restart, true, `attempt ${i} should restart`);
    s = { attempts: d.attempts, windowStart: d.windowStart };
    assert.equal(s.attempts, i);
    assert.equal(s.windowStart, T0 + 5_000); // window pinned at first failure
  }
  assert.equal(s.attempts, MONITOR_RECOVERY_MAX_ATTEMPTS);
});

test("Test 6 — repeated failure beyond MAX: cooldown, no uncontrolled loop", () => {
  let s = { attempts: 0, windowStart: 0 };
  let now = T0;
  // Burn through the allowed attempts.
  for (let i = 0; i < MONITOR_RECOVERY_MAX_ATTEMPTS; i += 1) {
    const d = monitorRecoveryDecision(s, now);
    s = { attempts: d.attempts, windowStart: d.windowStart };
    now += 60_000;
  }
  // Next failure inside the window: DENIED, with remaining cooldown.
  const denied = monitorRecoveryDecision(s, now);
  assert.equal(denied.restart, false);
  assert.ok(denied.cooldownMs > 0, "cooldown must be positive");
  // After the cooldown + window elapse, recovery re-arms.
  const later = monitorRecoveryDecision(s, now + 31 * 60_000);
  assert.equal(later.restart, true);
  assert.equal(later.attempts, 1); // window reset
});

test("Test 7 — window expiry resets attempts (no permanent lockout)", () => {
  const d = monitorRecoveryDecision({ attempts: MONITOR_RECOVERY_MAX_ATTEMPTS, windowStart: T0 }, T0 + 31 * 60_000);
  assert.equal(d.restart, true);
  assert.equal(d.attempts, 1);
});
