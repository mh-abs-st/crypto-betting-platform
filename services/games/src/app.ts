import { GameError } from "@yuubet/games";
import {
  HttpError,
  Reply,
  Router,
  bodyObject,
  requireInternal,
  requireUser,
  schema,
  type RequestContext,
} from "@yuubet/service-kit";
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

const serverTime = { type: "integer", description: "The server's clock, in milliseconds since 1970" };
const seedReply = schema.reply({
  serverSeedHash: { type: "string" },
  clientSeed: { type: "string" },
  nonce: { type: "integer" },
});
const matchId = schema.object({ id: schema.text(64) }, ["id"]);
const matchReply = schema.reply({
  id: { type: "string" },
  stake: schema.amount,
  status: { type: "string", enum: ["open", "settled", "cancelled", "expired"] },
  payoutPending: { type: "boolean" },
  creator: schema.caller,
  creatorSide: { type: "string", enum: ["heads", "tails"] },
  serverSeedHash: { type: "string" },
  createdAt: { type: "integer" },
  expiresAt: { type: "integer" },
  joiner: schema.caller,
  result: { type: "string", enum: ["heads", "tails"] },
  winner: schema.caller,
  prize: schema.amount,
  fee: schema.amount,
  serverSeed: { type: "string", description: "Revealed once the match is settled" },
  clientSeed: { type: "string" },
});
const roundReply = schema.reply({
  id: { type: "string" },
  number: { type: "integer" },
  status: { type: "string", enum: ["open", "drawing", "settled"] },
  serverSeedHash: { type: "string" },
  pot: schema.amount,
  closesAt: { type: "integer" },
  entropy: schema.reply({ source: { type: "string" }, height: { type: "integer" }, hash: { type: "string" } }),
  entries: {
    type: "array",
    items: schema.reply({ user: schema.caller, amount: schema.amount, chanceBps: { type: "integer" } }),
  },
  winner: schema.caller,
  winningTicket: schema.amount,
  prize: schema.amount,
  fee: schema.amount,
  serverSeed: { type: "string" },
  clientSeed: { type: "string" },
  serverTime,
});

/** HTTP endpoints for the games. Reached only through the gateway. */
export function buildGamesRouter(service: GamesService, internalKey: string): Router {
  // Responses with deadlines carry the server's time, so clients count down on its clock, not theirs.
  const timed = <T extends object>(body: T) => ({ ...body, serverTime: service.time() });

  const player = (ctx: RequestContext) => {
    requireInternal(ctx, internalKey);
    return requireUser(ctx);
  };

  return new Router({ internalKey, title: "YuuBet games service" })
    .mapError((error) =>
      error instanceof GameError
        ? new HttpError(STATUS_BY_CODE[error.code] ?? 400, error.code, error.message)
        : undefined,
    )
    .get("/health", () => ({ ok: true }), { response: { 200: schema.ok } })
    .get(
      "/config",
      (ctx) => {
        player(ctx);
        return service.describe();
      },
      { summary: "Limits and fees" },
    )
    .get("/fair/seed", (ctx) => service.seedInfo(player(ctx).id), {
      summary: "Your current Roulette seed pair (the server seed only as its hash)",
      response: { 200: seedReply },
    })
    .post("/fair/rotate", (ctx) => service.rotateSeed(player(ctx).id, bodyObject(ctx).clientSeed), {
      summary: "Reveal your server seed and start a new pair",
      body: schema.object({ clientSeed: schema.clientSeed }),
      response: {
        200: schema.reply({
          revealed: schema.reply({
            serverSeed: { type: "string" },
            serverSeedHash: { type: "string" },
            clientSeed: { type: "string" },
            betsPlaced: { type: "integer" },
          }),
          current: seedReply,
        }),
        409: schema.errorReply,
      },
    })
    .post("/roulette/spin", (ctx) => service.spinRoulette(player(ctx), bodyObject(ctx)), {
      summary: "Place Roulette bets and spin",
      body: schema.object(
        {
          bets: {
            type: "array",
            maxItems: 50,
            items: schema.object(
              {
                type: schema.text(16, "red, black, even, odd, low, high, dozen, column or straight"),
                value: { type: ["integer", "null"], description: "The number, dozen or column, where needed" },
                amount: schema.amount,
              },
              ["type", "amount"],
            ),
          },
        },
        ["bets"],
      ),
      response: {
        200: schema.reply({
          betId: { type: "string" },
          number: { type: "integer" },
          color: { type: "string" },
          totalStake: schema.amount,
          totalPayout: schema.amount,
          payoutStatus: { type: "string", enum: ["none", "paid", "pending"] },
          fairness: seedReply,
        }),
        400: schema.errorReply,
        409: schema.errorReply,
      },
    })
    .get(
      "/versus",
      async (ctx) => {
        player(ctx);
        return timed(await service.listVersus());
      },
      {
        summary: "Open matches and recent results",
        response: {
          200: schema.reply({
            open: { type: "array", items: matchReply },
            recent: { type: "array", items: matchReply },
            serverTime,
          }),
        },
      },
    )
    .post("/versus", async (ctx) => new Reply(201, timed(await service.createVersus(player(ctx), bodyObject(ctx)))), {
      summary: "Open a match",
      body: schema.object(
        { amount: schema.amount, side: schema.text(8, "heads or tails"), clientSeed: schema.clientSeed },
        ["amount", "side"],
      ),
      response: { 201: matchReply, 400: schema.errorReply, 409: schema.errorReply },
    })
    .post("/versus/:id/join", (ctx) => service.joinVersus(player(ctx), ctx.params.id!, bodyObject(ctx)), {
      summary: "Join an open match; it is settled at once",
      params: matchId,
      body: schema.object({ clientSeed: schema.clientSeed }),
      response: { 200: matchReply, 403: schema.errorReply, 404: schema.errorReply, 409: schema.errorReply },
    })
    .post("/versus/:id/cancel", (ctx) => service.cancelVersus(player(ctx), ctx.params.id!), {
      summary: "Cancel your open match and get your stake back",
      params: matchId,
      body: schema.object({}),
      response: { 200: matchReply, 403: schema.errorReply, 404: schema.errorReply, 409: schema.errorReply },
    })
    .get(
      "/jackpot",
      async (ctx) => {
        player(ctx);
        await service.drawJackpotIfDue();
        return timed(await service.currentJackpot());
      },
      { summary: "The current round", response: { 200: roundReply } },
    )
    .get(
      "/jackpot/history",
      (ctx) => {
        player(ctx);
        return service.listJackpotHistory();
      },
      { summary: "Recent rounds", response: { 200: schema.reply({ rounds: { type: "array", items: roundReply } }) } },
    )
    .post("/jackpot/enter", async (ctx) => timed(await service.enterJackpot(player(ctx), bodyObject(ctx))), {
      summary: "Add to the current round's pot",
      body: schema.object({ amount: schema.amount }, ["amount"]),
      response: { 200: roundReply, 400: schema.errorReply, 409: schema.errorReply },
    });
}
