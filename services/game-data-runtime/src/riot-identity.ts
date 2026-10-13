/**
 * Riot identity layer — LCU + GLZ + PD. The endpoint flow is verified from the
 * original runtime's own request logs (runtime.jsonl), not guessed:
 *
 *   local (lockfile basic-auth riot:<password>, self-signed TLS):
 *     GET /entitlements/v1/token          -> accessToken + entitlementsToken
 *     GET /chat/v1/session                -> local session
 *     GET /riotclient/region-locale       -> region (+ shard)
 *     GET /product-session/v1/external-sessions
 *     GET /chat/v4/presences              -> per-player presence (match id)
 *   glz (https://glz-<region>-1.<shard>.a.pvp.net):
 *     GET /pregame/v1/matches/:id         -> agent-select roster
 *     GET /core-game/v1/matches/:id       -> live roster (agents, teams, tiers)
 *   pd (https://pd.<shard>.a.pvp.net):
 *     PUT /name-service/v2/players        -> display names for player UUIDs
 *
 * Auth headers (recovered from the audited binary): Bearer <accessToken>,
 * X-Riot-Entitlements-JWT, X-Riot-ClientPlatform, X-Riot-ClientVersion.
 *
 * Agent UUID -> internal key/name tables are the original's own
 * (valorant/identities: VALORANT_AGENT_RIOT_IDS / VALORANT_AGENT_NAMES).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import https from "node:https";

import { checkValorantProcess } from "./valorant-detect";
import { formatMapKey } from "./gep-format";

export type IdentitySink = (fact: { kind: string; key: string; value: unknown }) => void;

/** The original's own agent tables (valorant/identities). */
const AGENT_RIOT_IDS: Record<string, string> = {
  aggrobot: "e370fa57-4757-3604-3648-499e1f642d3f",
  bountyhunter: "dade69b4-4f5a-8528-247b-219e5a1facd6",
  breach: "5f8d3a7f-467b-97f3-062c-13acf203c006",
  cable: "cc8b64c8-4b25-4ff9-6e7f-37b4da43d235",
  cashew: "b444168c-4e35-8076-db47-ef9bf368f384",
  clay: "f94c3b30-42be-e959-889c-5aa313dba261",
  deadeye: "22697a3d-45bf-8dd7-4fec-84a9e28c69d7",
  grenadier: "601dbbe7-43ce-be57-2a40-4abd24953621",
  guide: "6f2a04ca-43e0-be17-7f36-b3908627744d",
  gumshoe: "117ed9e3-49f3-6512-3ccf-0cada7e3823b",
  hunter: "320b2a48-4d9b-a075-30f1-1f93a9b638fa",
  iris: "7c8a4701-4de6-9355-b254-e09bc2a34b72",
  killjoy: "1e58de9c-4950-5125-93e9-a0aee9f98746",
  mage: "95b78ed7-4637-86d9-7e41-71ba8c293152",
  nox: "efba5359-4016-a1e5-7626-b1ae76895940",
  pandemic: "707eab51-4836-f488-046a-cda6bf494859",
  phoenix: "eb93336a-449b-9c1b-0a54-a891f7921d69",
  pine: "92eeef5d-43b5-1d4a-8d03-b3927a09034b",
  rift: "41fb69c1-4189-7b37-f117-bcaf1e96f1bf",
  sarge: "9f0d8ba9-4140-b941-57d3-a7ad57c6b417",
  sequoia: "0e38b510-41a8-5780-5e8f-568b2a4f2d6c",
  smonk: "1dbf2edd-4729-0984-3115-daa5eed44993",
  sprinter: "bb2a4828-46eb-8cd1-e765-15848195d751",
  stealth: "7f94d92c-4234-0a36-9646-3a87eb8b5c89",
  terra: "df1cb487-4902-002e-5c17-d28e83e78588",
  thorne: "569fdd95-4d10-43ab-ca70-79becc718b46",
  vampire: "a3bfb853-43b2-7238-a4f1-ad90e9e46bcc",
  wraith: "8e253930-4c05-31dd-1b6c-968525494517",
  wushu: "add6443a-41bd-e414-f6ad-e58d267f4e95",
};
const AGENT_BY_UUID = new Map(Object.entries(AGENT_RIOT_IDS).map(([k, v]) => [v, k]));

