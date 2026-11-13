import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GameError,
  colorOf,
  feeOf,
  jackpotPayout,
  parseAmount,
  pickJackpotWinner,
  rouletteBetWins,
  settleRoulette,
  validateRouletteBet,
  versusOutcome,
  versusPayout,
  winChanceBps,
  type RouletteBet,
} from "./index";

test("amounts must be positive digit strings", () => {
  assert.equal(parseAmount("1500000"), 1_500_000n);
  for (const bad of ["0", "-5", "1.5", "1e6", "", " 10", 10, null, "9".repeat(31)]) {
    assert.throws(() => parseAmount(bad), GameError, `accepted ${String(bad)}`);
  }
});

test("fees round down and stay inside the amount", () => {
  assert.equal(feeOf(1000n, 250), 25n);
  assert.equal(feeOf(999n, 1), 0n);
  assert.equal(feeOf(1000n, 10_000), 1000n);
  assert.throws(() => feeOf(1000n, 10_001), RangeError);
});

test("roulette colors: 18 red, 18 black, one green", () => {
  const colors = Array.from({ length: 37 }, (_, n) => colorOf(n));
  assert.equal(colors.filter((c) => c === "red").length, 18);
  assert.equal(colors.filter((c) => c === "black").length, 18);
  assert.equal(colors[0], "green");
  assert.equal(colorOf(32), "red");
  assert.equal(colorOf(15), "black");
});

test("each outside bet covers the right numbers", () => {
  const covered = (bet: Omit<RouletteBet, "amount">) =>
    Array.from({ length: 37 }, (_, n) => n).filter((n) => rouletteBetWins({ ...bet, amount: 1n }, n));

  assert.equal(covered({ type: "red" }).length, 18);
  assert.equal(covered({ type: "odd" }).length, 18);
  assert.deepEqual(
    covered({ type: "low" }),
    Array.from({ length: 18 }, (_, i) => i + 1),
  );
  assert.deepEqual(
    covered({ type: "dozen", value: 2 }),
    Array.from({ length: 12 }, (_, i) => i + 13),
  );
  assert.deepEqual(covered({ type: "column", value: 3 }), [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36]);
  assert.deepEqual(covered({ type: "straight", value: 0 }), [0]);
  // Zero loses every outside bet.
  for (const type of ["red", "black", "odd", "even", "low", "high"] as const) {
    assert.ok(!covered({ type }).includes(0));
  }
});

test("roulette settlement pays 35:1, 2:1 and 1:1", () => {
  const settlement = settleRoulette(
    [
      { type: "straight", value: 17, amount: 10n },
      { type: "black", amount: 20n },
      { type: "dozen", value: 2, amount: 30n },
      { type: "red", amount: 40n },
    ],
    17,
  );
  assert.equal(settlement.color, "black");
  assert.deepEqual(
    settlement.results.map((r) => r.payout),
    [360n, 40n, 90n, 0n],
  );
  assert.equal(settlement.totalStake, 100n);
  assert.equal(settlement.totalPayout, 490n);
});

test("every roulette bet type returns 36/37 of the stake on average", () => {
  const bets: RouletteBet[] = [
    { type: "straight", value: 5, amount: 37n },
    { type: "red", amount: 37n },
    { type: "even", amount: 37n },
    { type: "high", amount: 37n },
    { type: "dozen", value: 1, amount: 37n },
    { type: "column", value: 2, amount: 37n },
  ];
  for (const bet of bets) {
    let returned = 0n;
    for (let n = 0; n <= 36; n++) {
      returned += settleRoulette([bet], n).totalPayout;
    }
    assert.equal(returned, 36n * 37n, `${bet.type} has the wrong house edge`);
  }
});

test("invalid roulette bets are rejected", () => {
  const bad: RouletteBet[] = [
    { type: "straight", value: 37, amount: 1n },
    { type: "straight", amount: 1n },
    { type: "dozen", value: 0, amount: 1n },
    { type: "column", value: 1.5, amount: 1n },
    { type: "red", value: 3, amount: 1n },
    { type: "red", amount: 0n },
    { type: "split" as never, amount: 1n },
  ];
  for (const bet of bad) {
    assert.throws(
      () => validateRouletteBet(bet),
      GameError,
      JSON.stringify(bet, (_, v) => String(v)),
    );
  }
  assert.throws(() => settleRoulette([], 5), GameError);
});

test("versus: roll picks the side and the winner takes the pot minus the fee", () => {
  assert.equal(versusOutcome(0n), "heads");
  assert.equal(versusOutcome(1n), "tails");
  assert.throws(() => versusOutcome(2n), RangeError);
  assert.deepEqual(versusPayout(500n, 200), { pot: 1000n, fee: 20n, prize: 980n });
});

test("jackpot: tickets map to entries in order", () => {
  const entries = [
    { userId: "ann", amount: 100n },
    { userId: "bob", amount: 300n },
    { userId: "ann", amount: 600n },
  ];
  assert.equal(pickJackpotWinner(entries, 0n).userId, "ann");
  assert.equal(pickJackpotWinner(entries, 99n).userId, "ann");
  assert.equal(pickJackpotWinner(entries, 100n).userId, "bob");
  assert.equal(pickJackpotWinner(entries, 399n).userId, "bob");
  assert.equal(pickJackpotWinner(entries, 400n), entries[2]);
  assert.equal(pickJackpotWinner(entries, 999n), entries[2]);
  assert.throws(() => pickJackpotWinner(entries, 1000n), RangeError);

  assert.equal(winChanceBps(entries, "ann"), 7000);
  assert.equal(winChanceBps(entries, "bob"), 3000);
  assert.deepEqual(jackpotPayout(entries, 500), { pot: 1000n, fee: 50n, prize: 950n });
});
