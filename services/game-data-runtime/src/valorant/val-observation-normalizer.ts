import {
  type IFormattedValorantKillfeed,
  type IFormattedValorantPlayer,
  type IFormattedValorantRoundInfo,
  type IFormattedValorantScore,
  FormattingService,
} from "./valorant-api";
import {
  normalizeValorantAgentKey,
  type ValorantAgentKey,
} from "./game-identity";
import {
  type IFormattedValorantOCRPlayersScoreline,
  type IFormattedValorantOCRRoundHistory,
  type IFormattedValorantOCRRoundHistoryItem,
  type IFormattedValorantOCRRoundInfoScoreboard,
  type IFormattedValorantOCRRoundPhase,
  type IFormattedValorantOCRScore,
  type IFormattedValorantOCRScoreboardPlayer,
} from "./valorant-ocr";
import {
  type TFullValorantGameStateData,
  ValorantDataTypes,
} from "./valorant-shared";
import { getValorantAgentMaxUltPoints } from "./valorant-agent-ult-points";
import type { ValorantWeaponInternal } from "./valorant-weapons";
import type { HavocDataSource } from "./relay-message";

export type ValObservation = {
  havoc_data_source?: HavocDataSource;
  data: unknown;
  event: string;
};

type CandidateValorantPacket = {
  havoc_data_source?: HavocDataSource;
  data: unknown;
  event: string;
  killfeedSource?: "declared" | "raw_kill_feed_alias";
  ocrDerivedIsSpikePlanted?: boolean;
  ocrRoundHistory?: IFormattedValorantOCRRoundHistory;
};

type ValorantPacket<TEvent extends string, TData, TMetadata extends object = object> = {
  havoc_data_source?: HavocDataSource;
  data: TData;
  event: TEvent;
} & TMetadata;

export type NormalizedValorantPacket =
  | ValorantPacket<"planted_location", string>
  | ValorantPacket<
      ValorantDataTypes.KILLFEED,
      IFormattedValorantKillfeed,
      { killfeedSource: "declared" | "raw_kill_feed_alias" }
    >
  | ValorantPacket<ValorantDataTypes.OBSERVING, string>
  | ValorantPacket<ValorantDataTypes.PLAYER_SCOREBOARD, IFormattedValorantPlayer>
  | ValorantPacket<
      ValorantDataTypes.ROUND_INFO,
      IFormattedValorantRoundInfo,
      {
        ocrDerivedIsSpikePlanted?: boolean;
        ocrRoundHistory?: IFormattedValorantOCRRoundHistory;
      }
    >
  | ValorantPacket<ValorantDataTypes.SCORE, IFormattedValorantScore>
  | ValorantPacket<ValorantDataTypes.SPIKE_DEFUSED, number | true | null>
  | ValorantPacket<ValorantDataTypes.SPIKE_DETONATED, true | null>
  | ValorantPacket<ValorantDataTypes.SPIKE_PLANTED, true>;

export type PreparedValObservation =
  | {
      accepted: false;
      packets: readonly [];
    }
  | {
      accepted: true;
      packets: readonly NormalizedValorantPacket[];
    };

type OcrVitals = { health: number };

export interface ValorantNormalizerPlayerState {
  allPlayers: readonly {
    assists: number;
    currUltPoints: number;
    deaths: number;
    hasSpike: boolean;
    id: string;
    isAlive: boolean;
    kills: number;
    loadoutValue?: number;
    maxUltPoints: number;
    money: number;
    name: string;
    observerSlot?: number;
    observerSlotOrder?: number;
    rawName: string;
    shieldType?: 0 | 1 | 2 | 3 | 4;
    weaponName: string;
  }[];
}

const formattingService = FormattingService.getInstance();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  isFiniteNumber(value) && Number.isInteger(value) && value >= 0;

const isOptional = <T>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
): boolean => value === undefined || predicate(value);

const isStartTeam = (value: unknown): value is 0 | 1 => value === 0 || value === 1;

