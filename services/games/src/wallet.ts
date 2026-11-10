import { callService } from "@yuubet/service-kit";

export interface WalletMove {
  /** Unique per movement, so a retry cannot move money twice. */
  id: string;
  userId: string;
  currency: string;
  /** Negative takes a stake, positive pays out. Smallest units. */
  amount: bigint;
  kind: "bet" | "win" | "refund";
  ref: string;
}

/** How the games move money. The wallet service is the only place balances live. */
export interface WalletPort {
  move(move: WalletMove): Promise<void>;
}

export class HttpWallet implements WalletPort {
  constructor(
    private readonly baseUrl: string,
    private readonly internalKey: string,
  ) {}

  async move(move: WalletMove): Promise<void> {
    await callService(this.baseUrl, "/internal/transactions", {
      method: "POST",
      internalKey: this.internalKey,
      body: { ...move, amount: move.amount.toString() },
    });
  }
}
