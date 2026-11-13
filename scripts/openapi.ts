import { mkdir, writeFile } from "node:fs/promises";
import type { Router } from "@yuubet/service-kit";
import { buildAuthRouter } from "../services/auth/src/app";
import { buildGamesRouter } from "../services/games/src/app";
import { GamesService } from "../services/games/src/service";
import { buildGatewayRouter } from "../services/gateway/src/app";
import { buildWalletRouter } from "../services/wallet/src/app";

// npm run docs:api: writes each service's OpenAPI description to docs/api.
// Running services also serve theirs at /openapi.json.
const key = "unused";
const routers: Record<string, Router> = {
  gateway: buildGatewayRouter({ jwtSecret: key, internalKey: key, authUrl: "", walletUrl: "", gamesUrl: "" }),
  auth: buildAuthRouter({ jwtSecret: key, internalKey: key }),
  wallet: buildWalletRouter({ internalKey: key, devFaucet: false }),
  games: buildGamesRouter(await GamesService.create({ move: async () => {} }), key),
};

await mkdir("docs/api", { recursive: true });
for (const [name, router] of Object.entries(routers)) {
  await writeFile(`docs/api/${name}.openapi.json`, `${JSON.stringify(await router.openapi(), null, 2)}\n`);
  console.log(`docs/api/${name}.openapi.json`);
}
