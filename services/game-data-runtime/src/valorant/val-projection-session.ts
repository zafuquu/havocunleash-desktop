import { isDeepStrictEqual } from "node:util";

import {
  normalizeValorantMapKey,
  type ValorantScoreSnapshot,
  type ValorantSessionSnapshot,
  type ValorantTimeoutStarted,
} from "./game-identity";
import type {
  GameProjection,
  GameProjectionEvent,
  ValorantFacts,
} from "@havoc-platform/data-schemas/game-projection";
import type {
  IFormattedValorantKillfeed,
  IFormattedValorantPlayer,
  IFormattedValorantRosterPlayer,
  IFormattedValorantScore,
} from "./valorant-api";
import {
  EValorantRoundPhase,
  type TFullValorantGameStateData,
  ValorantDataTypes,
  resolveValorantGameMode,
} from "./valorant-shared";
import type { GameBindingContext } from "@havoc-platform/data-schemas/realtime/game-binding-context";
import type { GameProjectionAddress } from "@havoc-platform/data-schemas/realtime/game-address";
import type { GameSemanticObservation } from "@havoc-platform/data-schemas/realtime/game-semantic-observation";
import type { SeriesCompetitorId } from "@havoc-platform/data-schemas/live-series";

import { logger } from "./val-logger";
import type { ValorantTimerPauseEvidenceDto } from "@/shared/ipc/contracts/valorant-timer-pause.contract";

import {
  GameBindingResolver,
  type GameBindingResolution,
  type NativeBindingSide,
  type ResolvedGameBinding,
} from "../../base/game-binding-resolver";
import {
  resolveGameParticipants,
  type GameParticipantResolution,
} from "../../base/game-participant-resolution";
import type {
  GameProjectionOutputPort,
  GameProjectionSession,
} from "../../base/game-projection-session";
import { ValRoundClock, type ValProjectionTime, type ValScheduledTask } from "./val-round-clock";
import {
  type ValNativeCombatPlayer,
  type ValNativeRoundSettlement,
  ValRoundSettlement,
} from "./val-round-settlement";
import {
  type NormalizedValorantPacket,
  type ValObservation,
  ValObservationNormalizer,
} from "./val-observation-normalizer";
import { ValParticipantEquipmentProjection } from "./val-participant-equipment";
import { ValPlayerCombatAuthority } from "./val-player-combat-authority";
import { ValRoundHistory } from "./val-round-history";
import {
  projectValorantSessionRoster,
  resolveValorantStartingTeam,
} from "./val-session-roster-projection";
import { classifyValSkirmishScoreTransition } from "./val-skirmish-round-lifecycle";
import { planValorantStandardScore, valorantScoreTotal } from "./val-standard-score-policy";
import { valorantAttackerForRound } from "./val-side-ownership";

type ActiveSnapshot = Extract<ValorantSessionSnapshot, { phase: "ending" | "live" | "pregame" }>;
type ValorantProjectionEvent = Extract<GameProjectionEvent, { address: { game: "VAL" } }>["event"];
type ValorantResolvedProjectionBinding = ResolvedGameBinding & GameParticipantResolution;
type ValorantBindingResolution =
  | ValorantResolvedProjectionBinding
  | Extract<GameBindingResolution, { kind: "unavailable" }>;
type ValorantKillfeedPacket = Extract<
  NormalizedValorantPacket,
  { event: ValorantDataTypes.KILLFEED }
>;

interface ValorantProjectionSessionOptions {
  time?: ValProjectionTime;
}

const nativeTime: ValProjectionTime = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

const KILLFEED_CROSS_SOURCE_DEDUPE_MS = 150;

export interface ValAddressedPostgameCapture {
  address: GameProjectionAddress & { game: "VAL"; mapId: string };
  competitors: readonly [
    { competitorId: SeriesCompetitorId; nativeTeamId: string },
    { competitorId: SeriesCompetitorId; nativeTeamId: string },
  ];
  participantIdByNativePlayer: ReadonlyMap<string, string | null>;
}

/**
 * VALORANT projection retains Riot's startTeam as the stable native ownership key. Agent select,
 * live scoreboard, round lifecycle, and terminal facts all project through the same binding and
 * never import audience-presentation authority.
 */
export class ValorantProjectionSession implements GameProjectionSession<ValObservation> {
  public readonly game = "VAL" as const;

  private activeMapId: string | null = null;
  private activeObservedGameId: string | null = null;
  private activePhase: "ending" | "live" | "pregame" | null = null;
  private agentSelectGeneration = 0;
  private readonly binding = new GameBindingResolver();
  private bindingResolvedKey: string | null = null;
  private bindingUnavailableKey: string | null = null;
  private context: GameBindingContext | null = null;
  private currentRoundSpikeOutcome: "defused" | "detonated" | null = null;
  private currentGameplaySource: "OCR" | "OW" | null = null;
  private disposed = false;
  private eventSequence = 0;
  private gameData = initialGameData();
  private gameMode: ValorantFacts["gameMode"] = "standard";
  private isAgentSelectPhase = false;
  private isSpikeExploded = false;
  private isSpikePlanted = false;
  private lastSemantic: GameSemanticObservation | null = null;
  private matchEndDispatched = false;
  private matchStartDispatched = false;
  private readonly roundHistory = new ValRoundHistory();
  private readonly normalizer = new ValObservationNormalizer();
  private readonly participantEquipment = new ValParticipantEquipmentProjection();
  private readonly playerCombatAuthority = new ValPlayerCombatAuthority();
  private pendingAuthoritativeSpikePlant: { roundNumber: number; site?: string } | null = null;
  private pendingPacketEvents: ValorantProjectionEvent[] = [];
  private postgameCaptured = false;
  private presenceConfirmedRound = -1;
  private rawPlayers: Record<string, IFormattedValorantPlayer> = {};
  private readonly recentKillfeeds = new Map<
    string,
    { seenAt: number; source: ValorantKillfeedPacket["killfeedSource"] }
  >();
  private reliableSequence = 0;
  private roster: IFormattedValorantRosterPlayer[] = [];
  private readonly roundClock: ValRoundClock;
  private roundTimer: number | null = null;
  private readonly settlement: ValRoundSettlement;
  private sessionPhase: ValorantFacts["sessionPhase"] | null = null;
  private sessionSnapshot: ActiveSnapshot | null = null;
  private skirmishRoundEnd: ValScheduledTask | null = null;
  private skirmishScoreSeeded = false;
  private spikeDetonation: ValScheduledTask | null = null;
  private techPause: ValorantFacts["techPause"] = { status: "INACTIVE" };
  private readonly time: ValProjectionTime;
  private timeout: ValorantFacts["timeout"] = {
    competitorId: null,
    remainingSeconds: 0,
    side: null,
    status: "INACTIVE",
    totalDuration: 60,
  };
  private timeoutEnd: ValScheduledTask | null = null;
  private timeoutEndsAt: number | null = null;
  private timeoutTick: ValScheduledTask | null = null;

