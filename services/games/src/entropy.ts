import { createHash, randomBytes } from "node:crypto";

/**
 * Public randomness nobody controls: block hashes of a blockchain. A Jackpot
 * round commits to a block that does not exist yet when its entries close,
 * and its draw uses that block's hash, so neither the house (which knows the
 * server seed) nor a player can steer the winner by choosing when or how much
 * to enter.
 */
export interface EntropySource {
  /** Shown to players with the result, for example "ethereum". */
  readonly name: string;
  /** Height of the newest block. */
  tip(): Promise<number>;
  /**
   * The hash of the block at `height` once enough blocks are on top of it
   * that a reorganisation is very unlikely; undefined until then.
   */
  settledHash(height: number): Promise<string | undefined>;
}

/**
 * How far past the newest block a round commits. One block would be enough
 * if our node were never behind; two leaves a block of margin, so the
 * committed block cannot already exist when entries close.
 */
export const BLOCKS_AHEAD = 2;

const HASH = /^0x[0-9a-f]{64}$/;

/** Ethereum mainnet through any JSON-RPC endpoint. Blocks come about every 12 seconds. */
export class EthereumEntropy implements EntropySource {
  readonly name = "ethereum";

  constructor(
    private readonly rpcUrl: string,
    /** Blocks that must follow the committed block before its hash is used. */
    private readonly confirmations = 3,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const response = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`Ethereum RPC ${method} failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as { result?: T; error?: { message?: string } };
    if (body.error) {
      throw new Error(`Ethereum RPC ${method} failed: ${body.error.message ?? "unknown error"}`);
    }
    return body.result as T;
  }

  async tip(): Promise<number> {
    return Number.parseInt(await this.call<string>("eth_blockNumber", []), 16);
  }

  async settledHash(height: number): Promise<string | undefined> {
    if ((await this.tip()) < height + this.confirmations) {
      return undefined;
    }
    const block = await this.call<{ hash?: string } | null>("eth_getBlockByNumber", [
      `0x${height.toString(16)}`,
      false,
    ]);
    if (!block?.hash || !HASH.test(block.hash)) {
      return undefined;
    }
    return block.hash;
  }
}

/**
 * A stand-in chain for development and tests, with random block hashes.
 * It gives no protection and must never be used with real money.
 *
 * With `instant`, every block asked for exists at once, so draws do not wait.
 * Otherwise blocks are added by `mine`, for example on a timer.
 */
export class SimulatedChain implements EntropySource {
  readonly name = "simulated";
  private readonly hashes: string[] = [];

  constructor(private readonly options: { instant?: boolean; confirmations?: number } = {}) {
    this.mine();
  }

  /** Adds `count` blocks. */
  mine(count = 1): void {
    for (let i = 0; i < count; i++) {
      const previous = this.hashes.at(-1) ?? "genesis";
      this.hashes.push(`0x${createHash("sha256").update(previous).update(randomBytes(32)).digest("hex")}`);
    }
  }

  async tip(): Promise<number> {
    return this.hashes.length - 1;
  }

  async settledHash(height: number): Promise<string | undefined> {
    const needed = height + (this.options.confirmations ?? 0);
    if (this.options.instant && this.hashes.length - 1 < needed) {
      this.mine(needed - (this.hashes.length - 1));
    }
    return this.hashes.length - 1 >= needed ? this.hashes[height] : undefined;
  }
}

/** The Jackpot client seed: public facts about the round plus the committed block hash. */
export function jackpotClientSeed(roundId: string, entries: number, pot: bigint, blockHash: string): string {
  return `${roundId}:${entries}:${pot}:${blockHash}`;
}
