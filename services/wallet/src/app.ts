import { randomUUID } from "node:crypto";
import { HttpError, Router, bodyObject, requireInternal, requireUser } from "@yuubet/service-kit";
import { Ledger, type EntryKind, type LedgerEntry } from "./ledger";

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

/**
 * Balances. Players read their own balance under /me; only other services may
 * move money, under /internal. Crypto deposits and withdrawals are not built yet.
 */
export function buildWalletRouter(config: WalletConfig, ledger = new Ledger()): Router {
  return new Router()
    .get("/health", () => ({ ok: true }))
    .get("/me/balance", (ctx) => {
      requireInternal(ctx, config.internalKey);
      return { balances: ledger.balancesOf(requireUser(ctx).id) };
    })
    .get("/me/transactions", (ctx) => {
      requireInternal(ctx, config.internalKey);
      return { transactions: ledger.history(requireUser(ctx).id).map(view) };
    })
    .post("/me/faucet", (ctx) => {
      requireInternal(ctx, config.internalKey);
      const user = requireUser(ctx);
      if (!config.devFaucet) {
        throw new HttpError(404, "NOT_FOUND", "No such endpoint");
      }
      if (ledger.balance(user.id, "USDT") >= FAUCET_MAX_BALANCE) {
        throw new HttpError(409, "FAUCET_LIMIT", "Your balance is already high enough to play");
      }
      ledger.apply({
        id: randomUUID(),
        userId: user.id,
        currency: "USDT",
        amount: FAUCET_AMOUNT,
        kind: "faucet",
        ref: "dev-faucet",
      });
      return { balances: ledger.balancesOf(user.id) };
    })
    .post("/internal/transactions", (ctx) => {
      requireInternal(ctx, config.internalKey);
      const body = bodyObject(ctx);
      if (typeof body.amount !== "string" || !/^-?[0-9]{1,30}$/.test(body.amount)) {
        throw new HttpError(400, "INVALID_TRANSACTION", "amount must be a whole number as a string");
      }
      const entry = ledger.apply({
        id: String(body.id ?? ""),
        userId: String(body.userId ?? ""),
        currency: String(body.currency ?? ""),
        amount: BigInt(body.amount),
        kind: body.kind as EntryKind,
        ref: String(body.ref ?? ""),
      });
      return view(entry);
    });
}
