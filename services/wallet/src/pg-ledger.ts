import { isUniqueViolation, transaction, type Pool, type Queryable } from "@yuubet/db";
import { HttpError } from "@yuubet/service-kit";
import {
  insufficientFunds,
  sameOrConflict,
  validateInput,
  withAllCurrencies,
  type Balance,
  type EntryKind,
  type LedgerEntry,
  type LedgerInput,
  type LedgerStore,
} from "./ledger";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface EntryRow {
  id: string;
  user_id: string;
  currency: string;
  amount: string;
  kind: EntryKind;
  ref: string;
  balance_after: string;
  created_at: Date;
}

const ENTRY_COLUMNS = "id, user_id, currency, amount, kind, ref, balance_after, created_at";

function toEntry(row: EntryRow): LedgerEntry {
  return {
    id: row.id,
    userId: row.user_id,
    currency: row.currency,
    amount: BigInt(row.amount),
    kind: row.kind,
    ref: row.ref,
    balanceAfter: BigInt(row.balance_after),
    createdAt: row.created_at.getTime(),
  };
}

/**
 * The ledger on wallet.accounts and wallet.ledger_entries.
 *
 * Each entry is one transaction that locks the player's account row, so
 * concurrent bets on one account are applied one at a time and can never
 * overdraw it. The entry id is the primary key, so a repeated id finds the
 * first entry instead of applying again.
 */
export class PgLedger implements LedgerStore {
  constructor(private readonly pool: Pool) {}

  async balance(userId: string, currency: string): Promise<bigint> {
    if (!UUID.test(userId)) {
      return 0n;
    }
    const { rows } = await this.pool.query<{ balance: string }>(
      "SELECT balance FROM wallet.accounts WHERE user_id = $1 AND currency = $2",
      [userId, currency],
    );
    return rows[0] ? BigInt(rows[0].balance) : 0n;
  }

  async balancesOf(userId: string): Promise<Balance[]> {
    const found = new Map<string, bigint>();
    if (UUID.test(userId)) {
      const { rows } = await this.pool.query<{ currency: string; balance: string }>(
        "SELECT currency, balance FROM wallet.accounts WHERE user_id = $1",
        [userId],
      );
      for (const row of rows) {
        found.set(row.currency, BigInt(row.balance));
      }
    }
    return withAllCurrencies(found);
  }

  async history(userId: string, limit = 50): Promise<LedgerEntry[]> {
    if (!UUID.test(userId)) {
      return [];
    }
    const { rows } = await this.pool.query<EntryRow>(
      `SELECT ${ENTRY_COLUMNS} FROM wallet.ledger_entries WHERE user_id = $1 ORDER BY seq DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map(toEntry);
  }

  async apply(input: LedgerInput): Promise<LedgerEntry> {
    validateInput(input);
    if (!UUID.test(input.userId)) {
      throw new HttpError(400, "INVALID_TRANSACTION", "userId must be a UUID");
    }
    try {
      return await this.applyOnce(input);
    } catch (error) {
      // The same id was inserted for another account at the same moment.
      // Running again finds that entry and returns it or reports the conflict.
      if (isUniqueViolation(error, "ledger_entries_pkey")) {
        return this.applyOnce(input);
      }
      throw error;
    }
  }

  private applyOnce(input: LedgerInput): Promise<LedgerEntry> {
    return transaction(this.pool, async (client) => {
      const balance = await lockAccount(client, input.userId, input.currency);

      // Read after taking the lock, so a concurrent request with the same id
      // for this account has either committed (and is found) or not started.
      const earlier = await client.query<EntryRow>(`SELECT ${ENTRY_COLUMNS} FROM wallet.ledger_entries WHERE id = $1`, [
        input.id,
      ]);
      if (earlier.rows[0]) {
        return sameOrConflict(toEntry(earlier.rows[0]), input);
      }

      const balanceAfter = balance + input.amount;
      if (balanceAfter < 0n) {
        throw insufficientFunds();
      }
      await client.query("UPDATE wallet.accounts SET balance = $3 WHERE user_id = $1 AND currency = $2", [
        input.userId,
        input.currency,
        balanceAfter.toString(),
      ]);
      const { rows } = await client.query<EntryRow>(
        `INSERT INTO wallet.ledger_entries (id, user_id, currency, amount, kind, ref, balance_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${ENTRY_COLUMNS}`,
        [
          input.id,
          input.userId,
          input.currency,
          input.amount.toString(),
          input.kind,
          input.ref,
          balanceAfter.toString(),
        ],
      );
      return toEntry(rows[0]!);
    });
  }
}

/** Creates the account if needed, locks its row until the transaction ends, and returns the balance. */
async function lockAccount(client: Queryable, userId: string, currency: string): Promise<bigint> {
  await client.query(
    "INSERT INTO wallet.accounts (user_id, currency) VALUES ($1, $2) ON CONFLICT (user_id, currency) DO NOTHING",
    [userId, currency],
  );
  const { rows } = await client.query<{ balance: string }>(
    "SELECT balance FROM wallet.accounts WHERE user_id = $1 AND currency = $2 FOR UPDATE",
    [userId, currency],
  );
  return BigInt(rows[0]!.balance);
}
