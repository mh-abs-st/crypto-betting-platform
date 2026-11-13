import { randomUUID } from "node:crypto";
import { HttpError, Router, bodyObject, requireInternal, requireUser, schema } from "@yuubet/service-kit";
import { MemoryLedger, type EntryKind, type LedgerEntry, type LedgerStore } from "./ledger";

export interface WalletConfig {
  internalKey: string;
  /** Lets players credit themselves with play money. Development only. */
  devFaucet: boolean;
}

const FAUCET_AMOUNT = 100_000_000n; // 100 USDT
const FAUCET_MAX_BALANCE = 1_000_000_000n; // 1000 USDT

function view(entry: LedgerEntry) {
  return {
    id: entry.id,
    currency: entry.currency,
    amount: entry.amount,
    kind: entry.kind,
    ref: entry.ref,
    balanceAfter: entry.balanceAfter,
    createdAt: entry.createdAt,
  };
}

const balancesReply = schema.reply({
  balances: {
    type: "array",
    items: schema.reply({ currency: { type: "string" }, amount: schema.amount, decimals: { type: "integer" } }),
  },
});
const entryReply = schema.reply({
  id: { type: "string" },
  currency: { type: "string" },
  amount: schema.amount,
  kind: { type: "string", enum: ["deposit", "withdrawal", "bet", "win", "refund", "faucet"] },
  ref: { type: "string" },
  balanceAfter: schema.amount,
  createdAt: { type: "integer", description: "Milliseconds since 1970" },
});

/**
 * Balances. Players read their own balance under /me; only other services may
 * move money, under /internal. Crypto deposits and withdrawals are not built yet.
 */
export function buildWalletRouter(config: WalletConfig, ledger: LedgerStore = new MemoryLedger()): Router {
  return new Router({ internalKey: config.internalKey, title: "YuuBet wallet service" })
    .get("/health", () => ({ ok: true }), { response: { 200: schema.ok } })
    .get("/me/balance", async (ctx) => {
      requireInternal(ctx, config.internalKey);
      return { balances: await ledger.balancesOf(requireUser(ctx).id) };
    }, { summary: "Your balances", response: { 200: balancesReply } })
    .get("/me/transactions", async (ctx) => {
      requireInternal(ctx, config.internalKey);
      return { transactions: (await ledger.history(requireUser(ctx).id)).map(view) };
    }, {
      summary: "Your latest balance changes, newest first",
      response: { 200: schema.reply({ transactions: { type: "array", items: entryReply } }) },
    })
    .post("/me/faucet", async (ctx) => {
      requireInternal(ctx, config.internalKey);
      const user = requireUser(ctx);
      if (!config.devFaucet) {
        throw new HttpError(404, "NOT_FOUND", "No such endpoint");
      }
      if ((await ledger.balance(user.id, "USDT")) >= FAUCET_MAX_BALANCE) {
        throw new HttpError(409, "FAUCET_LIMIT", "Your balance is already high enough to play");
      }
      await ledger.apply({
        id: randomUUID(),
        userId: user.id,
        currency: "USDT",
        amount: FAUCET_AMOUNT,
        kind: "faucet",
        ref: "dev-faucet",
      });
      return { balances: await ledger.balancesOf(user.id) };
    }, {
      summary: "Play money for development (disabled in production)",
      body: schema.object({}),
      response: { 200: balancesReply, 404: schema.errorReply, 409: schema.errorReply },
    })
    .post("/internal/transactions", async (ctx) => {
      requireInternal(ctx, config.internalKey);
      const body = bodyObject(ctx);
      if (typeof body.amount !== "string" || !/^-?[0-9]{1,30}$/.test(body.amount)) {
        throw new HttpError(400, "INVALID_TRANSACTION", "amount must be a whole number as a string");
      }
      const entry = await ledger.apply({
        id: String(body.id ?? ""),
        userId: String(body.userId ?? ""),
        currency: String(body.currency ?? ""),
        amount: BigInt(body.amount),
        kind: body.kind as EntryKind,
        ref: String(body.ref ?? ""),
      });
      return view(entry);
    }, {
      summary: "Move money (other services only). Repeating an id has no further effect.",
      body: schema.object(
        {
          id: schema.text(200, "Chosen by the caller; unique per movement"),
          userId: schema.text(64),
          currency: schema.text(16),
          amount: { ...schema.amount, description: "Positive credits, negative debits" },
          kind: schema.text(16),
          ref: schema.text(200, "What caused the movement, for example a bet id"),
        },
        ["id", "userId", "currency", "amount", "kind", "ref"],
      ),
      response: { 200: entryReply, 400: schema.errorReply, 409: schema.errorReply },
    });
}
