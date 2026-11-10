import { GameError } from "./errors";

/** European roulette: pockets 0 to 36. */
export const ROULETTE_POCKETS = 37n;
export const MAX_BETS_PER_SPIN = 50;

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export const ROULETTE_BET_TYPES = [
  "straight",
  "red",
  "black",
  "odd",
  "even",
  "low",
  "high",
  "dozen",
  "column",
] as const;
export type RouletteBetType = (typeof ROULETTE_BET_TYPES)[number];
export type RouletteColor = "green" | "red" | "black";

export interface RouletteBet {
  type: RouletteBetType;
  /** The number for a straight bet (0-36), or which dozen or column (1-3). */
  value?: number;
  amount: bigint;
}

export interface RouletteBetResult {
  bet: RouletteBet;
  won: boolean;
  /** What the player receives for this bet, stake included; zero if it lost. */
  payout: bigint;
}

export interface RouletteSettlement {
  number: number;
  color: RouletteColor;
  results: RouletteBetResult[];
  totalStake: bigint;
  totalPayout: bigint;
}

export function colorOf(number: number): RouletteColor {
  if (number === 0) {
    return "green";
  }
  return RED_NUMBERS.has(number) ? "red" : "black";
}

/** Total returned per unit staked on a winning bet, stake included. */
export function returnMultiple(type: RouletteBetType): bigint {
  switch (type) {
    case "straight":
      return 36n;
    case "dozen":
    case "column":
      return 3n;
    default:
      return 2n;
  }
}

export function validateRouletteBet(bet: RouletteBet): void {
  if (!ROULETTE_BET_TYPES.includes(bet.type)) {
    throw new GameError("INVALID_BET", `Unknown roulette bet type: ${String(bet.type)}`);
  }
  if (bet.amount <= 0n) {
    throw new GameError("INVALID_BET", "Bet amount must be greater than zero");
  }

  const whole = Number.isInteger(bet.value);
  if (bet.type === "straight") {
    if (!whole || bet.value! < 0 || bet.value! > 36) {
      throw new GameError("INVALID_BET", "A straight bet needs a number from 0 to 36");
    }
  } else if (bet.type === "dozen" || bet.type === "column") {
    if (!whole || bet.value! < 1 || bet.value! > 3) {
      throw new GameError("INVALID_BET", `A ${bet.type} bet needs a value from 1 to 3`);
    }
  } else if (bet.value !== undefined) {
    throw new GameError("INVALID_BET", `A ${bet.type} bet takes no value`);
  }
}

/** Zero loses every bet except a straight bet on zero. */
export function rouletteBetWins(bet: RouletteBet, number: number): boolean {
  if (bet.type === "straight") {
    return bet.value === number;
  }
  if (number === 0) {
    return false;
  }
  switch (bet.type) {
    case "red":
      return colorOf(number) === "red";
    case "black":
      return colorOf(number) === "black";
    case "odd":
      return number % 2 === 1;
    case "even":
      return number % 2 === 0;
    case "low":
      return number <= 18;
    case "high":
      return number >= 19;
    case "dozen":
      return Math.ceil(number / 12) === bet.value;
    case "column":
      return ((number - 1) % 3) + 1 === bet.value;
  }
}

export function settleRoulette(bets: RouletteBet[], number: number): RouletteSettlement {
  if (!Number.isInteger(number) || number < 0 || number > 36) {
    throw new RangeError("Roulette number must be from 0 to 36");
  }
  if (bets.length === 0 || bets.length > MAX_BETS_PER_SPIN) {
    throw new GameError("INVALID_BET", `A spin needs between 1 and ${MAX_BETS_PER_SPIN} bets`);
  }

  let totalStake = 0n;
  let totalPayout = 0n;
  const results = bets.map((bet) => {
    validateRouletteBet(bet);
    const won = rouletteBetWins(bet, number);
    const payout = won ? bet.amount * returnMultiple(bet.type) : 0n;
    totalStake += bet.amount;
    totalPayout += payout;
    return { bet, won, payout };
  });

  return { number, color: colorOf(number), results, totalStake, totalPayout };
}
