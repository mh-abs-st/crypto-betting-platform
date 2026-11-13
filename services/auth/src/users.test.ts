import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createPool } from "@yuubet/db";
import { createTestDatabase, skipWithoutDatabase, type TestDatabase } from "@yuubet/db/testing";
import { formatParams, hashPassword, parseParams, verifyPassword } from "./passwords";
import { PgUserStore } from "./pg-users";
import { MemoryUserStore, type UserStore } from "./users";

const PASSWORD = "correct horse battery";
const name = () => `u_${randomBytes(6).toString("hex")}`;

function contract(label: string, make: () => UserStore, skip: string | false = false) {
  describe(label, { skip }, () => {
    test("register then sign in, with any capitalisation of the username", async () => {
      const users = make();
      const username = name();
      const created = await users.register(username, PASSWORD);
      assert.equal(created.username, username);
      assert.match(created.id, /^[0-9a-f-]{36}$/);
      assert.deepEqual(await users.verify(username.toUpperCase(), PASSWORD), created);
    });

    test("usernames are unique regardless of case", async () => {
      const users = make();
      const username = name();
      await users.register(username, PASSWORD);
      await assert.rejects(users.register(username.toUpperCase(), PASSWORD), { code: "USERNAME_TAKEN" });
    });

    test("two sign-ups racing for one name: exactly one wins", async () => {
      const users = make();
      const username = name();
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => users.register(username, PASSWORD)));
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.ok(
        results.every((r) => r.status === "fulfilled" || (r.reason as { code: string }).code === "USERNAME_TAKEN"),
      );
    });

    test("wrong password, unknown user and bad input are the same failure", async () => {
      const users = make();
      const username = name();
      await users.register(username, PASSWORD);
      for (const [u, p] of [
        [username, "wrong password"],
        [name(), PASSWORD],
        [username, 42],
        [null, PASSWORD],
        ["x".repeat(200), PASSWORD],
      ]) {
        await assert.rejects(users.verify(u, p), { code: "INVALID_CREDENTIALS" });
      }
    });

    test("invalid sign-ups are rejected", async () => {
      const users = make();
      await assert.rejects(users.register("ab", PASSWORD), { code: "INVALID_USERNAME" });
      await assert.rejects(users.register("has space", PASSWORD), { code: "INVALID_USERNAME" });
      await assert.rejects(users.register(name(), "short"), { code: "INVALID_PASSWORD" });
      await assert.rejects(users.register(name(), "x".repeat(129)), { code: "INVALID_PASSWORD" });
    });
  });
}

test("password hashes keep their parameters, so old ones verify after the defaults change", async () => {
  const weaker = { N: 1024, r: 8, p: 1, keyLength: 32 };
  const stored = await hashPassword(PASSWORD, weaker);
  assert.equal(stored.params, "scrypt:N=1024,r=8,p=1,len=32");
  assert.deepEqual(parseParams(stored.params), weaker);
  assert.equal(stored.hash.length, 32);
  assert.equal(await verifyPassword(PASSWORD, stored), true);
  assert.equal(await verifyPassword("nope nope nope", stored), false);
  assert.equal(await verifyPassword(PASSWORD, undefined), false);
  assert.throws(() => parseParams("bcrypt:12"), /Unknown password hash parameters/);
  assert.equal(formatParams(weaker), stored.params);
});

contract("MemoryUserStore", () => new MemoryUserStore());

let db: TestDatabase;
before(async () => {
  if (!skipWithoutDatabase) db = await createTestDatabase();
});
after(async () => {
  await db?.drop();
});
contract("PgUserStore", () => new PgUserStore(db.pool), skipWithoutDatabase);

describe("PgUserStore storage", { skip: skipWithoutDatabase }, () => {
  test("accounts survive a restart and store the hash parameters", async () => {
    const username = name();
    const created = await new PgUserStore(db.pool).register(username, PASSWORD);
    const fresh = createPool(db.url, { max: 1 });
    try {
      assert.deepEqual(await new PgUserStore(fresh).verify(username, PASSWORD), created);
    } finally {
      await fresh.end();
    }
    const { rows } = await db.pool.query(
      "SELECT password_params, octet_length(password_salt) AS salt FROM auth.users WHERE id = $1",
      [created.id],
    );
    assert.deepEqual(rows[0], { password_params: "scrypt:N=16384,r=8,p=1,len=64", salt: 16 });
  });

  test("an account stored with older parameters still signs in", async () => {
    const username = name();
    const old = await hashPassword(PASSWORD, { N: 1024, r: 8, p: 1, keyLength: 64 });
    await db.pool.query(
      "INSERT INTO auth.users (username, password_salt, password_hash, password_params) VALUES ($1, $2, $3, $4)",
      [username, old.salt, old.hash, old.params],
    );
    assert.equal((await new PgUserStore(db.pool).verify(username, PASSWORD)).username, username);
  });
});
