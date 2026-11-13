import { Reply, Router, bodyObject, requireInternal, schema, signToken } from "@yuubet/service-kit";
import { MemoryUserStore, type User, type UserStore } from "./users";

export interface AuthConfig {
  jwtSecret: string;
  internalKey: string;
  tokenTtlSeconds?: number;
}

const credentials = schema.object(
  {
    username: schema.text(64, "3 to 20 letters, digits or underscores"),
    password: schema.text(1024, "8 to 128 characters"),
  },
  ["username", "password"],
);
const sessionReply = schema.reply({
  token: { type: "string", description: "Send as Authorization: Bearer <token>" },
  user: schema.reply({ id: { type: "string" }, username: { type: "string" } }),
});

/** Sign-up and sign-in. Issues the token that the gateway checks on every request. */
export function buildAuthRouter(config: AuthConfig, users: UserStore = new MemoryUserStore()): Router {
  const ttl = config.tokenTtlSeconds ?? 12 * 60 * 60;
  const session = (user: User) => ({
    token: signToken(user, config.jwtSecret, ttl),
    user: { id: user.id, username: user.username },
  });

  return new Router({ internalKey: config.internalKey, title: "YuuBet auth service" })
    .get("/health", () => ({ ok: true }), { response: { 200: schema.ok } })
    .post(
      "/register",
      async (ctx) => {
        requireInternal(ctx, config.internalKey);
        const body = bodyObject(ctx);
        return new Reply(201, session(await users.register(body.username, body.password)));
      },
      {
        summary: "Create an account and sign in",
        body: credentials,
        response: { 201: sessionReply, 400: schema.errorReply, 409: schema.errorReply },
      },
    )
    .post(
      "/login",
      async (ctx) => {
        requireInternal(ctx, config.internalKey);
        const body = bodyObject(ctx);
        return session(await users.verify(body.username, body.password));
      },
      { summary: "Sign in", body: credentials, response: { 200: sessionReply, 401: schema.errorReply } },
    );
}
