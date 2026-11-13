import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "./pool";

export interface Migration {
  /** The number at the start of the file name, for example "001". */
  version: string;
  file: string;
  sql: string;
  checksum: string;
}

/** db/migrations in this repository. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

const FILE = /^(\d+)_[a-z0-9_]+\.sql$/;
// Any fixed number; only migration runners take this advisory lock.
const LOCK_KEY = "7351890263";

/** Reads `NNN_name.sql` files in version order. */
export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((file) => FILE.test(file)).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const sql = await readFile(join(dir, file), "utf8");
    const version = FILE.exec(file)![1]!;
    if (migrations.some((m) => m.version === version)) {
      throw new Error(`Two migrations have version ${version}`);
    }
    migrations.push({ version, file, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  return migrations;
}

/**
 * Applies the migrations that have not been applied yet, each in its own
 * transaction, and records them in public.schema_migrations. Refuses to run
 * if an applied migration file has since been changed. An advisory lock
 * keeps two runners from applying the same migration at once.
 *
 * Returns the files it applied.
 */
export async function migrate(
  pool: Pool,
  migrations: Migration[],
  log: (message: string) => void = () => {},
): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version     TEXT PRIMARY KEY,
        file        TEXT NOT NULL,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string; file: string }>(
      "SELECT version, checksum, file FROM public.schema_migrations",
    );
    const done = new Map(rows.map((row) => [row.version, row]));

    for (const migration of migrations) {
      const earlier = done.get(migration.version);
      if (earlier) {
        if (earlier.checksum !== migration.checksum) {
          throw new Error(`${migration.file} was changed after it was applied; add a new migration instead`);
        }
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query("INSERT INTO public.schema_migrations (version, file, checksum) VALUES ($1, $2, $3)", [
          migration.version,
          migration.file,
          migration.checksum,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`${migration.file} failed: ${(error as Error).message}`, { cause: error });
      }
      applied.push(migration.file);
      log(`applied ${migration.file}`);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
