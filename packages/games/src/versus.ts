import { feeOf } from "./money";

/** Versus: two players stake the same amount on opposite sides of a coin. */
export type Side = "heads" | "tails";

export const VERSUS_OUTCOMES = 2n;

export function isSide(value: unknown): value is Side {
  return value === "heads" || value === "tails";
}

export function oppositeSide(side: Side): Side {
  return side === "heads" ? "tails" : "heads";
}

/** Maps the fair roll (0 or 1) to the side that wins. */
export function versusOutcome(roll: bigint): Side {
  if (roll !== 0n && roll !== 1n) {
    throw new RangeError("A versus roll must be 0 or 1");
  }
  return roll === 0n ? "heads" : "tails";
}

export interface PotSplit {
  pot: bigint;
  fee: bigint;
  prize: bigint;
}

/** Both stakes form the pot; the winner takes it minus the house fee. */
export function versusPayout(stake: bigint, feeBps: number): PotSplit {
  const pot = stake * 2n;
  const fee = feeOf(pot, feeBps);
  return { pot, fee, prize: pot - fee };
}
