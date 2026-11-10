import { env, envPort, envSecret } from "@yuubet/service-kit";
import { buildWalletRouter } from "./app";

const port = envPort("WALLET_PORT", 8082);
const devFaucet = env("DEV_FAUCET", "false") === "true";
if (devFaucet && process.env.NODE_ENV === "production") {
  throw new Error("DEV_FAUCET must not be enabled in production");
}

await buildWalletRouter({ internalKey: envSecret("INTERNAL_KEY"), devFaucet }).listen(port);
console.log(`wallet service listening on ${port}${devFaucet ? " (dev faucet on)" : ""}`);
