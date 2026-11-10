import assert from "node:assert/strict";
import { test } from "node:test";
import { Ledger, type LedgerInput } from "./ledger";

const tx = (overrides: Partial<LedgerInput>): LedgerInput => ({
  id: "t1",
  userId: "ann",
  currency: "USDT",
  amount: 100n,
  kind: "deposit",
  ref: "test",
  ...overrides,
});

test("credits and debits change the balance", () => {
  const ledger = new Ledger();
  ledger.apply(tx({ id: "a", amount: 500n }));
  const entry = ledger.apply(tx({ id: "b", amount: -200n, kind: "bet" }));
  assert.equal(entry.balanceAfter, 300n);
  assert.equal(ledger.balance("ann", "USDT"), 300n);
  assert.equal(ledger.balance("bob", "USDT"), 0n);
});

test("a balance cannot go below zero", () => {
  const ledger = new Ledger();
  ledger.apply(tx({ id: "a", amount: 100n }));
  assert.throws(() => ledger.apply(tx({ id: "b", amount: -101n, kind: "bet" })), { code: "INSUFFICIENT_FUNDS" });
  assert.equal(ledger.balance("ann", "USDT"), 100n);
  ledger.apply(tx({ id: "c", amount: -100n, kind: "bet" }));
  assert.equal(ledger.balance("ann", "USDT"), 0n);
});

test("repeating a transaction id applies it once", () => {
  const ledger = new Ledger();
  const first = ledger.apply(tx({ id: "a", amount: 100n }));
  const again = ledger.apply(tx({ id: "a", amount: 100n }));
  assert.equal(again, first);
  assert.equal(ledger.balance("ann", "USDT"), 100n);
  assert.throws(() => ledger.apply(tx({ id: "a", amount: 999n })), { code: "ID_REUSED" });
});

test("invalid transactions are rejected", () => {
  const ledger = new Ledger();
  assert.throws(() => ledger.apply(tx({ currency: "DOGE" })), { code: "UNKNOWN_CURRENCY" });
  assert.throws(() => ledger.apply(tx({ amount: 0n })), { code: "INVALID_TRANSACTION" });
  assert.throws(() => ledger.apply(tx({ kind: "gift" as never })), { code: "INVALID_TRANSACTION" });
  assert.throws(() => ledger.apply(tx({ userId: "" })), { code: "INVALID_TRANSACTION" });
});

test("history lists a player's entries, newest first", () => {
  const ledger = new Ledger();
  ledger.apply(tx({ id: "a", amount: 100n }));
  ledger.apply(tx({ id: "b", amount: -40n, kind: "bet" }));
  ledger.apply(tx({ id: "c", userId: "bob", amount: 5n }));
  assert.deepEqual(ledger.history("ann").map((entry) => entry.id), ["b", "a"]);
});
