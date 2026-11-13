import { isUniqueViolation, transaction, type Pool, type Queryable } from "@yuubet/db";
import type { Side } from "@yuubet/games";
import type { Caller } from "@yuubet/service-kit";
import type {
  GamesStore,
  JackpotEntry,
  JackpotResult,
  JackpotRound,
  JackpotStatus,
  NewJackpotRound,
  RouletteSpin,
  SeedPair,
  VersusMatch,
  VersusResult,
  VersusStatus,
} from "./store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SeedRow {
  id: string;
  user_id: string;
  server_seed: string;
  server_seed_hash: string;
  client_seed: string;
  nonce: string;
}

const SEED_COLUMNS = "id, user_id, server_seed, server_seed_hash, client_seed, nonce";

const toSeedPair = (row: SeedRow): SeedPair => ({
  id: row.id,
  userId: row.user_id,
  serverSeed: row.server_seed,
  serverSeedHash: row.server_seed_hash,
  clientSeed: row.client_seed,
  nonce: Number(row.nonce),
});

interface MatchRow {
  id: string;
  currency: string;
  stake: string;
  status: VersusStatus;
  creator_id: string;
  creator_name: string;
  creator_side: Side;
  creator_seed: string;
  joiner_id: string | null;
  joiner_name: string | null;
  joiner_seed: string | null;
  server_seed: string;
  server_seed_hash: string;
  result: Side | null;
  winner_id: string | null;
  prize: string | null;
  fee: string | null;
  created_at: Date;
}

function toMatch(row: MatchRow): VersusMatch {
  const creator: Caller = { id: row.creator_id, name: row.creator_name };
  const joiner: Caller | undefined = row.joiner_id ? { id: row.joiner_id, name: row.joiner_name! } : undefined;
  return {
    id: row.id,
    currency: row.currency,
    stake: BigInt(row.stake),
    status: row.status,
    creator,
    creatorSide: row.creator_side,
    creatorSeed: row.creator_seed,
    serverSeed: row.server_seed,
    serverSeedHash: row.server_seed_hash,
    createdAt: row.created_at.getTime(),
    joiner,
    joinerSeed: row.joiner_seed ?? undefined,
    result: row.result ?? undefined,
    winner: row.winner_id ? (row.winner_id === creator.id ? creator : joiner) : undefined,
    prize: row.prize === null ? undefined : BigInt(row.prize),
    fee: row.fee === null ? undefined : BigInt(row.fee),
  };
}

interface RoundRow {
  id: string;
  number: string;
  currency: string;
  status: JackpotStatus;
  server_seed: string;
  server_seed_hash: string;
  client_seed: string | null;
  closes_at: Date | null;
  winning_ticket: string | null;
  winner_id: string | null;
  prize: string | null;
  fee: string | null;
}

interface EntryRow {
  round_id: string;
  user_id: string;
  user_name: string;
  amount: string;
}

/**
 * Game state in the games schema. Every state change is a conditional
 * UPDATE (or runs under a row lock), so several instances of the games
 * service can share one database.
 */
export class PgGamesStore implements GamesStore {
  constructor(private readonly pool: Pool) {}

  // ----- Seeds -----

  async activeSeedPair(userId: string) {
    const { rows } = await this.pool.query<SeedRow>(
      `SELECT ${SEED_COLUMNS} FROM games.seed_pairs WHERE user_id = $1 AND revealed_at IS NULL`,
      [userId],
    );
    return rows[0] && toSeedPair(rows[0]);
  }

  async createSeedPair(fresh: SeedPair) {
    await this.pool.query(
      `INSERT INTO games.seed_pairs (id, user_id, server_seed, server_seed_hash, client_seed, nonce)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) WHERE revealed_at IS NULL DO NOTHING`,
      [fresh.id, fresh.userId, fresh.serverSeed, fresh.serverSeedHash, fresh.clientSeed, fresh.nonce],
    );
    return (await this.activeSeedPair(fresh.userId))!;
  }

  async claimNonce(userId: string) {
    const { rows } = await this.pool.query<SeedRow>(
      `UPDATE games.seed_pairs SET nonce = nonce + 1
       WHERE user_id = $1 AND revealed_at IS NULL
       RETURNING ${SEED_COLUMNS}`,
      [userId],
    );
    if (!rows[0]) {
      throw new Error("No active seed pair");
    }
    const pair = toSeedPair(rows[0]);
    return { pair, nonce: pair.nonce - 1 };
  }

