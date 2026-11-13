import { randomUUID } from "node:crypto";
import { HttpError } from "@yuubet/service-kit";
import { hashPassword, verifyPassword, type PasswordHash } from "./passwords";

const USERNAME = /^[A-Za-z0-9_]{3,20}$/;

export interface User {
  id: string;
  username: string;
  createdAt: number;
}

/**
 * Accounts and password checks. Passwords are stored only as salted scrypt
 * hashes, together with the scrypt parameters used.
 *
 * `PgUserStore` (pg-users.ts) is the real one; `MemoryUserStore` is for tests
 * and for running without a database.
 */
export interface UserStore {
  register(username: unknown, password: unknown): Promise<User>;
  verify(username: unknown, password: unknown): Promise<User>;
}

/** Checks the sign-up input and returns it typed. */
export function validateSignUp(username: unknown, password: unknown): { username: string; password: string } {
  if (typeof username !== "string" || !USERNAME.test(username)) {
    throw new HttpError(400, "INVALID_USERNAME", "Username must be 3 to 20 letters, digits or underscores");
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    throw new HttpError(400, "INVALID_PASSWORD", "Password must be 8 to 128 characters");
  }
  return { username, password };
}

export const usernameTaken = () => new HttpError(409, "USERNAME_TAKEN", "That username is already taken");
export const invalidCredentials = () => new HttpError(401, "INVALID_CREDENTIALS", "Wrong username or password");

/** Typed sign-in input, or undefined if it cannot possibly match an account. */
export function signInInput(username: unknown, password: unknown): { username: string; password: string } | undefined {
  if (typeof username !== "string" || typeof password !== "string" || username.length > 20 || password.length > 128) {
    return undefined;
  }
  return { username, password };
}

interface StoredUser extends User {
  password: PasswordHash;
}

/** Accounts in memory. They are lost when the process stops. */
export class MemoryUserStore implements UserStore {
  private readonly byName = new Map<string, StoredUser>();

  async register(username: unknown, password: unknown): Promise<User> {
    const input = validateSignUp(username, password);
    const key = input.username.toLowerCase();
    if (this.byName.has(key)) {
      throw usernameTaken();
    }
    const hash = await hashPassword(input.password);
    // Check again: another request may have taken the name while hashing.
    if (this.byName.has(key)) {
      throw usernameTaken();
    }
    const user: StoredUser = { id: randomUUID(), username: input.username, createdAt: Date.now(), password: hash };
    this.byName.set(key, user);
    return publicUser(user);
  }

  async verify(username: unknown, password: unknown): Promise<User> {
    const input = signInInput(username, password);
    if (!input) {
      throw invalidCredentials();
    }
    const user = this.byName.get(input.username.toLowerCase());
    if (!(await verifyPassword(input.password, user?.password)) || !user) {
      throw invalidCredentials();
    }
    return publicUser(user);
  }
}

function publicUser(user: StoredUser): User {
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}
