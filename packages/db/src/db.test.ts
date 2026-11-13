import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadMigrations, migrate } from "./migrate";
import { transaction } from "./pool";
import { createTestDatabase, skipWithoutDatabase, type TestDatabase } from "./testing";

let db: TestDatabase;
const skip = skipWithoutDatabase;

before(async () => {
  if (!skip) db = await createTestDatabase();
});
after(async () => {
  await db?.drop();
});

test("loadMigrations reads files in version order and rejects duplicate versions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "migrations-"));
  await writeFile(join(dir, "002_second.sql"), "SELECT 2;");
  await writeFile(join(dir, "001_first.sql"), "SELECT 1;");
  await writeFile(join(dir, "README.md"), "not a migration");
  assert.deepEqual(
    (await loadMigrations(dir)).map((m) => m.file),
    ["001_first.sql", "002_second.sql"],
  );

  await writeFile(join(dir, "002_again.sql"), "SELECT 3;");
  await assert.rejects(loadMigrations(dir), /Two migrations have version 002/);
});

test("migrations apply from an empty database and only once", { skip }, async () => {
  const { rows } = await db.pool.query("SELECT version FROM public.schema_migrations ORDER BY version");
  const all = await loadMigrations();
  assert.deepEqual(
    rows.map((row) => row.version),
    all.map((m) => m.version),
  );
  assert.deepEqual(await migrate(db.pool, all), []);
});

test("a changed migration is refused", { skip }, async () => {
  const [first, ...rest] = await loadMigrations();
  const changed = { ...first!, checksum: "edited" };
  await assert.rejects(migrate(db.pool, [changed, ...rest]), /was changed after it was applied/);
});

test("a failing migration is rolled back and not recorded", { skip }, async () => {
  const bad = {
    version: "999",
    file: "999_bad.sql",
    checksum: "x",
    sql: "CREATE TABLE public.half_done (id INT); SELECT 1/0;",
  };
  await assert.rejects(migrate(db.pool, [...(await loadMigrations()), bad]), /999_bad.sql failed: division by zero/);
  const { rows } = await db.pool.query(
    "SELECT to_regclass('public.half_done') AS t, (SELECT count(*) FROM public.schema_migrations WHERE version = '999')::int AS n",
  );
  assert.deepEqual(rows[0], { t: null, n: 0 });
});

test("transaction commits on success and rolls back on error", { skip }, async () => {
  await db.pool.query("CREATE TABLE public.tx_test (n INT)");
  await transaction(db.pool, (c) => c.query("INSERT INTO public.tx_test VALUES (1)"));
  await assert.rejects(
    transaction(db.pool, async (c) => {
      await c.query("INSERT INTO public.tx_test VALUES (2)");
      throw new Error("boom");
    }),
    /boom/,
  );
  const { rows } = await db.pool.query("SELECT n FROM public.tx_test");
  assert.deepEqual(rows, [{ n: 1 }]);
});

test("transaction runs again after a serialization failure", { skip }, async () => {
  await db.pool.query(
    "CREATE TABLE public.counter (id INT PRIMARY KEY, n INT NOT NULL); INSERT INTO public.counter VALUES (1, 0)",
  );
  let attempts = 0;
  // Twenty serializable increments at once: some conflict and are retried.
  await Promise.all(
    Array.from({ length: 20 }, () =>
      transaction(
        db.pool,
        async (c) => {
          attempts++;
          const { rows } = await c.query("SELECT n FROM public.counter WHERE id = 1");
          await c.query("UPDATE public.counter SET n = $1 WHERE id = 1", [rows[0].n + 1]);
        },
        { isolation: "serializable", retries: 50 },
      ),
    ),
  );
  const { rows } = await db.pool.query("SELECT n FROM public.counter WHERE id = 1");
  assert.equal(rows[0].n, 20);
  assert.ok(attempts > 20, "expected at least one retry");
});

test("each service role reaches only its own schema", { skip }, async () => {
  const as = async (role: string, sql: string) =>
    transaction(
      db.pool,
      async (c) => {
        await c.query(`SET LOCAL ROLE ${role}`);
        return c.query(sql);
      },
      { retries: 0 },
    );

  await as("yuubet_wallet", "SELECT count(*) FROM wallet.ledger_entries");
  await assert.rejects(as("yuubet_wallet", "SELECT count(*) FROM auth.users"), { code: "42501" });
  await assert.rejects(as("yuubet_wallet", "DELETE FROM wallet.ledger_entries"), { code: "42501" });
  await assert.rejects(as("yuubet_wallet", "UPDATE wallet.ledger_entries SET ref = ref"), { code: "42501" });
  await as("yuubet_auth", "SELECT count(*) FROM auth.users");
  await assert.rejects(as("yuubet_auth", "SELECT count(*) FROM wallet.accounts"), { code: "42501" });
  await as("yuubet_games", "SELECT count(*) FROM games.versus_matches");
  await assert.rejects(as("yuubet_games", "SELECT count(*) FROM wallet.accounts"), { code: "42501" });
});
