import {
  EValorantRoundPhase,
  type IFormattedValorantData,
  VALORANT_PRE_SHOPPING_ROUND_PHASE,
  ValorantDataTypes,
} from "./valorant-shared";
import { FormattingService } from "./valorant-api";
import type { HavocGameDataPacket } from "./relay-message";
import type { GameIdentity } from "./game-identity";

import { DESKTOP_GAME_REGISTRY } from "./desktop-game-registry";
import { logger } from "./val-logger";

const VALORANT_PROVIDER_GAME_ID = DESKTOP_GAME_REGISTRY.VAL.gameDataRuntime.providerGameId;
type OwValorantObservation = HavocGameDataPacket & { havoc_data_source: "OW" };

const ROUND_PHASE_SEQUENCE: Readonly<Record<string, number>> = {
  [VALORANT_PRE_SHOPPING_ROUND_PHASE]: 0,
  [EValorantRoundPhase.Shopping]: 1,
  [EValorantRoundPhase.Combat]: 2,
  [EValorantRoundPhase.End]: 3,
  [EValorantRoundPhase.GameEnd]: 4,
};

export class ValObservationProcessor {
  private static instance: ValObservationProcessor;
  public currRoundNumber: number = 0;
  /**
   * OW publishes round number and phase as separate updates without guaranteeing their order.
   * These fields retain the latest partial facts and the last pair sent downstream so a phase
   * that starts the next round can wait for its matching number.
   */
  private latestRoundPhase: string | null = null;
  private lastPublishedRoundNumber = 0;
  private lastPublishedRoundPhase: string | null = null;
  private roundPhaseWaitingForNumber = false;
  private formattingService: FormattingService = FormattingService.getInstance();

  private constructor() {}

  public static getInstance(): ValObservationProcessor {
    if (ValObservationProcessor.instance == null)
      ValObservationProcessor.instance = new ValObservationProcessor();
    return ValObservationProcessor.instance;
  }

  public reset(): void {
    this.currRoundNumber = 0;
    this.latestRoundPhase = null;
    this.lastPublishedRoundNumber = 0;
    this.lastPublishedRoundPhase = null;
    this.roundPhaseWaitingForNumber = false;
  }

  processGameUpdate(data: {
    game: GameIdentity;
    gameId: number;
    key: string;
    value: unknown;
  }): OwValorantObservation | undefined {
    if (data.game !== "VAL" || data.gameId !== VALORANT_PROVIDER_GAME_ID) return;

    let toSend: IFormattedValorantData;
    switch (data.key) {
      // Core emits these as raw OW game events; the manager owns their validation.
      case "kill_feed":
      case "planted_location":
        return {
          havoc_data_source: "OW",
          data: data.value,
          event: data.key,
        };

      case "match_end":
      case "match_start":
        return;

      case "spike_defused":
        logger.info("valorant", "spike_defused");
        toSend = { data: true, event: ValorantDataTypes.SPIKE_DEFUSED };
        return this.toObservation(toSend);

      case "spike_detonated":
        logger.info("valorant", "spike_detonated");
        toSend = { data: true, event: ValorantDataTypes.SPIKE_DETONATED };
        return this.toObservation(toSend);

      case "spike_planted":
        logger.info("valorant", "spike_planted");
        toSend = { data: true, event: ValorantDataTypes.SPIKE_PLANTED };
        return this.toObservation(toSend);

      // Custom Events
      default: {
        const event = Object.values(ValorantDataTypes).find((candidate) => candidate === data.key);
        if (!event) return;
        if (
          typeof data.value !== "boolean" &&
          typeof data.value !== "number" &&
          typeof data.value !== "string"
        ) {
          return;
        }
        toSend = { data: data.value, event };
        return this.toObservation(toSend);
      }
    }
  }