  rotateSeedPair(userId: string, previousId: string, next: SeedPair) {
    return transaction(this.pool, async (client) => {
      const { rows } = await client.query<SeedRow>(
        `UPDATE games.seed_pairs SET revealed_at = now()
         WHERE id = $1 AND user_id = $2 AND revealed_at IS NULL
         RETURNING ${SEED_COLUMNS}`,
        [previousId, userId],
      );
      if (!rows[0]) {
        return undefined;
      }
      await client.query(
        `INSERT INTO games.seed_pairs (id, user_id, server_seed, server_seed_hash, client_seed, nonce)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [next.id, userId, next.serverSeed, next.serverSeedHash, next.clientSeed, next.nonce],
      );
      return toSeedPair(rows[0]);
    });
  }

  // ----- Roulette -----

  async recordSpin(spin: RouletteSpin) {
    await this.pool.query(
      `INSERT INTO games.roulette_spins (id, user_id, seed_pair_id, nonce, currency, bets, number, total_stake, total_payout)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        spin.id,
        spin.userId,
        spin.seedPairId,
        spin.nonce,
        spin.currency,
        JSON.stringify(spin.bets.map((bet) => ({ ...bet, amount: bet.amount.toString() }))),
        spin.number,
        spin.totalStake.toString(),
        spin.totalPayout.toString(),
      ],
    );
  }

  // ----- Versus -----

  async insertMatch(match: VersusMatch) {
    await this.pool.query(
      `INSERT INTO games.versus_matches
         (id, currency, stake, status, creator_id, creator_name, creator_side, creator_seed, server_seed, server_seed_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        match.id,
        match.currency,
        match.stake.toString(),
        match.status,
        match.creator.id,
        match.creator.name,
        match.creatorSide,
        match.creatorSeed,
        match.serverSeed,
        match.serverSeedHash,
        new Date(match.createdAt),
      ],
    );
  }

  async getMatch(id: string) {
    if (!UUID.test(id)) {
      return undefined;
    }
    const { rows } = await this.pool.query<MatchRow>("SELECT * FROM games.versus_matches WHERE id = $1", [id]);
    return rows[0] && toMatch(rows[0]);
  }

  async listMatches(limit: number) {
    const open = await this.pool.query<MatchRow>(
      "SELECT * FROM games.versus_matches WHERE status IN ('open', 'settling') ORDER BY created_at DESC, id",
    );
    const recent = await this.pool.query<MatchRow>(
      "SELECT * FROM games.versus_matches WHERE status = 'settled' ORDER BY settled_at DESC, id LIMIT $1",
      [limit],
    );
    return { open: open.rows.map(toMatch), recent: recent.rows.map(toMatch) };
  }

  async claimJoin(id: string, joiner: Caller, joinerSeed: string) {
    if (!UUID.test(id)) {
      return undefined;
    }
    const { rows } = await this.pool.query<MatchRow>(
      `UPDATE games.versus_matches SET status = 'settling', joiner_id = $2, joiner_name = $3, joiner_seed = $4
       WHERE id = $1 AND status = 'open' AND creator_id <> $2
       RETURNING *`,
      [id, joiner.id, joiner.name, joinerSeed],
    );
    return rows[0] && toMatch(rows[0]);
  }

  async releaseJoin(id: string, joinerId: string) {
    await this.pool.query(
      `UPDATE games.versus_matches SET status = 'open', joiner_id = NULL, joiner_name = NULL, joiner_seed = NULL
       WHERE id = $1 AND status = 'settling' AND joiner_id = $2 AND result IS NULL`,
      [id, joinerId],
    );
  }

  async recordVersusResult(id: string, result: VersusResult) {
    await this.pool.query(
      `UPDATE games.versus_matches SET result = $2, winner_id = $3, prize = $4, fee = $5
       WHERE id = $1 AND status = 'settling'`,
      [id, result.result, result.winner.id, result.prize.toString(), result.fee.toString()],
    );
  }

  async markSettled(id: string) {
    await this.pool.query(
      "UPDATE games.versus_matches SET status = 'settled', settled_at = now() WHERE id = $1 AND status = 'settling'",
      [id],
    );
  }

  async cancelMatch(id: string, creatorId: string) {
    if (!UUID.test(id)) {
      return undefined;
    }
    const { rows } = await this.pool.query<MatchRow>(
      `UPDATE games.versus_matches SET status = 'cancelled', settled_at = now()
       WHERE id = $1 AND status = 'open' AND creator_id = $2
       RETURNING *`,
      [id, creatorId],
    );
    return rows[0] && toMatch(rows[0]);
  }

  // ----- Jackpot -----

  private async rounds(client: Queryable, where: string, params: unknown[]): Promise<JackpotRound[]> {
    const { rows } = await client.query<RoundRow>(`SELECT * FROM games.jackpot_rounds WHERE ${where}`, params);
    if (rows.length === 0) {
      return [];
    }
    const entries = await client.query<EntryRow>(
      "SELECT round_id, user_id, user_name, amount FROM games.jackpot_entries WHERE round_id = ANY($1::uuid[]) ORDER BY position",
      [`{${rows.map((row) => row.id).join(",")}}`],
    );
    return rows.map((row) => {
      const mine = entries.rows
        .filter((entry) => entry.round_id === row.id)
        .map((entry): JackpotEntry => ({ user: { id: entry.user_id, name: entry.user_name }, amount: BigInt(entry.amount) }));
      return {
        id: row.id,
        number: Number(row.number),
        currency: row.currency,
        status: row.status,
        serverSeed: row.server_seed,
        serverSeedHash: row.server_seed_hash,
        entries: mine,
        closesAt: row.closes_at?.getTime(),
        clientSeed: row.client_seed ?? undefined,
        winningTicket: row.winning_ticket === null ? undefined : BigInt(row.winning_ticket),
        winner: row.winner_id ? mine.find((entry) => entry.user.id === row.winner_id)?.user : undefined,
        prize: row.prize === null ? undefined : BigInt(row.prize),
        fee: row.fee === null ? undefined : BigInt(row.fee),
      };
    });
  }

  async currentRound() {
    return (await this.rounds(this.pool, "status <> 'settled'", []))[0];
  }

  async openRound(fresh: NewJackpotRound) {
    try {
      await this.pool.query(
        `INSERT INTO games.jackpot_rounds (id, number, currency, status, server_seed, server_seed_hash)
         SELECT $1, coalesce(max(number), 0) + 1, $2, 'open', $3, $4 FROM games.jackpot_rounds`,
        [fresh.id, fresh.currency, fresh.serverSeed, fresh.serverSeedHash],
      );
    } catch (error) {
      // Another instance opened the round first.
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
    return (await this.currentRound())!;
  }

  addEntry(roundId: string, entry: JackpotEntry, now: number, durationMs: number) {
    return transaction(this.pool, async (client) => {
      // The row lock orders entries and keeps them out once the draw has claimed the round.
      const { rows } = await client.query<{ status: JackpotStatus; closes_at: Date | null }>(
        "SELECT status, closes_at FROM games.jackpot_rounds WHERE id = $1 FOR UPDATE",
        [roundId],
      );
      const round = rows[0];
      if (!round || round.status !== "open" || (round.closes_at && now >= round.closes_at.getTime())) {
        return undefined;
      }
      await client.query(
        `INSERT INTO games.jackpot_entries (id, round_id, position, user_id, user_name, amount)
         SELECT gen_random_uuid(), $1, count(*), $2, $3, $4 FROM games.jackpot_entries WHERE round_id = $1`,
        [roundId, entry.user.id, entry.user.name, entry.amount.toString()],
      );
      await client.query(
        `UPDATE games.jackpot_rounds SET closes_at = $2
         WHERE id = $1 AND closes_at IS NULL
           AND (SELECT count(DISTINCT user_id) FROM games.jackpot_entries WHERE round_id = $1) >= 2`,
        [roundId, new Date(now + durationMs)],
      );
      return (await this.rounds(client, "id = $1", [roundId]))[0];
    });
  }

  async claimDraw(roundId: string, now: number) {
    const { rowCount } = await this.pool.query(
      `UPDATE games.jackpot_rounds SET status = 'drawing'
       WHERE id = $1 AND (status = 'drawing' OR (status = 'open' AND closes_at <= $2))`,
      [roundId, new Date(now)],
    );
    return rowCount ? (await this.rounds(this.pool, "id = $1", [roundId]))[0] : undefined;
  }

  async recordJackpotResult(roundId: string, result: JackpotResult) {
    await this.pool.query(
      `UPDATE games.jackpot_rounds SET client_seed = $2, winning_ticket = $3, winner_id = $4, prize = $5, fee = $6
       WHERE id = $1 AND status = 'drawing'`,
      [roundId, result.clientSeed, result.winningTicket.toString(), result.winner.id, result.prize.toString(), result.fee.toString()],
    );
  }

  async settleRound(roundId: string) {
    const { rowCount } = await this.pool.query(
      "UPDATE games.jackpot_rounds SET status = 'settled', settled_at = now() WHERE id = $1 AND status = 'drawing'",
      [roundId],
    );
    return rowCount === 1;
  }

  async roundHistory(limit: number) {
    return this.rounds(this.pool, "status = 'settled' ORDER BY number DESC LIMIT $1", [limit]);
  }
}
