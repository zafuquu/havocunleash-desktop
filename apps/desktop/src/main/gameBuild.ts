/**
 * VALORANT build detection (v11 B8 / C11) — best-effort locate of the game
 * binary so the shell can say "VALORANT updated today; GEP may be
 * incompatible until Overwolf ships a corrected package" instead of showing
 * a mysteriously dead HUD on patch day.
 *
 * The audited machine has NO Riot registry keys (checked 2026-10-20) — the
 * install simply lives at <drive>\Riot Games\VALORANT — so candidates are
 * tried in order and the first existing binary wins.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ValorantBuildInfo {
  exePath: string;
  /** Binary mtime = the day the local game content changed (patch signal). */
  builtAt: number;
}

const EXE_REL = path.join(
  "live",
  "ShooterGame",
  "Binaries",
  "Win64",
  "VALORANT-Win64-Shipping.exe",
);

/** Production candidate roots: registry (best-effort) + common drives. */
export function valorantInstallRoots(): string[] {
  const roots: string[] = [];
  try {
    const out = execFileSync(
      "reg",
      ["query", "HKLM\\SOFTWARE\\WOW6432Node\\Riot Games\\VALORANT", "/v", "InstallPath"],
      { encoding: "utf8", timeout: 2_000, windowsHide: true },
    );
    const m = out.match(/InstallPath\s+REG_SZ\s+(.+)/i);
    if (m?.[1]) roots.push(m[1].trim());
  } catch {
    /* key absent on this machine — fall through to drive scan */
  }
  for (const drive of ["C:", "D:", "E:"]) roots.push(path.join(`${drive}\\`, "Riot Games", "VALORANT"));
  return roots;
}

/** Testable core: first candidate whose binary exists. */
export function detectValorantBuildFrom(roots: readonly string[]): ValorantBuildInfo | null {
  for (const root of roots) {
    try {
      const exe = path.join(root, EXE_REL);
      const st = fs.statSync(exe);
      if (st.isFile()) return { exePath: exe, builtAt: st.mtimeMs };
    } catch {
      /* next candidate */
    }
  }
  return null;
}

export function detectValorantBuild(): ValorantBuildInfo | null {
  return detectValorantBuildFrom(valorantInstallRoots());
}

/** True when the game binary changed within the last `windowMs` (patch signal). */
export function isGameRecentlyUpdated(
  build: ValorantBuildInfo | null,
  now = Date.now(),
  windowMs = 72 * 60 * 60 * 1000,
): boolean {
  return build !== null && now - build.builtAt < windowMs;
}
