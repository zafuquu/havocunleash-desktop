/**
 * OCR backup rules (v11 A) — PURE: no Electron / child-process imports, so
 * unit tests exercise exactly the logic production runs.
 *
 * v1 rule set (conservative by design — the overlay must never GUESS):
 *   LOCK IN visible            → agent-select (high confidence)
 *   VICTORY / DEFEAT visible   → post-game   (high confidence)
 *   top-band round timer       → in-match; ≥0:46 can only be live combat
 *                                 (VALORANT's buy phase tops out at 0:40 +
 *                                 0:10 barrier lock) → ingame-hud; ≤0:45 is
 *                                 ambiguous (late combat OR buy) → "hold"
 *   nothing confident          → null (controller keeps the last hint fresh
 *                                 briefly, then clears back to GEP logic)
 *
 * "hold" means: keep whatever scene is committed — the anti-flicker posture
 * that fixes the 2026-10-20 patch-day buy-round ↔ ingame-hud oscillation.
 * Raw score numerals are extracted but NEVER attributed (left/right screen
 * sides cannot be safely mapped to the viewer's team without GEP identity).
 */
import type { HudScene } from "./projection";

export interface OcrWord {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrFrame {
  words: OcrWord[];
  imgW: number;
  imgH: number;
  at: number;
}

export type OcrHint = HudScene | "hold";

export interface OcrClassification {
  /** Conservative scene hint; null = nothing confident on screen. */
  hint: OcrHint | null;
  /** A running round timer is visible in the top band → match is live. */
  inMatch: boolean;
  /** Raw top-bar numerals flanking the timer — diagnostics only. */
  score: { left: number; right: number } | null;
}

/** Only words fully inside this band of the image height count as top HUD. */
const TOP_BAND = 0.14;
const TIMER_RE = /^(\d{1,2}):(\d{2})$/;
const NUM_RE = /^\d{1,2}$/;
/** Buy phase ceiling (0:40 + 0:10 lock) + margin — at or above this, combat. */
const COMBAT_FLOOR_SECS = 46;

export function classifyOcrFrame(frame: OcrFrame): OcrClassification {
  const upper = frame.words.map((w) => w.t).join(" ").toUpperCase();
  if (/\bLOCK\s*IN\b/.test(upper)) return { hint: "agent-select", inMatch: false, score: null };
  if (/\bVICTORY\b/.test(upper) || /\bDEFEAT\b/.test(upper)) {
    return { hint: "post-game", inMatch: false, score: null };
  }

  const topY = frame.imgH * TOP_BAND;
  let timerWord: OcrWord | null = null;
  let secs = -1;
  for (const w of frame.words) {
    const m = TIMER_RE.exec(w.t.trim());
    if (m && w.y + w.h <= topY) {
      timerWord = w;
      secs = Number(m[1]) * 60 + Number(m[2]);
    }
  }
  if (!timerWord || secs < 0 || secs > 10 * 60) return { hint: null, inMatch: false, score: null };

  // Closest numeric word left/right of the timer inside the top band.
  let left: number | null = null;
  let right: number | null = null;
  let leftBest = Number.POSITIVE_INFINITY;
  let rightBest = Number.POSITIVE_INFINITY;
  for (const w of frame.words) {
    if (w === timerWord || w.y + w.h > topY) continue;
    const t = w.t.trim();
    if (!NUM_RE.test(t)) continue;
    const n = Number(t);
    if (n > 30) continue;
    const mid = w.x + w.w / 2;
    if (mid < timerWord.x) {
      const d = timerWord.x - (w.x + w.w);
      if (d >= 0 && d < leftBest) {
        leftBest = d;
        left = n;
      }
    } else if (mid > timerWord.x + timerWord.w) {
      const d = w.x - (timerWord.x + timerWord.w);
      if (d >= 0 && d < rightBest) {
        rightBest = d;
        right = n;
      }
    }
  }

  return {
    hint: secs >= COMBAT_FLOOR_SECS ? "ingame-hud" : "hold",
    inMatch: true,
    score: left !== null && right !== null ? { left, right } : null,
  };
}

/* ------------------------------ failover (A4) ------------------------------ */

/** Telemetry states that mean "GEP is not delivering" (mirror of the shell chip). */
export const OCR_BAD_STATES: ReadonlySet<string> = new Set([
  "STALE",
  "CONNECTED_BUT_NO_TELEMETRY",
  "ERROR",
]);
/** Stay off this long after telemetry goes bad before taking over. */
export const OCR_ENGAGE_AFTER_MS = 30_000;
/** After telemetry recovers, keep backing up this long before handing back. */
export const OCR_RELEASE_AFTER_MS = 60_000;

export interface OcrEngagementContext {
  enabled: boolean;
  telemetryState: string | null;
  /** When the telemetry state last CHANGED (provider_telemetry_state fact time). */
  telemetryChangedAt: number;
  sessionPhase: string | null;
  now: number;
}

/**
 * Pure engage/disengage machine (A4): engage30s after telemetry goes bad
 * while a session exists; release 60s after it recovers (never fight a live
 * GEP stream); disabled or session idle releases immediately.
 */
export function nextOcrEngagement(prev: boolean, c: OcrEngagementContext): boolean {
  if (!c.enabled) return false;
  if (!c.sessionPhase || c.sessionPhase === "idle") return false;
  const bad = c.telemetryState !== null && OCR_BAD_STATES.has(c.telemetryState);
  const sinceChange = c.now - c.telemetryChangedAt;
  if (!bad) return prev && sinceChange < OCR_RELEASE_AFTER_MS;
  return prev || sinceChange >= OCR_ENGAGE_AFTER_MS;
}
