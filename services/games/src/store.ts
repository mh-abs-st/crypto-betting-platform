import type { RouletteBet, Side } from "@yuubet/games";
import type { Caller } from "@yuubet/service-kit";

export interface SeedPair {
  id: string;
  userId: string;
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  /** The nonce the next bet will use. */
  nonce: number;
}

export interface RouletteSpin {
  id: string;
  userId: string;
  seedPairId: string;
  nonce: number;
  currency: string;
  bets: RouletteBet[];
  number: number;
  totalStake: bigint;
  totalPayout: bigint;
  /** Set while a winning spin's payout is not yet confirmed by the wallet. */
  payoutDueSince?: number;
}

export type VersusStatus = "open" | "settling" | "settled" | "cancelled" | "expired";

export interface VersusMatch {
  id: string;
  currency: string;
  stake: bigint;
  creator: Caller;
  creatorSide: Side;
  creatorSeed: string;
  serverSeed: string;
  serverSeedHash: string;
  status: VersusStatus;
  createdAt: number;
  /** When an open match is cancelled automatically and the creator refunded. */
  expiresAt: number;
  joiner?: Caller;
  joinerSeed?: string;
  result?: Side;
  winner?: Caller;
  prize?: bigint;
  fee?: bigint;
  /** When the seat was taken. */
  joinedAt?: number;
  /** Set while the prize (or, for a cancelled match, the refund) is not yet confirmed by the wallet. */
  payoutDueSince?: number;
}

export interface VersusResult {
  result: Side;
  winner: Caller;
  prize: bigint;
  fee: bigint;
}

export type JackpotStatus = "open" | "drawing" | "settled";

export interface JackpotEntry {
  user: Caller;
  amount: bigint;
}

/** The block a round's draw depends on. */
export interface EntropyCommitment {
  source: string;
  height: number;
  /** Known once the draw has used it. */
  hash?: string;
}

export interface JackpotRound {
  id: string;
  number: number;
  currency: string;
  serverSeed: string;
  serverSeedHash: string;
  status: JackpotStatus;
  entries: JackpotEntry[];
  closesAt?: number;
  entropy?: EntropyCommitment;
  clientSeed?: string;
  winningTicket?: bigint;
  winner?: Caller;
  prize?: bigint;
  fee?: bigint;
}

export interface JackpotResult {
  clientSeed: string;
  entropyHash: string;
  winningTicket: bigint;
  winner: Caller;
  prize: bigint;
  fee: bigint;
}

/** Money owed to players that the wallet has not yet confirmed. */
export interface DuePayouts {
  /** Winning spins whose payout is not confirmed. */
  spins: RouletteSpin[];
  /** Matches with a result whose prize is not confirmed. */
  prizes: VersusMatch[];
  /** Cancelled or expired matches whose refund is not confirmed. */
  refunds: VersusMatch[];
  /** Matches whose seat was taken but no result recorded: the join was interrupted. */
  stalledJoins: VersusMatch[];
}

export type NewJackpotRound = Pick<JackpotRound, "id" | "currency" | "serverSeed" | "serverSeedHash">;

/**
 * Where the games keep their state. Every method that changes state is a
 * conditional claim: it succeeds only if the state is still what the caller
 * expects, so two instances of the games service sharing one store can never
 * both join the same match, draw the same round twice, or reuse a nonce.
 *
 * `PgGamesStore` (pg-store.ts) is the real one; `MemoryGamesStore` is for
 * tests and for running without a database.
 */
export interface GamesStore {
  /** The player's unrevealed seed pair, if they have one. */
  activeSeedPair(userId: string): Promise<SeedPair | undefined>;
  /** Saves `fresh` as the active pair unless one already exists; returns the active pair. */
  createSeedPair(fresh: SeedPair): Promise<SeedPair>;
  /** Takes the next nonce of the player's active pair. The pair must exist. */
  claimNonce(userId: string): Promise<{ pair: SeedPair; nonce: number }>;
  /**
   * Reveals pair `previousId` and makes `next` active. Returns the revealed
   * pair with its final nonce, or undefined if `previousId` is no longer active.
   */
  rotateSeedPair(userId: string, previousId: string, next: SeedPair): Promise<SeedPair | undefined>;

  /** Records a spin. If it won, its payout is owed until `markSpinPaid`. */
  recordSpin(spin: RouletteSpin): Promise<void>;
  markSpinPaid(id: string): Promise<void>;

