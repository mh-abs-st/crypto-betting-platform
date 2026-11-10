import { env, envPort, envSecret } from "@yuubet/service-kit";
import { buildGamesRouter } from "./app";
import { GamesService } from "./service";
import { HttpWallet } from "./wallet";

const port = envPort("GAMES_PORT", 8083);
const internalKey = envSecret("INTERNAL_KEY");
const service = await GamesService.create(new HttpWallet(env("WALLET_URL", "http://localhost:8082"), internalKey));

await buildGamesRouter(service, internalKey).listen(port);
console.log(`games service listening on ${port}`);

// Draw the jackpot on time even when nobody is looking at it.
setInterval(() => {
  service.drawJackpotIfDue().catch((error) => console.error("jackpot draw failed", error));
}, 1000);
