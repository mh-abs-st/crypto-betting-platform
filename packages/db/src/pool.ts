import pg from "pg";
import type { Pool as PgPool, PoolClient } from "pg";

export type Pool = PgPool;
/** A pool or a client inside a transaction: anything that can run a query. */
export type Queryable = Pick<PoolClient, "query">;

export interface PoolOptions {
  /** Most connections this process opens. */
  max?: number;
  /** Shown in pg_stat_activity, so a connection can be traced to its service. */
  applicationName?: string;
}

/** A connection pool. Errors on idle connections are logged instead of crashing the process. */
export function createPool(connectionString: string, options: PoolOptions = {}): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName,
  });
  pool.on("error", (error: Error) => {
    console.error(`idle database connection failed: ${error.message}`);
  });
  return pool;
}

/** The SQLSTATE code of a database error, if it is one. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** True for a unique violation, optionally only on the named constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (errorCode(error) !== "23505") {
    return false;
  }
  return constraint === undefined || (error as { constraint?: string }).constraint === constraint;
}

/** Serialization failures and deadlocks: the transaction did nothing and can be run again. */
const RETRYABLE = new Set(["40001", "40P01"]);

export function isRetryable(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && RETRYABLE.has(code);
}

export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

export interface TransactionOptions {
  isolation?: IsolationLevel;
  /** How many times to run the transaction again after a serialization failure or deadlock. */
  retries?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `work` in a transaction on one connection. Commits if it returns,
 * rolls back if it throws. A serialization failure or deadlock runs the whole
 * transaction again, so `work` must not have effects outside the database.
 */
export async function transaction<T>(
  pool: Pool,
  work: (client: Queryable) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const isolation = options.isolation ?? "read committed";
  const retries = options.retries ?? 3;

  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection is unusable; drop it rather than return it to the pool.
        broken = true;
      }
      if (attempt < retries && isRetryable(error)) {
        await sleep(5 * 2 ** attempt + Math.random() * 10);
        continue;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }
}
