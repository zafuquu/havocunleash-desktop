/**
 * PASS 9 (R4) — privacy-safe support-bundle collector.
 *
 * ALLOWLIST-FIRST. Only the fields explicitly named below are collected; there
 * is no path that archives an application data directory, the Chromium profile,
 * `config.json`, or any raw environment variable. Redaction (see redaction.ts)
 * is applied BEFORE any byte is written, because log lines are untrusted
 * third-party text.
 *
 * Deliberately excluded, and recorded as excluded in the manifest:
 *   raw env vars · credentials · tokens · cookies · database/connection URLs ·
 *   private keys · email addresses · user ids · machine ids · the Chromium
 *   profile · `config.json` (holds the desktop auth token) · the full roster
 *   (player names / engine ids) — the state mirror is reduced to a structural
 *   summary of counts and enums only.
 *
 * This module is UI-free on purpose: the desktop has no support menu, so the
 * least disruptive integration point is a pure library entry point plus
 * `dev-utils/make-support-bundle.mjs`. No UI/UX is changed.
 *
 * Failure is explicit: on any error the staging directory is removed and
 * `ok:false` is returned, so a caller can never mistake a partial bundle for a
 * successful one.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { getBuildInfo, type HuBuildInfo } from "./buildInfo";
import { logDirectory, listSessionFiles, LOG_POLICY } from "./logger";
import { redactDeep, redactPath, redactText } from "./redaction";

/** Bumped when the bundle layout changes incompatibly. */
export const SUPPORT_BUNDLE_SCHEMA = 1;