const AGENT_NAMES: Record<string, string> = {
  aggrobot: "Gekko", bountyhunter: "Fade", breach: "Breach", cable: "Deadlock",
  cashew: "Tejo", clay: "Raze", deadeye: "Chamber", grenadier: "KAY/O",
  guide: "Skye", gumshoe: "Cypher", hunter: "Sova", iris: "Miks",
  killjoy: "Killjoy", mage: "Harbor", nox: "Vyse", pandemic: "Viper",
  phoenix: "Phoenix", pine: "Veto", rift: "Astra", sarge: "Brimstone",
  sequoia: "Iso", smonk: "Clove", sprinter: "Neon", stealth: "Yoru",
  terra: "Waylay", thorne: "Sage", vampire: "Reyna", wraith: "Omen",
  wushu: "Jett",
};

/** Riot's standard client platform header value. */
const CLIENT_PLATFORM = JSON.stringify({
  platformType: "PC",
  platformOS: "Windows",
  platformOSVersion: "10.0.19042.1.256.64bit",
  platformChipset: "Unknown",
});

function readLockfile(): { port: string; password: string } | null {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  const path = join(localAppData, "Riot Games", "Riot Client", "Config", "lockfile");
  try {
    if (!existsSync(path)) return null;
    const parts = readFileSync(path, "utf8").trim().split(":");
    if (parts.length >= 4) return { port: parts[2]!, password: parts[3]! };
  } catch { /* unreadable -> retry next poll */ }
  return null;
}