const isRoundPhase = (value: unknown): value is IFormattedValorantRoundInfo["roundPhase"] =>
  value === null ||
  value === "game_start" ||
  value === "shopping" ||
  value === "combat" ||
  value === "end" ||
  value === "game_end";

const isObserverSlot = (
  value: unknown,
): value is NonNullable<IFormattedValorantPlayer["observerSlot"]> =>
  isNonNegativeInteger(value) && value <= 9;

const isObserverSlotOrder = (
  value: unknown,
): value is NonNullable<IFormattedValorantPlayer["observerSlotOrder"]> =>
  isNonNegativeInteger(value) && value >= 1 && value <= 10;

const isShieldType = (value: unknown): boolean => isNonNegativeInteger(value) && value <= 4;

function isValorantPlayer(data: unknown): data is IFormattedValorantPlayer {
  return (
    isRecord(data) &&
    typeof data.agentName === "string" &&
    isFiniteNumber(data.assists) &&
    isFiniteNumber(data.currUltPoints) &&
    isFiniteNumber(data.deaths) &&
    typeof data.hasSpike === "boolean" &&
    typeof data.isAlive === "boolean" &&
    isFiniteNumber(data.kills) &&
    isFiniteNumber(data.maxUltPoints) &&
    isFiniteNumber(data.money) &&
    typeof data.name === "string" &&
    typeof data.playerId === "string" &&
    isStartTeam(data.startTeam) &&
    typeof data.tagline === "string" &&
    typeof data.weaponName === "string" &&
    isOptional(data.isLocalPlayer, (value): value is boolean => typeof value === "boolean") &&
    isOptional(data.isTeammate, (value): value is boolean => typeof value === "boolean") &&
    isOptional(data.loadoutValue, isFiniteNumber) &&
    isOptional(data.observerSlot, (value): value is number => isObserverSlot(value)) &&
    isOptional(data.observerSlotOrder, (value): value is number => isObserverSlotOrder(value)) &&
    isOptional(data.shieldType, (value): value is number => isShieldType(value))
  );
}

function isValorantRoundInfo(data: unknown): data is IFormattedValorantRoundInfo {
  return isRecord(data) && isNonNegativeInteger(data.roundNumber) && isRoundPhase(data.roundPhase);
}

function isValorantScore(data: unknown): data is IFormattedValorantScore {
  return isRecord(data) && isNonNegativeInteger(data.team_0) && isNonNegativeInteger(data.team_1);
}

function isOcrScoreboardPlayer(data: unknown): data is IFormattedValorantOCRScoreboardPlayer {
  return (
    isRecord(data) &&
    typeof data.agentName === "string" &&
    typeof data.playerId === "string" &&
    isStartTeam(data.startTeam) &&
    typeof data.tagline === "string" &&
    isOptional(data.assists, isFiniteNumber) &&
    isOptional(
      data.currUltPoints,
      (value): value is number | "READY" => value === "READY" || isFiniteNumber(value),
    ) &&
    isOptional(data.deaths, isFiniteNumber) &&
    isOptional(data.hasSpike, (value): value is boolean => typeof value === "boolean") &&
    isOptional(data.isAlive, (value): value is boolean => typeof value === "boolean") &&
    isOptional(data.kills, isFiniteNumber) &&
    isOptional(data.loadoutValue, isFiniteNumber) &&
    isOptional(data.money, isFiniteNumber) &&
    isOptional(data.name, (value): value is string => typeof value === "string") &&
    isOptional(data.observerSlot, (value): value is number => isObserverSlot(value)) &&
    isOptional(data.observerSlotOrder, (value): value is number => isObserverSlotOrder(value)) &&
    isOptional(data.shieldType, (value): value is number => isShieldType(value)) &&
    isOptional(data.weaponName, (value): value is string => typeof value === "string")
  );
}

function isOcrHealths(data: unknown): data is IFormattedValorantOCRPlayersScoreline {
  if (!isRecord(data)) return false;
  for (const team of ["0", "1"] as const) {
    const entries = data[team];
    if (entries === undefined) continue;
    if (!isRecord(entries)) return false;
    for (const [playerId, entry] of Object.entries(entries)) {
      if (
        playerId.trim() === "" ||
        !isRecord(entry) ||
        Object.keys(entry).some((key) => key !== "health") ||
        !isFiniteNumber(entry.health) ||
        entry.health <= 0 ||
        entry.health > 100
      ) {
        return false;
      }
    }
  }
  return true;
}

