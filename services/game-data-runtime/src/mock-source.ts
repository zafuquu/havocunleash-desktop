/** Deterministic mock Valorant provider speaking upstream frame shapes. */

export interface ProviderFact {
  kind: "new_info_update" | "new_game_event";
  key: string;
  value: unknown;
}

export type SourceEmit = (fact: ProviderFact) => void;

const PHASE_ORDER = ["shopping", "combat", "end"] as const;
const MAPS = ["ascent", "bind", "haven", "sunset"];
const AGENTS = ["Jett", "Omen", "Sova", "Reyna", "Killjoy", "Brimstone", "Phoenix", "Cypher", "Viper", "Raze"];
const WEAPONS = ["Vandal", "Phantom", "Sheriff", "Operator", "Classic", "Judge"];

/** Fixed 5v5 roster; killfeed names match these so the desktop classifier can attribute kills. */
export const ROSTER = {
  blue: ["Jett", "Omen", "Sova", "Reyna", "Killjoy"],
  red: ["Brimstone", "Phoenix", "Cypher", "Viper", "Raze"],
} as const;

export type ScenarioName = "random" | "ace" | "team-ace" | "clutch" | "flawless";

export function currentScenario(): ScenarioName {
  const raw = (process.env.HAVOC_SCENARIO ?? process.env.FORK_SCENARIO ?? "").toLowerCase();
  return (["ace", "team-ace", "clutch", "flawless"].includes(raw) ? raw : "random") as ScenarioName;
}

interface Kill { attacker: string; victim: string }

/** Build the kill script for one combat round. */
export function planRoundKills(roundNumber: number): Kill[] {
  const scenario = currentScenario();
  if (scenario === "random" || roundNumber !== 1) {
    // Random round: 2-4 kills across random teams.
    const kills: Kill[] = [];
    const count = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i += 1) {
      const blueAttacks = Math.random() < 0.5;
      const attackers = ROSTER.blue.filter((n) => !kills.some((k) => k.victim === n));
      const defenders = ROSTER.red.filter((n) => !kills.some((k) => k.victim === n));
      const from = blueAttacks ? attackers : defenders;
      const to = blueAttacks ? defenders : attackers;
      if (from.length === 0 || to.length === 0) break;
      kills.push({
        attacker: from[Math.floor(Math.random() * from.length)]!,
        victim: to[Math.floor(Math.random() * to.length)]!,
      });
    }
    return kills;
  }

  if (scenario === "ace") {
    // Jett drops a 5k; blue wins the round.
    return ROSTER.red.map((victim) => ({ attacker: "Jett", victim }));
  }
  if (scenario === "team-ace") {
    // Every blue player contributes exactly one kill.
    return ROSTER.blue.map((attacker, i) => ({ attacker, victim: ROSTER.red[i]! }));
  }
  if (scenario === "flawless") {
    // Blue sweeps without deaths; only two players get kills (avoids Team Ace).
    return ROSTER.red.map((victim, i) => ({
      attacker: ROSTER.blue[i % 2]!,
      victim,
    }));
  }
  // clutch: red opens 4-0 on blue, then Sova (last alive) clutches a 1v4... -> 1v4 entry,
  // then kills all five red. Classifier records max enemies seen (4) -> "Clutch".
  const blueOrder = [...ROSTER.blue];
  const out: Kill[] = [];
  for (let i = 0; i < 4; i += 1) out.push({ attacker: ROSTER.red[i]!, victim: blueOrder[i]! });
  for (const victim of ROSTER.red) out.push({ attacker: "Sova", victim });
  return out;
}

interface MatchState {
  matchId: string | null;
  mapKey: string | null;
  roundNumber: number;
  phaseIndex: number;
  blue: number;
  red: number;
}

export class MockValorantSource {
  private nextId = 1;
  private startedAt = Date.now();
  private state: MatchState = {
    matchId: null,
    mapKey: null,
    roundNumber: 0,
    phaseIndex: PHASE_ORDER.length,
    blue: 0,
    red: 0,
  };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private emitFn: SourceEmit | null = null;
  private readonly agents = ["Jett", "Omen", "Sova", "Reyna", "Killjoy", "Brimstone", "Phoenix", "Cypher"];
  private readonly weapons = ["Vandal", "Phantom", "Sheriff", "Operator", "Classic", "Judge"];

