/**
 * Bridge game-event derivation — the site's OWN event pipeline (KillBanner
 * banners + the EVENT_TEXT / Game Event sequence). Extracted from `index.ts` so
 * the lifecycle invariant below is testable without a live producer.
 *
 * THE INVARIANT: one completed round produces exactly ONE `roundWin` event.
 *
 * The previous implementation keyed the round-win marker on the round CURRENTLY
 * in progress and re-armed it whenever that number changed:
 *
 *   round 15 settles  -> marker "15:blue"          -> roundWin emitted (stage 1..3)
 *   round 16 shopping -> roundStart(16) -> marker re-armed to null
 *   round 16 buy      -> roundEnd (round 15's result) is STILL on the board
 *                        (deliberately: the buy brief renders it)
 *                     -> key "16:blue" != null     -> roundWin EMITTED AGAIN
 *
 * so the site replayed the whole Game Event from stage 1 for a round that had
 * already been shown. The identity now comes from the COMPLETED round — the
 * newest settled entry in the published round history — which cannot change
 * while that round's result is on screen. A late terminal correction may still
 * rewrite the reason of the completed round; it can never produce a second event.
 */
import type { HudRelayState } from "@havoc-unleash/contracts";

/**
 * How long a settled round waits for the engine's `round_settled` ceremony
 * label before the neutral "Round Win" text fires. Live timing 2026-10-18:
 * score → round_settled gap was 379-501 ms across rounds 1, 2 and 24 — 1200 ms
 * leaves headroom without visibly delaying the Game Event.
 */
export const ROUND_WIN_LABEL_GRACE_MS = 1200;

export interface BridgeEventState {
  matchWinner: "blue" | "red" | null;
  matchStarted: boolean;
  /** Round currently in progress (drives `roundStart`). */
  roundNumber: number;
  /** Highest kill-feed sequence already published. */
  killSeq: number;
  /**
   * Identity of the completed round whose `roundWin` was already emitted:
   * `<settled round>:<winner>`. Stable for the whole time that result is on the
   * board, and never re-armed by the next round starting.
   */
  roundWin: string | null;
  /**
   * A settled round waiting for the engine's `round_settled` classification
   * before its `roundWin` fires: `{key, since}`. The runtime settles
   * ~0.4-0.5 s AFTER the score that ends the round (live 2026-10-18: score
   * 04:04:33.834 / round_settled 04:04:34.213), so emitting the neutral
   * "Round Win" on the score made every ceremony (Thrifty/Ace/Clutch/Flawless)
   * lose the race — the reported "events always show round win".
   */
  roundWinPending: { key: string; since: number } | null;
  /** Last spike state published (drives one spike event per outcome). */
  spike: "planted" | "defused" | "detonated" | null;
}

export function initialBridgeEventState(): BridgeEventState {
  return {
    matchWinner: null,
    matchStarted: false,
    roundNumber: 0,
    killSeq: 0,
    roundWin: null,
    roundWinPending: null,
    spike: null,
  };
}

export interface BridgeEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Derive the bridge events implied by the current projection state.
 * Pure: the caller keeps the returned `next` state and passes it back.
 */
export function deriveBridgeEvents(
  proj: HudRelayState,
  prev: BridgeEventState,
  now: number = Date.now(),
): { events: BridgeEvent[]; next: BridgeEventState } {
  const next: BridgeEventState = { ...prev };
  const events: BridgeEvent[] = [];
  const ev = (type: string, data: Record<string, unknown> = {}): void => {
    events.push({ type, data });
  };

  const roundNumber = proj.round?.number ?? 0;
  const killfeed = proj.killfeed ?? [];
  const spikeNow = proj.spike ?? null;
  const matchWinner = proj.match?.winner ?? null;
  const roundEnd = proj.roundEnd ?? null;

  if (!matchWinner && next.matchWinner) {
    // New match: re-arm the whole event stream (the projection has wiped the
    // previous match's round history, so the round-win identity is meaningless).
    next.matchWinner = null;
    next.matchStarted = false;
    next.roundNumber = 0;
    next.killSeq = 0;
    next.roundWin = null;
    next.roundWinPending = null;
  }
  if (proj.sessionPhase === "live" && next.matchStarted !== true) {
    next.matchStarted = true;
    ev("matchStart", { roundNumber });
  }
  if (roundNumber > 0 && roundNumber !== next.roundNumber) {
    ev("roundStart", { roundNumber });
    next.roundNumber = roundNumber;
    // The round-win marker is deliberately NOT re-armed here: see this module's
    // header — re-arming it replayed the completed round's Game Event.
  }
  for (const k of killfeed) {
    if (k.seq > next.killSeq) {
      next.killSeq = k.seq;
      ev("killfeed", {
        attacker: k.attacker,
        victim: k.victim,
        weapon: k.weapon,
        isTeamkill: false,
      });
    }
  }
  if (spikeNow === "defused" && next.spike !== "defused") {
    next.spike = "defused";
    ev("spikeDefused", {});
  } else if (spikeNow === "detonated" && next.spike !== "detonated") {
    next.spike = "detonated";
    ev("spikeDetonated", {});
  } else if (spikeNow !== "planted") {
    next.spike = null;
  }

  // ONE roundWin per completed round, identified by the completed round itself.
  const settled = (proj.roundHistory ?? []).at(-1) ?? null;
  if (settled !== null && roundEnd?.winner) {
    const settledKey = `${settled.round}:${settled.winner}`;
    if (settledKey !== next.roundWin) {
      // PASS 7C: the ceremony label is only usable when it belongs to THIS
      // settled round (`gameEventRound`). A label from another round would put
      // the wrong ceremony text on this winner — the reported "my team won but
      // FLAWLESS/ACE appeared on the enemy side".
      const ownedLabel =
        proj.gameEventRound != null && proj.gameEventRound === settled.round ? proj.gameEvent : null;
      if (ownedLabel != null && ownedLabel !== "") {
        next.roundWin = settledKey;
        next.roundWinPending = null;
        ev("roundWin", {
          roundNumber: settled.round,
          winType: String(ownedLabel).toLowerCase(),
          winningCompetitorId: settled.winner,
        });
      } else if (next.roundWinPending?.key !== settledKey) {
        // Arm the grace: wait for the engine's round_settled classification
        // (~0.4-0.5 s after the score, see BridgeEventState.roundWinPending)
        // before falling back to the neutral ceremony text.
        next.roundWinPending = { key: settledKey, since: now };
      } else if (now - next.roundWinPending.since >= ROUND_WIN_LABEL_GRACE_MS) {
        next.roundWin = settledKey;
        next.roundWinPending = null;
        ev("roundWin", {
          roundNumber: settled.round,
          winType: "round win",
          winningCompetitorId: settled.winner,
        });
      }
    }
  }

  if (matchWinner && next.matchWinner !== matchWinner) {
    next.matchWinner = matchWinner;
    ev("matchEnd", { winner: matchWinner });
  }
  return { events, next };
}