function isOcrScore(data: unknown): data is IFormattedValorantOCRScore {
  return (
    isRecord(data) &&
    isNonNegativeInteger(data.team_0_score) &&
    isNonNegativeInteger(data.team_1_score)
  );
}

function isOcrRoundInfo(data: unknown): data is IFormattedValorantOCRRoundInfoScoreboard {
  return (
    isRecord(data) &&
    isNonNegativeInteger(data.currentRound) &&
    data.currentRound > 0 &&
    isOcrRoundHistory(data.roundHistory)
  );
}

function isOcrRoundHistory(data: unknown): data is IFormattedValorantOCRRoundHistory {
  if (!isRecord(data)) return false;
  for (const [round, item] of Object.entries(data)) {
    if (!Number.isInteger(Number(round)) || Number(round) <= 0 || !isOcrRoundHistoryItem(item)) {
      return false;
    }
  }
  return true;
}

function isOcrRoundHistoryItem(data: unknown): data is IFormattedValorantOCRRoundHistoryItem {
  return (
    isRecord(data) &&
    (data.team === "team_0" || data.team === "team_1") &&
    (data.winningReason === "defused" ||
      data.winningReason === "elimination" ||
      data.winningReason === "explosion" ||
      data.winningReason === "timeout")
  );
}

function isOcrPhase(data: unknown): data is IFormattedValorantOCRRoundPhase {
  return (
    isRecord(data) &&
    isOptional(
      data.phase,
      (value): value is "combat" | "end" | "shopping" =>
        value === "combat" || value === "end" || value === "shopping",
    ) &&
    isOptional(data.isSpikePlanted, (value): value is boolean => typeof value === "boolean")
  );
}

function sourceOf(observation: ValObservation): string | null {
  const source = observation.havoc_data_source?.trim().toUpperCase();
  return source ? source : null;
}

function isAdmittedValObservation(observation: ValObservation): boolean {
  const source = sourceOf(observation);
  switch (observation.event) {
    case ValorantDataTypes.OCR_HEALTHS:
    case ValorantDataTypes.OCR_SCORE:
    case ValorantDataTypes.OCR_SCOREBOARD:
    case ValorantDataTypes.OCR_ROUND_INFO:
    case ValorantDataTypes.OCR_PHASE:
      return source === "OCR";
    case "kill_feed":
    case "planted_location":
      return source === "OW";
    default:
      return source === "OW";
  }
}

function positiveRound(value: number | null | undefined): number | null {
  return value != null && value > 0 ? value : null;
}

function plantedSite(data: unknown): string | null {
  if (typeof data === "string") {
    const site = data.trim().toUpperCase();
    return site === "" ? null : site;
  }
  if (!isRecord(data)) return null;
  return plantedSite(data.site) ?? plantedSite(data.value) ?? plantedSite(data.data);
}

