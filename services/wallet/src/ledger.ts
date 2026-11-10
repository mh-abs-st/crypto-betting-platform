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

/**
 * Player balances as an append-only list of entries. A balance can never go
 * below zero, and every entry has a caller-chosen id so a retried request
 * cannot be applied twice. Kept in memory for now; the tables are in
 * db/migrations.
 */
export class Ledger {
  private readonly balances = new Map<string, bigint>();
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly byUser = new Map<string, LedgerEntry[]>();

  balance(userId: string, currency: string): bigint {
    return this.balances.get(`${userId}:${currency}`) ?? 0n;
  }

  balancesOf(userId: string): Array<{ currency: string; amount: bigint; decimals: number }> {
    return Object.entries(CURRENCIES).map(([currency, info]) => ({
      currency,
      amount: this.balance(userId, currency),
      decimals: info.decimals,
    }));
  }

  history(userId: string, limit = 50): LedgerEntry[] {
    return (this.byUser.get(userId) ?? []).slice(-limit).reverse();
  }

  apply(input: LedgerInput): LedgerEntry {
    if (!input.id || !input.userId || !input.ref) {
      throw new HttpError(400, "INVALID_TRANSACTION", "id, userId and ref are required");
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

    const earlier = this.entries.get(input.id);
    if (earlier) {
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

    const key = `${input.userId}:${input.currency}`;
    const balanceAfter = (this.balances.get(key) ?? 0n) + input.amount;
    if (balanceAfter < 0n) {
      throw new HttpError(409, "INSUFFICIENT_FUNDS", "Not enough balance");
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