  processInfoUpdate(data: {
    game: GameIdentity;
    gameId: number;
    key: string;
    value: unknown;
  }): OwValorantObservation | undefined {
    if (data.game !== "VAL" || data.gameId !== VALORANT_PROVIDER_GAME_ID) return;

    if (data.key.includes("scoreboard")) {
      if (data.value === "open" || data.value === "closed") return;
      const value = this.parseRecord(data.value);
      if (!value || typeof value.name !== "string" || value.name === "") return;

      const formatted: IFormattedValorantData = this.formattingService.formatScoreboardData(value);

      return this.toObservation(formatted);
    }

    switch (data.key) {
      case "kill_feed": {
        const value = this.parseRecord(data.value);
        if (!value) return;
        return this.toObservation(this.formattingService.formatKillfeedData(value));
      }

      // API owns session mode/identity; historical team-order packets have no consumer.
      case "game_mode":
      case "map":
      case "match_id":
      case "pseudo_match_id":
      case "scene":
      case "ui_team_order_allies":
      case "ui_team_order_enemies":
        return;

      case "match_score": {
        // OW already reports the two stable starting-side teams used by Unified Game State.
        // Preserve that tuple as a primary score observation; reconciliation and round
        // settlement belong to the game manager, not this transport adapter.
        const score = this.parseRecord(data.value);
        if (!score || typeof score.team_0 !== "number" || typeof score.team_1 !== "number") {
          return;
        }

        return this.toObservation({
          data: { team_0: score.team_0, team_1: score.team_1 },
          event: ValorantDataTypes.SCORE,
        });
      }

      case "observing":
        if (typeof data.value !== "string") return;
        logger.info("valorant", "observing_detected");
        return this.toObservation({ data: data.value, event: ValorantDataTypes.OBSERVING });

      case "round_number":
        {
          const round = Number(data.value);
          if (!Number.isFinite(round)) return;
          this.currRoundNumber = round;

          // A phase-first transition is now complete. Publishing here fixes the stale round
          // number without ever pairing a number-first transition with the previous round's
          // cached End phase.
          if (
            this.roundPhaseWaitingForNumber &&
            this.latestRoundPhase !== null &&
            round > this.lastPublishedRoundNumber
          ) {
            return this.publishRoundInfo(this.latestRoundPhase);
          }
        }
        break;

      case "round_phase":
        if (typeof data.value !== "string") return;
        // An End phase observed before this process knows any round number belongs to a round
        // that is already in progress. Its number will not arrive until the next round, so
        // retaining it would incorrectly publish End during that round's buy phase.
        if (data.value === EValorantRoundPhase.End && this.currRoundNumber <= 0) {
          this.latestRoundPhase = null;
          this.roundPhaseWaitingForNumber = false;
          return;
        }
        this.latestRoundPhase = data.value;
        if (this.shouldWaitForRoundNumber(data.value)) {
          this.roundPhaseWaitingForNumber = true;
          return;
        }
        return this.publishRoundInfo(data.value);

      default:
        break;
    }
  }

  private toObservation(data: IFormattedValorantData): OwValorantObservation {
    return {
      ...data,
      havoc_data_source: "OW",
    };
  }

  private publishRoundInfo(phase: string): OwValorantObservation {
    this.lastPublishedRoundNumber = this.currRoundNumber;
    this.lastPublishedRoundPhase = phase;
    this.roundPhaseWaitingForNumber = false;
    return this.toObservation(this.formattingService.formatRoundData(phase, this.currRoundNumber));
  }

  private shouldWaitForRoundNumber(nextPhase: string): boolean {
    // At startup a phase can beat the first round number. Holding it avoids ever emitting Round 0.
    if (this.currRoundNumber <= 0) return true;
    if (this.lastPublishedRoundPhase === null) return false;

    // When round_number arrives first it advances beyond the last complete pair; the following
    // phase can be published immediately with that new number.
    if (this.currRoundNumber > this.lastPublishedRoundNumber) return false;

    const previousOrder = ROUND_PHASE_SEQUENCE[this.lastPublishedRoundPhase];
    const nextOrder = ROUND_PHASE_SEQUENCE[nextPhase];
    // A backwards phase transition (for example End -> Shopping) starts a new round. If OW sent
    // the phase first, keep it pending instead of attaching it to the completed round's number.
    return previousOrder !== undefined && nextOrder !== undefined && nextOrder < previousOrder;
  }

  private parseRecord(value: unknown): null | Record<string, unknown> {
    try {
      const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}