function parseNormalizedValorantPacket(
  packet: CandidateValorantPacket,
): NormalizedValorantPacket | null {
  switch (packet.event) {
    case "planted_location":
      return typeof packet.data === "string"
        ? { ...packet, data: packet.data, event: "planted_location" }
        : null;
    case ValorantDataTypes.OBSERVING:
      return typeof packet.data === "string"
        ? { ...packet, data: packet.data, event: ValorantDataTypes.OBSERVING }
        : null;
    case ValorantDataTypes.PLAYER_SCOREBOARD:
      return isValorantPlayer(packet.data)
        ? { ...packet, data: packet.data, event: ValorantDataTypes.PLAYER_SCOREBOARD }
        : null;
    case ValorantDataTypes.KILLFEED:
      return isValorantKillfeed(packet.data)
        ? {
            ...packet,
            data: packet.data,
            event: ValorantDataTypes.KILLFEED,
            killfeedSource: packet.killfeedSource ?? "declared",
          }
        : null;
    case ValorantDataTypes.ROUND_INFO:
      return isValorantRoundInfo(packet.data)
        ? { ...packet, data: packet.data, event: ValorantDataTypes.ROUND_INFO }
        : null;
    case ValorantDataTypes.SCORE:
      return isValorantScore(packet.data)
        ? { ...packet, data: packet.data, event: ValorantDataTypes.SCORE }
        : null;
    case ValorantDataTypes.SPIKE_DEFUSED:
      return packet.data === true || packet.data === null || isFiniteNumber(packet.data)
        ? { ...packet, data: packet.data, event: ValorantDataTypes.SPIKE_DEFUSED }
        : null;
    case ValorantDataTypes.SPIKE_DETONATED:
      return packet.data === true || packet.data === null
        ? { ...packet, data: packet.data, event: ValorantDataTypes.SPIKE_DETONATED }
        : null;
    case ValorantDataTypes.SPIKE_PLANTED:
      return packet.data === true
        ? { ...packet, data: true, event: ValorantDataTypes.SPIKE_PLANTED }
        : null;
    default:
      return null;
  }
}

function parsedPacket(packet: CandidateValorantPacket): NormalizedValorantPacket[] {
  const parsed = parseNormalizedValorantPacket(packet);
  return parsed ? [parsed] : [];
}

export class ValObservationNormalizer {
  private latestRoundNumber: number | null = null;
  private readonly vitals = new Map<string, OcrVitals>();

  public reset(): void {
    this.latestRoundNumber = null;
    this.vitals.clear();
  }

  public clearRoundVitals(): void {
    this.vitals.clear();
  }

  public projectedVitals(roundNumber: number | undefined, playerId: string): OcrVitals | undefined {
    const round = positiveRound(roundNumber) ?? this.latestRoundNumber;
    if (round == null) return undefined;
    return this.vitals.get(`${round}:${playerId}`);
  }

  public prepare(
    observation: ValObservation,
    state: ValorantNormalizerPlayerState,
    raw: TFullValorantGameStateData,
  ): PreparedValObservation {
    const rejected = (): PreparedValObservation => ({
      accepted: false,
      packets: [],
    });
    const accepted = (packets: readonly NormalizedValorantPacket[]): PreparedValObservation => ({
      accepted: true,
      packets,
    });

    if (!isAdmittedValObservation(observation)) return rejected();

    if (observation.event === "planted_location") {
      const site = plantedSite(observation.data);
      if (!site) return rejected();
      const packets = parsedPacket({ ...observation, data: site, event: "planted_location" });
      return packets.length > 0 ? accepted(packets) : rejected();
    }

    if (observation.event === "kill_feed") {
      const payload = this.parseRawKillfeed(observation.data);
      if (!payload) return rejected();
      const formatted = formattingService.formatKillfeedData(payload);
      const packets = parsedPacket({
        havoc_data_source: observation.havoc_data_source,
        data: formatted.data,
        event: ValorantDataTypes.KILLFEED,
        killfeedSource: "raw_kill_feed_alias",
      });
      return packets.length > 0 ? accepted(packets) : rejected();
    }

    const packet: CandidateValorantPacket = {
      havoc_data_source: observation.havoc_data_source,
      data: observation.data,
      event: observation.event,
      ...(observation.event === ValorantDataTypes.KILLFEED
        ? { killfeedSource: "declared" as const }
        : {}),
    };

    switch (packet.event) {
      case ValorantDataTypes.OCR_HEALTHS:
        if (!isOcrHealths(packet.data)) return rejected();
        this.ingestHealths(raw.currentRound.roundNumber, packet.data);
        return accepted([]);
      case ValorantDataTypes.OCR_SCOREBOARD: {
        const packets = this.normalizeOcrScoreboard(packet, state, raw);
        return packets.length > 0 ? accepted(packets) : rejected();
      }
      case ValorantDataTypes.OCR_SCORE:
        if (!isOcrScore(packet.data)) return rejected();
        // OCR and OW deliberately converge on one internal SCORE packet. This conversion changes
        // only field names; it does not create another score store or give OCR lifecycle authority.
        return accepted(
          parsedPacket({
            ...packet,
            data: {
              team_0: packet.data.team_0_score,
              team_1: packet.data.team_1_score,
            },
            event: ValorantDataTypes.SCORE,
          }),
        );
      case ValorantDataTypes.OCR_ROUND_INFO: {
        const packets = this.normalizeOcrRoundInfo(packet, raw);
        return packets.length > 0 ? accepted(packets) : rejected();
      }
      case ValorantDataTypes.OCR_PHASE: {
        const packets = this.normalizeOcrPhase(packet, raw);
        return packets.length > 0 ? accepted(packets) : rejected();
      }
      case ValorantDataTypes.SCORE:
        // OW match_score is already expressed in the internal starting-side team coordinates.
        // The manager applies it as the selected primary source and reconciles Presence separately.
        return isValorantScore(packet.data)
          ? accepted(parsedPacket({ ...packet, data: packet.data, event: ValorantDataTypes.SCORE }))
          : rejected();
      default: {
        const packets = parsedPacket(packet);
        return packets.length > 0 ? accepted(packets) : rejected();
      }
    }
  }

