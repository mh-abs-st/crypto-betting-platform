import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createPool } from "@yuubet/db";
import { createTestDatabase, skipWithoutDatabase, type TestDatabase } from "@yuubet/db/testing";
import { MemoryLedger, type LedgerInput, type LedgerStore } from "./ledger";
import { PgLedger } from "./pg-ledger";

let ann = "";
let bob = "";

const tx = (overrides: Partial<LedgerInput>): LedgerInput => ({
  id: randomUUID(),
  userId: ann,
  currency: "USDT",
  amount: 100n,
  kind: "deposit",
  ref: "test",
  ...overrides,
});

/** The same rules must hold for every implementation. */
function contract(name: string, make: () => Promise<LedgerStore>, skip: string | false = false) {
  describe(name, { skip }, () => {
    let ledger: LedgerStore;
    before(() => {
      ann = randomUUID();
      bob = randomUUID();
    });

    test("credits and debits change the balance", async () => {
      ledger = await make();
      await ledger.apply(tx({ amount: 500n }));
      const entry = await ledger.apply(tx({ amount: -200n, kind: "bet" }));
      assert.equal(entry.balanceAfter, 300n);
      assert.equal(await ledger.balance(ann, "USDT"), 300n);
      assert.equal(await ledger.balance(bob, "USDT"), 0n);
      assert.deepEqual(await ledger.balancesOf(ann), [{ currency: "USDT", amount: 300n, decimals: 6 }]);
      assert.deepEqual(await ledger.balancesOf(bob), [{ currency: "USDT", amount: 0n, decimals: 6 }]);
    });

    test("a balance cannot go below zero", async () => {
      ledger = await make();
      await ledger.apply(tx({ userId: bob, amount: 100n }));
      await assert.rejects(ledger.apply(tx({ userId: bob, amount: -101n, kind: "bet" })), { code: "INSUFFICIENT_FUNDS" });
      assert.equal(await ledger.balance(bob, "USDT"), 100n);
      await ledger.apply(tx({ userId: bob, amount: -100n, kind: "bet" }));
      assert.equal(await ledger.balance(bob, "USDT"), 0n);
      const stranger = randomUUID();
      await assert.rejects(ledger.apply(tx({ userId: stranger, amount: -1n, kind: "bet" })), { code: "INSUFFICIENT_FUNDS" });
    });

    test("repeating a transaction id applies it once", async () => {
      ledger = await make();
      const user = randomUUID();
      const id = randomUUID();
      const first = await ledger.apply(tx({ id, userId: user, amount: 100n }));
      const again = await ledger.apply(tx({ id, userId: user, amount: 100n }));
      assert.deepEqual(again, first);
      assert.equal(await ledger.balance(user, "USDT"), 100n);
      await assert.rejects(ledger.apply(tx({ id, userId: user, amount: 999n })), { code: "ID_REUSED" });
      await assert.rejects(ledger.apply(tx({ id, userId: randomUUID(), amount: 100n })), { code: "ID_REUSED" });
    });

    test("invalid transactions are rejected", async () => {
      ledger = await make();
      await assert.rejects(ledger.apply(tx({ currency: "DOGE" })), { code: "UNKNOWN_CURRENCY" });
      await assert.rejects(ledger.apply(tx({ amount: 0n })), { code: "INVALID_TRANSACTION" });
      await assert.rejects(ledger.apply(tx({ kind: "gift" as never })), { code: "INVALID_TRANSACTION" });
      await assert.rejects(ledger.apply(tx({ userId: "" })), { code: "INVALID_TRANSACTION" });
      await assert.rejects(ledger.apply(tx({ id: "x".repeat(201) })), { code: "INVALID_TRANSACTION" });
    });

    test("history lists a player's entries, newest first", async () => {
      ledger = await make();
      const user = randomUUID();
      await ledger.apply(tx({ id: `${user}-a`, userId: user, amount: 100n }));
      await ledger.apply(tx({ id: `${user}-b`, userId: user, amount: -40n, kind: "bet" }));
      await ledger.apply(tx({ id: `${user}-c`, userId: user, amount: 5n, kind: "win" }));
      await ledger.apply(tx({ userId: randomUUID(), amount: 5n }));
      assert.deepEqual((await ledger.history(user)).map((entry) => entry.id), [`${user}-c`, `${user}-b`, `${user}-a`]);
      assert.deepEqual((await ledger.history(user, 2)).map((entry) => entry.id), [`${user}-c`, `${user}-b`]);
    });
  });
}

