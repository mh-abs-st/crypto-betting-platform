import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { fairDigest, fairInt, generateSeed, hashServerSeed, verifyCommitment } from "./index";

const input = { serverSeed: "a".repeat(64), clientSeed: "player-seed", nonce: 7 };

test("seeds are random hex of the requested length", () => {
  const first = generateSeed();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, generateSeed());
});

test("commitment is plain SHA-256 so anyone can check it", async () => {
  const expected = createHash("sha256").update(input.serverSeed).digest("hex");
  assert.equal(await hashServerSeed(input.serverSeed), expected);
  assert.equal(await verifyCommitment(input.serverSeed, expected.toUpperCase()), true);
  assert.equal(await verifyCommitment("b".repeat(64), expected), false);
});

test("digest matches an independent HMAC-SHA256", async () => {
  const expected = createHmac("sha256", input.serverSeed).update("player-seed:7").digest("hex");
  assert.equal(await fairDigest(input), expected);
});

test("fairInt is deterministic and depends on every input", async () => {
  const base = await fairInt(input, 1_000_000_007n);
  assert.equal(await fairInt(input, 1_000_000_007n), base);
  assert.notEqual(await fairInt({ ...input, nonce: 8 }, 1_000_000_007n), base);
  assert.notEqual(await fairInt({ ...input, clientSeed: "other" }, 1_000_000_007n), base);
  assert.notEqual(await fairInt({ ...input, serverSeed: "c".repeat(64) }, 1_000_000_007n), base);
});

test("fairInt stays in range and covers it evenly", async () => {
  const counts = new Array<number>(37).fill(0);
  const draws = 7400;
  for (let nonce = 0; nonce < draws; nonce++) {
    const value = Number(await fairInt({ ...input, nonce }, 37n));
    assert.ok(value >= 0 && value < 37);
    counts[value]! += 1;
  }
  // Expected 200 per pocket; a fair generator stays well inside 120..280.
  for (const count of counts) {
    assert.ok(count > 120 && count < 280, `pocket count ${count} is far from 200`);
  }
});

test("invalid ranges and nonces are rejected", async () => {
  await assert.rejects(fairInt(input, 0n), RangeError);
  await assert.rejects(fairInt(input, (1n << 64n) + 1n), RangeError);
  assert.throws(() => fairDigest({ ...input, nonce: -1 }), RangeError);
});
