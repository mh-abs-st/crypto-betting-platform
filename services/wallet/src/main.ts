import { createPool } from "@yuubet/db";
import { env, envPort, envSecret } from "@yuubet/service-kit";
import { buildWalletRouter } from "./app";
import { MemoryLedger, type LedgerStore } from "./ledger";
import { PgLedger } from "./pg-ledger";

const port = envPort("WALLET_PORT", 8082);
const production = process.env.NODE_ENV === "production";
const devFaucet = env("DEV_FAUCET", "false") === "true";
if (devFaucet && production) {
  throw new Error("DEV_FAUCET must not be enabled in production");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl && production) {
  throw new Error("DATABASE_URL is required in production");
}
const ledger: LedgerStore = databaseUrl
  ? new PgLedger(createPool(databaseUrl, { applicationName: "yuubet-wallet" }))
  : new MemoryLedger();

await buildWalletRouter({ internalKey: envSecret("INTERNAL_KEY"), devFaucet }, ledger).listen(port);
console.log(
  `wallet service listening on ${port}` +
    (databaseUrl ? "" : " (in memory: balances are lost on restart)") +
    (devFaucet ? " (dev faucet on)" : ""),
);