function lcuGet(port: string, password: string, endpoint: string, timeoutMs = 4000): Promise<unknown> {
  const auth = Buffer.from(`riot:${password}`).toString("base64");
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        path: endpoint,
        method: "GET",
        timeout: timeoutMs,
        headers: { Authorization: `Basic ${auth}` },
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 300) {
            reject(new Error(`lcu ${endpoint} -> ${res.statusCode}`));
            return;
          }
          try {
            resolve(text ? (JSON.parse(text) as unknown) : null);
          } catch {
            reject(new Error(`lcu ${endpoint} bad json`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** Client version from the newest VALORANT log (the original's "log" source). */
function readClientVersionFromLogs(): string | null {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? "", "VALORANT", "Saved", "Logs"),
    join(process.env.LOCALAPPDATA ?? "", "VALORANT", "Saved", "Logs", "ShooterGame"),
  ];
  for (const base of candidates) {
    try {
      if (!existsSync(base)) continue;
      const files = readdirSync(base).filter((f) => f.startsWith("ShooterGame") && f.endsWith(".log"));
      if (files.length === 0) continue;
      files.sort((a, b) => b.localeCompare(a));
      for (const f of files.slice(0, 3)) {
        const text = readFileSync(join(base, f), "utf8");
        const m = text.match(/CI server version: ([\w.-]+)/);
        if (m) return m[1]!;
      }
    } catch { /* try next candidate */ }
  }
  return null;
}

interface RiotContext {
  port: string;
  password: string;
  accessToken: string;
  entitlementsToken: string;
  region: string;
  shard: string;
  clientVersion: string;
  selfPuuid: string | null;
}

/**
 * Riot region -> shard. GLZ hosts are `glz-<region>-1.<shard>.a.pvp.net`, and
 * region != shard for most of the world: /riotclient/region-locale returns e.g.
 * "SG2", whose shard is "ap". Using the region as the shard builds
 * `glz-SG2-1.SG2.a.pvp.net`, which does not resolve (verified: "No such host
 * is known"), so every identity call failed before it was even sent.
 */
const REGION_TO_SHARD: Record<string, string> = {
  // Asia-Pacific
  ap: "ap", sg2: "ap", sg: "ap", jp1: "ap", jp: "ap", kr: "kr", kr1: "kr",
  oc1: "ap", tw2: "ap", hk: "ap",
  // Americas
  na: "na", na1: "na", latam: "na", la1: "na", la2: "na", br: "na", br1: "na",
  pbe: "pbe", pbe1: "pbe",
  // Europe
  eu: "eu", eu1: "eu", euw: "eu", eune: "eu", tr1: "eu", ru: "eu", ru1: "eu",
};

/** Resolve the GLZ shard for a region code (defaults to the region itself). */
function shardForRegion(region: string): string {
  const key = region.trim().toLowerCase();
  return REGION_TO_SHARD[key] ?? key;
}

async function resolveContext(prev: RiotContext | null): Promise<RiotContext> {
  const lockfile = readLockfile();
  if (!lockfile) throw new Error("lockfile_missing");
  const port = lockfile.port;

  const entitlements = (await lcuGet(port, lockfile.password, "/entitlements/v1/token")) as {
    accessToken?: string;
    entitlementsToken?: string;
  };
  const accessToken = entitlements?.accessToken ?? "";
  // The entitlements JWT is only required for the GLZ/PD cloud calls. The Riot
  // client frequently returns it empty (observed live: accessToken 1085 chars,
  // entitlementsToken ""), and treating that as fatal aborted resolveContext —
  // which killed the whole poll, including the LOCAL presence read that needs
  // no cloud token at all. That left the runtime idle during a live match.
  const entitlementsToken = entitlements?.entitlementsToken ?? "";
  if (!accessToken) throw new Error("entitlements_missing");

  let region = prev?.region ?? "";
  let shard = prev?.shard ?? "";
  try {
    const rl = (await lcuGet(port, lockfile.password, "/riotclient/region-locale")) as {
      region?: string;
    };
    if (rl?.region) {
      // region-locale reports the LOGIN region (e.g. "SG2"); GLZ is addressed
      // by SHARD. Verified by DNS: glz-ap-1.ap resolves, glz-sg2-1.ap and
      // glz-sg2-1.sg2 do not — so the shard is used in BOTH host positions.
      shard = shardForRegion(String(rl.region));
      region = shard;
    }
  } catch { /* keep previous */ }
  // A missing region only disables the GLZ cloud calls; local presence (the
  // authoritative phase source) still works, so this must not abort the poll.
  if (!region) {
    region = "";
    shard = "";
  }

  const clientVersion = readClientVersionFromLogs() ?? prev?.clientVersion ?? "release-13.05-shipping-11-5350494";

  // A5: seed the LOCAL identity from the LCU's own chat session — the
  // authoritative local puuid (this endpoint describes the logged-in user,
  // not other players). Without it ctx.selfPuuid stayed null forever and
  // pollMatch's presence fallback adopted whatever in-game presence it
  // found first (the A5-PRE contamination root). Never substitute another
  // player's puuid: a failed read just delays seeding to the next poll.
  let selfPuuid = prev?.selfPuuid ?? null;
  if (!selfPuuid) {
    try {
      const session = (await lcuGet(port, lockfile.password, "/chat/v1/session")) as {
        puuid?: string;
      };
      if (typeof session?.puuid === "string" && session.puuid) selfPuuid = session.puuid;
    } catch { /* retry next poll */ }
  }

  return {
    port,
    password: lockfile.password,
    accessToken,
    entitlementsToken,
    region,
    shard,
    clientVersion,
    selfPuuid,
  };
}

function glzRequest(
  ctx: RiotContext,
  path: string,
  method: "GET" | "PUT",
  body?: unknown,
  timeoutMs = 6000,
): Promise<unknown> {
  const headers: Record<string, string | number> = {
    Authorization: `Bearer ${ctx.accessToken}`,
    "X-Riot-Entitlements-JWT": ctx.entitlementsToken,
    "X-Riot-ClientPlatform": CLIENT_PLATFORM,
    "X-Riot-ClientVersion": ctx.clientVersion,
    "Content-Type": "application/json",
  };
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload !== undefined) headers["Content-Length"] = Buffer.byteLength(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: `glz-${ctx.region}-1.${ctx.shard}.a.pvp.net`,
        path,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 300) {
            reject(new Error(`glz ${path} -> ${res.statusCode}`));
            return;
          }
          try {
            resolve(text ? (JSON.parse(text) as unknown) : null);
          } catch {
            reject(new Error(`glz ${path} bad json`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

interface PresenceEntry {
  puuid: string;
  matchId: string | null;
  inProgress: boolean;
  /** NEW presence format (Riot client 2024+): no matchId in the havoc —
   *  loop state, map and team scores instead. */
  inGame: boolean;
  isPregame: boolean;
  matchMap: string | null;
  scoreAlly: number | null;
  scoreEnemy: number | null;
}

/**
 * Decode VALORANT presences. TWO wire formats exist:
 *
 *  OLD: `private` is a base64 JWT whose middle segment carries
 *       {puuid, matchId, gameInProgress, product}.
 *  NEW: `private` is plain base64 JSON with matchPresenceData
 *       {sessionLoopState, matchMap} and partyOwnerMatchScore* — NO matchId.
 *       The match id must then come from the GLZ player endpoints
 *       (/core-game/v1/players/:puuid -> MatchID).
 * Parsing is defensive: any malformed entry is skipped.
 */
function parsePresences(raw: unknown): PresenceEntry[] {
  const out: PresenceEntry[] = [];
  const presences = (raw as { presences?: unknown[] })?.presences;
  if (!Array.isArray(presences)) return out;
  for (const entry of presences) {
    const rec = entry as { pid?: string; puuid?: string; product?: string; private?: string };
    // `puuid` is the clean player UUID; `pid` is "puuid@cluster.pvp.net".
    // Prefer puuid — the domain-suffixed pid breaks GLZ player lookups and
    // selfPuuid matching (they never compare equal to the entitlement subject).
    const puuid = typeof rec?.puuid === "string" && rec.puuid ? rec.puuid : typeof rec?.pid === "string" ? rec.pid : null;
    const priv = typeof rec?.private === "string" ? rec.private : null;
    if (!puuid || !priv) continue;
    try {
      const decoded = Buffer.from(priv, "base64").toString("utf8").trim();
      if (decoded.startsWith("{")) {
        // NEW format: plain JSON.
        const payload = JSON.parse(decoded) as {
          sessionLoopState?: string;
          matchPresenceData?: { sessionLoopState?: string; matchMap?: string };
          partyOwnerMatchScoreAllyTeam?: number;
          partyOwnerMatchScoreEnemyTeam?: number;
        };
        if ((entry as { product?: string }).product === "valorant") {
          const loop = payload.matchPresenceData?.sessionLoopState ?? payload.sessionLoopState ?? "";
          out.push({
            puuid,
            matchId: null,
            inProgress: false,
            inGame: loop === "INGAME",
            isPregame: loop === "PREGAME",
            matchMap: payload.matchPresenceData?.matchMap ?? null,
            scoreAlly: typeof payload.partyOwnerMatchScoreAllyTeam === "number" ? payload.partyOwnerMatchScoreAllyTeam : null,
            scoreEnemy: typeof payload.partyOwnerMatchScoreEnemyTeam === "number" ? payload.partyOwnerMatchScoreEnemyTeam : null,
          });
        }
        continue;
      }
      // OLD format: JWT — middle segment carries matchId.
      const parts = decoded.split(".");
      if (parts.length < 2) continue;
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
        matchId?: string;
        gameInProgress?: boolean;
        product?: string;
      };
      if (payload.product && payload.product !== "valorant") continue;
      out.push({
        puuid,
        matchId: typeof payload.matchId === "string" ? payload.matchId : null,
        inProgress: payload.gameInProgress === true,
        inGame: payload.gameInProgress === true,
        isPregame: false,
        matchMap: null,
        scoreAlly: null,
        scoreEnemy: null,
      });
    } catch {
      /* malformed presence -> skip */
    }
  }
  return out;
}

/**
 * A5 session-identity boundary: the ONLY presence that may drive the local
 * runtime is the one whose puuid equals the LOCAL player's (ctx.selfPuuid,
 * seeded from the LCU's own /chat/v1/session — never from presences).
 * A5-PRE evidence (RIOT_PRESENCE_FALLBACK_CONTAMINATION): the previous
 * `presences.find(p => p.inGame || p.inProgress)` fallback selected a
 * friend's live match while the local user sat in the VALORANT lobby —
 * foreign score/map/live facts drove the HUD as if they were the local
 * session. A local desktop instance must NEVER project another player's
 * match merely because that player appears in Riot presence.
 */
export function selectSelfPresence<T extends { puuid: string }>(
  presences: T[],
  selfPuuid: string | null | undefined,
): T | null {
  if (!selfPuuid) return null;
  return presences.find((p) => p.puuid === selfPuuid) ?? null;
}

/** True only when the given (self) presence reports a locally live session. */
export function isSelfLive(
  p: { inGame?: boolean; inProgress?: boolean; isPregame?: boolean } | null | undefined,
): boolean {
  return !!p && !!(p.inGame || p.inProgress || p.isPregame);
}

interface RosterPlayer {
  puuid: string;
  name: string;
  tagline: string;
  agent: string | null;
  team: number | null;
  tier: number | null;
  teamId: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  score: number | null;
}

/** Normalize a pregame/core-game roster into roster players (verified fields). */
function parseRoster(match: unknown): RosterPlayer[] {
  const players = (match as { Players?: unknown[] })?.Players;
  if (!Array.isArray(players)) return [];
  const teamUuids = new Map<string, number>();
  const out: RosterPlayer[] = [];
  for (const p of players) {
    const rec = p as {
      Subject?: string;
      CharacterID?: string;
      TeamID?: string;
      CompetitiveTier?: number;
      CharacterSelectionState?: string;
      PlayerIdentity?: { GameName?: string; TagLine?: string };
    };
    const puuid = typeof rec?.Subject === "string" ? rec.Subject : "";
    if (!puuid) continue;
    const teamId = typeof rec.TeamID === "string" ? rec.TeamID : null;
    let team: number | null = null;
    if (teamId) {
      // "Red"/"Blue" (pregame) map to 1/0; core-game team UUIDs are assigned by
      // first-seen order, matching the original's side-ownership normalization.
      const low = teamId.toLowerCase();
      if (low === "red") team = 1;
      else if (low === "blue") team = 0;
      else {
        if (!teamUuids.has(teamId)) teamUuids.set(teamId, teamUuids.size);
        team = teamUuids.get(teamId)!;
      }
    }
    const agentUuid = typeof rec.CharacterID === "string" ? rec.CharacterID.toLowerCase() : "";
    const internalKey = AGENT_BY_UUID.get(agentUuid) ?? null;
    const selectionState = typeof rec.CharacterSelectionState === "string" ? rec.CharacterSelectionState : "";
    // Agents that are still being selected have the zero UUID — omit them.
    const agent =
      internalKey && selectionState !== "" && agentUuid !== "00000000-0000-0000-0000-000000000000"
        ? AGENT_NAMES[internalKey] ?? internalKey
        : null;
    const stats = (rec as { Stats?: { Kills?: number; Deaths?: number; Assists?: number; Score?: number } })?.Stats;
    const statNum = (v: unknown): number | null => (typeof v === "number" ? v : null);
    out.push({
      puuid,
      name: rec.PlayerIdentity?.GameName ?? "",
      tagline: rec.PlayerIdentity?.TagLine ?? "",
      agent,
      team,
      tier: typeof rec.CompetitiveTier === "number" ? rec.CompetitiveTier : null,
      teamId,
      kills: statNum(stats?.Kills),
      deaths: statNum(stats?.Deaths),
      assists: statNum(stats?.Assists),
      score: statNum(stats?.Score),
    });
  }
  return out;
}

/**
 * Polls the Riot client for the live session and emits identity facts:
 *   riot_session   { region, shard, selfPuuid }
 *   match_id       (authoritative match UUID — flips the session to live)
 *   match_map_id   (raw Riot MapID; GEP supplies the map codename separately)
 *   roster         per player: name, tagline, character, team, tier, player_id
 */
export class RiotIdentitySource {
  private timer: NodeJS.Timeout | null = null;
  private ctx: RiotContext | null = null;
  private lastMatchId: string | null = null;
  private lastMatchType: "core" | "pregame" | null = null;
  private stopped = false;
  /**
   * True while we have told the runtime the session is loading/live.
   * Riot chat presences go STALE when VALORANT exits — the client keeps
   * reporting the last match's sessionLoopState/map/score (observed live:
   * "INGAME / Infinity 9-9" with no game process). The runtime must only
   * trust presence while the game process actually exists; otherwise the HUD
   * stays "LIVE" forever after the match.
   */
  private nonIdlePhaseEmitted = false;
  /**
   * Previous poll's presence loop state + scores — used to detect a NEW match
   * from presence alone: a flip INGAME -> PREGAME (agent select of the next
   * match) or a score decrease (Riot resets partyOwnerMatchScore to 0-0) both
   * mean the runtime must reset, otherwise the previous match's score bleeds
   * into agent select (observed: HUD showing 4-8 "live" while nothing was
   * happening yet).
   */
  private lastLoopInGame: boolean | null = null;
  private lastScoreAlly: number | null = null;
  private lastScoreEnemy: number | null = null;
  /**
   * Consecutive polls that said "no live session" while we believe one is
   * active. A single miss is normal jitter (tasklist hiccups, LCU presence
   * churn mid-match) — retiring on the first miss made the HUD flap
   * live -> idle -> live every few seconds. Retire only after a streak.
   */
  private idleStreak = 0;

  /**
   * A5 observability — state-gated (one log per foreign-presence identity
   * change, never per tick): a non-self in-game presence was seen while the
   * local user is not live, and was deliberately ignored. Makes it
   * immediately obvious that `self=A selected=A ignored=B` rather than a
   * generic "presence found". Enable with HAVOC_DEBUG_PIPELINE=1.
   */
  private lastForeignLog: string | null = null;
  private logForeignIgnored(presences: PresenceEntry[], self: PresenceEntry | null): void {
    if (isSelfLive(self)) {
      this.lastForeignLog = null;
      return;
    }
    const foreign = presences.find((p) => p !== self && isSelfLive(p));
    if (!foreign) {
      this.lastForeignLog = null;
      return;
    }
    const selfTag = this.ctx?.selfPuuid ? `…${this.ctx.selfPuuid.slice(-6)}` : "unseeded";
    const key = `${selfTag}|…${foreign.puuid.slice(-6)}`;
    if (this.lastForeignLog === key) return;
    this.lastForeignLog = key;
    if (process.env.HAVOC_DEBUG_PIPELINE === "1") {
      console.log(
        `[pipeline:riot-identity] foreign_presence_ignored self=${selfTag} ` +
          `foreign=${key.split("|")[1]} (local session not live — not projecting)`,
      );
    }
  }

  private emitRoster(roster: RosterPlayer[], withStats: boolean): void {
    for (const player of roster) {
      this.emit({
        kind: "new_info_update",
        key: "roster",
        value: {
          player_id: player.puuid,
          name: player.name,
          tagline: player.tagline,
          character: player.agent,
          team: player.team,
          position: null,
          locked: true,
          competitiveTier: player.tier,
          // Live stats (GLZ core-game): updated on every poll while in match.
          kills: withStats ? player.kills : undefined,
          deaths: withStats ? player.deaths : undefined,
          assists: withStats ? player.assists : undefined,
          combatScore: withStats ? player.score : undefined,
        },
      });
    }
  }

  public constructor(private readonly emit: IdentitySink) {}

  public start(): void {
    if (this.timer) return;
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        this.ctx = await resolveContext(this.ctx);
        this.emitSession();
        await this.pollMatch();
      } catch {
        // Client closed / not logged in / mid-restart: reset cached tokens.
        this.ctx = null;
        this.lastMatchId = null;
      }
      this.timer = setTimeout(() => void tick(), 4_000);
    };
    void tick();
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private emitSession(): void {
    if (!this.ctx) return;
    this.emit({
      kind: "new_info_update",
      key: "riot_session",
      value: { region: this.ctx.region, shard: this.ctx.shard, selfPuuid: this.ctx.selfPuuid },
    });
  }

  /**
   * Fresh presence check: does the current presence list still show us (or
   * anyone) in an active match? Used by the retire-streak in pollMatch.
   */
  private async hasLivePresence(): Promise<boolean> {
    if (!this.ctx) return false;
    try {
      const raw = await lcuGet(this.ctx.port, this.ctx.password, "/chat/v4/presences");
      const presences = parsePresences(raw);
      // A5: SELF presence only. The old `presences.find(p => p.inGame ||
      // p.isPregame || p.inProgress)` fallback made retirement structurally
      // unreachable — any party member playing kept the local session alive.
      return isSelfLive(selectSelfPresence(presences, this.ctx.selfPuuid));
    } catch {
      // Presence read failed: assume the session persists (jitter, not exit).
      return true;
    }
  }

  /** Polls consecutive misses before retiring a live session (~12s at 4s tick). */
  private static readonly IDLE_STREAK_LIMIT = 3;

  private async pollMatch(): Promise<void> {
    if (!this.ctx) return;
    // Presence is only trustworthy while the game process exists. VALORANT
    // closed -> the Riot client keeps serving the stale INGAME presence, so
    // retire the session instead of mirroring frozen map/score to the HUD.
    // A single miss is jitter; require a streak before retiring.
    const gameRunning = checkValorantProcess().present;
    const sessionGone = !gameRunning || !(await this.hasLivePresence());
    if (sessionGone && this.nonIdlePhaseEmitted) {
      this.idleStreak += 1;
      if (this.idleStreak >= RiotIdentitySource.IDLE_STREAK_LIMIT) {
        this.idleStreak = 0;
        this.nonIdlePhaseEmitted = false;
        this.lastMatchId = null;
        this.lastMatchType = null;
        this.emit({ kind: "new_info_update", key: "session_phase", value: "idle" });
      }
      return;
    }
    this.idleStreak = 0;
    const presences = parsePresences(
      await lcuGet(this.ctx.port, this.ctx.password, "/chat/v4/presences"),
    );
    // Self = the LOCAL player ONLY (A5 session-identity boundary). Never
    // project another player's presence: the streamer's desktop represents
    // the local user's VALORANT session, not a friend's. When self is
    // absent or not in-game, the session is simply not live — a friend or
    // party member being in a match is irrelevant and must be ignored
    // completely (foreign_presence_ignored diagnostic below).
    const self = selectSelfPresence(presences, this.ctx.selfPuuid);
    this.logForeignIgnored(presences, self);

    // New-match detection from presence alone (see field docs): agent-select
    // flip after a live session, or a score decrease vs the previous poll.
    // Emits match_start, which resets the runtime (score/roster/rounds) so
    // the previous match's state never bleeds into the next one.
    const pregameFlip = !!self?.isPregame && this.lastLoopInGame === true;
    const scoreReset =
      (this.lastScoreAlly != null && self?.scoreAlly != null && self.scoreAlly < this.lastScoreAlly) ||
      (this.lastScoreEnemy != null && self?.scoreEnemy != null && self.scoreEnemy < this.lastScoreEnemy);
    if (pregameFlip || scoreReset) {
      this.emit({ kind: "new_info_update", key: "match_start", value: true });
    }
    this.lastLoopInGame = !!self?.inGame;
    if (self?.scoreAlly != null) this.lastScoreAlly = self.scoreAlly;
    if (self?.scoreEnemy != null) this.lastScoreEnemy = self.scoreEnemy;

    // 1. Presence with an explicit matchId (OLD format) — direct.
    let matchId = self?.matchId ?? null;
    let type: "core" | "pregame" | null = matchId ? "core" : null;

    // 2. NEW format: no matchId in presences — ask GLZ for the player's match.
    //    Requires cloud credentials + a shard; without them we fall through to
    //    the presence-derived facts below instead of aborting the poll.
    if (!matchId && self && this.ctx.entitlementsToken && this.ctx.shard) {
      const puuid = encodeURIComponent(self.puuid);
      try {
        const rec = (await glzRequest(this.ctx, `/core-game/v1/players/${puuid}`, "GET")) as {
          MatchID?: string;
        };
        if (typeof rec?.MatchID === "string" && rec.MatchID) {
          matchId = rec.MatchID;
          type = "core";
        }
      } catch { /* not in a live game */ }
      if (!matchId) {
        try {
          const rec = (await glzRequest(this.ctx, `/pregame/v1/players/${puuid}`, "GET")) as {
            PregameMatchID?: string;
          };
          if (typeof rec?.PregameMatchID === "string" && rec.PregameMatchID) {
            matchId = rec.PregameMatchID;
            type = "pregame";
          }
        } catch { /* not in agent select */ }
      }
    }

    // 3. Presence-derived facts that need no match id at all (NEW format):
    //    live team score from the party presence + raw map path.
    //
    //    This path is authoritative for the SESSION PHASE. GLZ may be
    //    unreachable (wrong shard, 403 TLS-fingerprint block) and GEP may be
    //    starved by a competing Overwolf host, but the local presence always
    //    tells us whether we are in agent select or in a live match. Without
    //    emitting the phase here the runtime stayed on "loading" forever and
    //    the overlay froze on the agent-select scene mid-match.
    if (!matchId) {
      if (self?.inGame && gameRunning) {
        if (self.matchMap) {
          // "/Game/Maps/Infinity/Infinity" -> canonical key "abyss" (Abyss).
          // Raw codenames leaked to the HUD as if they were map names
          // ("infinity", "bonsai") — they are Riot internal codenames.
          const mapKey = formatMapKey(self.matchMap);
          if (mapKey) this.emit({ kind: "new_info_update", key: "map", value: mapKey });
        }
        if (self.scoreAlly != null && self.scoreEnemy != null) {
          this.emit({
            kind: "new_info_update",
            key: "match_score",
            value: { team_0: self.scoreAlly, team_1: self.scoreEnemy },
          });
        }
        // INGAME with no resolvable match id: still a live match.
        this.emit({ kind: "new_info_update", key: "scene", value: "ingame_hud" });
        this.emit({ kind: "new_info_update", key: "session_phase", value: "live" });
        this.nonIdlePhaseEmitted = true;
      } else if (self?.isPregame && gameRunning) {
        this.emit({ kind: "new_info_update", key: "scene", value: "agent_select" });
        this.emit({ kind: "new_info_update", key: "session_phase", value: "loading" });
        this.nonIdlePhaseEmitted = true;
      }
      // Session retirement (game closed / backed out to lobby) is handled by
      // the idle-streak guard at the top of pollMatch — do not retire here on
      // a single missing presence (that made the HUD flap live <-> idle).
      this.lastMatchId = null;
      this.lastMatchType = null;
      return;
    }

    // Live game first, then agent select. While in a core-game match we poll
    // EVERY tick: the roster facts carry live kills/deaths/assists/score.
    let match: unknown = null;
    try {
      match = await glzRequest(this.ctx, `/core-game/v1/matches/${encodeURIComponent(matchId)}`, "GET");
    } catch {
      if (type === "pregame") {
        try {
          match = await glzRequest(this.ctx, `/pregame/v1/matches/${encodeURIComponent(matchId)}`, "GET");
        } catch {
          return; // match not provisioned on GLZ yet — retry next poll
        }
      } else {
        return;
      }
    }
    if (this.stopped) return;
    const roster = parseRoster(match);
    if (roster.length === 0) return;
    const withStats = type === "core";

    if (type === "pregame" || self?.isPregame) {
      this.emit({ kind: "new_info_update", key: "scene", value: "agent_select" });
      this.emit({ kind: "new_info_update", key: "session_phase", value: "loading" });
      this.nonIdlePhaseEmitted = true;
    } else if (type === "core" || self?.inGame) {
      this.emit({ kind: "new_info_update", key: "scene", value: "ingame_hud" });
      this.emit({ kind: "new_info_update", key: "session_phase", value: "live" });
      this.nonIdlePhaseEmitted = true;
    }

    if (matchId !== this.lastMatchId) {
      // New match: authoritative id + map flip the session to live.
      this.emit({ kind: "new_info_update", key: "match_id", value: matchId });
      const mapId = (match as { MapID?: string })?.MapID;
      if (typeof mapId === "string" && mapId) {
        // Raw Riot MapID (GEP supplies the map codename separately).
        this.emit({ kind: "new_info_update", key: "match_map_id", value: mapId });
      }
    }
    this.emitRoster(roster, withStats);
    // Presence-derived team score stays live alongside the roster stats.
    if (self?.inGame && self.scoreAlly != null && self.scoreEnemy != null) {
      this.emit({
        kind: "new_info_update",
        key: "match_score",
        value: { team_0: self.scoreAlly, team_1: self.scoreEnemy },
      });
    }
    this.lastMatchId = matchId;
    this.lastMatchType = type;
  }
}
