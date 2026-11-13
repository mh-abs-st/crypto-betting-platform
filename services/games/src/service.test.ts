import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { createTestDatabase, skipWithoutDatabase, type TestDatabase } from "@yuubet/db/testing";
import { fairInt, verifyCommitment } from "@yuubet/fair";
import { GameError, pickJackpotWinner, settleRoulette } from "@yuubet/games";
import { DEFAULT_GAMES_CONFIG, GamesService } from "./service";
import { PgGamesStore } from "./pg-store";
import { MemoryGamesStore, type GamesStore } from "./store";
import { FakeWallet } from "./fake-wallet";

const player = (name: string) => ({ id: randomUUID(), name });
let ann = player("ann");
let bob = player("bob");
let cat = player("cat");
const USDT = 1_000_000n;

let makeStore: () => Promise<GamesStore> = async () => new MemoryGamesStore();

async function setup(overrides = {}) {
  [ann, bob, cat] = [player("ann"), player("bob"), player("cat")];
  const wallet = new FakeWallet();
  for (const user of [ann, bob, cat]) {
    wallet.fund(user.id, 100n * USDT);
  }
  let clock = 1_000_000;
  const config = { ...DEFAULT_GAMES_CONFIG, now: () => clock, ...overrides };
  const service = await GamesService.create(wallet, config, await makeStore());
  return { wallet, service, config, advance: (ms: number) => (clock += ms) };
}

