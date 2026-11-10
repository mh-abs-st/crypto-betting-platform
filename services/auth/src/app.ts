import { Reply, Router, bodyObject, requireInternal, signToken } from "@yuubet/service-kit";
import { UserStore, type User } from "./users";

export interface AuthConfig {
  jwtSecret: string;
  internalKey: string;
  tokenTtlSeconds?: number;
}

/** Sign-up and sign-in. Issues the token that the gateway checks on every request. */
export function buildAuthRouter(config: AuthConfig, users = new UserStore()): Router {
  const ttl = config.tokenTtlSeconds ?? 12 * 60 * 60;
  const session = (user: User) => ({
    token: signToken(user, config.jwtSecret, ttl),
    user: { id: user.id, username: user.username },
  });

  return new Router()
    .get("/health", () => ({ ok: true }))
    .post("/register", async (ctx) => {
      requireInternal(ctx, config.internalKey);
      const body = bodyObject(ctx);
      return new Reply(201, session(await users.register(body.username, body.password)));
    })
    .post("/login", async (ctx) => {
      requireInternal(ctx, config.internalKey);
      const body = bodyObject(ctx);
      return session(await users.verify(body.username, body.password));
    });
}