  start(emit: SourceEmit): void {
    if (this.timer || this.emitFn) return;
    this.emitFn = emit;
    this.startedAt = Date.now();
    this.scheduleMatchStart(2_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.emitFn = null;
  }

  get info(): { bootedAt: number; currentRound: number } {
    return { bootedAt: this.startedAt, currentRound: this.state.roundNumber };
  }

  /** Chain-safe one-shot timer used by every scheduled transition below. */
  private schedule(fn: () => void, ms: number): void {
    setTimeout(() => fn(), ms);
  }

  private scheduleMatchStart(delayMs: number): void {
    this.schedule(() => {
      if (!this.emitFn) return;
      const maps = ["ascent", "bind", "haven", "sunset"];
      this.state = {
        matchId: `fork-${Math.random().toString(36).slice(2, 10)}`,
        mapKey: maps[Math.floor(Math.random() * maps.length)]!,
        roundNumber: 1,
        phaseIndex: 0,
        blue: 0,
        red: 0,
      };
      this.pushInfo("scene", "loading");
      this.schedule(() => this.beginShoppingPhase(), 4_000);
    }, delayMs);
  }

  private beginShoppingPhase(): void {
    if (!this.emitFn || !this.state.matchId) return;
    this.pushInfo("scene", this.state.mapKey);
    // Match identity: flips the runtime session to "live" so the projection
    // derives overlay scenes (the real provider emits this on match start).
    this.pushInfo("match_id", this.state.matchId);
    this.pushInfo("match_score", { team_0: this.state.blue, team_1: this.state.red });
    this.pushInfo("round_number", this.state.roundNumber);
    this.pushInfo("round_phase", PHASE_ORDER[this.state.phaseIndex]);
    this.pushScoreboard();
    this.schedule(() => this.enterCombat(), 12_000);
  }

  /** Emit a per-player detail observation (weapon/credits/ults/scoreline). */
  private pushScoreboard(): void {
    if (!this.emitFn || !this.state.matchId) return;
    const weapons = ["Vandal", "Phantom", "Sheriff", "Operator", "Classic", "Judge", "Guardian", "Spectre", "Marshal", "Frenzy", "Ares", "Odin"];
    const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
    for (const side of ["blue", "red"] as const) {
      ROSTER[side].forEach((name, i) => {
        this.pushInfo("scoreboard", {
          name,
          // Real team index so the runtime groups the roster into Blue/Red
          // teams instead of the "Unknown" bucket.
          team: side === "blue" ? 0 : 1,
          weapon: pick(weapons),
          credits: 800 + i * 150,
          spentCredits: i * 100,
          kills: this.state.roundNumber,
          deaths: i,
          assists: i % 3,
          health: 100,
          alive: true,
          ultPoints: i * 20,
          ultMax: 100,
          hasSpike: side === "blue" && i === 0,
          abilities: ["Q", "E", "C", "X"],
        });
      });
    }
  }

  private enterCombat(): void {
    if (!this.emitFn || !this.state.matchId) return;
    this.pushInfo("round_phase", "combat");
    const kills = planRoundKills(this.state.roundNumber);
    for (let i = 0; i < kills.length; i += 1) {
      this.schedule(() => this.scriptedKill(kills[i]!), 2_000 + i * 2_500);
    }
    this.schedule(() => this.plantOrSkip(), 5_000);
    this.schedule(() => this.settleRound(), 22_000);
  }

  private plantOrSkip(): void {
    if (!this.emitFn || !this.state.matchId || Math.random() < 0.45) return;
    this.pushEvent("spike_planted", true);
    this.schedule(() => {
      if (!this.emitFn) return;
      const roll = Math.random();
      if (roll < 0.35) this.pushEvent("spike_defused", true);
      else if (roll < 0.55) this.pushEvent("spike_detonated", true);
      // Otherwise the round ends without detonation; spike resets next round.
    }, 9_000);
  }

  private scriptedKill(kill: Kill): void {
    if (!this.emitFn || !this.state.matchId) return;
    this.pushEvent("kill_feed", {
      attacker: kill.attacker,
      victim: kill.victim,
      weapon: WEAPONS[Math.floor(Math.random() * WEAPONS.length)]!,
      modifier: Math.random() < 0.25 ? "headshot" : "bodyshot",
    });
  }

  private settleRound(): void {
    if (!this.emitFn || !this.state.matchId) return;
    this.pushInfo("round_phase", "end");
    // Scenario round 1 always goes to blue so the scripted win-type classifies.
    const blueWins =
      this.state.roundNumber === 1 && currentScenario() !== "random"
        ? true
        : Math.random() < 0.55;
    if (blueWins) this.state.blue += 1;
    else this.state.red += 1;
    this.schedule(() => {
      if (!this.emitFn) return;
      this.pushInfo("match_score", { team_0: this.state.blue, team_1: this.state.red });
      if (this.state.blue >= 13 || this.state.red >= 13) {
        this.state.matchId = null;
        this.state.mapKey = null;
        this.scheduleMatchStart(6_000);
      } else {
        this.state.roundNumber += 1;
        this.state.phaseIndex = 0;
        this.schedule(() => this.beginShoppingPhase(), 8_000);
      }
    }, 6_000);
  }

  private pushInfo(key: string, value: unknown): void {
    this.emit({ kind: "new_info_update", key, value });
  }

  private pushEvent(key: string, value: unknown): void {
    this.emit({ kind: "new_game_event", key, value });
  }

  private emit(fact: ProviderFact): void {
    if (!this.emitFn) return;
    this.emitFn(fact);
  }
}
