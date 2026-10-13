import type { IFormattedValorantPlayer } from "./valorant-api";
import {
  VALORANT_SHIELD_PRICES,
  VALORANT_WEAPON_PRICES,
} from "./valorant-prices";

type ShieldType = NonNullable<IFormattedValorantPlayer["shieldType"]>;
type KnownShieldType = Exclude<ShieldType, 3>;

export interface ValParticipantEquipmentFacts {
  loadoutValue: number | null;
  moneyAtRoundStart: number | null;
  previousMoney: number | null;
  shieldType?: ShieldType;
  spentMoney: number | null;
}

interface NativeEquipmentObservation {
  baseShieldType: KnownShieldType;
  currentMoney: number;
  currentShieldType: KnownShieldType;
  hasResolvedShield: boolean;
  moneyAtRoundStart: number | null;
  pendingShieldTransaction?: PendingShieldTransaction;
  previousMoney: number | null;
  roundNumber: number;
  weaponName: IFormattedValorantPlayer["weaponName"];
}

interface PendingShieldTransaction {
  currentMoney: number;
  currentShieldType: KnownShieldType;
  weaponName: IFormattedValorantPlayer["weaponName"];
}

const INFERRED_SHIELD_AGENTS = new Set(["smonk", "vampire"]);
const PURCHASABLE_SHIELDS = [1, 2, 4] as const;

/**
 * Retains the native money and equipment observations needed by addressed participant facts.
 * Explicit scoreboard equipment wins; Clove and Reyna use exact shopping transactions as a
 * best-effort fallback when the scoreboard reports an unknown enemy shield.
 */
export class ValParticipantEquipmentProjection {
  private observations = new Map<string, NativeEquipmentObservation>();

  public beginRound(
    roundNumber: number,
    players: readonly IFormattedValorantPlayer[],
    survivingPlayerIds: ReadonlySet<string>,
  ): void {
    const previousRound = this.observations;
    this.observations = new Map();
    for (const player of players) {
      const previous = previousRound.get(player.playerId);
      const carried = survivingPlayerIds.has(player.playerId) ? previous : undefined;
      const explicitShield = knownShield(player.shieldType);
      const baseShieldType = explicitShield ?? carried?.currentShieldType ?? 0;
      this.observations.set(player.playerId, {
        baseShieldType,
        currentMoney: player.money,
        currentShieldType: baseShieldType,
        hasResolvedShield: explicitShield !== undefined || carried?.hasResolvedShield === true,
        moneyAtRoundStart: player.money,
        previousMoney: player.money,
        roundNumber,
        weaponName: player.weaponName,
      });
    }
  }

  public observe(player: IFormattedValorantPlayer, roundNumber: number, isShopping: boolean): void {
    const previous = this.observations.get(player.playerId);
    const sameRound = previous?.roundNumber === roundNumber;
    const initialShield = knownShield(player.shieldType) ?? 0;
    let moneyAtRoundStart = sameRound ? previous.moneyAtRoundStart : null;
    if (isShopping) {
      moneyAtRoundStart = Math.max(moneyAtRoundStart ?? player.money, player.money);
    }
    const next: NativeEquipmentObservation = {
      baseShieldType: sameRound ? previous.baseShieldType : initialShield,
      currentMoney: player.money,
      currentShieldType: sameRound ? previous.currentShieldType : initialShield,
      hasResolvedShield: sameRound
        ? previous.hasResolvedShield
        : knownShield(player.shieldType) !== undefined,
      moneyAtRoundStart,
      ...(sameRound &&
      isShopping &&
      previous.pendingShieldTransaction?.currentMoney === player.money &&
      previous.pendingShieldTransaction.weaponName === player.weaponName
        ? { pendingShieldTransaction: previous.pendingShieldTransaction }
        : {}),
      previousMoney: sameRound ? previous.currentMoney : isShopping ? player.money : null,
      roundNumber,
      weaponName: player.weaponName,
    };

    if (sameRound && isShopping && INFERRED_SHIELD_AGENTS.has(player.agentName)) {
      this.inferShieldTransaction(next, previous, player);
    }

    const explicitShield = knownShield(player.shieldType);
    const isLaggingEmptyShield =
      explicitShield === 0 &&
      INFERRED_SHIELD_AGENTS.has(player.agentName) &&
      isShopping &&
      next.hasResolvedShield &&
      next.currentShieldType !== 0;
    if (explicitShield !== undefined && !isLaggingEmptyShield) {
      next.currentShieldType = explicitShield;
      next.hasResolvedShield = true;
      if (explicitShield !== 0) delete next.pendingShieldTransaction;
    }

    this.observations.set(player.playerId, next);
  }

