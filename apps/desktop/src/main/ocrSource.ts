/**
 * OCR backup controller (v11 A) — screen-read fallback for the SCENE only.
 *
 * When GEP telemetry dies mid-match (patch day: DLL injection broken), this
 * controller takes over the scene decision through
 * `projection.applyOcrReading` — conservatively (see ocrRules.ts: never
 * guesses; "hold" keeps the committed scene through ambiguity). Score numerals
 * are read for the shell health panel but NEVER attributed to the projection
 * (left/right screen sides cannot be mapped to the viewer's team safely).
 *
 * Pipeline: engage tick (2s, pure state machine) → while engaged, capture the
 * primary screen at ~1fps (desktopCapturer thumbnail → temp PNG) → persistent
 * WinRT OCR bridge (powershell, offline) → classify → apply.
 *
 * Deps are injected so the pure decision logic (ocrRules.ts) stays unit-
 * testable without Electron; this file is the thin wiring.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { desktopCapturer } from "electron";

import type { ValProjectionSession } from "./projection";
import { classifyOcrFrame, nextOcrEngagement, type OcrHint } from "./ocrRules";
import { logger } from "./logger";

export interface OcrSettings {
  enabled: boolean;
}

export interface OcrStatus {
  enabled: boolean;
  engaged: boolean;
  engineError: string | null;
  bridgeRunning: boolean;
  lastReadAt: number | null;
  hint: OcrHint | null;
  score: { left: number; right: number } | null;
}

export interface OcrContext {
  telemetryState: string | null;
  telemetryChangedAt: number;
  sessionPhase: string | null;
}

const CAPTURE_INTERVAL_MS = 1_000;
/** Keep refreshing the last confident hint through short OCR gaps (blips). */
const HINT_REFRESH_MS = 30_000;

export class OcrBackupController {
  private settings: OcrSettings = { enabled: false };
  private engaged = false;
  private bridge: ChildProcessWithoutNullStreams | null = null;
  private bridgeReady = false;
  private engineError: string | null = null;
  private captureTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private capturing = false;
  private lastReadAt: number | null = null;
  private lastHint: OcrHint | null = null;
  private lastHintAt = 0;
  private score: { left: number; right: number } | null = null;
  private frameSeq = 0;

  public constructor(
    private readonly deps: {
      scriptPath: string;
      settingsFile: string;
      projection: ValProjectionSession;
      getContext: () => OcrContext;
    },
  ) {
    try {
      const raw = fs.readFileSync(this.deps.settingsFile, "utf8");
      const parsed = JSON.parse(raw) as Partial<OcrSettings>;
      this.settings = { enabled: parsed.enabled === true };
    } catch {
      /* first run — stays disabled (v11 default: OFF) */
    }
  }

  public start(): void {
    this.tickTimer = setInterval(() => this.engagementTick(), 2_000);
    this.tickTimer.unref?.();
    this.engagementTick();
  }

