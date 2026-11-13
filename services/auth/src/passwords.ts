import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scryptAsync = (password: string, salt: Buffer, keyLength: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key))),
  );

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

/** Used for new passwords. Raising these later does not break stored hashes, which keep their own. */
export const CURRENT_PARAMS: ScryptParams = { N: 16_384, r: 8, p: 1, keyLength: 64 };

export interface PasswordHash {
  /** For example `scrypt:N=16384,r=8,p=1,len=64`. Stored next to the hash. */
  params: string;
  salt: Buffer;
  hash: Buffer;
}

export function formatParams(params: ScryptParams): string {
  return `scrypt:N=${params.N},r=${params.r},p=${params.p},len=${params.keyLength}`;
}

const PARAMS = /^scrypt:N=(\d+),r=(\d+),p=(\d+),len=(\d+)$/;

export function parseParams(text: string): ScryptParams {
  const match = PARAMS.exec(text);
  if (!match) {
    throw new Error(`Unknown password hash parameters: ${text}`);
  }
  const [N, r, p, keyLength] = match.slice(1).map(Number) as [number, number, number, number];
  return { N, r, p, keyLength };
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  // scrypt needs about 128 * N * r bytes; allow twice that.
  return scryptAsync(password, salt, params.keyLength, { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r });
}

export async function hashPassword(password: string, params = CURRENT_PARAMS): Promise<PasswordHash> {
  const salt = randomBytes(16);
  return { params: formatParams(params), salt, hash: await derive(password, salt, params) };
}

// Checked against when the username does not exist, so a wrong name takes as long as a wrong password.
const DECOY: PasswordHash = { params: formatParams(CURRENT_PARAMS), salt: randomBytes(16), hash: randomBytes(CURRENT_PARAMS.keyLength) };

/** True if the password matches. Pass `undefined` for an unknown user to spend the same time and return false. */
export async function verifyPassword(password: string, stored: PasswordHash | undefined): Promise<boolean> {
  const target = stored ?? DECOY;
  const hash = await derive(password, target.salt, parseParams(target.params));
  return stored !== undefined && hash.length === target.hash.length && timingSafeEqual(hash, target.hash);
}
