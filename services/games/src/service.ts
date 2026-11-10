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

const CLIENT_SEED = /^[A-Za-z0-9_-]{1,64}$/;
const HISTORY_LIMIT = 20;

interface SeedPair {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

interface VersusMatch {
  id: string;
  stake: bigint;
  creator: Caller;
  creatorSide: Side;
  creatorSeed: string;
  serverSeed: string;
  serverSeedHash: string;
  status: "open" | "settling" | "settled" | "cancelled";
  createdAt: number;
  joiner?: Caller;
  joinerSeed?: string;
  result?: Side;
  winner?: Caller;
  prize?: bigint;
  fee?: bigint;
}

interface JackpotRound {
  id: string;
  number: number;
  serverSeed: string;
  serverSeedHash: string;
  status: "open" | "drawing" | "settled";
  entries: Array<{ user: Caller; amount: bigint }>;
  closesAt?: number;
  clientSeed?: string;
  winningTicket?: bigint;
  winner?: Caller;
  prize?: bigint;
  fee?: bigint;
}

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
 * Game state is kept in memory for now; the tables are in db/migrations.
 */
export class GamesService {
  private readonly seeds = new Map<string, SeedPair>();
  private readonly versus = new Map<string, VersusMatch>();
  private readonly jackpotHistory: JackpotRound[] = [];
  private jackpot!: JackpotRound;
  private jackpotCount = 0;
  private readonly now: () => number;

  private constructor(
    private readonly wallet: WalletPort,
    private readonly config: GamesConfig,
  ) {
    this.now = config.now ?? Date.now;
  }

