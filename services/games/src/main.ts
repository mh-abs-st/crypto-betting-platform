import { createPool } from "@yuubet/db";
import { env, envPort, envSecret } from "@yuubet/service-kit";
import { buildGamesRouter } from "./app";
import { PgGamesStore } from "./pg-store";
import { GamesService } from "./service";
import { MemoryGamesStore, type GamesStore } from "./store";
import { HttpWallet } from "./wallet";

const port = envPort("GAMES_PORT", 8083);
const internalKey = envSecret("INTERNAL_KEY");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl && process.env.NODE_ENV === "production") {
  throw new Error("DATABASE_URL is required in production");
}
const store: GamesStore = databaseUrl
  ? new PgGamesStore(createPool(databaseUrl, { applicationName: "yuubet-games" }))
  : new MemoryGamesStore();
const service = await GamesService.create(new HttpWallet(env("WALLET_URL", "http://localhost:8082"), internalKey), undefined, store);

await buildGamesRouter(service, internalKey).listen(port);
console.log(`games service listening on ${port}${databaseUrl ? "" : " (in memory: games are lost on restart)"}`);

// Draw the jackpot on time even when nobody is looking at it. Safe to run on every instance.
setInterval(() => {
  service.drawJackpotIfDue().catch((error) => console.error("jackpot draw failed", error));
}, 1000);

// Pay anything owed whose first payment failed, for example while the wallet was down.
setInterval(() => {
  service.retryPayouts().catch((error) => console.error("payout retry failed", error));
}, 5000);