export interface SupportBundleOptions {
  /** Directory the bundle directory + archive are created in. */
  outDir: string;
  /** Log directory to excerpt. Defaults to the live logger directory. */
  logDir?: string;
  /** Provenance to embed. Defaults to this artifact's own provenance. */
  buildInfo?: HuBuildInfo;
  /** Per-log-file excerpt budget (tail). Default 256 KiB. */
  maxLogFileBytes?: number;
  /** Most-recent session files to excerpt. Default 10. */
  maxLogFiles?: number;
  /** Whole-bundle log budget. Default 2 MiB. */
  maxTotalLogBytes?: number;
  /** `%TEMP%` projection mirror. Summarized structurally, never copied. */
  stateMirrorPath?: string | null;
  /** Package version override; defaults to the build info's. */
  appVersion?: string | null;
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

export interface SupportBundleFile {
  name: string;
  bytes: number;
  sha256: string;
}

export interface SupportManifest {
  schema: number;
  created: string;
  service: "havoc-unleash-desktop";
  appVersion: string | null;
  build: {
    revision: string | null;
    revisionShort: string | null;
    dirty: boolean | null;
    builtAt: string | null;
    source: string;
  };
  platform: {
    osPlatform: string;
    arch: string;
    osRelease: string;
    nodeVersion: string;
    electronVersion: string | null;
  };
  logPolicy: {
    maxBytes: number;
    keep: number;
    /** Synchronous writes mean there is no user-space buffer to bound. */
    writeMode: string;
    perFileExcerptBytes: number;
    maxFiles: number;
    totalLogBudgetBytes: number;
  };
  /** Exactly what went in. */
  included: string[];
  /** Exactly what was kept out, and why. */
  excluded: { item: string; reason: string }[];
  files: SupportBundleFile[];
  redaction: { applied: boolean; method: string };
  ok: boolean;
  notes: string[];
}

export interface SupportBundleResult {
  ok: boolean;
  error?: string;
  bundleDir?: string;
  manifestPath?: string;
  /** Null when no zip tool was available — the directory is still valid. */
  archivePath?: string | null;
  manifest?: SupportManifest;
}

function sha256File(file: string): string {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

/**
 * Tail a file to at most `maxBytes`, dropping any partial leading line.
 *
 * Each line is parsed as JSON and passed through `redactDeep` so KEY-based
 * rules apply too — value-shaped regexes alone cannot catch a token sitting
 * under a key like `__desktopAuth`. Non-JSON lines fall back to value-only
 * redaction, since their structure is unknown.
 */
function tailRedacted(file: string, maxBytes: number): string | null {
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    try {
      const start = Math.max(0, stat.size - maxBytes);
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      let text = buf.toString("utf8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        text = nl >= 0 ? text.slice(nl + 1) : text;
      }
      return text
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((line) => {
          const t = line.trim();
          if (t.startsWith("{") || t.startsWith("[")) {
            try {
              return JSON.stringify(redactDeep(JSON.parse(t)));
            } catch {
              /* fall through to value-only redaction */
            }
          }
          return redactText(line);
        })
        .join("\n");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Reduce the projection mirror to STRUCTURE ONLY.
 *
 * Player display names, engine ids (puuids) and the kill feed are the most
 * useful things to debug and the most identifying things to leak, so they are
 * deliberately not exported: only counts, round enums and the score are kept.
 */
export function summarizeStateMirror(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const roster = Array.isArray(s.roster) ? s.roster : [];
  const round = (s.round ?? {}) as Record<string, unknown>;
  const roundEnd = (s.roundEnd ?? null) as Record<string, unknown> | null;
  const history = Array.isArray(s.roundHistory) ? s.roundHistory : [];
  return {
    present: true,
    rev: typeof s.revision === "number" ? s.revision : null,
    sessionPhase: typeof s.sessionPhase === "string" ? s.sessionPhase : null,
    roundNumber: typeof s.roundNumber === "number" ? s.roundNumber : (round.number ?? null),
    roundPhase: typeof s.roundPhase === "string" ? s.roundPhase : (round.phase ?? null),
    roundPhaseFromFact: typeof s.roundPhaseFromFact === "boolean" ? s.roundPhaseFromFact : null,
    lastSettledRound: typeof s.lastSettledRound === "number" ? s.lastSettledRound : null,
    blue: typeof s.blue === "number" ? s.blue : null,
    red: typeof s.red === "number" ? s.red : null,
    matchWinner: s.matchWinner ?? null,
    viewerRole: s.viewerRole ?? null,
    rosterSize: roster.length,
    roundHistoryLength: history.length,
    hasRoundEnd: roundEnd !== null,
    hasGameEvent: s.gameEvent !== null && s.gameEvent !== undefined,
    restorePending: s.restorePending === true,
    note: "player identities, puuids and the kill feed are intentionally omitted",
  };
}

/**
 * Create a support bundle. Returns `ok:false` (and removes any partial output)
 * on failure so a caller can never mistake a broken bundle for a good one.
 */
export function createSupportBundle(options: SupportBundleOptions): SupportBundleResult {
  const now = options.now ?? (() => new Date());
  const stamp = now()
    .toISOString()
    .replace(/[:T]/g, "-")
    .replace(/\..*/, "");
  const perFileBytes = options.maxLogFileBytes ?? 256 * 1024;
  const totalLogBudget = options.maxTotalLogBytes ?? 2 * 1024 * 1024;
  const bundleDir = path.join(options.outDir, `hu-support-${stamp}`);
  const staging = `${bundleDir}.partial`;
  const notes: string[] = [];

  /** Remove BOTH the staging and the final dir so no partial bundle survives. */
  const cleanup = (): void => {
    for (const dir of [staging, bundleDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* never let cleanup be the thing that throws */
      }
    }
  };

  try {
    fs.mkdirSync(options.outDir, { recursive: true });
    fs.mkdirSync(path.join(staging, "logs"), { recursive: true });

    const build = options.buildInfo ?? getBuildInfo();
    const included: string[] = [
      "manifest.json",
      "build-info.json",
      "environment.json",
      "state-summary.json",
      "logs/ (redacted excerpts)",
    ];
    const excluded: { item: string; reason: string }[] = [
      { item: "raw environment variables", reason: "may contain credentials, hostnames and account names" },
      { item: "config.json", reason: "holds the desktop auth token" },
      { item: "chromium profile (Local/Session Storage, Cache, Network)", reason: "cookies and session state" },
      { item: "credentials, tokens, cookies, private keys, database URLs", reason: "secrets" },
      { item: "email addresses and user ids", reason: "personal identifiers" },
      { item: "machine id / device id", reason: "stable personal identifier" },
      { item: "roster player names and engine ids (puuid)", reason: "identifies third parties; counts only" },
      { item: "kill feed", reason: "identifies third parties" },
      { item: "the rest of the application data directory", reason: "not on the allowlist" },
      { item: "the full projection mirror", reason: "replaced by state-summary.json (counts and enums only)" },
    ];

    // --- build-info.json (safe by construction: no user data) ---
    fs.writeFileSync(
      path.join(staging, "build-info.json"),
      JSON.stringify(redactDeep(build), null, 2) + "\n",
      "utf8",
    );

    // --- environment.json (allowlisted runtime facts only; NO env vars) ---
    const envDoc = redactDeep({
      osPlatform: os.platform(),
      arch: os.arch(),
      osRelease: os.release(),
      nodeVersion: process.version,
      electronVersion: process.versions.electron ?? null,
      cpus: typeof os.cpus === "function" ? os.cpus().length : null,
      totalMemBytes: typeof os.totalmem === "function" ? os.totalmem() : null,
    });
    fs.writeFileSync(path.join(staging, "environment.json"), JSON.stringify(envDoc, null, 2) + "\n", "utf8");

    // --- state-summary.json (structural summary, never the raw mirror) ---
    const mirrorPath = options.stateMirrorPath ?? path.join(os.tmpdir(), "havoc-unleash-last-state.json");
    let stateSummary: Record<string, unknown> = { present: false };
    try {
      if (fs.existsSync(mirrorPath)) {
        stateSummary = summarizeStateMirror(JSON.parse(fs.readFileSync(mirrorPath, "utf8"))) ?? {
          present: false,
          error: "unreadable",
        };
      }
    } catch {
      stateSummary = { present: false, error: "unreadable" };
    }
    fs.writeFileSync(
      path.join(staging, "state-summary.json"),
      JSON.stringify(redactDeep(stateSummary), null, 2) + "\n",
      "utf8",
    );
    // --- logs/ (redacted excerpts, tail-capped, budgeted) ---
    // Only the NEWEST sessions are considered: a long-lived install can hold
    // hundreds of files, and archiving them would be both huge and useless
    // (R4.6 — never indiscriminately archive the log directory).
    const logDir = options.logDir ?? logDirectory();
    const maxLogFiles = options.maxLogFiles ?? 10;
    const candidates = listSessionFiles(logDir).slice(-Math.max(1, maxLogFiles));
    let bytesUsed = 0;
    let logFiles = 0;
    for (const file of candidates) {
      if (bytesUsed >= totalLogBudget) {
        notes.push(`log budget of ${totalLogBudget} bytes reached; remaining session files omitted`);
        break;
      }
      const body = tailRedacted(file, Math.min(perFileBytes, totalLogBudget - bytesUsed));
      if (body === null) continue;
      fs.writeFileSync(path.join(staging, "logs", path.basename(file)), body + "\n", "utf8");
      bytesUsed += Buffer.byteLength(body, "utf8");
      logFiles += 1;
    }
    notes.push(`redacted excerpts from ${logFiles} session log file(s) under ${redactPath(logDir)}`);

    // --- manifest.json (written LAST so it can describe the other files) ---
    const files: SupportBundleFile[] = [];
    for (const rel of ["build-info.json", "environment.json", "state-summary.json", ...fs.readdirSync(path.join(staging, "logs")).map((n) => `logs/${n}`)]) {
      const abs = path.join(staging, rel);
      try {
        files.push({ name: rel, bytes: fs.statSync(abs).size, sha256: sha256File(abs) });
      } catch {
        /* skip anything we cannot stat */
      }
    }

    const manifest: SupportManifest = {
      schema: SUPPORT_BUNDLE_SCHEMA,
      created: now().toISOString(),
      service: "havoc-unleash-desktop",
      appVersion: options.appVersion ?? build.version,
      build: {
        revision: build.revision,
        revisionShort: build.revisionShort,
        dirty: build.dirty,
        builtAt: build.builtAt,
        source: build.source,
      },
      platform: {
        osPlatform: os.platform(),
        arch: os.arch(),
        osRelease: os.release(),
        nodeVersion: process.version,
        electronVersion: process.versions.electron ?? null,
      },
      logPolicy: {
        maxBytes: LOG_POLICY.defaultMaxBytes,
        keep: LOG_POLICY.defaultKeep,
        writeMode: "synchronous (fs.writeSync) — no user-space buffer to bound",
        perFileExcerptBytes: perFileBytes,
        maxFiles: maxLogFiles,
        totalLogBudgetBytes: totalLogBudget,
      },
      included,
      excluded,
      files,
      redaction: {
        applied: true,
        method: "allowlist-first; key- and value-based redaction applied before writing; paths de-identified",
      },
      ok: true,
      notes,
    };
    const manifestPath = path.join(staging, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(redactDeep(manifest), null, 2) + "\n", "utf8");

    // --- publish: staging -> final (a bundle only ever appears complete) ---
    fs.renameSync(staging, bundleDir);

    // --- archive (best effort; the directory is valid either way) ---
    let archivePath: string | null = null;
    try {
      const zipTarget = `${bundleDir}.zip`;
      execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -Path '${bundleDir}' -DestinationPath '${zipTarget}' -Force`],
        { stdio: "ignore", timeout: 60_000 },
      );
      archivePath = zipTarget;
    } catch {
      notes.push("no zip tool available; the bundle directory is complete and usable on its own");
    }

    return { ok: true, bundleDir, manifestPath: path.join(bundleDir, "manifest.json"), archivePath, manifest };
  } catch (err) {
    cleanup();
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
