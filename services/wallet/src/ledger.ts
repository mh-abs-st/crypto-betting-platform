import { HttpError } from "@yuubet/service-kit";

export const CURRENCIES: Record<string, { decimals: number }> = {
  USDT: { decimals: 6 },
};

export const ENTRY_KINDS = ["deposit", "withdrawal", "bet", "win", "refund", "faucet"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export interface LedgerInput {
  /** Chosen by the caller. Sending the same id again has no further effect. */
  id: string;
  userId: string;
  currency: string;
  /** Positive adds to the balance, negative takes from it. Smallest units. */
  amount: bigint;
  kind: EntryKind;
  /** What caused this entry, for example a bet id. */
  ref: string;
}

export interface LedgerEntry extends LedgerInput {
  balanceAfter: bigint;
  createdAt: number;
}

export interface Balance {
  currency: string;
  amount: bigint;
  decimals: number;
}

/**
 * Player balances as an append-only list of entries. A balance can never go
 * below zero, and every entry has a caller-chosen id so a retried request
 * cannot be applied twice.
 *
 * `PgLedger` (pg-ledger.ts) is the real one; `MemoryLedger` is for tests and
 * for running without a database.
 */
export interface LedgerStore {
  balance(userId: string, currency: string): Promise<bigint>;
  balancesOf(userId: string): Promise<Balance[]>;
  /** A player's entries, newest first. */
  history(userId: string, limit?: number): Promise<LedgerEntry[]>;
  /** Applies an entry, or returns the earlier one if this id was already applied. */
  apply(input: LedgerInput): Promise<LedgerEntry>;
}

/** Throws a 400 for an entry that can never be applied. */
export function validateInput(input: LedgerInput): void {
  if (!input.id || !input.userId || !input.ref) {
    throw new HttpError(400, "INVALID_TRANSACTION", "id, userId and ref are required");
  }
  if (input.id.length > 200 || input.ref.length > 200) {
    throw new HttpError(400, "INVALID_TRANSACTION", "id and ref must be at most 200 characters");
  }
  if (!(input.currency in CURRENCIES)) {
    throw new HttpError(400, "UNKNOWN_CURRENCY", `Unsupported currency: ${input.currency}`);
  }
  if (!ENTRY_KINDS.includes(input.kind)) {
    throw new HttpError(400, "INVALID_TRANSACTION", `Unknown entry kind: ${String(input.kind)}`);
  }
  if (input.amount === 0n) {
    throw new HttpError(400, "INVALID_TRANSACTION", "Amount must not be zero");
  }
}

/** The earlier entry with this id, if it is the same transaction; throws if the id was used for another. */
export function sameOrConflict(earlier: LedgerEntry, input: LedgerInput): LedgerEntry {
  const same =
    earlier.userId === input.userId &&
    earlier.currency === input.currency &&
    earlier.amount === input.amount &&
    earlier.kind === input.kind;
  if (!same) {
    throw new HttpError(409, "ID_REUSED", "This transaction id was already used for a different transaction");
  }
  return earlier;
}

export function insufficientFunds(): HttpError {
  return new HttpError(409, "INSUFFICIENT_FUNDS", "Not enough balance");
}

export function withAllCurrencies(found: Map<string, bigint>): Balance[] {
  return Object.entries(CURRENCIES).map(([currency, info]) => ({
    currency,
    amount: found.get(currency) ?? 0n,
    decimals: info.decimals,
  }));
}

/** The ledger in memory. State is lost when the process stops. */
export class MemoryLedger implements LedgerStore {
  private readonly balances = new Map<string, bigint>();
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly byUser = new Map<string, LedgerEntry[]>();

  async balance(userId: string, currency: string): Promise<bigint> {
    return this.balances.get(`${userId}:${currency}`) ?? 0n;
  }

  async balancesOf(userId: string): Promise<Balance[]> {
    const found = new Map<string, bigint>();
    for (const currency of Object.keys(CURRENCIES)) {
      found.set(currency, await this.balance(userId, currency));
    }
    return withAllCurrencies(found);
  }

  async history(userId: string, limit = 50): Promise<LedgerEntry[]> {
    return (this.byUser.get(userId) ?? []).slice(-limit).reverse();
  }

  async apply(input: LedgerInput): Promise<LedgerEntry> {
    validateInput(input);
    const earlier = this.entries.get(input.id);
    if (earlier) {
      return sameOrConflict(earlier, input);
    }

    const key = `${input.userId}:${input.currency}`;
    const balanceAfter = (this.balances.get(key) ?? 0n) + input.amount;
    if (balanceAfter < 0n) {
      throw insufficientFunds();
    }

    const entry: LedgerEntry = { ...input, balanceAfter, createdAt: Date.now() };
    this.balances.set(key, balanceAfter);
    this.entries.set(entry.id, entry);
    const list = this.byUser.get(entry.userId) ?? [];
    list.push(entry);
    this.byUser.set(entry.userId, list);
    return entry;
  }
}
