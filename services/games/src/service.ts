import { randomUUID } from "node:crypto";
import { fairInt, generateSeed, hashServerSeed } from "@yuubet/fair";
import {
  GameError,
  ROULETTE_POCKETS,
  VERSUS_OUTCOMES,
  isSide,
  jackpotPayout,
  jackpotPot,
  oppositeSide,
  parseAmount,
  pickJackpotWinner,
  settleRoulette,
  validateRouletteBet,
  versusOutcome,
  versusPayout,
  winChanceBps,
  type RouletteBet,
  type RouletteBetType,
  type Side,
} from "@yuubet/games";
import type { Caller } from "@yuubet/service-kit";
import { BLOCKS_AHEAD, SimulatedChain, jackpotClientSeed, type EntropySource } from "./entropy";
import { MemoryGamesStore, type GamesStore, type JackpotRound, type SeedPair, type VersusMatch } from "./store";
import type { WalletPort } from "./wallet";

export interface GamesConfig {
  currency: string;
  minBet: bigint;
  maxBet: bigint;
  versusFeeBps: number;
  jackpotFeeBps: number;
  /** How long a jackpot round stays open once two players are in. */
  jackpotDurationMs: number;
  now?: () => number;
}

export const DEFAULT_GAMES_CONFIG: GamesConfig = {
  currency: "USDT",
  minBet: 10_000n, // 0.01 USDT
  maxBet: 1_000_000_000n, // 1000 USDT
  versusFeeBps: 200,
  jackpotFeeBps: 500,
  jackpotDurationMs: 30_000,
};

type PayoutStatus = "none" | "paid" | "pending";

const CLIENT_SEED = /^[A-Za-z0-9_-]{1,64}$/;
const HISTORY_LIMIT = 20;

function clientSeedFrom(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return generateSeed(8);
  }
  if (typeof value !== "string" || !CLIENT_SEED.test(value)) {
    throw new GameError("INVALID_SEED", "Client seed must be 1 to 64 letters, digits, dashes or underscores");
  }
  return value;
}

/**
 * The three launch games. Each takes the stake from the wallet before the
 * outcome is computed and publishes the hash of its server seed before any
 * bet, so every result can be verified afterwards.
 *
 * State lives in a GamesStore: PostgreSQL in production, memory in tests.
 * Every change of state is a conditional claim in the store, so several
 * instances of this service can run against one database.
 */
export class GamesService {
  private readonly now: () => number;

  private constructor(
    private readonly wallet: WalletPort,
    private readonly config: GamesConfig,
    private readonly store: GamesStore,
    private readonly entropy: EntropySource,
  ) {
    this.now = config.now ?? Date.now;
  }

  static async create(
    wallet: WalletPort,
    config: GamesConfig = DEFAULT_GAMES_CONFIG,
    store: GamesStore = new MemoryGamesStore(),
    entropy: EntropySource = new SimulatedChain({ instant: true }),
  ): Promise<GamesService> {
    const service = new GamesService(wallet, config, store, entropy);
    // Resumes the round that was open before a restart, or opens the first one.
    await service.jackpotRound();
    return service;
  }

  describe() {
    return {
      currency: this.config.currency,
      minBet: this.config.minBet,
      maxBet: this.config.maxBet,
      versusFeeBps: this.config.versusFeeBps,
      jackpotFeeBps: this.config.jackpotFeeBps,
      jackpotDurationMs: this.config.jackpotDurationMs,
    };
  }

  private stake(value: unknown, field = "amount"): bigint {
    const amount = parseAmount(value, field);
    if (amount < this.config.minBet || amount > this.config.maxBet) {
      throw new GameError("BET_OUT_OF_RANGE", `Bets must be between ${this.config.minBet} and ${this.config.maxBet}`);
    }
    return amount;
  }

  // ----- Seeds for single-player games -----

  private async freshSeedPair(userId: string, clientSeed = generateSeed(8)): Promise<SeedPair> {
    const serverSeed = generateSeed();
    return { id: randomUUID(), userId, serverSeed, serverSeedHash: await hashServerSeed(serverSeed), clientSeed, nonce: 0 };
  }

  private async seedPair(userId: string): Promise<SeedPair> {
    return (await this.store.activeSeedPair(userId)) ?? this.store.createSeedPair(await this.freshSeedPair(userId));
  }

  async seedInfo(userId: string) {
    const pair = await this.seedPair(userId);
    return { serverSeedHash: pair.serverSeedHash, clientSeed: pair.clientSeed, nonce: pair.nonce };
  }