  private ingestHealths(
    roundNumber: number,
    scoreline: IFormattedValorantOCRPlayersScoreline,
  ): void {
    const round = positiveRound(roundNumber) ?? this.latestRoundNumber ?? 1;
    // Scoreline is a sparse health source only. VALORANT sometimes omits living agents, so
    // absent entries leave prior vitals untouched. The scoreboard weapon-cell observation is
    // the life/death authority, and the scoreline contract admits positive health only.
    for (const startTeam of [0, 1] as const) {
      for (const [playerId, entry] of Object.entries(scoreline[startTeam] ?? {})) {
        if (!entry) continue;
        this.vitals.set(`${round}:${playerId}`, {
          health: entry.health,
        });
      }
    }
  }

  private normalizeOcrScoreboard(
    packet: CandidateValorantPacket,
    state: ValorantNormalizerPlayerState,
    raw: TFullValorantGameStateData,
  ): NormalizedValorantPacket[] {
    if (!Array.isArray(packet.data) || !packet.data.every(isOcrScoreboardPlayer)) return [];
    return packet.data
      .map((player) => this.normalizeOcrPlayer(player, state, raw))
      .filter((player): player is IFormattedValorantPlayer => player !== null)
      .flatMap((player) =>
        parsedPacket({ ...packet, data: player, event: ValorantDataTypes.PLAYER_SCOREBOARD }),
      );
  }

