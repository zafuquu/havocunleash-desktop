import type { IFormattedValorantKillfeed } from "./valorant-api";
import { classifyValorantKillfeedCause } from "./valorant-killfeed";

type NativeTeamId = 0 | 1;

interface ResolveValCombatTruthInput {
  attackerId?: string | null;
  attackerTeamId?: NativeTeamId | null;
  killfeed: Pick<IFormattedValorantKillfeed, "isTeamkill" | "ultName" | "weaponName">;
  victimId?: string | null;
  victimTeamId?: NativeTeamId | null;
}

export interface ValResolvedCombatTruth {
  causeClass: "combat" | "environment" | "objective";
  countsForAssistCredit: boolean;
  countsForCombatBoardDeath: boolean;
  creditsAttackerKill: boolean;
  resolvedSameTeam: boolean | null;
}

/** Resolves combat using native start-team ownership; raw teamkill flags are advisory only. */
export function resolveValCombatTruth({
  attackerId,
  attackerTeamId,
  killfeed,
  victimId,
  victimTeamId,
}: ResolveValCombatTruthInput): ValResolvedCombatTruth {
  const killfeedCause = classifyValorantKillfeedCause({
    ultName: killfeed.ultName,
    weaponName: killfeed.weaponName,
  });
  const resolvedSameTeam =
    attackerTeamId != null && victimTeamId != null
      ? attackerTeamId === victimTeamId
      : killfeed.isTeamkill
        ? true
        : null;
  const causeClass =
    killfeedCause === "objective"
      ? "objective"
      : killfeedCause === "weapon" || killfeedCause === "ability"
        ? "combat"
        : "environment";
  const countsForCombatBoardDeath = Boolean(
    victimId && causeClass === "combat" && resolvedSameTeam !== true,
  );

  return {
    causeClass,
    countsForAssistCredit: countsForCombatBoardDeath,
    countsForCombatBoardDeath,
    creditsAttackerKill: Boolean(
      attackerId &&
      victimId &&
      attackerId !== victimId &&
      causeClass === "combat" &&
      resolvedSameTeam !== true,
    ),
    resolvedSameTeam,
  };
}