  /**
   * Retires the current server seed and reveals it, so past bets can be
   * verified, and starts a new one. The player may set their own client seed.
   */
  async rotateSeed(userId: string, clientSeed: unknown) {
    const nextClientSeed = clientSeedFrom(clientSeed);
    const previous = await this.seedPair(userId);
    const next = await this.freshSeedPair(userId, nextClientSeed);

    const revealed = await this.store.rotateSeedPair(userId, previous.id, next);
    if (!revealed) {
      throw new GameError("SEED_CHANGED", "Your seed changed while rotating. Try again.");
    }
    return {
      revealed: {
        serverSeed: revealed.serverSeed,
        serverSeedHash: revealed.serverSeedHash,
        clientSeed: revealed.clientSeed,
        betsPlaced: revealed.nonce,
      },
      current: { serverSeedHash: next.serverSeedHash, clientSeed: next.clientSeed, nonce: 0 },
    };
  }

  // ----- Roulette -----

  async spinRoulette(user: Caller, input: Record<string, unknown>) {
    if (!Array.isArray(input.bets)) {
      throw new GameError("INVALID_BET", "bets must be a list");
    }
    const bets: RouletteBet[] = input.bets.map((raw: unknown) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      const bet: RouletteBet = { type: item.type as RouletteBetType, amount: parseAmount(item.amount) };
      if (item.value !== undefined && item.value !== null) {
        bet.value = item.value as number;
      }
      validateRouletteBet(bet);
      return bet;
    });

    // Validates the number of bets too; the number passed here is not the result.
    const total = settleRoulette(bets, 0).totalStake;
    if (bets.some((bet) => bet.amount < this.config.minBet) || total > this.config.maxBet) {
      throw new GameError(
        "BET_OUT_OF_RANGE",
        `Each bet must be at least ${this.config.minBet} and the spin at most ${this.config.maxBet}`,
      );
    }

    // Make sure a seed pair exists before the stake is taken.
    await this.seedPair(user.id);
    const betId = randomUUID();
    const currency = this.config.currency;
    await this.wallet.move({ id: `${betId}:stake`, userId: user.id, currency, amount: -total, kind: "bet", ref: betId });

    // The stake is taken, so the bet is final. The store hands out each nonce once.
    const { pair, nonce } = await this.store.claimNonce(user.id);
    const fairness = { serverSeedHash: pair.serverSeedHash, clientSeed: pair.clientSeed, nonce };

    const roll = await fairInt({ serverSeed: pair.serverSeed, clientSeed: pair.clientSeed, nonce }, ROULETTE_POCKETS);
    const settlement = settleRoulette(bets, Number(roll));

    await this.store.recordSpin({
      id: betId,
      userId: user.id,
      seedPairId: pair.id,
      nonce,
      currency,
      bets,
      number: settlement.number,
      totalStake: settlement.totalStake,
      totalPayout: settlement.totalPayout,
    });

    let payoutStatus: PayoutStatus = "none";
    if (settlement.totalPayout > 0n) {
      payoutStatus = (await this.payRouletteSpin(betId, user.id, currency, settlement.totalPayout)) ? "paid" : "pending";
    }

