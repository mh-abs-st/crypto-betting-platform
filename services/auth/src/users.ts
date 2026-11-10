import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { HttpError } from "@yuubet/service-kit";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keyLength: number) => Promise<Buffer>;
const KEY_LENGTH = 64;
const USERNAME = /^[A-Za-z0-9_]{3,20}$/;

export interface User {
  id: string;
  username: string;
  createdAt: number;
}

interface StoredUser extends User {
  salt: Buffer;
  passwordHash: Buffer;
}

/**
 * Accounts and password checks. Passwords are stored only as salted scrypt
 * hashes. Kept in memory for now; the table is in db/migrations.
 */
export class UserStore {
  private readonly byName = new Map<string, StoredUser>();
  // Hashed for unknown usernames so a wrong name takes as long as a wrong password.
  private readonly decoySalt = randomBytes(16);

  async register(username: unknown, password: unknown): Promise<User> {
    if (typeof username !== "string" || !USERNAME.test(username)) {
      throw new HttpError(400, "INVALID_USERNAME", "Username must be 3 to 20 letters, digits or underscores");
    }
    if (typeof password !== "string" || password.length < 8 || password.length > 128) {
      throw new HttpError(400, "INVALID_PASSWORD", "Password must be 8 to 128 characters");
    }

    const key = username.toLowerCase();
    if (this.byName.has(key)) {
      throw new HttpError(409, "USERNAME_TAKEN", "That username is already taken");
    }

    const salt = randomBytes(16);
    const passwordHash = await scryptAsync(password, salt, KEY_LENGTH);
    // Check again: another request may have taken the name while hashing.
    if (this.byName.has(key)) {
      throw new HttpError(409, "USERNAME_TAKEN", "That username is already taken");
    }

    const user: StoredUser = { id: randomUUID(), username, createdAt: Date.now(), salt, passwordHash };
    this.byName.set(key, user);
    return publicUser(user);
  }

  async verify(username: unknown, password: unknown): Promise<User> {
    const failure = new HttpError(401, "INVALID_CREDENTIALS", "Wrong username or password");
    if (typeof username !== "string" || typeof password !== "string" || password.length > 128) {
      throw failure;
    }

    const user = this.byName.get(username.toLowerCase());
    const hash = await scryptAsync(password, user?.salt ?? this.decoySalt, KEY_LENGTH);
    if (!user || !timingSafeEqual(hash, user.passwordHash)) {
      throw failure;
    }
    return publicUser(user);
  }
}

function publicUser(user: StoredUser): User {
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}
