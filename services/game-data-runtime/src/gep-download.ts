/**
 * GEP package downloader — ported from the audited original HAVOC runtime
 * (havoc-game-data-runtime.exe): fetch Overwolf's public package manifest with
 * the `x-owe-dev` dev header (no credentials needed), download the GEP
 * `module.owepk`, extract with tar, and verify `verified_contents.json` hashes.
 *
 * Layout mirrors the original:
 *   <dataDir>/packages/gep/<version>/extracted/   (module contents incl. index.js + plugin)
 *   <dataDir>/packages/gep/<version>/resolved-package.json
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_URL = "https://electronapi.overwolf.com/v2/packages";
const USER_AGENT = "havoc-game-data-runtime/0.1";

export function resolveGameDataDir(): string {
  const env = process.env.HAVOC_GAME_DATA_DIR?.trim();
  if (env) return env;
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (!localAppData) throw new Error("LOCALAPPDATA is unavailable; set HAVOC_GAME_DATA_DIR");
  return join(localAppData, "Havoc", "game-data-runtime");
}

interface ManifestPackage {
  name?: string;
  version?: string;
  url?: string;
  channels?: Record<string, { version?: string; url?: string }>;
}

/** Resolve the production GEP package from the manifest (original selection logic). */
function pickGepPackage(manifest: unknown): { version: string; url: string } {
  const packages = (manifest as { packages?: ManifestPackage[] })?.packages;
  if (!Array.isArray(packages)) throw new Error("manifest did not contain a packages array");
  const gep = packages.find((p) => p?.name === "gep");
  if (!gep) throw new Error("GEP package not found in manifest");
  const entry = gep.channels?.production ?? gep;
  if (!entry?.version || !entry?.url) throw new Error("GEP package entry missing version/url");
  return { version: entry.version, url: entry.url };
}

async function fetchJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "x-owe-dev": "1", "user-agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`manifest request failed: HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

async function downloadTo(url: string, dest: string, timeoutMs = 60_000): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, buffer);
  rmSync(dest, { force: true });
  try {
    renameSync(tmp, dest);
  } catch {
    copyFileSync(tmp, dest);
    unlinkSync(tmp);
  }
}

function extractTar(archive: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar.exe", ["-xf", archive, "-C", destDir], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => (stderr += String(c)));
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`package extraction failed: ${stderr.trim()}`)),
    );
    child.on("error", reject);
  });
}

/** Return mismatched paths; empty array means the package verifies. */
function verifyContents(extractedDir: string): string[] {
  const metaPath = join(extractedDir, "_metadata", "verified_contents.json");
  if (!existsSync(metaPath)) throw new Error("verified_contents.json missing from GEP package");
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { hashes?: Record<string, string> };
  if (!meta.hashes || typeof meta.hashes !== "object") {
    throw new Error("verified_contents.json did not contain hashes");
  }
  const mismatches: string[] = [];
  for (const [rel, expected] of Object.entries(meta.hashes)) {
    const file = join(extractedDir, rel);
    if (!existsSync(file)) {
      mismatches.push(rel);
      continue;
    }
    const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (actual !== String(expected).toLowerCase()) mismatches.push(rel);
  }
  return mismatches;
}

export interface GepPackageInfo {
  version: string;
  directory: string;
}

/**
 * Ensure the GEP module is downloaded, extracted and verified. Reuses a valid
 * extraction across runs (same behavior as the original runtime).
 */
export async function ensureGepPackage(dataDir = resolveGameDataDir()): Promise<GepPackageInfo> {
  const trackDir = join(dataDir, "packages", "gep");

  // OFFLINE-FIRST: reuse the newest valid cached extraction without any
  // network. A flaky connection to Overwolf must never block the elevated
  // provider from launching (the original runtime behaves the same way — its
  // cached GEP package is reused until an update succeeds).
  if (existsSync(trackDir)) {
    const cachedVersions = readdirSync(trackDir)
      .filter((v) => existsSync(join(trackDir, v, "extracted", "ow-electron-gep-plugin.node")))
      .sort((a, b) => b.localeCompare(a));
    for (const version of cachedVersions) {
      const extractedDir = join(trackDir, version, "extracted");
      try {
        const mismatches = verifyContents(extractedDir);
        if (mismatches.length === 0) {
          rmSync(join(trackDir, version, "module.owepk"), { force: true });
          writeResolved(join(trackDir, version), version);
          return { version, directory: extractedDir };
        }
      } catch {
        // unreadable or failed verification -> fall through to the network path
      }
    }
  }

  // Network path: resolve the latest package from Overwolf's public manifest.
  const manifest = await fetchJson(MANIFEST_URL);
  const { version, url } = pickGepPackage(manifest);

  const versionDir = join(trackDir, version);
  const archivePath = join(versionDir, "module.owepk");
  const extractedDir = join(versionDir, "extracted");

  mkdirSync(versionDir, { recursive: true });
  if (!existsSync(archivePath)) await downloadTo(url, archivePath);
  rmSync(extractedDir, { recursive: true, force: true });
  mkdirSync(extractedDir, { recursive: true });
  await extractTar(archivePath, extractedDir);
  const mismatches = verifyContents(extractedDir);
  if (mismatches.length > 0) {
    rmSync(archivePath, { force: true });
    rmSync(extractedDir, { recursive: true, force: true });
    throw new Error(`GEP package ${version} failed verification: ${mismatches.slice(0, 5).join(", ")}`);
  }
  rmSync(archivePath, { force: true });
  writeResolved(versionDir, version);
  return { version, directory: extractedDir };
}

function writeResolved(versionDir: string, version: string): void {
  try {
    writeFileSync(
      join(versionDir, "resolved-package.json"),
      JSON.stringify({ track: "production", source: "production", version }, null, 2),
    );
  } catch {
    /* best-effort marker */
  }
}

/** Stable 40-char [a-p] app uid derived from a seed (Overwolf uid alphabet). */
export function deriveAppUid(seed: string): string {
  const digest = createHash("sha256").update(seed).digest();
  let uid = "";
  for (let i = 0; i < 20; i += 1) {
    const byte = digest[i]!;
    uid += String.fromCharCode(97 + (byte >> 4));
    uid += String.fromCharCode(97 + (byte & 0xf));
  }
  return uid;
}