  /** How many open matches the player has created. */
  countOpenMatches(creatorId: string): Promise<number>;
  /**
   * Saves a new open match if its creator has fewer than `maxOpen` open
   * matches. Otherwise saves it as cancelled with the refund owed, and
   * returns false.
   */
  insertMatch(match: VersusMatch, maxOpen: number): Promise<boolean>;
  getMatch(id: string): Promise<VersusMatch | undefined>;
  /** Matches waiting for a joiner (not yet expired at `now`), newest first, and the latest with a result, newest first. */
  listMatches(limit: number, now: number): Promise<{ open: VersusMatch[]; recent: VersusMatch[] }>;
  /** Takes the seat in an open, unexpired match. Undefined if that is not possible or it is the joiner's own. */
  claimJoin(id: string, joiner: Caller, joinerSeed: string, now: number): Promise<VersusMatch | undefined>;
  /** Marks open matches past their expiry as expired, with the refund owed, and returns them. */
  expireMatches(now: number): Promise<VersusMatch[]>;
  /** Gives the seat back after the joiner's stake could not be taken. */
  releaseJoin(id: string, joinerId: string): Promise<void>;
  /** Records the outcome of a match whose seat is taken; the prize is owed until `markSettled`. */
  recordVersusResult(id: string, result: VersusResult): Promise<void>;
  /** The prize is paid: the match is settled. */
  markSettled(id: string): Promise<void>;
  /** Cancels an open match created by `creatorId`; the refund is owed until `markRefunded`. */
  cancelMatch(id: string, creatorId: string): Promise<VersusMatch | undefined>;
  markRefunded(id: string): Promise<void>;
  /** Everything owed for at least `minAgeMs`, and joins interrupted at least that long ago. */
  duePayouts(minAgeMs: number): Promise<DuePayouts>;

  /** The round that is not yet settled, if there is one. */
  currentRound(): Promise<JackpotRound | undefined>;
  /** Opens `fresh` as the next round unless one is already open; returns the current round. */
  openRound(fresh: NewJackpotRound): Promise<JackpotRound>;
  /**
   * Adds an entry to an open round that is not past its close time, and
   * starts the timer once two players are in. Undefined if the round is closing.
   */
  addEntry(roundId: string, entry: JackpotEntry, now: number, durationMs: number): Promise<JackpotRound | undefined>;
  /**
   * Stops entries to a round that is due, commits it to the block in
   * `commitment`, and returns it for drawing. A round already being drawn is
   * returned again with its original commitment, so an interrupted or waiting
   * draw is finished.
   */
  claimDraw(roundId: string, now: number, commitment: EntropyCommitment): Promise<JackpotRound | undefined>;
  recordJackpotResult(roundId: string, result: JackpotResult): Promise<void>;
  /** Marks a round being drawn as settled. False if another caller already did. */
  settleRound(roundId: string): Promise<boolean>;
  /** Settled rounds, newest first. */
  roundHistory(limit: number): Promise<JackpotRound[]>;
}

const copy = <T>(value: T): T => structuredClone(value);

/** All game state in memory. It is lost when the process stops. */
export class MemoryGamesStore implements GamesStore {
  private readonly seeds = new Map<string, SeedPair>();
  private readonly spins: RouletteSpin[] = [];
  private readonly matches = new Map<string, VersusMatch>();
  private readonly settledOrder: string[] = [];
  private readonly rounds: JackpotRound[] = [];

  /** Spins recorded so far, for tests. */
  get recordedSpins(): readonly RouletteSpin[] {
    return this.spins;
  }

  async activeSeedPair(userId: string) {
    const pair = this.seeds.get(userId);
    return pair && copy(pair);
  }

  async createSeedPair(fresh: SeedPair) {
    if (!this.seeds.has(fresh.userId)) {
      this.seeds.set(fresh.userId, copy(fresh));
    }
    return copy(this.seeds.get(fresh.userId)!);
  }

  async claimNonce(userId: string) {
    const pair = this.seeds.get(userId);
    if (!pair) {
      throw new Error("No active seed pair");
    }
    const nonce = pair.nonce;
    pair.nonce += 1;
    return { pair: copy(pair), nonce };
  }

  async rotateSeedPair(userId: string, previousId: string, next: SeedPair) {
    const current = this.seeds.get(userId);
    if (!current || current.id !== previousId) {
      return undefined;
    }
    this.seeds.set(userId, copy(next));
    return copy(current);
  }

  async recordSpin(spin: RouletteSpin) {
    this.spins.push({ ...copy(spin), payoutDueSince: spin.totalPayout > 0n ? Date.now() : undefined });
  }

  async markSpinPaid(id: string) {
    const spin = this.spins.find((s) => s.id === id);
    if (spin) {
      spin.payoutDueSince = undefined;
    }
  }

  async countOpenMatches(creatorId: string) {
    return [...this.matches.values()].filter((m) => m.status === "open" && m.creator.id === creatorId).length;
  }

  async insertMatch(match: VersusMatch, maxOpen: number) {
    const allowed = (await this.countOpenMatches(match.creator.id)) < maxOpen;
    this.matches.set(match.id, allowed ? copy(match) : { ...copy(match), status: "cancelled", payoutDueSince: Date.now() });
    return allowed;
  }

  async getMatch(id: string) {
    const match = this.matches.get(id);
    return match && copy(match);
  }

