import { HttpError, Router, forward, verifyToken, type Caller, type RequestContext } from "@yuubet/service-kit";

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

  return new Router({ corsOrigin: config.webOrigin })
    .get("/health", () => ({ ok: true }))
    .post("/api/auth/register", pass(config.authUrl, "/register"))
    .post("/api/auth/login", pass(config.authUrl, "/login"))
    .get("/api/auth/me", (ctx) => {
      const user = authenticate(ctx);
      return { id: user.id, username: user.name };
    })
    // Only a player's own wallet endpoints are reachable from outside.
    .add("*", "/api/wallet/me/*", pass(config.walletUrl, "/me/", authenticate))
    .add("*", "/api/games/*", pass(config.gamesUrl, "/", authenticate));
}
