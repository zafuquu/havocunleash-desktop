/**
 * Lightweight Valorant process detector for the runtime.
 *
 * The runtime (services/game-data-runtime/src/server.ts) prefers Overwolf GEP
 * as its authoritative data source. When GEP is unavailable it stays idle. This
 * module lets the runtime also track the actual Valorant process so the desktop
 * reports live state without inventing OCR data.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface ValorantPresence {
  present: boolean;
  executablePath: string | null;
}

const KNOWN_EXES = ["VALORANT-Win64-Shipping.exe", "VALORANT.exe"];
const SHORTCUT_DIRECTORIES = [
  "F:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64",
] as const;

export function checkValorantProcess(): ValorantPresence {
  try {
    const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" }).toLowerCase();
    for (const exe of KNOWN_EXES) {
      if (out.includes(exe.toLowerCase())) {
        return { present: true, executablePath: findActualPath() };
      }
    }
  } catch { /* tasklist unavailable -> not present */ }
  return { present: false, executablePath: null };
}
/** Resolve the running game's process id (first VALORANT image match), or null. */
export function getValorantProcessId(): number | null {
  try {
    const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const cells = line.split('","');
      if (cells.length < 2) continue;
      const image = cells[0]!.replace(/^"/, "").toLowerCase();
      if (KNOWN_EXES.includes(image)) {
        const pid = Number((cells[1] ?? "").replace(/"/, ""));
        if (Number.isFinite(pid) && pid > 0) return pid;
      }
    }
  } catch { /* tasklist unavailable */ }
  return null;
}


function findActualPath(): string | null {
  for (const dir of SHORTCUT_DIRECTORIES) {
    for (const exe of KNOWN_EXES) {
      const candidate = dir + "\\" + exe;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
