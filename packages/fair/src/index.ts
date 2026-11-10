/**
 * Provably fair random numbers.
 *
 * Before a bet the server publishes the SHA-256 hash of a secret server seed.
 * The outcome is HMAC-SHA256(server seed, "client seed:nonce"). When the server
 * seed is revealed later, anyone can check that it matches the published hash
 * and recompute every outcome.
 *
 * Uses the Web Crypto API only, so the same code runs in the services and in
 * the browser, where players verify their own bets.
 */

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A new random seed as a hex string. */
export function generateSeed(byteLength = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return toHex(new Uint8Array(digest));
}

/** The commitment published before a bet. */
export function hashServerSeed(serverSeed: string): Promise<string> {
  return sha256Hex(serverSeed);
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return toHex(new Uint8Array(signature));
}

export interface FairInput {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
}

/** The raw 256-bit result for one bet, as hex. */
export function fairDigest(input: FairInput): Promise<string> {
  if (!Number.isSafeInteger(input.nonce) || input.nonce < 0) {
    throw new RangeError("nonce must be a non-negative integer");
  }
  return hmacSha256Hex(input.serverSeed, `${input.clientSeed}:${input.nonce}`);
}

/**
 * A whole number from 0 up to, but not including, maxExclusive.
 *
 * Takes the first 128 bits of the digest modulo the range. For ranges below
 * 2^64 the bias from the modulo is under 2^-64, far too small to matter.
 */
export async function fairInt(input: FairInput, maxExclusive: bigint): Promise<bigint> {
  if (maxExclusive <= 0n) {
    throw new RangeError("maxExclusive must be positive");
  }
  if (maxExclusive > 1n << 64n) {
    throw new RangeError("maxExclusive is too large");
  }
  const digest = await fairDigest(input);
  return BigInt(`0x${digest.slice(0, 32)}`) % maxExclusive;
}

/** True when a revealed server seed matches the hash published earlier. */
export async function verifyCommitment(serverSeed: string, publishedHash: string): Promise<boolean> {
  return (await hashServerSeed(serverSeed)) === publishedHash.toLowerCase();
}
