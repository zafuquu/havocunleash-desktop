/**
 * PASS 9 (R2) — build provenance.
 *
 * Answers, at runtime and from the packaged artifact, "which source produced this
 * build?". Mirrors BLOB's `blobSourceRevision` / `blobSourceDirty` fields, but is
 * implemented independently against HU's own conventions.
 *
 * SOURCES, in precedence order:
 *   1. `embedded`    — esbuild `define` literals injected by `scripts/pack-desktop.mjs`.
 *                      Compiled INTO `dist/main.js`, so the packaged app carries its
 *                      own provenance with no env var and no file access.
 *   2. `environment` — real `HU_BUILD_*` process env vars (dev builds, `tsc`-only,
 *                      tests). Lets a caller stamp a build without repackaging.
 *   3. `unknown`     — neither present. Reported honestly rather than guessed: a build
 *                      that cannot identify itself must never claim a revision.
 *
 * A `null` revision / `null` dirty is ALWAYS "unknown", never a guess and never
 * inherited from the working tree at read time. The inspector reads the value that
 * was BAKED IN, so a stale package cannot silently describe a newer revision.
 */

/** Build-time constants — replaced by esbuild `define` in packaged builds. */
declare const __HU_BUILD_REVISION__: string | undefined;
declare const __HU_BUILD_DIRTY__: string | undefined;
declare const __HU_BUILD_BUILT_AT__: string | undefined;
declare const __HU_APP_VERSION__: string | undefined;

export type HuBuildInfoSource = "embedded" | "environment" | "unknown";

export interface HuBuildInfo {
  /** Full git revision, or null when it could not be determined. */
  revision: string | null;
  /** First 12 chars of `revision` for display, or null. */
  revisionShort: string | null;
  /** True when the working tree had uncommitted changes at build time. */
  dirty: boolean | null;
  /** ISO-8601 UTC instant the artifact was produced, or null. */
  builtAt: string | null;
  /** Package version the artifact was built from. */
  version: string | null;
  /** Which source supplied `revision` / `dirty`. */
  source: HuBuildInfoSource;
}

/** A 40-hex git object name. */
const REVISION_RE = /^[0-9a-f]{7,40}$/i;

function normalizeRevision(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return REVISION_RE.test(t) ? t.toLowerCase() : null;
}

function normalizeDirty(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const t = value.trim().toLowerCase();
  if (t === "1" || t === "true" || t === "dirty") return true;
  if (t === "0" || t === "false" || t === "clean") return false;
  return null;
}

function normalizeIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return /^\d+\.\d+\.\d+/.test(t) ? t : null;
}

/** Read an esbuild-injected constant without throwing when the symbol is absent. */
function readInjected(
  name: "__HU_BUILD_REVISION__" | "__HU_BUILD_DIRTY__" | "__HU_BUILD_BUILT_AT__" | "__HU_APP_VERSION__",
): unknown {
  try {
    switch (name) {
      case "__HU_BUILD_REVISION__":
        return typeof __HU_BUILD_REVISION__ === "undefined" ? undefined : __HU_BUILD_REVISION__;
      case "__HU_BUILD_DIRTY__":
        return typeof __HU_BUILD_DIRTY__ === "undefined" ? undefined : __HU_BUILD_DIRTY__;
      case "__HU_BUILD_BUILT_AT__":
        return typeof __HU_BUILD_BUILT_AT__ === "undefined" ? undefined : __HU_BUILD_BUILT_AT__;
      case "__HU_APP_VERSION__":
        return typeof __HU_APP_VERSION__ === "undefined" ? undefined : __HU_APP_VERSION__;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readEnv(name: string): string | undefined {
  try {
    const v = process.env[name];
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the provenance of THIS artifact. Never throws: an unavailable source
 * degrades to `unknown`, which is the only honest answer.
 */
export function getBuildInfo(): HuBuildInfo {
  const injectedRevision = normalizeRevision(readInjected("__HU_BUILD_REVISION__"));
  const injectedDirty = normalizeDirty(readInjected("__HU_BUILD_DIRTY__"));
  const injectedBuiltAt = normalizeIso(readInjected("__HU_BUILD_BUILT_AT__"));
  const injectedVersion = normalizeVersion(readInjected("__HU_APP_VERSION__"));

  const envRevision = normalizeRevision(readEnv("HU_BUILD_REVISION"));
  const envDirty = normalizeDirty(readEnv("HU_BUILD_DIRTY"));
  const envBuiltAt = normalizeIso(readEnv("HU_BUILD_BUILT_AT"));
  const envVersion = normalizeVersion(readEnv("HU_APP_VERSION"));

  const source: HuBuildInfoSource =
    injectedRevision !== null || injectedDirty !== null
      ? "embedded"
      : envRevision !== null || envDirty !== null
        ? "environment"
        : "unknown";

  const revision = injectedRevision ?? envRevision ?? null;
  return {
    revision,
    revisionShort: revision === null ? null : revision.slice(0, 12),
    dirty: injectedDirty ?? envDirty ?? null,
    builtAt: injectedBuiltAt ?? envBuiltAt ?? null,
    version: injectedVersion ?? envVersion ?? null,
    source,
  };
}

/** One-line, log-safe summary. Contains no user data by construction. */
export function formatBuildInfo(info: HuBuildInfo = getBuildInfo()): string {
  const rev = info.revisionShort ?? "unknown-revision";
  const dirty = info.dirty === null ? "unknown" : info.dirty ? "dirty" : "clean";
  const ver = info.version ?? "unknown-version";
  return `${ver} (${rev}, ${dirty}, ${info.source})`;
}