  private normalizeOcrPlayer(
    player: IFormattedValorantOCRScoreboardPlayer,
    state: ValorantNormalizerPlayerState,
    raw: TFullValorantGameStateData,
  ): IFormattedValorantPlayer | null {
    const playerId = player.playerId;
    const previousRaw = raw.players[playerId];
    const previous = state.allPlayers.find((candidate) => candidate.id === playerId);
    const maxUltPoints =
      previousRaw?.maxUltPoints ??
      previous?.maxUltPoints ??
      getValorantAgentMaxUltPoints(
        normalizeValorantAgentKey(player.agentName) ?? (player.agentName as ValorantAgentKey),
      );
    const currUltPoints =
      player.currUltPoints === "READY"
        ? maxUltPoints
        : (player.currUltPoints ?? previousRaw?.currUltPoints ?? previous?.currUltPoints);
    const weaponName = player.weaponName ?? previousRaw?.weaponName ?? previous?.weaponName;
    const hasSpike = player.hasSpike ?? previousRaw?.hasSpike ?? previous?.hasSpike;
    const kills = player.kills ?? previousRaw?.kills ?? previous?.kills;
    const deaths = player.deaths ?? previousRaw?.deaths ?? previous?.deaths;
    const assists = player.assists ?? previousRaw?.assists ?? previous?.assists;
    const money = player.money ?? previousRaw?.money ?? previous?.money;
    const isAlive = player.isAlive ?? previousRaw?.isAlive ?? previous?.isAlive;
    const observerSlot = player.observerSlot ?? previousRaw?.observerSlot ?? previous?.observerSlot;
    const observerSlotOrder =
      player.observerSlotOrder ?? previousRaw?.observerSlotOrder ?? previous?.observerSlotOrder;
    if (
      maxUltPoints == null ||
      currUltPoints == null ||
      weaponName == null ||
      hasSpike == null ||
      kills == null ||
      deaths == null ||
      assists == null ||
      money == null ||
      isAlive == null
    ) {
      return null;
    }
    return {
      agentName: normalizeValorantAgentKey(player.agentName) ?? (player.agentName as ValorantAgentKey),
      assists,
      currUltPoints,
      deaths,
      hasSpike,
      isAlive,
      kills,
      maxUltPoints,
      money,
      name:
        player.name?.trim() ||
        previousRaw?.name ||
        previous?.rawName ||
        previous?.name ||
        player.agentName,
      playerId,
      startTeam: player.startTeam,
      tagline: player.tagline,
      weaponName: weaponName as ValorantWeaponInternal,
      ...((player.loadoutValue ?? previousRaw?.loadoutValue ?? previous?.loadoutValue) !== undefined
        ? {
            loadoutValue:
              player.loadoutValue ?? previousRaw?.loadoutValue ?? previous?.loadoutValue,
          }
        : {}),
      shieldType: (player.shieldType ?? previousRaw?.shieldType ?? previous?.shieldType) as
        | 0
        | 1
        | 2
        | 3
        | 4
        | undefined,
      ...(isObserverSlot(observerSlot) ? { observerSlot } : {}),
      ...(isObserverSlotOrder(observerSlotOrder) ? { observerSlotOrder } : {}),
    } satisfies IFormattedValorantPlayer;
  }

  private normalizeOcrRoundInfo(
    packet: CandidateValorantPacket,
    raw: TFullValorantGameStateData,
  ): NormalizedValorantPacket[] {
    if (!isOcrRoundInfo(packet.data)) return [];
    const data = packet.data;
    this.latestRoundNumber = data.currentRound;
    return parsedPacket({
      ...packet,
      data: { roundNumber: data.currentRound, roundPhase: raw.currentRound.roundPhase },
      event: ValorantDataTypes.ROUND_INFO,
      ocrRoundHistory: data.roundHistory,
    });
  }

  private normalizeOcrPhase(
    packet: CandidateValorantPacket,
    raw: TFullValorantGameStateData,
  ): NormalizedValorantPacket[] {
    if (!isOcrPhase(packet.data)) return [];
    const data = packet.data;
    const roundNumber = positiveRound(raw.currentRound.roundNumber) ?? this.latestRoundNumber;
    const roundPhase = data.phase ?? raw.currentRound.roundPhase;
    if (roundNumber == null || roundPhase == null) return [];
    return parsedPacket({
      ...packet,
      data: { roundNumber, roundPhase },
      event: ValorantDataTypes.ROUND_INFO,
      ...(data.isSpikePlanted === undefined
        ? {}
        : { ocrDerivedIsSpikePlanted: data.isSpikePlanted }),
    });
  }

  private parseRawKillfeed(data: unknown): Record<string, unknown> | null {
    if (isRecord(data)) return data;
    if (typeof data !== "string") return null;
    try {
      const parsed: unknown = JSON.parse(data);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function isValorantKillfeed(data: unknown): data is IFormattedValorantKillfeed {
  return (
    isRecord(data) &&
    Array.isArray(data.assists) &&
    data.assists.every((assist) => typeof assist === "string") &&
    typeof data.attacker === "string" &&
    data.attacker.trim() !== "" &&
    typeof data.headshotKill === "boolean" &&
    typeof data.isTeamkill === "boolean" &&
    typeof data.victim === "string" &&
    data.victim.trim() !== "" &&
    typeof data.weaponName === "string" &&
    data.weaponName.trim() !== "" &&
    isOptional(data.ultName, (value): value is string => typeof value === "string")
  );
}