  async listMatches(limit: number, now: number) {
    const all = [...this.matches.values()];
    const open = all
      .filter((m) => (m.status === "open" && m.expiresAt > now) || (m.status === "settling" && m.result === undefined))
      .reverse();
    const recent = this.settledOrder
      .slice(-limit)
      .reverse()
      .map((id) => this.matches.get(id)!);
    return { open: open.map(copy), recent: recent.map(copy) };
  }

  async claimJoin(id: string, joiner: Caller, joinerSeed: string, now: number) {
    const match = this.matches.get(id);
    if (!match || match.status !== "open" || match.expiresAt <= now || match.creator.id === joiner.id) {
      return undefined;
    }
    Object.assign(match, { status: "settling", joiner, joinerSeed, joinedAt: Date.now() });
    return copy(match);
  }

  async releaseJoin(id: string, joinerId: string) {
    const match = this.matches.get(id);
    if (match?.status === "settling" && match.joiner?.id === joinerId && match.result === undefined) {
      Object.assign(match, { status: "open", joiner: undefined, joinerSeed: undefined, joinedAt: undefined });
    }
  }

  async recordVersusResult(id: string, result: VersusResult) {
    const match = this.matches.get(id)!;
    if (match.status === "settling" && match.result === undefined) {
      Object.assign(match, result, { payoutDueSince: Date.now() });
      // Listed with the results from now on, even while the prize is being paid.
      this.settledOrder.push(id);
    }
  }

  async markSettled(id: string) {
    const match = this.matches.get(id)!;
    if (match.status === "settling" && match.result !== undefined) {
      Object.assign(match, { status: "settled", payoutDueSince: undefined });
    }
  }

  async cancelMatch(id: string, creatorId: string) {
    const match = this.matches.get(id);
    if (!match || match.status !== "open" || match.creator.id !== creatorId) {
      return undefined;
    }
    Object.assign(match, { status: "cancelled", payoutDueSince: Date.now() });
    return copy(match);
  }

  async expireMatches(now: number) {
    const expired = [...this.matches.values()].filter((m) => m.status === "open" && m.expiresAt <= now);
    for (const match of expired) {
      Object.assign(match, { status: "expired", payoutDueSince: Date.now() });
    }
    return expired.map(copy);
  }

  async markRefunded(id: string) {
    const match = this.matches.get(id);
    if (match?.status === "cancelled" || match?.status === "expired") {
      match.payoutDueSince = undefined;
    }
  }

  async duePayouts(minAgeMs: number) {
    const cutoff = Date.now() - minAgeMs;
    const due = (since?: number) => since !== undefined && since <= cutoff;
    const matches = [...this.matches.values()];
    return {
      spins: this.spins.filter((spin) => due(spin.payoutDueSince)).map(copy),
      prizes: matches.filter((m) => m.status === "settling" && due(m.payoutDueSince)).map(copy),
      refunds: matches.filter((m) => (m.status === "cancelled" || m.status === "expired") && due(m.payoutDueSince)).map(copy),
      stalledJoins: matches.filter((m) => m.status === "settling" && m.result === undefined && due(m.joinedAt)).map(copy),
    };
  }

  private current() {
    return this.rounds.find((round) => round.status !== "settled");
  }

  async currentRound() {
    const round = this.current();
    return round && copy(round);
  }

  async openRound(fresh: NewJackpotRound) {
    if (!this.current()) {
      this.rounds.push({ ...copy(fresh), number: this.rounds.length + 1, status: "open", entries: [] });
    }
    return copy(this.current()!);
  }

  async addEntry(roundId: string, entry: JackpotEntry, now: number, durationMs: number) {
    const round = this.rounds.find((r) => r.id === roundId);
    if (!round || round.status !== "open" || (round.closesAt !== undefined && now >= round.closesAt)) {
      return undefined;
    }
    round.entries.push(copy(entry));
    const players = new Set(round.entries.map((e) => e.user.id));
    if (players.size >= 2 && round.closesAt === undefined) {
      round.closesAt = now + durationMs;
    }
    return copy(round);
  }

  async claimDraw(roundId: string, now: number, commitment: EntropyCommitment) {
    const round = this.rounds.find((r) => r.id === roundId);
    if (!round) {
      return undefined;
    }
    if (round.status === "open" && round.closesAt !== undefined && now >= round.closesAt) {
      round.status = "drawing";
      round.entropy = { source: commitment.source, height: commitment.height };
    }
    return round.status === "drawing" ? copy(round) : undefined;
  }

  async recordJackpotResult(roundId: string, { entropyHash, ...result }: JackpotResult) {
    const round = this.rounds.find((r) => r.id === roundId)!;
    Object.assign(round, result, { entropy: { ...round.entropy!, hash: entropyHash } });
  }

  async settleRound(roundId: string) {
    const round = this.rounds.find((r) => r.id === roundId)!;
    if (round.status !== "drawing") {
      return false;
    }
    round.status = "settled";
    return true;
  }

  async roundHistory(limit: number) {
    return this.rounds
      .filter((round) => round.status === "settled")
      .slice(-limit)
      .reverse()
      .map(copy);
  }
}