/** Every game rule must hold with each store. */
function games(label: string, store: () => Promise<GamesStore>, skip: string | false = false) {
  describe(label, { skip }, () => {
    beforeEach(() => {
      makeStore = store;
    });

  test("roulette: stake is taken, winnings paid, and the result can be verified", async () => {
    const { wallet, service } = await setup();
    const before = await service.seedInfo(ann.id);

    const spins = [];
    for (let i = 0; i < 30; i++) {
      spins.push(
        await service.spinRoulette(ann, {
          bets: [
            { type: "red", amount: String(USDT) },
            { type: "straight", value: 7, amount: String(USDT / 10n) },
          ],
        }),
      );
    }

    const staked = spins.reduce((sum, spin) => sum + spin.totalStake, 0n);
    const paid = spins.reduce((sum, spin) => sum + spin.totalPayout, 0n);
    assert.equal(wallet.balance(ann.id), 100n * USDT - staked + paid);
    assert.deepEqual(spins.map((spin) => spin.fairness.nonce), spins.map((_, i) => i));
    assert.ok(spins.every((spin) => spin.fairness.serverSeedHash === before.serverSeedHash));

    // Reveal the seed and recompute every spin exactly as a player would.
    const { revealed, current } = await service.rotateSeed(ann.id, "my-new-seed");
    assert.equal(await verifyCommitment(revealed.serverSeed, before.serverSeedHash), true);
    assert.equal(revealed.betsPlaced, 30);
    assert.deepEqual({ clientSeed: current.clientSeed, nonce: current.nonce }, { clientSeed: "my-new-seed", nonce: 0 });
    assert.notEqual(current.serverSeedHash, before.serverSeedHash);

    for (const spin of spins) {
      const roll = await fairInt(
        { serverSeed: revealed.serverSeed, clientSeed: spin.fairness.clientSeed, nonce: spin.fairness.nonce },
        37n,
      );
      assert.equal(spin.number, Number(roll));
      const expected = settleRoulette(
        spin.bets.map((bet) => ({ type: bet.type, value: bet.value, amount: bet.amount })),
        spin.number,
      );
      assert.equal(spin.totalPayout, expected.totalPayout);
    }
  });

  test("roulette: bad bets and empty wallets are refused before anything moves", async () => {
    const { wallet, service } = await setup();
    const bad = [
      { bets: [] },
      { bets: "red" },
      { bets: [{ type: "red", amount: "1" }] },
      { bets: [{ type: "red", amount: String(2000n * USDT) }] },
      { bets: [{ type: "straight", value: 40, amount: String(USDT) }] },
      { bets: [{ type: "red", amount: 5 }] },
      { bets: [null] },
    ];
    for (const input of bad) {
      await assert.rejects(service.spinRoulette(ann, input), GameError, JSON.stringify(input));
    }
    await assert.rejects(service.spinRoulette(ann, { bets: [{ type: "red", amount: String(101n * USDT) }] }), {
      code: "INSUFFICIENT_FUNDS",
    });
    assert.equal(wallet.moves.length, 0);
    assert.equal((await service.seedInfo(ann.id)).nonce, 0);
  });

  test("roulette: concurrent spins never share a nonce", async () => {
    const { service } = await setup();
    const spins = await Promise.all(
      Array.from({ length: 20 }, () => service.spinRoulette(ann, { bets: [{ type: "black", amount: String(USDT) }] })),
    );
    assert.equal(new Set(spins.map((spin) => spin.fairness.nonce)).size, 20);
  });

  test("versus: winner takes the pot minus the fee and the result can be verified", async () => {
    const { wallet, service } = await setup();
    const created = await service.createVersus(ann, { amount: String(10n * USDT), side: "heads", clientSeed: "ann-seed" });
    assert.equal(created.status, "open");
    assert.equal(created.serverSeed, undefined);
    assert.equal(wallet.balance(ann.id), 90n * USDT);
    assert.equal((await service.listVersus()).open.length, 1);

    const settled = await service.joinVersus(bob, created.id, { clientSeed: "bob-seed" });
    assert.equal(settled.status, "settled");
    assert.equal(settled.clientSeed, "ann-seed:bob-seed");
    assert.equal(await verifyCommitment(settled.serverSeed!, created.serverSeedHash), true);

    const roll = await fairInt({ serverSeed: settled.serverSeed!, clientSeed: settled.clientSeed!, nonce: 0 }, 2n);
    const expectedSide = roll === 0n ? "heads" : "tails";
    assert.equal(settled.result, expectedSide);
    assert.equal(settled.winner!.id, expectedSide === "heads" ? ann.id : bob.id);

    const loser = settled.winner!.id === ann.id ? bob : ann;
    assert.equal(settled.fee, (20n * USDT * 2n) / 100n);
    assert.equal(wallet.balance(settled.winner!.id), 90n * USDT + settled.prize!);
    assert.equal(wallet.balance(loser.id), 90n * USDT);
    assert.equal(wallet.total(), 300n * USDT - settled.fee!);
    assert.equal((await service.listVersus()).open.length, 0);
    assert.equal((await service.listVersus()).recent.length, 1);
  });

  test("versus: both sides win about half the time", async () => {
    const { service } = await setup({ minBet: 1n });
    let heads = 0;
    for (let i = 0; i < 200; i++) {
      const match = await service.createVersus(ann, { amount: "1", side: "heads" });
      const settled = await service.joinVersus(bob, match.id, {});
      heads += settled.result === "heads" ? 1 : 0;
    }
    assert.ok(heads > 70 && heads < 130, `heads won ${heads} of 200`);
  });

  test("versus: only one joiner gets in, and rules are enforced", async () => {
    const { wallet, service } = await setup();
    const match = await service.createVersus(ann, { amount: String(10n * USDT), side: "tails" });

    await assert.rejects(service.joinVersus(ann, match.id, {}), { code: "OWN_MATCH" });
    await assert.rejects(service.cancelVersus(bob, match.id), { code: "NOT_YOUR_MATCH" });
    await assert.rejects(service.joinVersus(bob, "missing", {}), { code: "NOT_FOUND" });
    await assert.rejects(service.createVersus(ann, { amount: String(USDT), side: "edge" }), { code: "INVALID_SIDE" });
    await assert.rejects(service.createVersus(ann, { amount: String(USDT), side: "heads", clientSeed: "a:b" }), {
      code: "INVALID_SEED",
    });

    const results = await Promise.allSettled([service.joinVersus(bob, match.id, {}), service.joinVersus(cat, match.id, {})]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(wallet.moves.filter((move) => move.id.endsWith(":joiner")).length, 1);
    await assert.rejects(service.cancelVersus(ann, match.id), { code: "MATCH_CLOSED" });
  });

  test("versus: a joiner who cannot pay leaves the match open; cancelling refunds", async () => {
    const { wallet, service } = await setup();
    const match = await service.createVersus(ann, { amount: String(60n * USDT), side: "heads" });
    wallet.balances.set(bob.id, USDT);
    await assert.rejects(service.joinVersus(bob, match.id, {}), { code: "INSUFFICIENT_FUNDS" });
    assert.equal((await service.listVersus()).open.length, 1);

    const cancelled = await service.cancelVersus(ann, match.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(wallet.balance(ann.id), 100n * USDT);
    await assert.rejects(service.joinVersus(cat, match.id, {}), { code: "MATCH_CLOSED" });
  });

  test("jackpot: the timer starts with the second player and the draw can be verified", async () => {
    const { wallet, service, advance } = await setup();
    const first = await service.currentJackpot();

    let round = await service.enterJackpot(ann, { amount: String(10n * USDT) });
    assert.equal(round.closesAt, undefined);
    round = await service.enterJackpot(ann, { amount: String(10n * USDT) });
    assert.equal(round.closesAt, undefined, "one player alone does not start the timer");
    round = await service.enterJackpot(bob, { amount: String(30n * USDT) });
    assert.ok(round.closesAt);
    assert.deepEqual(round.entries.map((entry) => entry.chanceBps), [4000, 4000, 6000]);
    assert.equal(round.serverSeed, undefined);

    assert.equal(await service.drawJackpotIfDue(), undefined, "not due yet");
    advance(DEFAULT_GAMES_CONFIG.jackpotDurationMs);
    await assert.rejects(service.enterJackpot(cat, { amount: String(USDT) }), { code: "ROUND_CLOSING" });

    const settled = (await service.drawJackpotIfDue())!;
    assert.equal(settled.status, "settled");
    assert.equal(settled.pot, 50n * USDT);
    assert.equal(settled.fee, (50n * USDT * 5n) / 100n);
    assert.equal(await verifyCommitment(settled.serverSeed!, first.serverSeedHash), true);

    const ticket = await fairInt({ serverSeed: settled.serverSeed!, clientSeed: settled.clientSeed!, nonce: 0 }, settled.pot);
    assert.equal(settled.winningTicket, ticket);
    const expected = pickJackpotWinner(
      settled.entries.map((entry) => ({ userId: entry.user.id, amount: entry.amount })),
      ticket,
    );
    assert.equal(settled.winner!.id, expected.userId);

    const staked = { [ann.id]: 20n * USDT, [bob.id]: 30n * USDT };
    for (const user of [ann, bob]) {
      const won = user.id === settled.winner!.id ? settled.prize! : 0n;
      assert.equal(wallet.balance(user.id), 100n * USDT - staked[user.id]! + won);
    }
    assert.equal(wallet.total(), 300n * USDT - settled.fee!);

    const next = await service.currentJackpot();
    assert.equal(next.number, first.number + 1);
    assert.equal(next.entries.length, 0);
    assert.notEqual(next.serverSeedHash, first.serverSeedHash);
    assert.equal((await service.listJackpotHistory()).rounds[0]!.id, settled.id);
    assert.equal(await service.drawJackpotIfDue(), undefined);
  });

  test("jackpot: a failed payout is retried and paid exactly once", async () => {
    const { wallet, service, advance } = await setup();
    await service.enterJackpot(ann, { amount: String(10n * USDT) });
    await service.enterJackpot(bob, { amount: String(10n * USDT) });
    advance(DEFAULT_GAMES_CONFIG.jackpotDurationMs);

    wallet.failNext = "win";
    await assert.rejects(service.drawJackpotIfDue(), /wallet is down/);
    assert.equal(wallet.moves.filter((move) => move.kind === "win").length, 0);

    const [first, second] = await Promise.all([service.drawJackpotIfDue(), service.drawJackpotIfDue()]);
    assert.equal([first, second].filter(Boolean).length, 1, "concurrent draws settle the round once");
    assert.equal(wallet.moves.filter((move) => move.kind === "win").length, 1);
  });

  test("jackpot: stake share decides the winner over many rounds", async () => {
    const { service, advance } = await setup({ minBet: 1n, jackpotFeeBps: 0 });
    let annWins = 0;
    for (let i = 0; i < 300; i++) {
      await service.enterJackpot(ann, { amount: "3" });
      await service.enterJackpot(bob, { amount: "1" });
      advance(DEFAULT_GAMES_CONFIG.jackpotDurationMs);
      annWins += (await service.drawJackpotIfDue())!.winner!.id === ann.id ? 1 : 0;
    }
    // Ann holds 75% of each pot: expect about 225 of 300.
    assert.ok(annWins > 195 && annWins < 255, `ann won ${annWins} of 300`);
  });
  });
}

games("games in memory", async () => new MemoryGamesStore());

let db: TestDatabase;
before(async () => {
  if (!skipWithoutDatabase) db = await createTestDatabase();
});
after(async () => {
  await db?.drop();
});

/** A fresh games schema for each test, so lobbies and rounds start empty. */
async function emptyPgStore() {
  await db.pool.query(
    "TRUNCATE games.jackpot_entries, games.jackpot_rounds, games.versus_matches, games.roulette_spins, games.seed_pairs",
  );
  return new PgGamesStore(db.pool);
}

games("games on PostgreSQL", emptyPgStore, skipWithoutDatabase);
