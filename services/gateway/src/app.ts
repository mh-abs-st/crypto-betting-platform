import { HttpError, Router, forward, schema, verifyToken, type Caller, type RequestContext } from "@yuubet/service-kit";

export interface GatewayConfig {
  jwtSecret: string;
  internalKey: string;
  authUrl: string;
  walletUrl: string;
  gamesUrl: string;
  /** Browser origin allowed to call the API. */
  webOrigin?: string;
}

/**
 * The only service the browser talks to. It checks the login token, then
 * passes the request to the service that owns it, adding the player's
 * identity and the internal key. Services never see the token itself.
 */
export function buildGatewayRouter(config: GatewayConfig): Router {
  const authenticate = (ctx: RequestContext): Caller => {
    const header = ctx.headers.authorization ?? "";
    const claims = header.startsWith("Bearer ") ? verifyToken(header.slice(7), config.jwtSecret) : undefined;
    if (!claims) {
      throw new HttpError(401, "UNAUTHORIZED", "Sign in to continue");
    }
    return { id: claims.sub, name: claims.username };
  };

  const pass = (baseUrl: string, prefix: string, user?: (ctx: RequestContext) => Caller) => (ctx: RequestContext) => {
    const query = ctx.query.toString();
    const path = `${prefix}${ctx.params["*"] ?? ""}${query ? `?${query}` : ""}`;
    // The forwarded path must stay under the prefix, whatever the client sent.
    if (!new URL(path, baseUrl).pathname.startsWith(prefix)) {
      throw new HttpError(404, "NOT_FOUND", "No such endpoint");
    }
    return forward(baseUrl, path, {
      method: ctx.method,
      body: ctx.body,
      internalKey: config.internalKey,
      user: user?.(ctx),
    });
  };

  const credentials = {
    body: schema.object({ username: schema.text(64), password: schema.text(1024) }, ["username", "password"]),
  };

  // The routes under /api/wallet/me and /api/games are passed through and
  // validated by the service that owns them; see each service's /openapi.json.
  return (
    new Router({ corsOrigin: config.webOrigin, title: "YuuBet public API (gateway)" })
      .get("/health", () => ({ ok: true }), { response: { 200: schema.ok } })
      .post("/api/auth/register", pass(config.authUrl, "/register"), { summary: "Create an account", ...credentials })
      .post("/api/auth/login", pass(config.authUrl, "/login"), { summary: "Sign in", ...credentials })
      .get(
        "/api/auth/me",
        (ctx) => {
          const user = authenticate(ctx);
          return { id: user.id, username: user.name };
        },
        {
          summary: "The signed-in player",
          response: {
            200: schema.reply({ id: { type: "string" }, username: { type: "string" } }),
            401: schema.errorReply,
          },
        },
      )
      // Only a player's own wallet endpoints are reachable from outside.
      .add("*", "/api/wallet/me/*", pass(config.walletUrl, "/me/", authenticate))
      .add("*", "/api/games/*", pass(config.gamesUrl, "/", authenticate))
  );
}