contract("MemoryLedger", async () => new MemoryLedger());

let db: TestDatabase;
before(async () => {
  if (!skipWithoutDatabase) db = await createTestDatabase();
});
after(async () => {
  await db?.drop();
});
contract("PgLedger", async () => new PgLedger(db.pool), skipWithoutDatabase);

describe("PgLedger under load", { skip: skipWithoutDatabase }, () => {
  test("many simultaneous bets never overdraw or lose an entry", async () => {
    const ledger = new PgLedger(db.pool);
    const user = randomUUID();
    await ledger.apply(tx({ userId: user, amount: 1_000n }));

    // 300 bets of 10 against a balance of 1000: exactly 100 can be taken.
    const results = await Promise.allSettled(
      Array.from({ length: 300 }, () => ledger.apply(tx({ userId: user, amount: -10n, kind: "bet" }))),
    );
    const taken = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter((r) => r.status === "rejected" && (r.reason as { code?: string }).code === "INSUFFICIENT_FUNDS").length;
    assert.equal(taken, 100);
    assert.equal(refused, 200);
    assert.equal(await ledger.balance(user, "USDT"), 0n);

    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n, sum(amount)::text AS total, min(balance_after)::text AS lowest FROM wallet.ledger_entries WHERE user_id = $1",
      [user],
    );
    assert.deepEqual(rows[0], { n: 101, total: "0", lowest: "0" });
  });

  test("the same id sent many times at once is applied once", async () => {
    const ledger = new PgLedger(db.pool);
    const user = randomUUID();
    const id = randomUUID();
    const results = await Promise.all(Array.from({ length: 50 }, () => ledger.apply(tx({ id, userId: user, amount: 7n }))));
    assert.ok(results.every((entry) => entry.id === id && entry.balanceAfter === 7n));
    assert.equal(await ledger.balance(user, "USDT"), 7n);
  });

  test("the same id for two players at once is applied for one of them", async () => {
    const ledger = new PgLedger(db.pool);
    const id = randomUUID();
    const [one, two] = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled([
      ledger.apply(tx({ id, userId: one, amount: 5n })),
      ledger.apply(tx({ id, userId: two, amount: 5n })),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.equal(failed.reason.code, "ID_REUSED");
    assert.equal((await ledger.balance(one, "USDT")) + (await ledger.balance(two, "USDT")), 5n);
  });

  test("balances survive a restart", async () => {
    const user = randomUUID();
    await new PgLedger(db.pool).apply(tx({ userId: user, amount: 42n }));
    const fresh = createPool(db.url, { max: 2 });
    try {
      assert.equal(await new PgLedger(fresh).balance(user, "USDT"), 42n);
      assert.equal((await new PgLedger(fresh).history(user))[0]?.amount, 42n);
    } finally {
      await fresh.end();
    }
  });

  test("the wallet role can do everything the ledger needs", async () => {
    const user = randomUUID();
    // Run one entry's statements as the wallet role, on one connection.
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE yuubet_wallet");
      await client.query("INSERT INTO wallet.accounts (user_id, currency) VALUES ($1, 'USDT') ON CONFLICT DO NOTHING", [user]);
      await client.query("SELECT balance FROM wallet.accounts WHERE user_id = $1 FOR UPDATE", [user]);
      await client.query("UPDATE wallet.accounts SET balance = 1 WHERE user_id = $1", [user]);
      await client.query(
        "INSERT INTO wallet.ledger_entries (id, user_id, currency, amount, kind, ref, balance_after) VALUES ($1, $2, 'USDT', 1, 'deposit', 'r', 1)",
        [randomUUID(), user],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});
