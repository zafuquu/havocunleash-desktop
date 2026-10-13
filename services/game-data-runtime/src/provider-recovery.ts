/**
 * A4 — GEP monitor-loss recovery helpers.
 *
 * A3-LIVE confirmed the failure boundary: the GEP plugin attaches, runs its
 * init window, then reports plugin_status { state:"error",
 * last_error:"failed_initializing_monitor" } — and the old recovery path
 * restarted the provider ONLY when retail Overwolf processes were found and
 * killed. When Overwolf was already dead, `resolved=false` meant the provider
 * was never restarted and the fact stream stayed dead for the rest of the
 * match. FIX A: recovery no longer depends on Overwolf presence.
 *
 * FIX B (orphan cleanup): provider children can survive a forced desktop kill
 * and keep contending for the exclusive GEP monitor (multiple such orphans
 * were observed across restarts). Before each spawn, stale gep-provider
 * processes are identified by command line and terminated.
 *
 * FIX 11 (loop protection): recovery attempts are bounded per rolling window
 * with a cooldown — a failed monitor must not produce an infinite rapid
 * restart loop (GEP's own init window is up to 300s, so even a healthy cycle
 * is slow; the cap exists for pathological churn).
 */

export const MONITOR_RECOVERY_MAX_ATTEMPTS = 5;
export const MONITOR_RECOVERY_WINDOW_MS = 30 * 60_000;
export const MONITOR_RECOVERY_COOLDOWN_MS = 10 * 60_000;

export interface MonitorRecoveryState {
  attempts: number;
  windowStart: number;
}

export interface MonitorRecoveryDecision {
  /** true = proceed with cleanup + provider restart. */
  restart: boolean;
  attempts: number;
  windowStart: number;
  /** When restart is denied, the remaining cooldown in ms. */
  cooldownMs: number;
}

/**
 * Bounded recovery gate. Attempts are counted in a rolling window; exceeding
 * MONITOR_RECOVERY_MAX_ATTEMPTS inside the window denies the restart until
 * the cooldown elapses, after which the window resets and recovery resumes.
 */
export function monitorRecoveryDecision(
  state: MonitorRecoveryState,
  now: number,
): MonitorRecoveryDecision {
  let attempts = state.attempts;
  let windowStart = state.windowStart;
  if (windowStart <= 0 || now - windowStart > MONITOR_RECOVERY_WINDOW_MS) {
    windowStart = now;
    attempts = 0;
  }
  attempts += 1;
  if (attempts > MONITOR_RECOVERY_MAX_ATTEMPTS) {
    const elapsed = now - windowStart;
    return {
      restart: false,
      attempts: attempts - 1,
      windowStart,
      cooldownMs: Math.max(0, MONITOR_RECOVERY_WINDOW_MS - elapsed),
    };
  }
  return { restart: true, attempts, windowStart, cooldownMs: 0 };
}

/**
 * Narrow identifier for HU's GEP provider processes. The provider child is
 * the ow-electron executable running `...\gep-provider\index.js --session …`
 * (node mode) or `...\gep-provider\` (electron mode) — in both modes the
 * command line contains the `gep-provider` directory name, which no unrelated
 * process (Vercel/dev servers, other HU services, user apps) contains.
 */
export function isOrphanGepProviderCommandLine(commandLine: string | null | undefined): boolean {
  if (!commandLine) return false;
  return commandLine.includes("gep-provider");
}
