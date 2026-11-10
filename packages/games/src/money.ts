import { GameError } from "./errors";

/**
 * Amounts are whole numbers of the currency's smallest unit, held as bigint
 * so no rounding can happen. They travel through JSON as decimal strings.
 */
export function parseAmount(value: unknown, field = "amount"): bigint {
  if (typeof value !== "string" || !/^[0-9]{1,30}$/.test(value)) {
    throw new GameError("INVALID_AMOUNT", `${field} must be a string of digits in the smallest unit`);
  }
  const amount = BigInt(value);
  if (amount <= 0n) {
    throw new GameError("INVALID_AMOUNT", `${field} must be greater than zero`);
  }
  return amount;
}

/** The house's share of an amount, in basis points (100 = 1%), rounded down. */
export function feeOf(amount: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new RangeError("feeBps must be a whole number from 0 to 10000");
  }
  return (amount * BigInt(feeBps)) / 10_000n;
}
