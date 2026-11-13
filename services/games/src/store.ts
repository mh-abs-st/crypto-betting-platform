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
}

export type VersusStatus = "open" | "settling" | "settled" | "cancelled";

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
  joiner?: Caller;
  joinerSeed?: string;
  result?: Side;
  winner?: Caller;
  prize?: bigint;
  fee?: bigint;
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

export interface JackpotRound {
  id: string;
  number: number;
  currency: string;
  serverSeed: string;
  serverSeedHash: string;
  status: JackpotStatus;
  entries: JackpotEntry[];
  closesAt?: number;
  clientSeed?: string;
  winningTicket?: bigint;
  winner?: Caller;
  prize?: bigint;
  fee?: bigint;
}

export interface JackpotResult {
  clientSeed: string;
  winningTicket: bigint;
  winner: Caller;
  prize: bigint;
  fee: bigint;
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

  recordSpin(spin: RouletteSpin): Promise<void>;

  insertMatch(match: VersusMatch): Promise<void>;
  getMatch(id: string): Promise<VersusMatch | undefined>;
  /** Open matches, newest first, and the most recently settled ones, newest first. */
  listMatches(limit: number): Promise<{ open: VersusMatch[]; recent: VersusMatch[] }>;
  /** Takes the seat in an open match. Undefined if it is not open or is the joiner's own. */
  claimJoin(id: string, joiner: Caller, joinerSeed: string): Promise<VersusMatch | undefined>;
  /** Gives the seat back after the joiner's stake could not be taken. */
  releaseJoin(id: string, joinerId: string): Promise<void>;
  /** Records the outcome of a match whose seat is taken. Does not change its status. */
  recordVersusResult(id: string, result: VersusResult): Promise<void>;
  markSettled(id: string): Promise<void>;
  /** Cancels an open match created by `creatorId`. Undefined if that is not possible. */
  cancelMatch(id: string, creatorId: string): Promise<VersusMatch | undefined>;

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
   * Stops entries to a round that is due, and returns it for drawing. A round
   * already being drawn is returned again, so an interrupted draw is finished.
   */
  claimDraw(roundId: string, now: number): Promise<JackpotRound | undefined>;
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
    this.spins.push(copy(spin));
  }

  async insertMatch(match: VersusMatch) {
    this.matches.set(match.id, copy(match));
  }

  async getMatch(id: string) {
    const match = this.matches.get(id);
    return match && copy(match);
  }

  async listMatches(limit: number) {
    const all = [...this.matches.values()];
    const open = all.filter((m) => m.status === "open" || m.status === "settling").reverse();
    const recent = this.settledOrder
      .slice(-limit)
      .reverse()
      .map((id) => this.matches.get(id)!);
    return { open: open.map(copy), recent: recent.map(copy) };
  }

  async claimJoin(id: string, joiner: Caller, joinerSeed: string) {
    const match = this.matches.get(id);
    if (!match || match.status !== "open" || match.creator.id === joiner.id) {
      return undefined;
    }
    Object.assign(match, { status: "settling", joiner, joinerSeed });
    return copy(match);
  }

  async releaseJoin(id: string, joinerId: string) {
    const match = this.matches.get(id);
    if (match?.status === "settling" && match.joiner?.id === joinerId && match.result === undefined) {
      Object.assign(match, { status: "open", joiner: undefined, joinerSeed: undefined });
    }
  }

  async recordVersusResult(id: string, result: VersusResult) {
    Object.assign(this.matches.get(id)!, result);
  }

  async markSettled(id: string) {
    const match = this.matches.get(id)!;
    if (match.status !== "settled") {
      match.status = "settled";
      this.settledOrder.push(id);
    }
  }

  async cancelMatch(id: string, creatorId: string) {
    const match = this.matches.get(id);
    if (!match || match.status !== "open" || match.creator.id !== creatorId) {
      return undefined;
    }
    match.status = "cancelled";
    return copy(match);
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

  async claimDraw(roundId: string, now: number) {
    const round = this.rounds.find((r) => r.id === roundId);
    if (!round) {
      return undefined;
    }
    if (round.status === "open" && round.closesAt !== undefined && now >= round.closesAt) {
      round.status = "drawing";
    }
    return round.status === "drawing" ? copy(round) : undefined;
  }

  async recordJackpotResult(roundId: string, result: JackpotResult) {
    Object.assign(this.rounds.find((r) => r.id === roundId)!, result);
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
