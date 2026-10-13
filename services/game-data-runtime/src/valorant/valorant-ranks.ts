/**
 * Rank key shim. The original's ranks table maps numeric competitive tiers to
 * display names; the tier numbers arrive directly from Riot rosters, so the
 * key is the tier number itself.
 */
export type ValorantRankKey = number;
