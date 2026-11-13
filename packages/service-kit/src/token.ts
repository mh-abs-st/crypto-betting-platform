import { createHmac, timingSafeEqual } from "node:crypto";

export interface TokenClaims {
  /** User id. */
  sub: string;
  username: string;
  /** Expiry, in seconds since the epoch. */
  exp: number;
}

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

function sign(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

/** Issues a JWT signed with HMAC-SHA256. */
export function signToken(
  user: { id: string; username: string },
  secret: string,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const claims: TokenClaims = { sub: user.id, username: user.username, exp: Math.floor(now / 1000) + ttlSeconds };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const data = `${HEADER}.${payload}`;
  return `${data}.${sign(data, secret).toString("base64url")}`;
}

/** Returns the claims of a valid, unexpired token, or undefined. */
export function verifyToken(token: string, secret: string, now = Date.now()): TokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== HEADER) {
    return undefined;
  }

  const expected = sign(`${parts[0]}.${parts[1]}`, secret);
  const given = Buffer.from(parts[2]!, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return undefined;
  }

  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as TokenClaims;
    if (typeof claims.sub !== "string" || typeof claims.username !== "string" || typeof claims.exp !== "number") {
      return undefined;
    }
    return claims.exp * 1000 > now ? claims : undefined;
  } catch {
    return undefined;
  }
}
