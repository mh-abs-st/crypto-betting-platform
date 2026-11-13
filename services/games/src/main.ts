import { createPool } from "@yuubet/db";
import { env, envPort, envSecret } from "@yuubet/service-kit";
import { buildGamesRouter } from "./app";
import { EthereumEntropy, SimulatedChain, type EntropySource } from "./entropy";
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
// Jackpot draws use Ethereum block hashes. Without an RPC endpoint a simulated
// chain stands in, which is only acceptable in development.
const rpcUrl = process.env.ETH_RPC_URL;
if (!rpcUrl && process.env.NODE_ENV === "production") {
  throw new Error("ETH_RPC_URL is required in production");
}
let entropy: EntropySource;
if (rpcUrl) {
  entropy = new EthereumEntropy(rpcUrl, Number(env("ETH_CONFIRMATIONS", "3")));
} else {
  const chain = new SimulatedChain();
  setInterval(() => chain.mine(), 3000);
  entropy = chain;
}

const service = await GamesService.create(
  new HttpWallet(env("WALLET_URL", "http://localhost:8082"), internalKey),
  undefined,
  store,
  entropy,
);

await buildGamesRouter(service, internalKey).listen(port);
console.log(
  `games service listening on ${port}` +
    (databaseUrl ? "" : " (in memory: games are lost on restart)") +
    (rpcUrl ? "" : " (simulated chain for jackpot draws)"),
);

// Draw the jackpot on time even when nobody is looking at it. Safe to run on every instance.
setInterval(() => {
  service.drawJackpotIfDue().catch((error) => console.error("jackpot draw failed", error));
}, 1000);

// Pay anything owed whose first payment failed, for example while the wallet was down.
setInterval(() => {
  service.retryPayouts().catch((error) => console.error("payout retry failed", error));
}, 5000);

// Expire Versus matches nobody joined in time and refund their creators.
setInterval(() => {
  service.expireVersusMatches().catch((error) => console.error("versus expiry failed", error));
}, 5000);
