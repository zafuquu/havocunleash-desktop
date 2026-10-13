/**
 * Retail-Overwolf conflict detection.
 *
 * Overwolf's Game Events Provider (GEP) owns a single, EXCLUSIVE process
 * monitor. When the retail Overwolf client (Overwolf.exe) is running it claims
 * that monitor first, and our ow-electron GEP host loses the race — the plugin
 * reports:
 *
 *   plugin_status { key: "state",      value: "error" }
 *   plugin_status { key: "last_error", value: "failed_initializing_monitor" }
 *
 * and then loops disconnected -> shutdown -> initializing forever, so no game
 * data ever reaches the runtime (observed live: data stopped the moment retail
 * Overwolf came up, HUD froze on the agent-select scene).
 *
 * ValoSpectra hits the same wall and resolves it the same way (Spectra-Client
 * src/main.ts): find Overwolf.exe, offer to terminate it, continue without it.
 * We do it headlessly here — the runtime is a background service, so there is
 * no dialog to show; the desktop surfaces the state through provider_status.
 */
import { execFileSync } from "node:child_process";

/** Retail Overwolf images that contend for the GEP process monitor. */
const OVERWOLF_IMAGES = [
  "Overwolf.exe",
  "OverwolfBrowser.exe",
  "OverwolfHelper.exe",
  "OverwolfHelper64.exe",
];

/** The GEP plugin error that means "another host owns the process monitor". */
export const MONITOR_CONFLICT_ERROR = "failed_initializing_monitor";

export interface OverwolfProcess {
  image: string;
  pid: number;
}

/** List running retail-Overwolf processes (empty when Overwolf is not up). */
export function findOverwolfProcesses(): OverwolfProcess[] {
  const found: OverwolfProcess[] = [];
  try {
    const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    });
    for (const line of out.split("\n")) {
      const cells = line.split('","');
      if (cells.length < 2) continue;
      const image = cells[0]!.replace(/^"/, "");
      const match = OVERWOLF_IMAGES.find((i) => i.toLowerCase() === image.toLowerCase());
      if (!match) continue;
      const pid = Number((cells[1] ?? "").replace(/"/g, "").trim());
      if (Number.isFinite(pid) && pid > 0) found.push({ image: match, pid });
    }
  } catch {
    /* tasklist unavailable -> assume no conflict */
  }
  return found;
}

/** True when retail Overwolf is running and will steal the GEP monitor. */
export function isOverwolfRunning(): boolean {
  return findOverwolfProcesses().length > 0;
}

/**
 * Terminate retail Overwolf so our GEP host can own the process monitor.
 *
 * Opt-in via HAVOC_KILL_OVERWOLF=1 — killing another vendor's client is
 * destructive, so the default is to report the conflict and let the user
 * decide. Returns the processes we actually stopped.
 */
export function stopOverwolf(): OverwolfProcess[] {
  const running = findOverwolfProcesses();
  const stopped: OverwolfProcess[] = [];
  // Kill the root client first; helpers exit with it.
  const ordered = [...running].sort((a, b) =>
    a.image === "Overwolf.exe" ? -1 : b.image === "Overwolf.exe" ? 1 : 0,
  );
  for (const proc of ordered) {
    try {
      execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      });
      stopped.push(proc);
    } catch {
      /* already gone or access denied -> skip */
    }
  }
  return stopped;
}
