import type { IFormattedValorantRoundInfo } from "./valorant-api";
import { EValorantRoundPhase } from "./valorant-shared";

export interface ValScheduledTask {
  cancel(): void;
}

export interface ValProjectionTime {
  now(): number;
  schedule(callback: () => void, delayMs: number): ValScheduledTask;
}

type RoundPhase = IFormattedValorantRoundInfo["roundPhase"];

/**
 * Retains VALORANT's native round-clock capability without becoming a lifecycle authority. The
 * session decides phase transitions; this class owns exactly one natural game-clock deadline and
 * reports display changes for WebRTC snapshot projection only.
 */
export class ValRoundClock {
  private displaySeconds = 0;
  private endAt: number | null = null;
  private pausedSeconds: number | null = null;
  private phase: RoundPhase = null;
  private tick: ValScheduledTask | null = null;

  public constructor(
    private readonly time: ValProjectionTime,
    private readonly displayChanged: (seconds: number) => void,
  ) {}

  public start(durationSeconds: number, phase: RoundPhase): number {
    this.cancelTick();
    this.pausedSeconds = null;
    this.phase = phase;
    this.endAt = this.time.now() + durationSeconds * 1_000;
    this.displaySeconds = durationSeconds;
    this.scheduleTick();
    return this.displaySeconds;
  }

  public pause(snapbackSeconds = 0): number | null {
    if (this.endAt == null && this.pausedSeconds == null) return null;
    const remaining =
      this.endAt == null ? (this.pausedSeconds ?? 0) : (this.endAt - this.time.now()) / 1_000;
    this.pausedSeconds = Math.max(0, remaining + snapbackSeconds);
    this.cancelTick();
    this.endAt = null;
    this.displaySeconds = Math.ceil(this.pausedSeconds);
    return this.displaySeconds;
  }

  public resume(): number | null {
    if (this.pausedSeconds == null) return null;
    const remaining = this.pausedSeconds;
    this.pausedSeconds = null;
    return this.start(remaining, this.phase);
  }

  public stop(resetValue = true): number | null {
    this.cancelTick();
    this.endAt = null;
    this.pausedSeconds = null;
    if (!resetValue) return null;
    this.displaySeconds = 0;
    return this.displaySeconds;
  }

  public dispose(): void {
    this.stop(false);
  }

  private scheduleTick(): void {
    this.cancelTick();
    if (this.endAt == null) return;
    this.tick = this.time.schedule(() => {
      this.tick = null;
      if (this.endAt == null) return;
      const remaining = (this.endAt - this.time.now()) / 1_000;
      const value = projectValRoundTimerDisplay(this.phase, remaining);
      if (value !== this.displaySeconds) {
        this.displaySeconds = value;
        this.displayChanged(value);
      }
      if (remaining <= 0) this.stop(false);
      else this.scheduleTick();
    }, 100);
  }

  private cancelTick(): void {
    this.tick?.cancel();
    this.tick = null;
  }
}

export function projectValRoundTimerDisplay(phase: RoundPhase, remainingSeconds: number): number {
  return phase === EValorantRoundPhase.Combat && remainingSeconds <= 15 && remainingSeconds > 0
    ? remainingSeconds
    : Math.max(0, Math.ceil(remainingSeconds));
}