  public project(
    occurrencePlayerId: string,
    player: IFormattedValorantPlayer | undefined,
  ): ValParticipantEquipmentFacts {
    const observation = this.observations.get(occurrencePlayerId);
    const moneyAtRoundStart = observation?.moneyAtRoundStart ?? null;
    const currentMoney = observation?.currentMoney;
    const shieldType = this.projectedShield(player, observation);
    const loadoutValue = this.projectedLoadoutValue(player, shieldType);
    return {
      loadoutValue,
      moneyAtRoundStart,
      previousMoney: observation?.previousMoney ?? null,
      ...(shieldType === undefined ? {} : { shieldType }),
      spentMoney:
        moneyAtRoundStart == null || currentMoney == null
          ? null
          : Math.max(0, moneyAtRoundStart - currentMoney),
    };
  }

  public reset(): void {
    this.observations.clear();
  }

  private inferShieldTransaction(
    next: NativeEquipmentObservation,
    previous: NativeEquipmentObservation,
    player: IFormattedValorantPlayer,
  ): void {
    const pending = previous.pendingShieldTransaction;
    if (
      player.shieldType === 3 &&
      pending?.currentMoney === player.money &&
      pending.weaponName === player.weaponName
    ) {
      next.currentShieldType = pending.currentShieldType;
      next.hasResolvedShield = true;
      delete next.pendingShieldTransaction;
      return;
    }

    const inferredShield = this.inferredShieldTransaction(previous, player);
    if (inferredShield === undefined) return;

    if (player.shieldType === 3) {
      next.currentShieldType = inferredShield;
      next.hasResolvedShield = true;
      delete next.pendingShieldTransaction;
      return;
    }

    if (player.shieldType === 0) {
      next.pendingShieldTransaction = {
        currentMoney: player.money,
        currentShieldType: inferredShield,
        weaponName: player.weaponName,
      };
    }
  }

  private inferredShieldTransaction(
    previous: NativeEquipmentObservation,
    player: IFormattedValorantPlayer,
  ): KnownShieldType | undefined {
    const netSpend = previous.currentMoney - player.money;
    const weaponDelta =
      (VALORANT_WEAPON_PRICES[player.weaponName] ?? 0) -
      (VALORANT_WEAPON_PRICES[previous.weaponName] ?? 0);
    const shieldSpend = netSpend - weaponDelta;
    const currentTradeIn =
      previous.currentShieldType === previous.baseShieldType
        ? 0
        : VALORANT_SHIELD_PRICES[previous.currentShieldType];

    for (const target of PURCHASABLE_SHIELDS) {
      if (shieldSpend !== VALORANT_SHIELD_PRICES[target] - currentTradeIn) continue;
      return target;
    }

    if (previous.currentShieldType !== previous.baseShieldType && shieldSpend === -currentTradeIn) {
      return previous.baseShieldType;
    }
  }

  private projectedShield(
    player: IFormattedValorantPlayer | undefined,
    observation: NativeEquipmentObservation | undefined,
  ): ShieldType | undefined {
    if (!player || player.shieldType !== 3 || !INFERRED_SHIELD_AGENTS.has(player.agentName)) {
      return player?.shieldType;
    }
    return observation?.hasResolvedShield ? observation.currentShieldType : player.shieldType;
  }

  private projectedLoadoutValue(
    player: IFormattedValorantPlayer | undefined,
    shieldType: ShieldType | undefined,
  ): number | null {
    if (player?.loadoutValue === undefined) return null;
    const rawShieldValue = VALORANT_SHIELD_PRICES[player.shieldType ?? 0];
    const resolvedShieldValue = VALORANT_SHIELD_PRICES[shieldType ?? 0];
    return Math.max(0, player.loadoutValue - rawShieldValue + resolvedShieldValue);
  }
}

function knownShield(shieldType: ShieldType | undefined): KnownShieldType | undefined {
  return shieldType === 3 ? undefined : shieldType;
}
