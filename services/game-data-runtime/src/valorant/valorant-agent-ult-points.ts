import type { ValorantAgentKey } from "./game-identity";

export const ValorantAgentMaxUltPoints: Record<ValorantAgentKey, number> = {
  aggrobot: 8,
  bountyhunter: 8,
  breach: 8,
  cable: 7,
  cashew: 9,
  clay: 8,
  deadeye: 8,
  grenadier: 8,
  guide: 8,
  gumshoe: 7,
  hunter: 8,
  iris: 8,
  killjoy: 9,
  mage: 7,
  nox: 8,
  pandemic: 9,
  phoenix: 6,
  pine: 7,
  rift: 7,
  sarge: 8,
  sequoia: 7,
  smonk: 8,
  sprinter: 8,
  stealth: 8,
  terra: 8,
  thorne: 7,
  vampire: 7,
  wraith: 7,
  wushu: 8,
};

export function getValorantAgentMaxUltPoints(agentName: ValorantAgentKey): number {
  return ValorantAgentMaxUltPoints[agentName];
}