  public constructor(
    private readonly output: GameProjectionOutputPort,
    options: ValorantProjectionSessionOptions = {},
  ) {
    this.time = options.time ?? nativeTime;
    this.roundClock = new ValRoundClock(this.time, (roundTimer) => {
      this.roundTimer = roundTimer;
      this.projectCurrentTruth();
    });
    this.settlement = new ValRoundSettlement(this.time, (result) => this.handleSettlement(result));
  }

  public replaceContext(context: GameBindingContext): void {
    this.assertActive();
    if (context.game !== "VAL") throw new Error("VALORANT received a non-VAL binding context.");
    this.context = structuredClone(context);
    this.binding.replaceContext(context);
    this.lastSemantic = null;
    logger.info("valorant-projection", "binding_replaced", {
      attributionContextId: context.address.attributionContextId,
      bindingEpoch: context.bindingCursor.epoch,
      bindingRevision: context.bindingCursor.revision,
      seriesId: context.address.seriesId,
    });
    if (this.activeObservedGameId && this.sessionSnapshot) {
      this.projectCurrentTruth();
      logger.info("valorant-projection", "retained_state_reprojected", {
        attributionContextId: context.address.attributionContextId,
        observedGameId: this.activeObservedGameId,
      });
    }
  }

  public observe(observation: ValObservation): void {
    this.assertActive();
    if (this.sessionPhase !== "live") return;
    const prepared = this.normalizer.prepare(observation, this.normalizerState(), this.gameData);
    if (!prepared.accepted || prepared.packets.length === 0) return;
    this.pendingPacketEvents = [];
    for (const packet of prepared.packets) this.handlePacket(packet);
    this.projectCurrentTruth();
    const events = this.pendingPacketEvents;
    this.pendingPacketEvents = [];
    for (const event of events) this.emitEvent(event);
  }

  public replaceSession(snapshot: ValorantSessionSnapshot): ValAddressedPostgameCapture | null {
    this.assertActive();
    if (snapshot.phase === "unknown") return null;
    if (snapshot.phase === "idle") {
      // Leaving the game is presentation lifecycle, not match completion. Retain the occurrence
      // facts for reconnect/postgame correlation, but publish their non-live session presence so
      // every HUD exits without emitting a result or retiring the observed game.
      if (!this.sessionSnapshot || this.sessionPhase === "idle") return null;
      this.sessionPhase = "idle";
      this.pendingAuthoritativeSpikePlant = null;
      this.isAgentSelectPhase = false;
      this.roundClock.stop(false);
      this.cancelLiveDeadlines();
      this.pendingPacketEvents = [];
      this.projectCurrentTruth();
      return null;
    }

    const occurrenceAdmission = this.binding.beginOccurrence(snapshot.session.matchId);
    if (occurrenceAdmission === "retired") return null;
    const newMatch = occurrenceAdmission === "started";
    if (newMatch) this.beginNewOccurrence(snapshot.session.matchId);
    else if (this.activePhase === "ending") return null;
    this.activePhase = snapshot.phase;
    this.sessionPhase = snapshot.phase;
    this.sessionSnapshot = structuredClone(snapshot);
    this.activeMapId = normalizeValMapId(snapshot.session.map.key);
    this.gameMode = resolveValorantGameMode(snapshot.session.modeId);
    this.roster = projectValorantSessionRoster(snapshot, {
      skirmish: this.gameMode === "skirmish",
    });
    this.playerCombatAuthority.replaceRoster(this.combatPlayers());
    this.isAgentSelectPhase = snapshot.phase === "pregame";
    if (snapshot.phase === "live" && this.gameMode === "skirmish" && newMatch) {
      this.gameData.currentRound = {
        roundNumber: this.gameData.score.team_0 + this.gameData.score.team_1 + 1,
        roundPhase: EValorantRoundPhase.Combat,
      };
      this.roundTimer = null;
    }
    if (snapshot.phase === "ending") {
      this.pendingAuthoritativeSpikePlant = null;
      this.isAgentSelectPhase = false;
      this.roundTimer = 0;
      this.roundClock.stop(false);
      this.cancelLiveDeadlines();
      this.gameData.currentRound = {
        ...this.gameData.currentRound,
        roundPhase: EValorantRoundPhase.GameEnd,
      };
    }
    this.projectCurrentTruth();
    if (snapshot.phase === "live" && !this.matchStartDispatched) {
      this.matchStartDispatched = true;
      this.emitEvent({ data: null, type: "matchStart" });
    }
    if (snapshot.phase !== "ending") return null;
    if (!this.matchEndDispatched) {
      this.matchEndDispatched = true;
      this.emitEvent(this.matchEndEvent());
    }
    if (this.postgameCaptured) return null;
    const capture = this.capturePostgame();
    if (capture) this.postgameCaptured = true;
    return capture;
  }

  public correctScoreFromPresence(score: ValorantScoreSnapshot): void {
    if (
      this.sessionPhase !== "live" ||
      !this.activeObservedGameId ||
      score.matchId.toLowerCase() !== this.activeObservedGameId.toLowerCase() ||
      this.gameMode === "skirmish"
    ) {
      return;
    }
    const next = { team_0: score.red, team_1: score.blue };
    this.presenceConfirmedRound = Math.max(this.presenceConfirmedRound, valorantScoreTotal(next));
    const scoreChanged = this.applyScore(next, "presence");
    const roundEstablished = this.establishRoundFromPresenceScore(next);
    if (scoreChanged || roundEstablished) this.projectCurrentTruth();
  }

  /** Returns retained terminal native facts re-addressed through the current binding. */
  public currentPostgameCapture(): ValAddressedPostgameCapture | null {
    if (this.activePhase !== "ending") return null;
    return this.capturePostgame();
  }

