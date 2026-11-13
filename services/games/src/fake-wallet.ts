import { GameError } from "@yuubet/games";
import type { WalletMove, WalletPort } from "./wallet";

/** An in-memory wallet with the same rules as the real one. */
export class FakeWallet implements WalletPort {
  balances = new Map<string, bigint>();
  moves: WalletMove[] = [];
  failNext: string | undefined;

  fund(userId: string, amount: bigint) {
    this.balances.set(userId, (this.balances.get(userId) ?? 0n) + amount);
  }

  balance(userId: string) {
    return this.balances.get(userId) ?? 0n;
  }

  total() {
    return [...this.balances.values()].reduce((sum, value) => sum + value, 0n);
  }

  async move(move: WalletMove) {
    if (this.failNext && move.kind === this.failNext) {
      this.failNext = undefined;
      throw new Error("wallet is down");
    }
    if (this.moves.some((earlier) => earlier.id === move.id)) {
      return;
    }
    const next = this.balance(move.userId) + move.amount;
    if (next < 0n) {
      throw new GameError("INSUFFICIENT_FUNDS", "Not enough balance");
    }
    this.balances.set(move.userId, next);
    this.moves.push(move);
  }
}
