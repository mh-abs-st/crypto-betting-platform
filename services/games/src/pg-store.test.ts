import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { createPool, type Pool } from "@yuubet/db";
import { createTestDatabase, skipWithoutDatabase, type TestDatabase } from "@yuubet/db/testing";
import { FakeWallet } from "./fake-wallet";
import { PgGamesStore } from "./pg-store";
import { DEFAULT_GAMES_CONFIG, GamesService } from "./service";

/**
 * The games service against PostgreSQL across restarts, and with two
 * instances sharing one database, as in production.
 */
const USDT = 1_000_000n;
const player = (name: string) => ({ id: randomUUID(), name });

let db: TestDatabase;
const pools: Pool[] = [];
let clock = 1_000_000;

before(async () => {
  if (!skipWithoutDatabase) db = await createTestDatabase();
});
after(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await db?.drop();
});

beforeEach(async () => {
  if (skipWithoutDatabase) return;
  await db.pool.query(
    "TRUNCATE games.jackpot_entries, games.jackpot_rounds, games.versus_matches, games.roulette_spins, games.seed_pairs",
  );
});

/** A games service with its own connection pool, like a separate process. */
async function instance(wallet: FakeWallet) {
  const pool = createPool(db.url, { max: 5 });
  pools.push(pool);
  return GamesService.create(wallet, { ...DEFAULT_GAMES_CONFIG, now: () => clock }, new PgGamesStore(pool));
}

function funded(...names: string[]) {
  const wallet = new FakeWallet();
  const users = names.map(player);
  users.forEach((user) => wallet.fund(user.id, 100n * USDT));
  return { wallet, users };
}

describe("games on PostgreSQL", { skip: skipWithoutDatabase }, () => {
  test("a restart keeps open matches, the jackpot round and unrevealed seeds", async () => {
    const { wallet, users } = funded("ann", "bob", "cat");
    const [ann, bob, cat] = users as [ReturnType<typeof player>, ReturnType<typeof player>, ReturnType<typeof player>];
    const first = await instance(wallet);

    const match = await first.createVersus(ann, { amount: String(5n * USDT), side: "heads" });
    await first.enterJackpot(ann, { amount: String(2n * USDT) });
    await first.enterJackpot(bob, { amount: String(3n * USDT) });
    const spin = await first.spinRoulette(cat, { bets: [{ type: "red", amount: String(USDT) }] });
    const before = await first.currentJackpot();

    const restarted = await instance(wallet);
    assert.deepEqual((await restarted.listVersus()).open.map((m) => m.id), [match.id]);
    const round = await restarted.currentJackpot();
    assert.equal(round.id, before.id);
    assert.equal(round.closesAt, before.closesAt);
    assert.deepEqual(round.entries.map((entry) => [entry.user.name, entry.amount]), [["ann", 2n * USDT], ["bob", 3n * USDT]]);
    assert.deepEqual(await restarted.seedInfo(cat.id), { ...spin.fairness, nonce: 1 });

    // The restarted instance finishes what the first one started.
    const settled = await restarted.joinVersus(bob, match.id, {});
    assert.equal(settled.status, "settled");
    const { revealed } = await restarted.rotateSeed(cat.id, undefined);
    assert.equal(revealed.serverSeedHash, spin.fairness.serverSeedHash);
    assert.equal(revealed.betsPlaced, 1);

    const { rows } = await db.pool.query("SELECT nonce::int, number::int FROM games.roulette_spins WHERE id = $1", [spin.betId]);
    assert.deepEqual(rows[0], { nonce: 0, number: spin.number });
  });

  test("two instances: one joiner per match, and a nonce is never reused", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const { wallet, users } = funded("host", ...names);
    const [host, ...joiners] = users as Array<ReturnType<typeof player>>;
    const a = await instance(wallet);
    const b = await instance(wallet);

    const match = await a.createVersus(host!, { amount: String(USDT), side: "tails" });
    const joins = await Promise.allSettled(joiners.map((user, i) => (i % 2 ? a : b).joinVersus(user, match.id, {})));
    assert.equal(joins.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(wallet.moves.filter((move) => move.id === `${match.id}:joiner`).length, 1);
    assert.equal(wallet.moves.filter((move) => move.id === `${match.id}:prize`).length, 1);

    const spinner = joiners[0]!;
    const spins = await Promise.all(
      Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).spinRoulette(spinner, { bets: [{ type: "odd", amount: String(USDT / 100n) }] })),
    );
    assert.deepEqual(spins.map((s) => s.fairness.nonce).sort((x, y) => x - y), Array.from({ length: 30 }, (_, i) => i));
    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM games.roulette_spins WHERE user_id = $1", [spinner.id]);
    assert.equal(rows[0].n, 30);
  });

  test("two instances: the jackpot is drawn and paid once, and the next round opens once", async () => {
    const { wallet, users } = funded("ann", "bob", "cat", "dan");
    const a = await instance(wallet);
    const b = await instance(wallet);

    await Promise.all(users.map((user, i) => (i % 2 ? a : b).enterJackpot(user, { amount: String(BigInt(i + 1) * USDT) })));
    const round = await a.currentJackpot();
    assert.equal(round.entries.length, 4);
    assert.equal(new Set((await db.pool.query("SELECT position FROM games.jackpot_entries")).rows.map((r) => r.position)).size, 4);

    clock += DEFAULT_GAMES_CONFIG.jackpotDurationMs;
    const draws = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).drawJackpotIfDue()));
    assert.equal(draws.filter(Boolean).length, 1);
    assert.equal(wallet.moves.filter((move) => move.kind === "win").length, 1);

    const { rows } = await db.pool.query("SELECT status, count(*)::int AS n FROM games.jackpot_rounds GROUP BY status ORDER BY status");
    assert.deepEqual(rows, [{ status: "open", n: 1 }, { status: "settled", n: 1 }]);
    assert.equal((await b.listJackpotHistory()).rounds[0]!.id, round.id);
  });

  test("a draw interrupted by a failed payout is finished after a restart", async () => {
    const { wallet, users } = funded("ann", "bob");
    const first = await instance(wallet);
    for (const user of users) {
      await first.enterJackpot(user, { amount: String(USDT) });
    }
    clock += DEFAULT_GAMES_CONFIG.jackpotDurationMs;
    wallet.failNext = "win";
    await assert.rejects(first.drawJackpotIfDue(), /wallet is down/);
    await assert.rejects(first.enterJackpot(users[0]!, { amount: String(USDT) }), { code: "ROUND_CLOSING" });

    const restarted = await instance(wallet);
    const settled = await restarted.drawJackpotIfDue();
    assert.equal(settled?.status, "settled");
    assert.equal(wallet.moves.filter((move) => move.kind === "win").length, 1);
    assert.equal((await restarted.currentJackpot()).entries.length, 0);
  });
});