  public startTimeout(timeout: ValorantTimeoutStarted): void {
    if (
      this.sessionPhase !== "live" ||
      !this.activeObservedGameId ||
      timeout.matchId.toLowerCase() !== this.activeObservedGameId.toLowerCase()
    ) {
      return;
    }
    const startedAt = Date.parse(timeout.observedAt);
    const elapsedMs = this.time.now() - startedAt;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= 60_000) return;
    if (this.timeout.status === "ACTIVE") return;
    this.cancelTimeoutDeadlines();
    const endedTechPause = this.techPause.status === "ACTIVE";
    if (endedTechPause) {
      this.techPause = { status: "INACTIVE" };
    } else {
      const paused = this.roundClock.pause();
      if (paused !== null) this.roundTimer = paused;
    }
    const remainingSeconds = Math.ceil((60_000 - elapsedMs) / 1_000);
    this.timeout = {
      competitorId: null,
      remainingSeconds,
      side: "unattributed",
      status: "ACTIVE",
      totalDuration: 60,
    };
    this.timeoutEndsAt = startedAt + 60_000;
    this.projectCurrentTruth();
    if (endedTechPause) this.emitEvent({ data: null, type: "tech_pause_end" });
    // Buff supplies no team identity, so attribution stays explicit rather than being guessed.
    this.emitEvent({
      data: {
        competitorId: null,
        remainingSeconds,
        side: "unattributed",
        totalDuration: 60,
      },
      type: "timeout_start",
    });
    this.scheduleTimeoutTick();
  }

  public observeTimerPause(evidence: ValorantTimerPauseEvidenceDto): void {
    if (
      this.sessionPhase !== "live" ||
      !this.activeObservedGameId ||
      evidence.matchId.toLowerCase() !== this.activeObservedGameId.toLowerCase()
    ) {
      return;
    }
    if (this.gameData.currentRound.roundPhase !== EValorantRoundPhase.Shopping) return;
    const nextStatus = evidence.status === "frozen" ? "ACTIVE" : "INACTIVE";
    if (this.techPause.status === nextStatus) return;
    if (nextStatus === "ACTIVE" && this.timeout.status === "ACTIVE") return;
    this.techPause = { status: nextStatus };
    if (nextStatus === "ACTIVE") {
      if (evidence.status !== "frozen") return;
      const elapsedMs = Math.max(0, this.time.now() - evidence.frozenSince);
      const paused = this.roundClock.pause(Math.ceil(elapsedMs / 1_000));
      if (paused !== null) this.roundTimer = paused;
    } else {
      const resumed = this.roundClock.resume();
      if (resumed !== null) this.roundTimer = resumed;
    }
    this.projectCurrentTruth();
    this.emitEvent({
      data: null,
      type: nextStatus === "ACTIVE" ? "tech_pause_start" : "tech_pause_end",
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelLiveDeadlines();
    this.recentKillfeeds.clear();
    this.roundClock.dispose();
    this.playerCombatAuthority.reset();
    this.settlement.reset();
  }

  private handlePacket(packet: NormalizedValorantPacket): void {
    if (
      this.gameMode === "skirmish" &&
      packet.event !== ValorantDataTypes.PLAYER_SCOREBOARD &&
      packet.event !== ValorantDataTypes.SCORE
    ) {
      return;
    }
    if (
      (packet.event === ValorantDataTypes.PLAYER_SCOREBOARD ||
        packet.event === ValorantDataTypes.ROUND_INFO ||
        packet.event === ValorantDataTypes.SCORE) &&
      (packet.havoc_data_source === "OCR" || packet.havoc_data_source === "OW")
    ) {
      this.currentGameplaySource = packet.havoc_data_source;
    }
    switch (packet.event) {
      case "planted_location": {
        this.triggerSpikePlant(packet.data, true);
        break;
      }
      case ValorantDataTypes.PLAYER_SCOREBOARD: {
        const previousRaw = this.rawPlayers[packet.data.playerId];
        const previous = previousRaw ? this.combatPlayer(previousRaw) : undefined;
        this.rawPlayers = { ...this.rawPlayers, [packet.data.playerId]: packet.data };
        const next = this.combatPlayer(packet.data);
        this.gameData.players = this.rawPlayers;
        this.participantEquipment.observe(
          packet.data,
          this.gameData.currentRound.roundNumber,
          this.gameData.currentRound.roundPhase === EValorantRoundPhase.Shopping,
        );
        if (
          packet.havoc_data_source === "OW" &&
          this.gameMode !== "skirmish" &&
          previousRaw &&
          this.sideForStartTeam(next.startTeam) === "attack" &&
          packet.data.money - previousRaw.money === 300
        ) {
          this.triggerSpikePlant();
        }
        this.settlement.observeScoreboardDelta(
          this.gameData.currentRound.roundNumber,
          previous,
          next,
        );
        const recovered =
          packet.havoc_data_source === "OW" &&
          this.playerCombatAuthority.observeScoreboard(
            next,
            packet.havoc_data_source,
            this.gameData.currentRound.roundNumber,
            this.gameData.currentRound.roundPhase,
          );
        if (recovered) {
          logger.info("valorant-projection", "player_scoreboard_authority_recovered", {
            roundNumber: this.gameData.currentRound.roundNumber,
          });
        }
        break;
      }
      case ValorantDataTypes.OBSERVING:
        this.gameData.currentlyObserving = packet.data;
        break;
      case ValorantDataTypes.KILLFEED:
        if (this.isDuplicateKillfeed(packet)) break;
        this.settlement.observeKillfeed(this.gameData.currentRound.roundNumber, packet.data);
        if (this.currentGameplaySource !== "OCR") {
          this.playerCombatAuthority.observeKillfeed(packet.data);
        }
        this.queueKillfeed(packet.data);
        break;
      case ValorantDataTypes.ROUND_INFO: {
        const priorPhase = this.gameData.currentRound.roundPhase;
        const priorRoundNumber = this.gameData.currentRound.roundNumber;
        if (packet.data.roundPhase === EValorantRoundPhase.GameEnd) break;
        this.gameData.currentRound = packet.data;
        if (priorRoundNumber !== packet.data.roundNumber) {
          this.currentRoundSpikeOutcome = null;
          this.pendingAuthoritativeSpikePlant = null;
          this.normalizer.clearRoundVitals();
          const priorPlayers = Object.values(this.rawPlayers);
          const survivingPlayerIds = new Set(
            priorPlayers
              .filter(
                (player) =>
                  (this.currentGameplaySource === "OW"
                    ? this.playerCombatAuthority.project(player.playerId)?.isAlive
                    : undefined) ?? player.isAlive,
              )
              .map((player) => player.playerId),
          );
          this.participantEquipment.beginRound(
            packet.data.roundNumber,
            priorPlayers,
            survivingPlayerIds,
          );
          this.rawPlayers = Object.fromEntries(
            Object.entries(this.rawPlayers).map(([playerId, player]) => [
              playerId,
              { ...player, isAlive: true },
            ]),
          );
          this.playerCombatAuthority.beginRound(packet.data.roundNumber);
          this.settlement.beginRound(packet.data.roundNumber, this.combatPlayers());
          this.queueEvent({ data: null, type: "roundStart" });
        }
        const newlyFallback = this.playerCombatAuthority.observeRoundPhase(
          packet.data.roundNumber,
          packet.data.roundPhase,
          this.currentGameplaySource ?? undefined,
        );
        if (newlyFallback > 0) {
          logger.info("valorant-projection", "shopping_scoreboard_fallback_activated", {
            playerCount: newlyFallback,
            roundNumber: packet.data.roundNumber,
          });
        }
        if (priorPhase !== packet.data.roundPhase) this.handleRoundPhase(packet.data);
        if (packet.ocrRoundHistory) this.settlement.observeOcrHistory(packet.ocrRoundHistory);
        if (packet.ocrDerivedIsSpikePlanted === true) this.triggerSpikePlant();
        else if (packet.ocrDerivedIsSpikePlanted === false) this.clearSpikeState();
        this.consumePendingAuthoritativeSpikePlant();
        this.isAgentSelectPhase = false;
        break;
      }
      case ValorantDataTypes.SCORE:
        this.applyScore(packet.data, "primary");
        break;
      case ValorantDataTypes.SPIKE_DEFUSED:
        if (this.currentRoundSpikeOutcome === "defused") break;
        this.currentRoundSpikeOutcome = "defused";
        this.settlement.observeSpikeOutcome("defused");
        this.stopSpikeDetonation();
        this.isSpikePlanted = false;
        this.queueEvent({
          data: { timeleft: typeof packet.data === "number" ? packet.data : 0 },
          type: "spikeDefused",
        });
        break;
      case ValorantDataTypes.SPIKE_DETONATED:
        if (this.currentRoundSpikeOutcome === "detonated") break;
        this.currentRoundSpikeOutcome = "detonated";
        this.settlement.observeSpikeOutcome("detonated");
        this.isSpikeExploded = true;
        this.queueEvent({ data: null, type: "spikeDetonated" });
        break;
      case ValorantDataTypes.SPIKE_PLANTED:
        this.triggerSpikePlant(undefined, true);
        break;
    }
  }

  private applyScore(next: IFormattedValorantScore, role: "presence" | "primary"): boolean {
    if (this.gameMode === "skirmish") return this.applySkirmishScore(next);
    const previous = this.gameData.score;
    const plan = planValorantStandardScore({
      currentRoundNumber:
        this.gameData.currentRound.roundNumber > 0 ? this.gameData.currentRound.roundNumber : null,
      next,
      presenceConfirmedRound: this.presenceConfirmedRound,
      previous,
      role,
    });
    if (!plan.apply) return false;
    this.gameData.score = { ...next };
    this.roundHistory.acceptScore(next);
    const roundNumber = valorantScoreTotal(next);
    if (plan.decision === "corrected") {
      const winnerStartTeam: 0 | 1 = next.team_0 > previous.team_0 ? 0 : 1;
      if (!this.settlement.correctPendingWinner(roundNumber, winnerStartTeam)) {
        this.roundHistory.correctObservedWinner(roundNumber, winnerStartTeam);
      }
    }
    if (plan.settle) {
      this.settlement.score(roundNumber, previous, next, this.combatPlayers());
    }
    return true;
  }

  private establishRoundFromPresenceScore(score: IFormattedValorantScore): boolean {
    if (this.gameData.currentRound.roundNumber > 0) return false;
    // Presence proves how many rounds have completed, but not the current buy/combat subphase.
    // Use combat as the live fallback until the primary gameplay source supplies exact phase.
    this.gameData.currentRound = {
      roundNumber: valorantScoreTotal(score) + 1,
      roundPhase: EValorantRoundPhase.Combat,
    };
    return true;
  }

  private applySkirmishScore(next: IFormattedValorantScore): boolean {
    if (!this.skirmishScoreSeeded) {
      this.skirmishScoreSeeded = true;
      this.gameData.score = { ...next };
      this.gameData.currentRound = {
        roundNumber: valorantScoreTotal(next) + 1,
        roundPhase: EValorantRoundPhase.Combat,
      };
      return true;
    }
    const transition = classifyValSkirmishScoreTransition({
      observed: next,
      phase: this.gameData.currentRound.roundPhase === EValorantRoundPhase.End ? "end" : "combat",
      previous: this.gameData.score,
    });
    if (transition.kind === "ignore") return false;
    this.gameData.score = { ...transition.score };
    if (transition.kind === "resync") {
      this.gameData.currentRound = {
        roundNumber:
          valorantScoreTotal(transition.score) +
          (this.gameData.currentRound.roundPhase === EValorantRoundPhase.End ? 0 : 1),
        roundPhase:
          this.gameData.currentRound.roundPhase === EValorantRoundPhase.End
            ? EValorantRoundPhase.End
            : EValorantRoundPhase.Combat,
      };
      return true;
    }
    this.gameData.currentRound = {
      roundNumber: transition.roundNumber,
      roundPhase: EValorantRoundPhase.End,
    };
    this.roundTimer = this.roundClock.start(5, EValorantRoundPhase.End);
    const resolved = this.currentBinding();
    if (resolved?.kind === "resolved") {
      const winnerStartTeam = transition.winner === "team_0" ? 0 : 1;
      this.queueEvent({
        data: {
          highlightPlayerId: null,
          losingCompetitorId: this.competitorForStartTeam(resolved, winnerStartTeam === 0 ? 1 : 0),
          roundNumber: transition.roundNumber,
          winningCompetitorId: this.competitorForStartTeam(resolved, winnerStartTeam),
          winningSide: winnerStartTeam === 0 ? "attack" : "defense",
          winType: "Normal",
          winTypeLabel: "Normal",
        },
        type: "roundWin",
      });
    }
    this.skirmishRoundEnd?.cancel();
    this.skirmishRoundEnd = this.time.schedule(() => this.beginNextSkirmishRound(), 5_000);
    return true;
  }

  private beginNextSkirmishRound(): void {
    this.skirmishRoundEnd = null;
    if (
      this.gameMode !== "skirmish" ||
      this.sessionPhase !== "live" ||
      this.gameData.currentRound.roundPhase !== EValorantRoundPhase.End
    ) {
      return;
    }
    this.roundClock.stop(false);
    this.normalizer.clearRoundVitals();
    this.rawPlayers = Object.fromEntries(
      Object.entries(this.rawPlayers).map(([playerId, player]) => [
        playerId,
        { ...player, isAlive: true },
      ]),
    );
    this.gameData.currentRound = {
      roundNumber: valorantScoreTotal(this.gameData.score) + 1,
      roundPhase: EValorantRoundPhase.Combat,
    };
    this.roundTimer = null;
    this.projectCurrentTruth();
    this.emitEvent({ data: null, type: "roundStart" });
  }

  private queueKillfeed(kill: IFormattedValorantKillfeed): void {
    const attackerId = this.resolvePlayerLabel(kill.attacker);
    const victimId = this.resolvePlayerLabel(kill.victim);
    if (!attackerId || !victimId) return;
    this.queueEvent({
      data: {
        assists: kill.assists.flatMap((assist) => this.resolvePlayerLabel(assist) ?? []),
        attackerId,
        headshotKill: kill.headshotKill,
        isTeamkill: kill.isTeamkill,
        victimId,
        weaponName: kill.weaponName,
      },
      type: "killfeed",
    });
  }

  private handleRoundPhase(round: TFullValorantGameStateData["currentRound"]): void {
    switch (round.roundPhase) {
      case EValorantRoundPhase.Shopping:
        this.currentRoundSpikeOutcome = null;
        this.clearSpikeState();
        this.roundTimer = this.roundClock.start(
          round.roundNumber === 1 || round.roundNumber === 13 || round.roundNumber >= 25 ? 45 : 30,
          round.roundPhase,
        );
        break;
      case EValorantRoundPhase.Combat:
        if (!this.isSpikePlanted) this.roundTimer = this.roundClock.start(100, round.roundPhase);
        break;
      case EValorantRoundPhase.End:
        this.pendingAuthoritativeSpikePlant = null;
        this.roundTimer = this.roundClock.start(7, round.roundPhase);
        break;
      default:
        this.pendingAuthoritativeSpikePlant = null;
        this.roundTimer = this.roundClock.stop();
    }
    if (round.roundPhase !== EValorantRoundPhase.Shopping && this.techPause.status === "ACTIVE") {
      this.techPause = { status: "INACTIVE" };
      this.queueEvent({ data: null, type: "tech_pause_end" });
    }
  }

  private triggerSpikePlant(site?: string, authoritative = false): void {
    this.settlement.observePlant(site);
    if (this.isSpikePlanted) return;
    if (this.gameData.currentRound.roundPhase !== EValorantRoundPhase.Combat) {
      if (authoritative && this.gameData.currentRound.roundNumber > 0) {
        this.pendingAuthoritativeSpikePlant = {
          roundNumber: this.gameData.currentRound.roundNumber,
          ...(site === undefined ? {} : { site }),
        };
      }
      return;
    }
    this.pendingAuthoritativeSpikePlant = null;
    this.activateSpikePlant();
  }

  private consumePendingAuthoritativeSpikePlant(): void {
    const pending = this.pendingAuthoritativeSpikePlant;
    if (
      !pending ||
      pending.roundNumber !== this.gameData.currentRound.roundNumber ||
      this.gameData.currentRound.roundPhase !== EValorantRoundPhase.Combat
    ) {
      return;
    }
    this.pendingAuthoritativeSpikePlant = null;
    this.activateSpikePlant();
  }

  private activateSpikePlant(): void {
    if (this.isSpikePlanted) return;
    this.isSpikePlanted = true;
    this.isSpikeExploded = false;
    this.roundTimer = this.roundClock.start(45, EValorantRoundPhase.Combat);
    this.stopSpikeDetonation();
    this.spikeDetonation = this.time.schedule(() => {
      this.spikeDetonation = null;
      if (
        !this.isSpikePlanted ||
        this.sessionPhase !== "live" ||
        this.currentRoundSpikeOutcome !== null
      ) {
        return;
      }
      this.currentRoundSpikeOutcome = "detonated";
      this.isSpikeExploded = true;
      this.settlement.observeSpikeOutcome("detonated");
      this.projectCurrentTruth();
      this.emitEvent({ data: null, type: "spikeDetonated" });
    }, 44_500);
    this.queueEvent({ data: null, type: "spikePlanted" });
  }

  private clearSpikeState(): void {
    this.stopSpikeDetonation();
    this.isSpikeExploded = false;
    this.isSpikePlanted = false;
  }

  private stopSpikeDetonation(): void {
    this.spikeDetonation?.cancel();
    this.spikeDetonation = null;
  }

  private handleSettlement(result: ValNativeRoundSettlement): void {
    if (this.sessionPhase !== "live") return;
    this.roundHistory.recordObserved(result);
    this.pendingAuthoritativeSpikePlant = null;
    this.clearSpikeState();
    const resolved = this.currentBinding();
    this.projectCurrentTruth();
    if (!resolved || resolved.kind === "unavailable") return;
    const winningCompetitorId = this.competitorForStartTeam(resolved, result.winnerStartTeam);
    this.emitEvent({
      data: {
        highlightPlayerId: result.highlightOccurrencePlayerId,
        losingCompetitorId: this.competitorForStartTeam(
          resolved,
          result.winnerStartTeam === 0 ? 1 : 0,
        ),
        roundNumber: result.roundNumber,
        winningCompetitorId,
        winningSide: result.winningSide,
        winType: result.winType,
        winTypeLabel: result.winTypeLabel,
      },
      type: "roundWin",
    });
  }

  private projectCurrentTruth(): void {
    const context = this.context;
    const observedGameId = this.activeObservedGameId;
    if (!context || !observedGameId) return;
    const resolution = this.currentBinding();
    if (!resolution) return;
    const address = this.address();
    if (resolution.kind === "unavailable") {
      this.observeUnavailableSemantic(address, resolution);
      return;
    }
    const resolved = resolution;
    const facts = this.projectFacts(resolved);
    const snapshot: GameProjection = {
      address,
      competitorIds: [context.competitors[0].competitorId, context.competitors[1].competitorId],
      facts,
      kind: "game-snapshot",
      sequence: ++this.reliableSequence,
    };
    this.output.publish([snapshot]);
    this.observeSemantic(address, facts);
  }

  private projectFacts(resolved: ValorantResolvedProjectionBinding): ValorantFacts {
    const sessionSnapshot = this.sessionSnapshot;
    if (!sessionSnapshot) throw new Error("VALORANT facts require an accepted API session.");
    const participantId = (playerId: string) =>
      resolved.participantIdByOccurrence.get(playerId) ?? null;
    const playerSources = this.playerSources();
    const participantsByOccurrenceId: ValorantFacts["participantsByOccurrenceId"] = {};
    for (const source of playerSources) {
      const raw = source.raw;
      const roster = source.roster;
      const occurrencePlayerId = roster?.playerId ?? raw!.playerId;
      const nativeTeam = roster?.startTeam ?? raw!.startTeam;
      const observerSlot = roster?.observerSlot ?? raw?.observerSlot;
      const observerSlotOrder = roster?.observerSlotOrder ?? raw?.observerSlotOrder;
      const combat =
        this.currentGameplaySource === "OW"
          ? this.playerCombatAuthority.project(occurrencePlayerId)
          : null;
      const usesFallback = combat?.source === "killfeed";
      const equipment = this.participantEquipment.project(occurrencePlayerId, raw);
      const projectedHealth = this.normalizer.projectedVitals(
        this.gameData.currentRound.roundNumber,
        occurrencePlayerId,
      )?.health;
      participantsByOccurrenceId[occurrencePlayerId] = {
        agentName: roster?.agentName ?? raw?.agentName ?? "",
        assists: combat?.assists ?? raw?.assists ?? 0,
        competitorId: this.competitorForStartTeam(resolved, nativeTeam),
        currUltPoints: usesFallback ? 0 : (raw?.currUltPoints ?? 0),
        deaths: combat?.deaths ?? raw?.deaths ?? 0,
        hasSpike: usesFallback ? false : (raw?.hasSpike ?? false),
        ...(usesFallback
          ? { health: combat?.isAlive === false ? 0 : 100 }
          : projectedHealth === undefined
            ? {}
            : { health: projectedHealth }),
        isAlive: combat?.isAlive ?? raw?.isAlive ?? true,
        kills: combat?.kills ?? raw?.kills ?? 0,
        loadoutValue: usesFallback ? 0 : equipment.loadoutValue,
        maxUltPoints: raw?.maxUltPoints ?? 0,
        money: usesFallback ? 0 : (raw?.money ?? 0),
        moneyAtRoundStart: usesFallback ? 0 : equipment.moneyAtRoundStart,
        nativeTeam,
        observedLabel: roster ? `${roster.name}#${roster.tagline}` : raw!.name,
        ...(observerSlot === undefined ? {} : { observerSlot }),
        ...(observerSlotOrder === undefined ? {} : { observerSlotOrder }),
        occurrencePlayerId,
        participantId: participantId(occurrencePlayerId),
        previousMoney: usesFallback ? 0 : equipment.previousMoney,
        ...(usesFallback
          ? { shieldType: 0 }
          : equipment.shieldType === undefined
            ? {}
            : { shieldType: equipment.shieldType }),
        tagline: roster?.tagline ?? raw?.tagline ?? "",
        spentMoney: usesFallback ? 0 : equipment.spentMoney,
        weaponName: usesFallback ? "" : (raw?.weaponName ?? ""),
      };
    }
    const competitor = (nativeTeam: 0 | 1) => ({
      competitorId: this.competitorForStartTeam(resolved, nativeTeam),
      nativeSide: this.sideForStartTeam(nativeTeam),
      nativeTeam,
      occurrencePlayerIds: Object.values(participantsByOccurrenceId)
        .filter((player) => player.nativeTeam === nativeTeam)
        .map((player) => player.occurrencePlayerId),
      rawScore: nativeTeam === 0 ? this.gameData.score.team_0 : this.gameData.score.team_1,
    });
    return {
      agentSelectGeneration: this.agentSelectGeneration,
      competitors: [competitor(0), competitor(1)],
      currentPlayerId: this.resolvePlayerLabel(this.gameData.currentlyObserving) ?? null,
      currentRound:
        this.gameData.currentRound.roundNumber > 0 ? { ...this.gameData.currentRound } : null,
      gameMode: this.gameMode,
      isAgentSelectPhase: this.isAgentSelectPhase,
      isSpikeExploded: this.isSpikeExploded,
      isSpikePlanted: this.isSpikePlanted,
      mapId: normalizeValorantMapKey(this.activeMapId),
      mapReady:
        (sessionSnapshot.phase === "live" || sessionSnapshot.phase === "ending") &&
        sessionSnapshot.mapReady,
      participantsByOccurrenceId,
      rosterParticipants: this.roster.map((roster) => ({
        agentName: roster.agentName,
        locked: roster.locked,
        nativeTeam: roster.startTeam,
        observedLabel: `${roster.name}#${roster.tagline}`,
        ...(roster.observerSlot === undefined ? {} : { observerSlot: roster.observerSlot }),
        ...(roster.observerSlotOrder === undefined
          ? {}
          : { observerSlotOrder: roster.observerSlotOrder }),
        occurrencePlayerId: roster.playerId,
        participantId: participantId(roster.playerId),
        position: roster.position,
        rank: roster.rank,
      })),
      roundHistory: Object.fromEntries(
        [...this.roundHistory.entries()].map(([roundNumber, history]) => {
          if (history.provenance === "score-inferred") {
            return [
              String(roundNumber),
              {
                provenance: history.provenance,
                winningCompetitorId: this.competitorForStartTeam(resolved, history.winnerStartTeam),
                winningReason: history.winningReason,
                winningSide: history.winningSide,
              },
            ];
          }
          return [
            String(roundNumber),
            {
              ...(history.plantSite ? { plantSite: history.plantSite } : {}),
              provenance: history.provenance,
              winningCompetitorId: this.competitorForStartTeam(resolved, history.winnerStartTeam),
              winningReason: history.winningReason,
              winningSide: history.winningSide,
            },
          ];
        }),
      ),
      roundTimer: this.roundTimer,
      sessionPhase: this.sessionPhase ?? sessionSnapshot.phase,
      techPause: this.techPause,
      timeout: this.timeout,
    };
  }

  private observeSemantic(address: GameProjectionAddress, facts: ValorantFacts): void {
    const phase =
      this.activePhase === "live" || this.activePhase === "pregame" ? "active" : "ended";
    const observation: GameSemanticObservation = {
      address,
      kind: "game-semantic-observation",
      phase,
      teamBinding: {
        competitorOrder: [facts.competitors[1].competitorId, facts.competitors[0].competitorId],
        observedScoreByCompetitor: Object.fromEntries(
          facts.competitors.map((competitor) => [competitor.competitorId, competitor.rawScore]),
        ),
        status: "resolved",
      },
    };
    if (isDeepStrictEqual(observation, this.lastSemantic)) return;
    this.lastSemantic = structuredClone(observation);
    this.output.observeSemantic(observation);
  }

  private observeUnavailableSemantic(
    address: GameProjectionAddress,
    resolution: Extract<GameBindingResolution, { kind: "unavailable" }>,
  ): void {
    const observation: GameSemanticObservation = {
      address,
      kind: "game-semantic-observation",
      phase: this.activePhase === "live" || this.activePhase === "pregame" ? "active" : "ended",
      teamBinding: { reason: resolution.reason, status: "unavailable" },
    };
    if (isDeepStrictEqual(observation, this.lastSemantic)) return;
    this.lastSemantic = structuredClone(observation);
    this.output.observeSemantic(observation);
  }

  private currentBinding(): ValorantBindingResolution | null {
    const context = this.context;
    const sides = this.nativeSides();
    if (!context || !sides) return null;
    const resolved = this.binding.resolve(sides);
    if (resolved.kind === "unavailable") this.reportBindingUnavailable(resolved);
    else {
      this.reportBindingResolved(resolved);
      this.bindingUnavailableKey = null;
      // Team binding is already authoritative here. Participant matching is a separate optional
      // decoration capability composed only for facts and postgame participant references.
      return {
        ...resolved,
        ...resolveGameParticipants(context, sides, resolved.competitorIdBySide),
      };
    }
    return resolved;
  }

  private reportBindingUnavailable(
    resolved: Extract<GameBindingResolution, { kind: "unavailable" }>,
  ): void {
    const context = this.context;
    const observedGameId = this.activeObservedGameId;
    if (!context || !observedGameId) return;
    const key = `${context.address.attributionContextId}:${observedGameId}:${resolved.reason}`;
    if (this.bindingUnavailableKey === key) return;
    this.bindingUnavailableKey = key;
    logger.debug("valorant-projection", "binding_unavailable", {
      attributionContextId: context.address.attributionContextId,
      bindingEpoch: context.bindingCursor.epoch,
      bindingRevision: context.bindingCursor.revision,
      observedGameId,
      reason: resolved.reason,
      seriesId: context.address.seriesId,
    });
  }

  private reportBindingResolved(resolved: ResolvedGameBinding): void {
    const context = this.context;
    const observedGameId = this.activeObservedGameId;
    if (!context || !observedGameId) return;
    const key = `${context.address.attributionContextId}:${observedGameId}:${resolved.basis}`;
    if (this.bindingResolvedKey === key) return;
    this.bindingResolvedKey = key;
    logger.debug("valorant-projection", "binding_resolved", {
      attributionContextId: context.address.attributionContextId,
      basis: resolved.basis,
      bindingEpoch: context.bindingCursor.epoch,
      bindingRevision: context.bindingCursor.revision,
      observedGameId,
      seriesId: context.address.seriesId,
    });
  }

  private nativeSides(): readonly [NativeBindingSide, NativeBindingSide] | null {
    const snapshot = this.sessionSnapshot;
    if (!snapshot) return null;
    const teamIds = new Map<0 | 1, string[]>();
    for (const [teamIndex, team] of snapshot.session.teams.entries()) {
      const startTeam = resolveValorantStartingTeam({
        skirmish: this.gameMode === "skirmish",
        startingSide: team.startingSide,
        teamId: team.teamId,
        teamIndex,
      });
      teamIds.set(startTeam, [...(teamIds.get(startTeam) ?? []), team.teamId]);
    }
    const side = (startTeam: 0 | 1): NativeBindingSide => ({
      key: String(startTeam),
      nativeTeamIds: [...(teamIds.get(startTeam) ?? []), `startTeam:${startTeam}`],
      participants: this.playerSources()
        .filter((source) => (source.roster?.startTeam ?? source.raw?.startTeam) === startTeam)
        .map((source) => {
          const occurrencePlayerId = source.roster?.playerId ?? source.raw!.playerId;
          return {
            nativeIds: [
              occurrencePlayerId,
              source.roster ? `${source.roster.name}#${source.roster.tagline}` : source.raw!.name,
              source.roster?.name ?? source.raw!.name,
            ],
            nativeNames: source.roster
              ? [`${source.roster.name}#${source.roster.tagline}`, source.roster.name]
              : [source.raw!.name],
            occurrencePlayerId,
          };
        }),
    });
    // VAL's authored left competitor has historically been Riot startTeam 1. Keep that product
    // policy explicit at the fallback boundary; round-side changes never alter startTeam identity.
    return [side(1), side(0)];
  }

  private competitorForStartTeam(
    resolved: ResolvedGameBinding,
    startTeam: 0 | 1,
  ): SeriesCompetitorId {
    const competitorId = resolved.competitorIdBySide.get(String(startTeam));
    if (!competitorId) throw new Error("VALORANT binding is not a complete bijection.");
    return competitorId;
  }

  private sideForStartTeam(startTeam: 0 | 1): "attack" | "defense" {
    const round = Math.max(1, this.gameData.currentRound.roundNumber);
    return valorantAttackerForRound(round) === `team_${startTeam}` ? "attack" : "defense";
  }

  private playerSources(): readonly {
    raw?: IFormattedValorantPlayer;
    roster?: IFormattedValorantRosterPlayer;
  }[] {
    const remaining = new Map(
      Object.values(this.rawPlayers).map((player) => [player.playerId, player]),
    );
    const roster = this.roster.map((entry) => {
      const raw = remaining.get(entry.playerId);
      remaining.delete(entry.playerId);
      return { raw, roster: entry };
    });
    return [...roster, ...[...remaining.values()].map((raw) => ({ raw }))];
  }

  /**
   * Settlement is deliberately fed occurrence-local identity and Riot start-team ownership.
   * Roster facts win over a transient scoreboard packet so an incomplete observing-client board
   * can still be advanced by killfeed evidence without inventing canonical participant identity.
   */
  private combatPlayer(raw: IFormattedValorantPlayer): ValNativeCombatPlayer {
    const roster = this.roster.find((player) => player.playerId === raw.playerId);
    const occurrencePlayerId = roster?.playerId ?? raw.playerId;
    return {
      agentName: roster?.agentName ?? raw.agentName,
      assists: raw.assists,
      deaths: raw.deaths,
      isAlive: raw.isAlive,
      kills: raw.kills,
      ...(raw.loadoutValue === undefined ? {} : { loadoutValue: raw.loadoutValue }),
      observedLabels: this.combatLabels({ raw, roster }, occurrencePlayerId),
      occurrencePlayerId,
      startTeam: roster?.startTeam ?? raw.startTeam,
    };
  }

  private combatPlayers(): readonly ValNativeCombatPlayer[] {
    return this.playerSources().map(({ raw, roster }) => {
      if (raw) return this.combatPlayer(raw);
      const occurrencePlayerId = roster!.playerId;
      return {
        agentName: roster!.agentName,
        assists: 0,
        deaths: 0,
        isAlive: true,
        kills: 0,
        observedLabels: this.combatLabels({ roster }, occurrencePlayerId),
        occurrencePlayerId,
        startTeam: roster!.startTeam,
      };
    });
  }

  private combatLabels(
    source: { raw?: IFormattedValorantPlayer; roster?: IFormattedValorantRosterPlayer },
    occurrencePlayerId: string,
  ): readonly string[] {
    const labels = new Set<string>([occurrencePlayerId]);
    if (source.raw) {
      labels.add(source.raw.name);
      labels.add(`${source.raw.name}#${source.raw.tagline}`);
      labels.add(source.raw.agentName);
    }
    if (source.roster) {
      labels.add(source.roster.name);
      labels.add(`${source.roster.name}#${source.roster.tagline}`);
      labels.add(source.roster.agentName);
    }
    return [...labels].filter(Boolean);
  }

  private normalizerState() {
    return {
      allPlayers: this.playerSources().flatMap(({ raw, roster }) => {
        const source = raw;
        const id = roster?.playerId ?? source?.playerId;
        if (!id) return [];
        const observerSlot = roster?.observerSlot ?? source?.observerSlot;
        const observerSlotOrder = roster?.observerSlotOrder ?? source?.observerSlotOrder;
        return [
          {
            assists: source?.assists ?? 0,
            currUltPoints: source?.currUltPoints ?? 0,
            deaths: source?.deaths ?? 0,
            hasSpike: source?.hasSpike ?? false,
            id,
            isAlive: source?.isAlive ?? true,
            kills: source?.kills ?? 0,
            ...(source?.loadoutValue === undefined ? {} : { loadoutValue: source.loadoutValue }),
            maxUltPoints: source?.maxUltPoints ?? 0,
            money: source?.money ?? 0,
            name: roster?.name ?? source?.name ?? id,
            ...(observerSlot === undefined ? {} : { observerSlot }),
            ...(observerSlotOrder === undefined ? {} : { observerSlotOrder }),
            rawName: roster?.name ?? source?.name ?? id,
            ...(source?.shieldType === undefined ? {} : { shieldType: source.shieldType }),
            weaponName: source?.weaponName ?? "",
          },
        ];
      }),
    };
  }

  private scheduleTimeoutTick(): void {
    this.timeoutTick?.cancel();
    const remainingMs = (this.timeoutEndsAt ?? this.time.now()) - this.time.now();
    if (remainingMs <= 0) {
      this.beginTimeoutExit();
      return;
    }
    this.timeoutTick = this.time.schedule(
      () => {
        this.timeoutTick = null;
        if (this.timeout.status !== "ACTIVE") return;
        const nextRemainingMs = (this.timeoutEndsAt ?? this.time.now()) - this.time.now();
        if (nextRemainingMs <= 0) {
          this.timeout = { ...this.timeout, remainingSeconds: 0 };
          this.beginTimeoutExit();
          return;
        }
        this.timeout = {
          ...this.timeout,
          remainingSeconds: Math.ceil(nextRemainingMs / 1_000),
        };
        this.projectCurrentTruth();
        this.scheduleTimeoutTick();
      },
      Math.min(1_000, remainingMs),
    );
  }

  private beginTimeoutExit(): void {
    if (this.timeout.status !== "ACTIVE") return;
    this.timeoutTick?.cancel();
    this.timeoutTick = null;
    this.timeoutEndsAt = null;
    const resumed = this.roundClock.resume();
    if (resumed !== null) this.roundTimer = resumed;
    this.timeout = { ...this.timeout, remainingSeconds: 0, status: "EXITING" };
    this.projectCurrentTruth();
    this.timeoutEnd = this.time.schedule(() => {
      this.timeoutEnd = null;
      this.timeout = {
        competitorId: null,
        remainingSeconds: 0,
        side: null,
        status: "INACTIVE",
        totalDuration: 60,
      };
      this.projectCurrentTruth();
      this.emitEvent({ data: null, type: "timeout_end" });
    }, 1_000);
  }

  private cancelTimeoutDeadlines(): void {
    this.timeoutEnd?.cancel();
    this.timeoutEnd = null;
    this.timeoutTick?.cancel();
    this.timeoutTick = null;
    this.timeoutEndsAt = null;
  }

  private cancelLiveDeadlines(): void {
    this.cancelTimeoutDeadlines();
    this.skirmishRoundEnd?.cancel();
    this.skirmishRoundEnd = null;
    this.stopSpikeDetonation();
  }

  private queueEvent(event: ValorantProjectionEvent): void {
    this.pendingPacketEvents.push(event);
  }

  private matchEndEvent(): ValorantProjectionEvent {
    const resolved = this.currentBinding();
    if (!resolved || resolved.kind === "unavailable") return { data: null, type: "matchEnd" };
    const score = this.gameData.score;
    const first = this.competitorForStartTeam(resolved, 0);
    const second = this.competitorForStartTeam(resolved, 1);
    return {
      data: {
        finalRawScoreByCompetitor: { [first]: score.team_0, [second]: score.team_1 },
        resultKind: score.team_0 === score.team_1 ? "draw" : "proper_win",
        terminalReason: "match_end",
      },
      type: "matchEnd",
    };
  }

  private emitEvent(event: ValorantProjectionEvent): void {
    if (!this.context || !this.activeObservedGameId) return;
    this.output.publish([
      { address: this.address(), event, kind: "game-event", sequence: ++this.eventSequence },
    ]);
  }

  private address(): GameProjectionAddress & { game: "VAL" } {
    if (!this.context || !this.activeObservedGameId) {
      throw new Error("VALORANT projection address is unavailable.");
    }
    return {
      ...this.context.address,
      game: "VAL",
      mapId: this.activeMapId,
      observedGameId: this.activeObservedGameId,
    };
  }

  private capturePostgame(): ValAddressedPostgameCapture | null {
    const address = this.address();
    const resolved = this.currentBinding();
    const snapshot = this.sessionSnapshot;
    if (!address.mapId || !resolved || resolved.kind === "unavailable" || !snapshot) return null;
    const nativeTeamIdByCompetitor = new Map<SeriesCompetitorId, string>();
    for (const [teamIndex, team] of snapshot.session.teams.entries()) {
      const startTeam = resolveValorantStartingTeam({
        skirmish: this.gameMode === "skirmish",
        startingSide: team.startingSide,
        teamId: team.teamId,
        teamIndex,
      });
      nativeTeamIdByCompetitor.set(this.competitorForStartTeam(resolved, startTeam), team.teamId);
    }
    const firstCompetitorId = this.context?.competitors[0].competitorId;
    const secondCompetitorId = this.context?.competitors[1].competitorId;
    const firstNativeTeamId = firstCompetitorId
      ? nativeTeamIdByCompetitor.get(firstCompetitorId)
      : undefined;
    const secondNativeTeamId = secondCompetitorId
      ? nativeTeamIdByCompetitor.get(secondCompetitorId)
      : undefined;
    if (!firstCompetitorId || !secondCompetitorId || !firstNativeTeamId || !secondNativeTeamId) {
      return null;
    }
    return {
      address: { ...address, mapId: address.mapId },
      competitors: [
        { competitorId: firstCompetitorId, nativeTeamId: firstNativeTeamId },
        { competitorId: secondCompetitorId, nativeTeamId: secondNativeTeamId },
      ],
      participantIdByNativePlayer: new Map(
        this.playerSources().map(({ raw, roster }) => {
          const id = roster?.playerId ?? raw!.playerId;
          return [id, resolved.participantIdByOccurrence.get(id) ?? null];
        }),
      ),
    };
  }

  private resolvePlayerLabel(label: string): string | undefined {
    const normalized = label.replace(/\s+#/g, "#").trim().toLowerCase();
    const source = this.playerSources().find(({ raw, roster }) => {
      const id = roster?.playerId ?? raw?.playerId;
      const full = roster
        ? `${roster.name}#${roster.tagline}`
        : raw
          ? `${raw.name}#${raw.tagline}`
          : "";
      return id?.toLowerCase() === normalized || full.toLowerCase() === normalized;
    });
    return source?.roster?.playerId ?? source?.raw?.playerId;
  }

  private isDuplicateKillfeed(packet: ValorantKillfeedPacket): boolean {
    const now = this.time.now();
    for (const [fingerprint, previous] of this.recentKillfeeds) {
      if (now - previous.seenAt > KILLFEED_CROSS_SOURCE_DEDUPE_MS) {
        this.recentKillfeeds.delete(fingerprint);
      }
    }

    const fingerprint = killfeedFingerprint(packet.data);
    const previous = this.recentKillfeeds.get(fingerprint);
    if (
      previous &&
      previous.source !== packet.killfeedSource &&
      now - previous.seenAt <= KILLFEED_CROSS_SOURCE_DEDUPE_MS
    ) {
      return true;
    }

    this.recentKillfeeds.set(fingerprint, { seenAt: now, source: packet.killfeedSource });
    return false;
  }

  private beginNewOccurrence(observedGameId: string): void {
    // The binding lock belongs to this Riot match ID. Room attribution remains stable while a new
    // match gets one fresh opportunity to establish native start-team ownership.
    this.cancelLiveDeadlines();
    this.roundClock.stop(false);
    this.settlement.reset();
    this.playerCombatAuthority.reset();
    this.activeObservedGameId = observedGameId;
    this.bindingUnavailableKey = null;
    this.activeMapId = null;
    this.agentSelectGeneration += 1;
    this.gameData = initialGameData();
    this.currentRoundSpikeOutcome = null;
    this.currentGameplaySource = null;
    this.isSpikeExploded = false;
    this.isSpikePlanted = false;
    this.lastSemantic = null;
    this.matchEndDispatched = false;
    this.matchStartDispatched = false;
    this.roundHistory.reset();
    this.normalizer.reset();
    this.participantEquipment.reset();
    this.pendingPacketEvents = [];
    this.pendingAuthoritativeSpikePlant = null;
    this.postgameCaptured = false;
    this.presenceConfirmedRound = -1;
    this.rawPlayers = {};
    this.recentKillfeeds.clear();
    this.roster = [];
    this.roundTimer = null;
    this.skirmishScoreSeeded = false;
    this.techPause = { status: "INACTIVE" };
    this.timeout = {
      competitorId: null,
      remainingSeconds: 0,
      side: null,
      status: "INACTIVE",
      totalDuration: 60,
    };
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("VALORANT projection session has been disposed.");
  }
}

function killfeedFingerprint(kill: IFormattedValorantKillfeed): string {
  return JSON.stringify({
    assists: kill.assists.map((assist) => assist.trim().toLowerCase()),
    attacker: kill.attacker.trim().toLowerCase(),
    headshotKill: kill.headshotKill,
    ultName: kill.ultName?.trim().toLowerCase(),
    victim: kill.victim.trim().toLowerCase(),
    weaponName: kill.weaponName.trim().toLowerCase(),
  });
}

function initialGameData(): TFullValorantGameStateData {
  return {
    currentRound: { roundNumber: 0, roundPhase: EValorantRoundPhase.End },
    currentlyObserving: "",
    map: "",
    players: {},
    score: { team_0: 0, team_1: 0 },
  };
}

function normalizeValMapId(value: unknown): string | null {
  const known = normalizeValorantMapKey(value);
  if (known) return known;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return `val_${trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
}