  public stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.captureTimer) clearInterval(this.captureTimer);
    this.tickTimer = null;
    this.captureTimer = null;
    this.killBridge();
    if (this.engaged) {
      this.engaged = false;
      this.deps.projection.applyOcrReading(null);
    }
  }

  public getSettings(): OcrSettings {
    return { ...this.settings };
  }

  public setSettings(next: Partial<OcrSettings>): OcrSettings {
    if (typeof next.enabled === "boolean" && next.enabled !== this.settings.enabled) {
      this.settings = { enabled: next.enabled };
      try {
        fs.mkdirSync(path.dirname(this.deps.settingsFile), { recursive: true });
        fs.writeFileSync(this.deps.settingsFile, JSON.stringify(this.settings, null, 2));
      } catch (error) {
        logger.warn("ocr", "settings_persist_failed", { error: String(error) });
      }
      // Immediate re-evaluation — disabling must release without the next tick.
      this.engagementTick();
    }
    return { ...this.settings };
  }

  public status(): OcrStatus {
    return {
      enabled: this.settings.enabled,
      engaged: this.engaged,
      engineError: this.engineError,
      bridgeRunning: this.bridge !== null,
      lastReadAt: this.lastReadAt,
      hint: this.lastHint,
      score: this.score,
    };
  }

  /* ------------------------------- engage tick ------------------------------ */

  private engagementTick(): void {
    const ctx = this.deps.getContext();
    const next = nextOcrEngagement(this.engaged, {
      enabled: this.settings.enabled,
      telemetryState: ctx.telemetryState,
      telemetryChangedAt: ctx.telemetryChangedAt,
      sessionPhase: ctx.sessionPhase,
      now: Date.now(),
    });
    if (next === this.engaged) return;
    this.engaged = next;
    logger.info("ocr", next ? "engaged" : "released", {
      telemetryState: ctx.telemetryState,
      sessionPhase: ctx.sessionPhase,
    });
    if (next) {
      this.ensureBridge();
      this.startCapture();
    } else {
      this.stopCapture();
      this.killBridge();
      this.lastHint = null;
      this.score = null;
      this.deps.projection.applyOcrReading(null);
    }
  }

  /* -------------------------------- capture -------------------------------- */

  private startCapture(): void {
    if (this.captureTimer) return;
    this.captureTimer = setInterval(() => void this.captureFrame(), CAPTURE_INTERVAL_MS);
    this.captureTimer.unref?.();
    void this.captureFrame();
  }

  private stopCapture(): void {
    if (this.captureTimer) clearInterval(this.captureTimer);
    this.captureTimer = null;
  }

  private async captureFrame(): Promise<void> {
    if (this.capturing || !this.bridge || !this.bridgeReady) return;
    this.capturing = true;
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1600, height: 900 },
      });
      const source = sources[0];
      if (!source) return;
      const png = source.thumbnail.toPNG();
      if (png.length === 0) return;
      const file = path.join(os.tmpdir(), `havoc-ocr-${Date.now()}-${(this.frameSeq += 1)}.png`);
      fs.writeFileSync(file, png);
      this.bridge.stdin.write(`${file}\n`);
    } catch (error) {
      logger.debug("ocr", "capture_failed", { error: String(error) });
    } finally {
      this.capturing = false;
    }
  }

  /* --------------------------------- bridge -------------------------------- */

  private ensureBridge(): void {
    if (this.bridge) return;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.deps.scriptPath],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (error) {
      this.engineError = `bridge spawn failed: ${String(error)}`;
      return;
    }
    this.bridge = child;
    this.bridgeReady = false;
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (line) this.onBridgeLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      logger.debug("ocr", "bridge_stderr", { text: chunk.slice(0, 300) });
    });
    child.on("exit", (code) => {
      logger.warn("ocr", "bridge_exited", { code });
      this.bridge = null;
      this.bridgeReady = false;
      // Transient restart only while still engaged — the disable path never respawns.
      if (this.engaged) {
        const t = setTimeout(() => {
          if (this.engaged) this.ensureBridge();
        }, 3_000);
        t.unref?.();
      }
    });
  }

  private killBridge(): void {
    if (!this.bridge) return;
    try {
      this.bridge.kill();
    } catch {
      /* already gone */
    }
    this.bridge = null;
    this.bridgeReady = false;
  }

  private onBridgeLine(line: string): void {
    let msg: {
      hello?: boolean;
      error?: string;
      ok?: boolean;
      words?: unknown;
      imgW?: number;
      imgH?: number;
      at?: number;
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.hello === "boolean") {
      this.bridgeReady = msg.hello === true;
      this.engineError = msg.hello ? null : msg.error ?? "bridge failed";
      logger.info("ocr", "bridge_hello", { ok: msg.hello, error: msg.error ?? null });
      return;
    }
    if (msg.ok !== true || !Array.isArray(msg.words) || !msg.imgW || !msg.imgH) {
      if (msg.error) this.engineError = msg.error;
      return;
    }
    const now = Date.now();
    this.lastReadAt = now;
    const cls = classifyOcrFrame({
      words: msg.words as { t: string; x: number; y: number; w: number; h: number }[],
      imgW: msg.imgW,
      imgH: msg.imgH,
      at: now,
    });
    if (cls.score) this.score = cls.score;
    if (cls.hint !== null) {
      this.lastHint = cls.hint;
      this.lastHintAt = now;
      this.deps.projection.applyOcrReading({ hint: cls.hint, at: now });
    } else if (this.lastHint !== null && now - this.lastHintAt < HINT_REFRESH_MS) {
      // Transient gap (menu flash, OCR miss): refresh the last confident hint
      // so deriveScene's 30s freshness never expires mid-incident.
      this.deps.projection.applyOcrReading({ hint: this.lastHint, at: now });
    }
  }
}
