/**
 * Structured JSONL session logger mirroring the audited layout:
 *   %LOCALAPPDATA%\havoc-unleash\desktop\logs\app\session_<ts>.jsonl
 *
 * PASS 9 (R3) — bounded growth. The previous implementation opened one
 * timestamped file per process start and never capped anything, so a long
 * session — or hundreds of restarts — grew the log directory without limit. It
 * also attached no `error` handler to its WriteStream, so a write failure (disk
 * full, directory removed, AV quarantine) surfaced as an UNCAUGHT exception and
 * could take the desktop down.
 *
 * Writes are SYNCHRONOUS (`fs.writeSync`) rather than streamed. A diagnostic
 * logger must never be the thing that loses the last lines before a crash, and
 * synchronous writes remove the entire class of buffering/backpressure problems
 * (R3.6) at the cost of one syscall per record — negligible at this volume.
 *
 * Bounded by construction:
 *   - the ACTIVE file rolls over at `HU_LOG_MAX_BYTES` (default 5 MiB);
 *   - the directory retains at most `HU_LOG_KEEP` files (default 5), pruned at
 *     startup AND on every rotation, so growth is bounded across restarts too;
 *   - every filesystem operation is guarded, and a failure degrades to
 *     stdout-only (a NON-RECURSIVE fallback that never re-enters the failed
 *     file) instead of throwing into the application;
 *   - no secret, token, header, cookie or environment variable is ever read or
 *     written here.
 *
 * The public surface (`logger.info/warn/error/debug/log`) is unchanged, so the
 * ten existing importers are untouched.
 */
import fs from "node:fs";
import path from "node:path";

type Level = "debug" | "info" | "warn" | "error";

interface LogRecord {
  component: string;
  event: string;
  level: Level;
  context?: Record<string, unknown>;
  service: "havoc-unleash-desktop";
  timestamp: string;
}

/** Exported for tests and for the support bundle's documented policy. */
export const LOG_POLICY = {
  /** Default active-file size cap: 5 MiB (matches the observed BLOB cap). */
  defaultMaxBytes: 5 * 1024 * 1024,
  /** Default number of session files retained in the log directory. */
  defaultKeep: 5,
} as const;

function envInt(name: string, fallback: number, min: number): number {
  try {
    const raw = process.env[name];
    if (typeof raw !== "string" || raw.trim() === "") return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= min ? n : fallback;
  } catch {
    return fallback;
  }
}

/** The log directory. Overridable so tests never touch a real user profile. */
export function logDirectory(): string {
  const base = process.env.LOCALAPPDATA ?? process.cwd();
  return path.join(base, "havoc-unleash", "desktop", "logs", "app");
}

/** Session files only (`session_*.jsonl`), oldest first. Never throws. */
export function listSessionFiles(dir: string = logDirectory()): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => /^session_.*\.jsonl$/.test(name))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

class JsonlLogger {
  private fd: number | null = null;
  private activePath: string | null = null;
  private activeBytes = 0;
  private pruned = false;
  /** Set once the active file has failed: we then log to stdout only. */
  private degraded = false;
  /** Diagnostics for the support bundle. No user data by construction. */
  private counters = { writeErrors: 0, rotations: 0 };

  private maxBytes(): number {
    return envInt("HU_LOG_MAX_BYTES", LOG_POLICY.defaultMaxBytes, 1024);
  }
  private keep(): number {
    return envInt("HU_LOG_KEEP", LOG_POLICY.defaultKeep, 1);
  }

  /** Delete the OLDEST session files beyond `keep`. Best-effort, never throws. */
  private prune(dir: string): void {
    try {
      const files = listSessionFiles(dir);
      const excess = files.length - this.keep();
      for (let i = 0; i < excess; i += 1) {
        try {
          fs.rmSync(files[i]!, { force: true });
        } catch {
          /* a locked or already-gone file must never break logging */
        }
      }
    } catch {
      /* pruning is best-effort */
    }
  }

