import {
  normalizeValorantAgentKey,
  type ValorantCurrentGamePlayer,
  type ValorantPregamePlayer,
  type ValorantSessionSnapshot,
} from "./game-identity";
import type { IFormattedValorantRosterPlayer } from "./valorant-api";
import type { ValorantRankKey } from "./valorant-ranks";

type ActiveSessionSnapshot = Extract<
  ValorantSessionSnapshot,
  { phase: "ending" | "live" | "pregame" }
>;

type SessionRosterEntry =
  | {
      entry: ValorantPregamePlayer;
      kind: "pregame";
      position: number;
      startingSide: "attack" | "defense" | null;
      teamId: string;
      teamIndex: number;
    }
  | {
      entry: ValorantCurrentGamePlayer;
      kind: "current";
      position: number;
      startingSide: "attack" | "defense" | null;
      teamId: string;
      teamIndex: number;
    };

const VALID_VALORANT_RANKS = new Set<number>([
  0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
]);

/**
 * Projects Riot session identity into Desktop's stable roster facts. Current
 * Game owns player ID, name, agent, starting team, and observer ordering; later
 * OCR/OW telemetry may enrich but must not replace those identity fields.
 */
export function projectValorantSessionRoster(
  snapshot: ActiveSessionSnapshot,
  options: { skirmish: boolean },
): IFormattedValorantRosterPlayer[] {
  let position = 0;
  return snapshot.phase === "pregame"
    ? snapshot.session.teams.flatMap((team, teamIndex) =>
        team.players.map((entry) =>
          projectSessionRosterPlayer(
            {
              entry,
              kind: "pregame",
              position: position++,
              startingSide: team.startingSide,
              teamId: team.teamId,
              teamIndex,
            },
            options,
          ),
        ),
      )
    : snapshot.session.teams.flatMap((team, teamIndex) =>
        team.players.map((entry) =>
          projectSessionRosterPlayer(
            {
              entry,
              kind: "current",
              position: position++,
              startingSide: team.startingSide,
              teamId: team.teamId,
              teamIndex,
            },
            options,
          ),
        ),
      );
}

export function resolveValorantStartingTeam(input: {
  skirmish: boolean;
  startingSide: "attack" | "defense" | null;
  teamId: string;
  teamIndex: number;
}): 0 | 1 {
  if (input.skirmish) {
    const teamId = input.teamId.trim().toLowerCase();
    if (teamId === "blue") return 1;
    if (teamId === "red") return 0;
  }
  if (input.startingSide === "attack") return 0;
  if (input.startingSide === "defense") return 1;
  return input.teamIndex === 0 ? 0 : 1;
}

function projectSessionRosterPlayer(
  source: SessionRosterEntry,
  options: { skirmish: boolean },
): IFormattedValorantRosterPlayer {
  const { position, teamId, teamIndex } = source;
  const player = source.entry.player;
  const startTeam = resolveValorantStartingTeam({
    skirmish: options.skirmish,
    startingSide: source.startingSide,
    teamId,
    teamIndex,
  });
  if (source.kind === "pregame") {
    const rank = isValorantRankKey(source.entry.competitiveTier) ? source.entry.competitiveTier : 0;
    return {
      agentName: source.entry.agent
        ? (normalizeValorantAgentKey(source.entry.agent.key) ?? "")
        : "",
      locked: source.entry.selection === "locked",
      name: player.name.gameName,
      playerId: player.puuid,
      position,
      rank,
      startTeam,
      tagline: player.name.tagLine,
    };
  }
  return {
    agentName: normalizeValorantAgentKey(source.entry.agent.key) ?? "",
    locked: true,
    name: player.name.gameName,
    ...(source.entry.observerSlot === null ? {} : { observerSlot: source.entry.observerSlot }),
    ...(source.entry.observerSlotOrder === null
      ? {}
      : { observerSlotOrder: source.entry.observerSlotOrder }),
    playerId: player.puuid,
    position,
    rank: 0,
    startTeam,
    tagline: player.name.tagLine,
  };
}

function isValorantRankKey(value: number): value is ValorantRankKey {
  return VALID_VALORANT_RANKS.has(value);
}