    return {
      betId,
      payoutStatus,
      currency,
      number: settlement.number,
      color: settlement.color,
      totalStake: settlement.totalStake,
      totalPayout: settlement.totalPayout,
      bets: settlement.results.map((result) => ({
        type: result.bet.type,
        value: result.bet.value,
        amount: result.bet.amount,
        won: result.won,
        payout: result.payout,
      })),
      fairness,
    };
  }

  /** Pays a recorded winning spin. False if the wallet failed; the payout stays owed and is retried. */
  private async payRouletteSpin(betId: string, userId: string, currency: string, amount: bigint): Promise<boolean> {
    try {
      await this.wallet.move({ id: `${betId}:payout`, userId, currency, amount, kind: "win", ref: betId });
    } catch (error) {
      console.error(`roulette payout for ${betId} failed; it will be retried: ${(error as Error).message}`);
      return false;
    }
    await this.store.markSpinPaid(betId);
    return true;
  }

  // ----- Versus -----

  private versusView(match: VersusMatch) {
    // Once the result is recorded the match is over for the players, even if the prize is still being paid.
    const settled = match.status === "settled" || (match.status === "settling" && match.result !== undefined);
    return {
      id: match.id,
      currency: match.currency,
      stake: match.stake,
      status: settled ? "settled" : match.status === "settling" ? "open" : match.status,
      /** A prize or refund is owed but the wallet has not confirmed it yet. */
      payoutPending: match.payoutDueSince !== undefined,
      creator: match.creator,
      creatorSide: match.creatorSide,
      serverSeedHash: match.serverSeedHash,
      createdAt: match.createdAt,
      joiner: match.joiner,
      result: settled ? match.result : undefined,
      winner: settled ? match.winner : undefined,
      prize: settled ? match.prize : undefined,
      fee: settled ? match.fee : undefined,
      // Secret until the match is over.
      serverSeed: settled ? match.serverSeed : undefined,
      clientSeed: settled ? `${match.creatorSeed}:${match.joinerSeed}` : undefined,
    };
  }

  async listVersus() {
    const { open, recent } = await this.store.listMatches(HISTORY_LIMIT);
    return {
      open: open.map((match) => this.versusView(match)),
      recent: recent.map((match) => this.versusView(match)),
    };
  }

  async createVersus(user: Caller, input: Record<string, unknown>) {
    const stake = this.stake(input.amount);
    if (!isSide(input.side)) {
      throw new GameError("INVALID_SIDE", "side must be heads or tails");
    }
    const creatorSeed = clientSeedFrom(input.clientSeed);

    const id = randomUUID();
    const serverSeed = generateSeed();
    const serverSeedHash = await hashServerSeed(serverSeed);
    await this.wallet.move({
      id: `${id}:creator`,
      userId: user.id,
      currency: this.config.currency,
      amount: -stake,
      kind: "bet",
      ref: id,
    });

    const match: VersusMatch = {
      id,
      currency: this.config.currency,
      stake,
      creator: user,
      creatorSide: input.side,
      creatorSeed,
      serverSeed,
      serverSeedHash,
      status: "open",
      createdAt: this.now(),
    };
    await this.store.insertMatch(match);
    return this.versusView(match);
  }

  /** Explains why a match cannot be joined or cancelled. */
  private async refusal(id: string, userId: string, action: "join" | "cancel"): Promise<GameError> {
    const match = await this.store.getMatch(id);
    if (!match) {
      return new GameError("NOT_FOUND", "No such match");
    }
    if (match.status !== "open") {
      return new GameError("MATCH_CLOSED", "This match is no longer open");
    }
    if (action === "join" && match.creator.id === userId) {
      return new GameError("OWN_MATCH", "You cannot join your own match");
    }
    if (action === "cancel" && match.creator.id !== userId) {
      return new GameError("NOT_YOUR_MATCH", "Only the player who created a match can cancel it");
    }
    return new GameError("MATCH_CLOSED", "This match is no longer open");
  }

  async joinVersus(user: Caller, id: string, input: Record<string, unknown>) {
    const joinerSeed = clientSeedFrom(input.clientSeed);

    // Claim the seat first, so a second joiner is turned away.
    const match = await this.store.claimJoin(id, user, joinerSeed);
    if (!match) {
      throw await this.refusal(id, user.id, "join");
    }
    try {
      await this.takeJoinerStake(match);
    } catch (error) {
      await this.store.releaseJoin(id, user.id);
      throw error;
    }
    await this.finishMatch(match);
    return this.versusView((await this.store.getMatch(id))!);
  }

  private takeJoinerStake(match: VersusMatch) {
    return this.wallet.move({
      id: `${match.id}:joiner`,
      userId: match.joiner!.id,
      currency: match.currency,
      amount: -match.stake,
      kind: "bet",
      ref: match.id,
    });
  }

  /**
   * Records the result of a match whose seat is taken and both stakes are in,
   * then pays the prize. The result follows from the seeds alone, so running
   * this again gives the same result and, with the fixed prize id, pays once.
   */
  private async finishMatch(match: VersusMatch) {
    const joiner = match.joiner!;
    const roll = await fairInt(
      { serverSeed: match.serverSeed, clientSeed: `${match.creatorSeed}:${match.joinerSeed}`, nonce: 0 },
      VERSUS_OUTCOMES,
    );
    const split = versusPayout(match.stake, this.config.versusFeeBps);
    const result = versusOutcome(roll);
    const winner = result === match.creatorSide ? match.creator : joiner;
    await this.store.recordVersusResult(match.id, { result, winner, prize: split.prize, fee: split.fee });
    await this.payVersusPrize({ ...match, result, winner, prize: split.prize, fee: split.fee });
  }

  /** Pays a recorded prize. False if the wallet failed; the prize stays owed and is retried. */
  private async payVersusPrize(match: VersusMatch): Promise<boolean> {
    try {
      await this.wallet.move({
        id: `${match.id}:prize`,
        userId: match.winner!.id,
        currency: match.currency,
        amount: match.prize!,
        kind: "win",
        ref: match.id,
      });
    } catch (error) {
      console.error(`versus prize for ${match.id} failed; it will be retried: ${(error as Error).message}`);
      return false;
    }
    await this.store.markSettled(match.id);
    return true;
  }

  /** Refunds a cancelled match. False if the wallet failed; the refund stays owed and is retried. */
  private async refundVersus(match: VersusMatch): Promise<boolean> {
    try {
      await this.wallet.move({
        id: `${match.id}:refund`,
        userId: match.creator.id,
        currency: match.currency,
        amount: match.stake,
        kind: "refund",
        ref: match.id,
      });
    } catch (error) {
      console.error(`versus refund for ${match.id} failed; it will be retried: ${(error as Error).message}`);
      return false;
    }
    await this.store.markRefunded(match.id);
    return true;
  }

  async cancelVersus(user: Caller, id: string) {
    const match = await this.store.cancelMatch(id, user.id);
    if (!match) {
      throw await this.refusal(id, user.id, "cancel");
    }
    const refunded = await this.refundVersus(match);
    return this.versusView({ ...match, payoutDueSince: refunded ? undefined : match.payoutDueSince });
  }

  /** The side a joiner would be playing. */
  static joinerSide(creatorSide: Side): Side {
    return oppositeSide(creatorSide);
  }

  // ----- Jackpot -----

  /** The round taking entries or being drawn; opens a new one if there is none. */
  private async jackpotRound(): Promise<JackpotRound> {
    const current = await this.store.currentRound();
    if (current) {
      return current;
    }
    const serverSeed = generateSeed();
    return this.store.openRound({
      id: randomUUID(),
      currency: this.config.currency,
      serverSeed,
      serverSeedHash: await hashServerSeed(serverSeed),
    });
  }

  private jackpotView(round: JackpotRound) {
    const stakes = round.entries.map((entry) => ({ userId: entry.user.id, amount: entry.amount }));
    const settled = round.status === "settled";
    return {
      id: round.id,
      number: round.number,
      currency: round.currency,
      status: round.status,
      serverSeedHash: round.serverSeedHash,
      pot: jackpotPot(stakes),
      closesAt: round.closesAt,
      /** The block whose hash the draw uses; the hash appears once the draw is done. */
      entropy: round.entropy && { ...round.entropy, hash: settled ? round.entropy.hash : undefined },
      entries: round.entries.map((entry) => ({
        user: entry.user,
        amount: entry.amount,
        chanceBps: winChanceBps(stakes, entry.user.id),
      })),
      winner: settled ? round.winner : undefined,
      winningTicket: settled ? round.winningTicket : undefined,
      prize: settled ? round.prize : undefined,
      fee: settled ? round.fee : undefined,
      // Secret until the round is over.
      serverSeed: settled ? round.serverSeed : undefined,
      clientSeed: settled ? round.clientSeed : undefined,
    };
  }

  async currentJackpot() {
    return this.jackpotView(await this.jackpotRound());
  }

  async listJackpotHistory() {
    return { rounds: (await this.store.roundHistory(HISTORY_LIMIT)).map((round) => this.jackpotView(round)) };
  }

  async enterJackpot(user: Caller, input: Record<string, unknown>) {
    const amount = this.stake(input.amount);
    const round = await this.jackpotRound();
    if (round.status !== "open" || (round.closesAt !== undefined && this.now() >= round.closesAt)) {
      throw new GameError("ROUND_CLOSING", "This round is being drawn. Join the next one.");
    }

    const entryId = randomUUID();
    await this.wallet.move({
      id: `${round.id}:entry:${entryId}`,
      userId: user.id,
      currency: round.currency,
      amount: -amount,
      kind: "bet",
      ref: round.id,
    });

    const updated = await this.store.addEntry(round.id, { user, amount }, this.now(), this.config.jackpotDurationMs);
    if (!updated) {
      // The round closed while the stake was being taken. Give it back.
      await this.wallet.move({
        id: `${round.id}:entry:${entryId}:refund`,
        userId: user.id,
        currency: round.currency,
        amount,
        kind: "refund",
        ref: round.id,
      });
      throw new GameError("ROUND_CLOSING", "This round is being drawn. Join the next one.");
    }
    return this.jackpotView(updated);
  }

  /**
   * Draws the current round once it is due. Entries stop and the round
   * commits to a block that does not exist yet; the draw happens when that
   * block's hash is settled. Safe to call as often as you like, from any
   * instance: the result is fixed by the entries, the seed and the block,
   * and the payout id is fixed, so it is paid once.
   *
   * Returns the settled round, or undefined if nothing was settled by this call.
   */
  async drawJackpotIfDue() {
    const current = await this.store.currentRound();
    if (!current) {
      return undefined;
    }
    const due =
      current.status === "drawing" || (current.closesAt !== undefined && this.now() >= current.closesAt);
    if (!due) {
      return undefined;
    }
    const commitment = { source: this.entropy.name, height: (await this.entropy.tip()) + BLOCKS_AHEAD };
    const round = await this.store.claimDraw(current.id, this.now(), commitment);
    if (!round?.entropy) {
      return undefined;
    }
    if (round.entropy.source !== this.entropy.name) {
      throw new Error(`Round ${round.id} committed to ${round.entropy.source}, but this instance reads ${this.entropy.name}`);
    }
    const blockHash = await this.entropy.settledHash(round.entropy.height);
    if (!blockHash) {
      // The committed block is not settled yet; a later call draws.
      return undefined;
    }

    const stakes = round.entries.map((entry) => ({ userId: entry.user.id, amount: entry.amount }));
    const split = jackpotPayout(stakes, this.config.jackpotFeeBps);
    const clientSeed = jackpotClientSeed(round.id, round.entries.length, split.pot, blockHash);
    const winningTicket = await fairInt({ serverSeed: round.serverSeed, clientSeed, nonce: 0 }, split.pot);
    const winning = pickJackpotWinner(stakes, winningTicket);
    const winner = round.entries.find((entry) => entry.user.id === winning.userId)!.user;
    await this.store.recordJackpotResult(round.id, {
      clientSeed,
      entropyHash: blockHash,
      winningTicket,
      winner,
      prize: split.prize,
      fee: split.fee,
    });

    // If this fails the round stays in "drawing", and the next call pays it.
    await this.wallet.move({
      id: `${round.id}:prize`,
      userId: winner.id,
      currency: round.currency,
      amount: split.prize,
      kind: "win",
      ref: round.id,
    });

    // Concurrent draws all pay the same prize id; only the one that settles reports the result.
    const settledHere = await this.store.settleRound(round.id);
    await this.jackpotRound();
    if (!settledHere) {
      return undefined;
    }
    return this.jackpotView({
      ...round,
      status: "settled",
      entropy: { ...round.entropy, hash: blockHash },
      clientSeed,
      winningTicket,
      winner,
      prize: split.prize,
      fee: split.fee,
    });
  }

  // ----- Money owed -----

  /**
   * Pays everything that is owed but not confirmed: Roulette payouts, Versus
   * prizes and refunds, and Versus joins interrupted before a result was
   * recorded. Every payment has a fixed id, so a payment that did go through
   * is not made again. Safe to call often and from every instance.
   *
   * `minAgeMs` leaves recent payments to the request that is making them;
   * anything owed for longer than `alertAfterMs` is logged as an error.
   */
  async retryPayouts({ minAgeMs = 5_000, alertAfterMs = 5 * 60_000 } = {}) {
    const due = await this.store.duePayouts(minAgeMs);
    const now = Date.now();
    let paid = 0;
    let pending = 0;
    const done = (ok: boolean, what: string, since?: number) => {
      if (ok) {
        paid += 1;
        return;
      }
      pending += 1;
      if (since !== undefined && now - since > alertAfterMs) {
        console.error(`ALERT: ${what} has been owed for ${Math.round((now - since) / 1000)}s`);
      }
    };

    for (const spin of due.spins) {
      done(await this.payRouletteSpin(spin.id, spin.userId, spin.currency, spin.totalPayout), `roulette payout ${spin.id}`, spin.payoutDueSince);
    }
    for (const match of due.prizes) {
      done(await this.payVersusPrize(match), `versus prize ${match.id}`, match.payoutDueSince);
    }
    for (const match of due.refunds) {
      done(await this.refundVersus(match), `versus refund ${match.id}`, match.payoutDueSince);
    }
    for (const match of due.stalledJoins) {
      // The join stopped after the seat was taken. Take the joiner's stake (a
      // no-op if it was taken before) and finish the match; if the joiner can
      // no longer pay, give the seat back.
      try {
        await this.takeJoinerStake(match);
      } catch (error) {
        if ((error as { code?: string }).code === "INSUFFICIENT_FUNDS") {
          await this.store.releaseJoin(match.id, match.joiner!.id);
          continue;
        }
        done(false, `versus join ${match.id}`, match.joinedAt);
        continue;
      }
      await this.finishMatch(match);
      const after = await this.store.getMatch(match.id);
      done(after?.status === "settled", `versus prize ${match.id}`, match.joinedAt);
    }
    return { paid, pending };
  }
}