  static async create(wallet: WalletPort, config: GamesConfig = DEFAULT_GAMES_CONFIG): Promise<GamesService> {
    const service = new GamesService(wallet, config);
    service.jackpot = await service.newJackpotRound();
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

  private async seedPair(userId: string): Promise<SeedPair> {
    let pair = this.seeds.get(userId);
    if (!pair) {
      const serverSeed = generateSeed();
      const created = { serverSeed, serverSeedHash: await hashServerSeed(serverSeed), clientSeed: generateSeed(8), nonce: 0 };
      // Another request may have created the pair while hashing; keep the first.
      pair = this.seeds.get(userId) ?? created;
      this.seeds.set(userId, pair);
    }
    return pair;
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
    const serverSeed = generateSeed();
    const serverSeedHash = await hashServerSeed(serverSeed);

    if (this.seeds.get(userId) !== previous) {
      throw new GameError("SEED_CHANGED", "Your seed changed while rotating. Try again.");
    }
    this.seeds.set(userId, { serverSeed, serverSeedHash, clientSeed: nextClientSeed, nonce: 0 });

    return {
      revealed: {
        serverSeed: previous.serverSeed,
        serverSeedHash: previous.serverSeedHash,
        clientSeed: previous.clientSeed,
        betsPlaced: previous.nonce,
      },
      current: { serverSeedHash, clientSeed: nextClientSeed, nonce: 0 },
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

    const betId = randomUUID();
    const currency = this.config.currency;
    await this.wallet.move({ id: `${betId}:stake`, userId: user.id, currency, amount: -total, kind: "bet", ref: betId });

    // The stake is taken, so the bet is final. Claim the next nonce without
    // awaiting in between, so two spins can never share one.
    const pair = await this.seedPair(user.id);
    const nonce = pair.nonce;
    pair.nonce += 1;
    const fairness = { serverSeedHash: pair.serverSeedHash, clientSeed: pair.clientSeed, nonce };

    const roll = await fairInt({ serverSeed: pair.serverSeed, clientSeed: pair.clientSeed, nonce }, ROULETTE_POCKETS);
    const settlement = settleRoulette(bets, Number(roll));

    if (settlement.totalPayout > 0n) {
      await this.wallet.move({
        id: `${betId}:payout`,
        userId: user.id,
        currency,
        amount: settlement.totalPayout,
        kind: "win",
        ref: betId,
      });
    }

    return {
      betId,
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

  // ----- Versus -----

  private versusView(match: VersusMatch) {
    const settled = match.status === "settled";
    return {
      id: match.id,
      currency: this.config.currency,
      stake: match.stake,
      status: match.status === "settling" ? "open" : match.status,
      creator: match.creator,
      creatorSide: match.creatorSide,
      serverSeedHash: match.serverSeedHash,
      createdAt: match.createdAt,
      joiner: match.joiner,
      result: match.result,
      winner: match.winner,
      prize: match.prize,
      fee: match.fee,
      // Secret until the match is over.
      serverSeed: settled ? match.serverSeed : undefined,
      clientSeed: settled ? `${match.creatorSeed}:${match.joinerSeed}` : undefined,
    };
  }

  listVersus() {
    const matches = [...this.versus.values()];
    const open = matches.filter((match) => match.status === "open" || match.status === "settling");
    const recent = matches.filter((match) => match.status === "settled").slice(-HISTORY_LIMIT);
    return {
      open: open.reverse().map((match) => this.versusView(match)),
      recent: recent.reverse().map((match) => this.versusView(match)),
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
      stake,
      creator: user,
      creatorSide: input.side,
      creatorSeed,
      serverSeed,
      serverSeedHash,
      status: "open",
      createdAt: this.now(),
    };
    this.versus.set(id, match);
    return this.versusView(match);
  }

  private openMatch(id: string): VersusMatch {
    const match = this.versus.get(id);
    if (!match) {
      throw new GameError("NOT_FOUND", "No such match");
    }
    if (match.status !== "open") {
      throw new GameError("MATCH_CLOSED", "This match is no longer open");
    }
    return match;
  }

  async joinVersus(user: Caller, id: string, input: Record<string, unknown>) {
    const joinerSeed = clientSeedFrom(input.clientSeed);
    const match = this.openMatch(id);
    if (match.creator.id === user.id) {
      throw new GameError("OWN_MATCH", "You cannot join your own match");
    }

    // Claim the seat before any await, so a second joiner is turned away.
    match.status = "settling";
    const currency = this.config.currency;
    try {
      await this.wallet.move({ id: `${id}:joiner`, userId: user.id, currency, amount: -match.stake, kind: "bet", ref: id });
    } catch (error) {
      match.status = "open";
      throw error;
    }

    match.joiner = user;
    match.joinerSeed = joinerSeed;
    const roll = await fairInt(
      { serverSeed: match.serverSeed, clientSeed: `${match.creatorSeed}:${joinerSeed}`, nonce: 0 },
      VERSUS_OUTCOMES,
    );
    const split = versusPayout(match.stake, this.config.versusFeeBps);
    match.result = versusOutcome(roll);
    match.winner = match.result === match.creatorSide ? match.creator : user;
    match.prize = split.prize;
    match.fee = split.fee;

    await this.wallet.move({ id: `${id}:prize`, userId: match.winner.id, currency, amount: split.prize, kind: "win", ref: id });
    match.status = "settled";
    return this.versusView(match);
  }

  async cancelVersus(user: Caller, id: string) {
    const match = this.openMatch(id);
    if (match.creator.id !== user.id) {
      throw new GameError("NOT_YOUR_MATCH", "Only the player who created a match can cancel it");
    }
    match.status = "cancelled";
    await this.wallet.move({
      id: `${id}:refund`,
      userId: user.id,
      currency: this.config.currency,
      amount: match.stake,
      kind: "refund",
      ref: id,
    });
    return this.versusView(match);
  }

  /** The side a joiner would be playing. */
  static joinerSide(creatorSide: Side): Side {
    return oppositeSide(creatorSide);
  }

  // ----- Jackpot -----

  private async newJackpotRound(): Promise<JackpotRound> {
    const serverSeed = generateSeed();
    this.jackpotCount += 1;
    return {
      id: randomUUID(),
      number: this.jackpotCount,
      serverSeed,
      serverSeedHash: await hashServerSeed(serverSeed),
      status: "open",
      entries: [],
    };
  }

  private jackpotView(round: JackpotRound) {
    const stakes = round.entries.map((entry) => ({ userId: entry.user.id, amount: entry.amount }));
    const settled = round.status === "settled";
    return {
      id: round.id,
      number: round.number,
      currency: this.config.currency,
      status: round.status === "drawing" ? "open" : round.status,
      serverSeedHash: round.serverSeedHash,
      pot: jackpotPot(stakes),
      closesAt: round.closesAt,
      entries: round.entries.map((entry) => ({
        user: entry.user,
        amount: entry.amount,
        chanceBps: winChanceBps(stakes, entry.user.id),
      })),
      winner: round.winner,
      winningTicket: round.winningTicket,
      prize: round.prize,
      fee: round.fee,
      // Secret until the round is over.
      serverSeed: settled ? round.serverSeed : undefined,
      clientSeed: settled ? round.clientSeed : undefined,
    };
  }

  currentJackpot() {
    return this.jackpotView(this.jackpot);
  }

  listJackpotHistory() {
    return { rounds: this.jackpotHistory.slice(-HISTORY_LIMIT).reverse().map((round) => this.jackpotView(round)) };
  }

  async enterJackpot(user: Caller, input: Record<string, unknown>) {
    const amount = this.stake(input.amount);
    const round = this.jackpot;
    if (round.status !== "open" || (round.closesAt !== undefined && this.now() >= round.closesAt)) {
      throw new GameError("ROUND_CLOSING", "This round is being drawn. Join the next one.");
    }

    const entryId = randomUUID();
    await this.wallet.move({
      id: `${round.id}:entry:${entryId}`,
      userId: user.id,
      currency: this.config.currency,
      amount: -amount,
      kind: "bet",
      ref: round.id,
    });

    if (round.status !== "open") {
      // The draw began while the stake was being taken. Give it back.
      await this.wallet.move({
        id: `${round.id}:entry:${entryId}:refund`,
        userId: user.id,
        currency: this.config.currency,
        amount,
        kind: "refund",
        ref: round.id,
      });
      throw new GameError("ROUND_CLOSING", "This round is being drawn. Join the next one.");
    }

    round.entries.push({ user, amount });
    const players = new Set(round.entries.map((entry) => entry.user.id));
    if (players.size >= 2 && round.closesAt === undefined) {
      round.closesAt = this.now() + this.config.jackpotDurationMs;
    }
    return this.jackpotView(round);
  }

  /** Draws the current round if its time is up. Safe to call as often as you like. */
  async drawJackpotIfDue() {
    const round = this.jackpot;
    if (round.status !== "open" || round.closesAt === undefined || this.now() < round.closesAt) {
      return undefined;
    }

    round.status = "drawing";
    try {
      const stakes = round.entries.map((entry) => ({ userId: entry.user.id, amount: entry.amount }));
      const split = jackpotPayout(stakes, this.config.jackpotFeeBps);
      // Public facts about the round, fixed once entries stop.
      round.clientSeed = `${round.id}:${round.entries.length}:${split.pot}`;
      round.winningTicket = await fairInt(
        { serverSeed: round.serverSeed, clientSeed: round.clientSeed, nonce: 0 },
        split.pot,
      );
      const winning = pickJackpotWinner(stakes, round.winningTicket);
      round.winner = round.entries.find((entry) => entry.user.id === winning.userId)!.user;
      round.prize = split.prize;
      round.fee = split.fee;

      await this.wallet.move({
        id: `${round.id}:prize`,
        userId: round.winner.id,
        currency: this.config.currency,
        amount: split.prize,
        kind: "win",
        ref: round.id,
      });
    } catch (error) {
      // Leave the round due, so the next call tries the draw again. The payout
      // id is fixed, so a retry cannot pay twice.
      round.status = "open";
      throw error;
    }

    round.status = "settled";
    this.jackpotHistory.push(round);
    this.jackpot = await this.newJackpotRound();
    return this.jackpotView(round);
  }
}
