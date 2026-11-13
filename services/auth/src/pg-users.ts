import { isUniqueViolation, type Pool } from "@yuubet/db";
import { hashPassword, verifyPassword } from "./passwords";
import { invalidCredentials, signInInput, usernameTaken, validateSignUp, type User, type UserStore } from "./users";

interface UserRow {
  id: string;
  username: string;
  created_at: Date;
}

const toUser = (row: UserRow): User => ({ id: row.id, username: row.username, createdAt: row.created_at.getTime() });

/**
 * Accounts in auth.users. The unique index on lower(username) decides who
 * gets a name, so two sign-ups racing for it cannot both succeed.
 */
export class PgUserStore implements UserStore {
  constructor(private readonly pool: Pool) {}

  async register(username: unknown, password: unknown): Promise<User> {
    const input = validateSignUp(username, password);
    const hash = await hashPassword(input.password);
    try {
      const { rows } = await this.pool.query<UserRow>(
        `INSERT INTO auth.users (username, password_salt, password_hash, password_params)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, created_at`,
        [input.username, hash.salt, hash.hash, hash.params],
      );
      return toUser(rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error, "users_username_lower")) {
        throw usernameTaken();
      }
      throw error;
    }
  }

  async verify(username: unknown, password: unknown): Promise<User> {
    const input = signInInput(username, password);
    if (!input) {
      throw invalidCredentials();
    }
    const { rows } = await this.pool.query<UserRow & { password_salt: Buffer; password_hash: Buffer; password_params: string }>(
      `SELECT id, username, created_at, password_salt, password_hash, password_params
       FROM auth.users WHERE lower(username) = lower($1)`,
      [input.username],
    );
    const row = rows[0];
    const stored = row && { params: row.password_params, salt: row.password_salt, hash: row.password_hash };
    if (!(await verifyPassword(input.password, stored)) || !row) {
      throw invalidCredentials();
    }
    return toUser(row);
  }
}
