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
/** Bounded manifest check so an offline boot still reaches the cache fallback quickly. */
const UPDATE_CHECK_TIMEOUT_MS = 8_000;

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

async function fetchJsonDefault(url: string, timeoutMs = 15_000): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "x-owe-dev": "1", "user-agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`manifest request failed: HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

async function downloadToDefault(url: string, dest: string, timeoutMs = 60_000): Promise<void> {
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

function extractTarDefault(archive: string, destDir: string): Promise<void> {
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

/** Test seam for ensureGepPackage network/tar I/O (no sockets, no tar.exe in tests). */
export interface EnsureGepOptions {
  fetchJsonImpl?: (url: string, timeoutMs?: number) => Promise<unknown>;
  downloadToImpl?: (url: string, dest: string, timeoutMs?: number) => Promise<void>;
  extractTarImpl?: (archive: string, destDir: string) => Promise<void>;
}

/** Boot options (D15): cache-first boot + background update task. */
export interface BootGepOptions extends EnsureGepOptions {
  /** Check the manifest for updates in the BACKGROUND (default true). */
  backgroundUpdate?: boolean;
  /** Test seam / observability hook for the background update task. */
  backgroundUpdateImpl?: (dataDir: string, opts: EnsureGepOptions) => Promise<GepPackageInfo | null>;
}

/**
 * Numeric-aware dotted-version compare. Lexicographic/`localeCompare` sorts
 * rank "315.3.5" above "315.3.10" ("5" > "1") — every version-selection site
 * must use this instead (patch-day 2026-10-20 audit).
 */
export function compareGepVersions(a: string, b: string): number {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Cached versions with a plugin file present, newest first (numeric order). */
function listCachedVersions(trackDir: string): string[] {
  try {
    return readdirSync(trackDir)
      .filter((v) => existsSync(join(trackDir, v, "extracted", "ow-electron-gep-plugin.node")))
      .sort((a, b) => compareGepVersions(b, a));
  } catch {
    return [];
  }
}

/** Best-effort single-version cache: drop every extraction except `keep`. */
function pruneOtherVersions(trackDir: string, keep: string): void {
  try {
    for (const v of readdirSync(trackDir)) {
      if (v !== keep) rmSync(join(trackDir, v), { recursive: true, force: true });
    }
  } catch {
    /* best-effort — a locked file just keeps the extra copy */
  }
}

type DownloadExtractImpl = {
  downloadTo: (url: string, dest: string, timeoutMs?: number) => Promise<void>;
  extractTar: (archive: string, destDir: string) => Promise<void>;
};

/** Download (unless the archive survived), extract and verify one version. */
async function downloadExtractVerify(
  trackDir: string,
  url: string,
  version: string,
  impl: DownloadExtractImpl,
): Promise<GepPackageInfo> {
  const versionDir = join(trackDir, version);
  const archivePath = join(versionDir, "module.owepk");
  const extractedDir = join(versionDir, "extracted");

  mkdirSync(versionDir, { recursive: true });
  if (!existsSync(archivePath)) await impl.downloadTo(url, archivePath);
  rmSync(extractedDir, { recursive: true, force: true });
  mkdirSync(extractedDir, { recursive: true });
  await impl.extractTar(archivePath, extractedDir);
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

/**
 * Ensure the GEP module is downloaded, extracted and verified.
 *
 * v10 (patch-day 2026-10-20): the old implementation returned ANY valid cached
 * extraction WITHOUT consulting Overwolf's manifest — so once a game patch
 * broke the installed GEP build, a corrective package published by Overwolf
 * could never be picked up (the cache was frozen at whatever was current at
 * the last successful download). We now check the manifest on every launch;
 * the offline-first guarantee is preserved by falling back to the newest
 * valid cache whenever the manifest is unreachable, and a FAILED UPDATE can
 * never brick the launch — any valid older extraction is used instead.
 */
export async function ensureGepPackage(
  dataDir = resolveGameDataDir(),
  opts: EnsureGepOptions = {},
): Promise<GepPackageInfo> {
  const trackDir = join(dataDir, "packages", "gep");
  const fetchJson = opts.fetchJsonImpl ?? fetchJsonDefault;
  const downloadTo = opts.downloadToImpl ?? downloadToDefault;
  const extractTar = opts.extractTarImpl ?? extractTarDefault;

  // 1) Update check (v10): resolve the latest production package from the
  //    manifest. ANY failure (offline, Overwolf down, manifest shape change)
  //    is non-fatal — the cache below takes over, as the original runtime did.
  let latest: { version: string; url: string } | null = null;
  let manifestError: unknown = null;
  try {
    latest = pickGepPackage(await fetchJson(MANIFEST_URL, UPDATE_CHECK_TIMEOUT_MS));
  } catch (error) {
    manifestError = error;
  }

  const cachedVersions = listCachedVersions(trackDir);

  // 2) The manifest's latest is not cached yet: download + extract + verify.
  //    A failed update falls through to the cache — it must never brick a
  //    launch that could still run on the previous package.
  if (latest && !cachedVersions.includes(latest.version)) {
    try {
      const info = await downloadExtractVerify(trackDir, latest.url, latest.version, { downloadTo, extractTar });
      pruneOtherVersions(trackDir, latest.version);
      return info;
    } catch (error) {
      if (cachedVersions.length === 0) throw error;
    }
  }

  // 3) Cache path: newest valid extraction wins (numeric order), re-verified
  //    on every launch; corrupt extractions fall through to the next version.
  for (const version of cachedVersions) {
    const extractedDir = join(trackDir, version, "extracted");
    try {
      const mismatches = verifyContents(extractedDir);
      if (mismatches.length === 0) {
        rmSync(join(trackDir, version, "module.owepk"), { force: true });
        writeResolved(join(trackDir, version), version);
        pruneOtherVersions(trackDir, version);
        return { version, directory: extractedDir };
      }
    } catch {
      // unreadable or failed verification -> try the next-oldest cached version
    }
  }

  // 4) Nothing usable is cached: with a manifest we (re-)attempt the fresh
  //    download once — this also repairs a corrupt extraction of the same
  //    version; without one we surface the manifest failure (offline, no cache).
  if (latest) {
    const info = await downloadExtractVerify(trackDir, latest.url, latest.version, { downloadTo, extractTar });
    pruneOtherVersions(trackDir, latest.version);
    return info;
  }
  throw manifestError instanceof Error
    ? manifestError
    : new Error("GEP package manifest unavailable and no cached package is usable");
}

/**
 * v11 D15 — cache-first boot with a BACKGROUND update check.
 *
 * v10 checked the manifest synchronously on every launch (up to 8s when
 * offline) before the provider could start. Boot now validates the cache
 * (fast, local) and returns immediately; `backgroundGepUpdate` then fetches
 * the manifest and stages any newer package for the NEXT launch. The
 * patch-day guarantee is preserved — a corrective Overwolf package is still
 * downloaded automatically — just applied one launch later, which is fine
 * because an injection fix requires a game/provider restart anyway.
 *
 * When no valid cache exists there is nothing to boot from: falls through to
 * the full synchronous `ensureGepPackage` (which downloads).
 */
export async function bootGepPackage(
  dataDir = resolveGameDataDir(),
  opts: BootGepOptions = {},
): Promise<GepPackageInfo> {
  const trackDir = join(dataDir, "packages", "gep");
  for (const version of listCachedVersions(trackDir)) {
    const extractedDir = join(trackDir, version, "extracted");
    try {
      if (verifyContents(extractedDir).length === 0) {
        rmSync(join(trackDir, version, "module.owepk"), { force: true });
        writeResolved(join(trackDir, version), version);
        // Single-version cache, pruned BEFORE the background task starts so
        // it can never race a download of the version we are about to use.
        pruneOtherVersions(trackDir, version);
        if (opts.backgroundUpdate !== false) {
          const run = opts.backgroundUpdateImpl ?? backgroundGepUpdate;
          void run(dataDir, opts).catch(() => {
            /* background update is strictly best-effort */
          });
        }
        return { version, directory: extractedDir };
      }
    } catch {
      // unreadable/corrupt extraction -> try the next-oldest cached version
    }
  }
  return ensureGepPackage(dataDir, opts);
}

/**
 * Background manifest check (D15): download + verify a newer package so the
 * NEXT boot finds it as the newest valid cache. Never prunes (the booted
 * extraction may be in use), never throws — returns null when there is
 * nothing to do or the check fails.
 */
export async function backgroundGepUpdate(
  dataDir: string,
  opts: EnsureGepOptions = {},
): Promise<GepPackageInfo | null> {
  const trackDir = join(dataDir, "packages", "gep");
  const fetchJson = opts.fetchJsonImpl ?? fetchJsonDefault;
  const downloadTo = opts.downloadToImpl ?? downloadToDefault;
  const extractTar = opts.extractTarImpl ?? extractTarDefault;
  try {
    const latest = pickGepPackage(await fetchJson(MANIFEST_URL, UPDATE_CHECK_TIMEOUT_MS));
    if (listCachedVersions(trackDir).includes(latest.version)) return null;
    return await downloadExtractVerify(trackDir, latest.url, latest.version, { downloadTo, extractTar });
  } catch {
    return null;
  }
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