  private closeActive(): void {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      /* ignore */
    }
    this.fd = null;
  }

  private openStream(): void {
    try {
      const dir = logDirectory();
      fs.mkdirSync(dir, { recursive: true });
      if (!this.pruned) {
        this.pruned = true;
        this.prune(dir);
      }
      const stamp = new Date()
        .toISOString()
        .replace(/[:T]/g, "-")
        .replace(/\..*/, "");
      // The stamp is second-granular, so several rotations can land in the same
      // second. Reopening the SAME path would silently defeat rotation (the size
      // counter would reset while the file kept growing), so disambiguate.
      let candidate = path.join(dir, `session_${stamp}.jsonl`);
      let n = 2;
      while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `session_${stamp}-${n}.jsonl`);
        n += 1;
        if (n > 10_000) break;
      }
      this.activePath = candidate;
      this.fd = fs.openSync(this.activePath, "a");
      this.activeBytes = fs.statSync(this.activePath).size;
    } catch {
      this.degraded = true;
      this.fd = null;
      this.activePath = null;
    }
  }

  private ensureFd(): number | null {
    if (this.degraded) return null;
    if (this.fd !== null) return this.fd;
    this.openStream();
    return this.fd;
  }

  /** Roll over to a fresh session file once the active one is full. */
  private rotate(): void {
    try {
      this.counters.rotations += 1;
      this.closeActive();
      this.activePath = null;
      this.activeBytes = 0;
      this.openStream();
      if (this.activePath) this.prune(path.dirname(this.activePath));
    } catch {
      /* rotation must never throw into the caller */
    }
  }

  /** Non-recursive fallback: writes to stdout ONLY, never to the failed file. */
  private stdoutOnly(event: string, level: Level, context?: Record<string, unknown>): void {
    try {
      process.stdout.write(
        JSON.stringify({
          component: "logger",
          event,
          level,
          ...(context ? { context } : {}),
          service: "havoc-unleash-desktop",
          timestamp: new Date().toISOString(),
        }) + "\n",
      );
    } catch {
      /* nothing further we can do */
    }
  }

  public log(level: Level, component: string, event: string, context?: Record<string, unknown>): void {
    let line: string;
    try {
      const record: LogRecord = {
        component,
        event,
        level,
        ...(context ? { context } : {}),
        service: "havoc-unleash-desktop",
        timestamp: new Date().toISOString(),
      };
      line = JSON.stringify(record);
    } catch {
      // An unserializable context must still leave a record behind.
      line = JSON.stringify({
        component,
        event: "log_unserializable_context",
        level: "warn",
        service: "havoc-unleash-desktop",
        timestamp: new Date().toISOString(),
      });
    }
    // Mirror into stdout for headless runs — the always-available channel.
    try {
      process.stdout.write(line + "\n");
    } catch {
      /* stdout may be closed in a packaged child */
    }

    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (this.activeBytes + bytes > this.maxBytes()) this.rotate();
    const fd = this.ensureFd();
    if (fd === null) return;
    try {
      fs.writeSync(fd, line + "\n");
      this.activeBytes += bytes;
    } catch {
      // Disk full, EBADF, EPIPE, AV quarantine... degrade instead of crashing.
      this.counters.writeErrors += 1;
      this.degraded = true;
      this.closeActive();
      this.activePath = null;
      this.stdoutOnly("log_write_failed", "warn", { writeErrors: this.counters.writeErrors });
    }
  }

  public info(component: string, event: string, context?: Record<string, unknown>): void {
    this.log("info", component, event, context);
  }
  public warn(component: string, event: string, context?: Record<string, unknown>): void {
    this.log("warn", component, event, context);
  }
  public error(component: string, event: string, context?: Record<string, unknown>): void {
    this.log("error", component, event, context);
  }
  public debug(component: string, event: string, context?: Record<string, unknown>): void {
    this.log("debug", component, event, context);
  }

  /** Counters for diagnostics. Contains no user data. */
  public stats(): {
    degraded: boolean;
    activePath: string | null;
    activeBytes: number;
    writeErrors: number;
    rotations: number;
  } {
    return {
      ...this.counters,
      degraded: this.degraded,
      activePath: this.activePath,
      activeBytes: this.activeBytes,
    };
  }
}

export const logger = new JsonlLogger();

