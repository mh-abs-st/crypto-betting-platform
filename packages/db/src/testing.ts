import { randomBytes } from "node:crypto";
import { loadMigrations, migrate } from "./migrate";
import { createPool, type Pool } from "./pool";

/**
 * Connection to a server where tests may create and drop databases, for
 * example postgres://yuubet:yuubet@localhost:5432/postgres. Database tests
 * are skipped when it is not set.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

/** Pass as the `skip` option of a test that needs PostgreSQL. */
export const skipWithoutDatabase: string | false = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set; skipping PostgreSQL tests";

export interface TestDatabase {
  url: string;
  pool: Pool;
  /** Closes the pool and drops the database. */
  drop(): Promise<void>;
}

/** Creates an empty database with every migration applied. */
export async function createTestDatabase(): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is not set");
  }
  const name = `yuubet_test_${randomBytes(6).toString("hex")}`;
  const admin = createPool(TEST_DATABASE_URL, { max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), { max: 20 });
  await migrate(pool, await loadMigrations());

  return {
    url: url.toString(),
    pool,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
