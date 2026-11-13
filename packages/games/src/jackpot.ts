import { GameError } from "./errors";
import { feeOf } from "./money";
import type { PotSplit } from "./versus";

/**
 * Jackpot: players add to one pot and a single winner takes it. Every
 * smallest unit staked is one ticket, so the chance of winning equals the
 * player's share of the pot.
 */
export interface JackpotEntry {
  userId: string;
  amount: bigint;
}

export function jackpotPot(entries: JackpotEntry[]): bigint {
  return entries.reduce((total, entry) => total + entry.amount, 0n);
}

/**
 * Finds the entry holding the winning ticket. Tickets are numbered from 0 in
 * entry order: the first entry holds 0 to amount-1, the next continues on.
 */
export function pickJackpotWinner(entries: JackpotEntry[], ticket: bigint): JackpotEntry {
  const pot = jackpotPot(entries);
  if (entries.length === 0) {
    throw new GameError("EMPTY_ROUND", "A jackpot round needs at least one entry");
  }
  if (ticket < 0n || ticket >= pot) {
    throw new RangeError("Winning ticket is outside the pot");
  }

  let upper = 0n;
  for (const entry of entries) {
    upper += entry.amount;
    if (ticket < upper) {
      return entry;
    }
  }
  throw new Error("unreachable: ticket not found");
}

export function jackpotPayout(entries: JackpotEntry[], feeBps: number): PotSplit {
  const pot = jackpotPot(entries);
  const fee = feeOf(pot, feeBps);
  return { pot, fee, prize: pot - fee };
}

/** A player's share of the pot in basis points (10000 = certain to win). */
export function winChanceBps(entries: JackpotEntry[], userId: string): number {
  const pot = jackpotPot(entries);
  if (pot === 0n) {
    return 0;
  }
  const staked = entries.filter((entry) => entry.userId === userId).reduce((total, entry) => total + entry.amount, 0n);
  return Number((staked * 10_000n) / pot);
}
