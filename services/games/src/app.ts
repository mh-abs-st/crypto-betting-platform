import { GameError } from "@yuubet/games";
import { HttpError, Reply, Router, bodyObject, requireInternal, requireUser, type RequestContext } from "@yuubet/service-kit";
import type { GamesService } from "./service";

const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  MATCH_CLOSED: 409,
  ROUND_CLOSING: 409,
  SEED_CHANGED: 409,
  TOO_MANY_OPEN_MATCHES: 409,
  OWN_MATCH: 403,
  NOT_YOUR_MATCH: 403,
};

/** HTTP endpoints for the games. Reached only through the gateway. */
export function buildGamesRouter(service: GamesService, internalKey: string): Router {
  // Responses with deadlines carry the server's time, so clients count down on its clock, not theirs.
  const timed = <T extends object>(body: T) => ({ ...body, serverTime: service.time() });

  const player = (ctx: RequestContext) => {
    requireInternal(ctx, internalKey);
    return requireUser(ctx);
  };

  return new Router()
    .mapError((error) =>
      error instanceof GameError ? new HttpError(STATUS_BY_CODE[error.code] ?? 400, error.code, error.message) : undefined,
    )
    .get("/health", () => ({ ok: true }))
    .get("/config", (ctx) => {
      player(ctx);
      return service.describe();
    })
    .get("/fair/seed", (ctx) => service.seedInfo(player(ctx).id))
    .post("/fair/rotate", (ctx) => service.rotateSeed(player(ctx).id, bodyObject(ctx).clientSeed))
    .post("/roulette/spin", (ctx) => service.spinRoulette(player(ctx), bodyObject(ctx)))
    .get("/versus", async (ctx) => {
      player(ctx);
      return timed(await service.listVersus());
    })
    .post("/versus", async (ctx) => new Reply(201, timed(await service.createVersus(player(ctx), bodyObject(ctx)))))
    .post("/versus/:id/join", (ctx) => service.joinVersus(player(ctx), ctx.params.id!, bodyObject(ctx)))
    .post("/versus/:id/cancel", (ctx) => service.cancelVersus(player(ctx), ctx.params.id!))
    .get("/jackpot", async (ctx) => {
      player(ctx);
      await service.drawJackpotIfDue();
      return timed(await service.currentJackpot());
    })
    .get("/jackpot/history", (ctx) => {
      player(ctx);
      return service.listJackpotHistory();
    })
    .post("/jackpot/enter", async (ctx) => timed(await service.enterJackpot(player(ctx), bodyObject(ctx))));
}
