import { env, envPort, envSecret } from "@yuubet/service-kit";
import { buildGatewayRouter } from "./app";

const port = envPort("GATEWAY_PORT", 8080);
await buildGatewayRouter({
  jwtSecret: envSecret("JWT_SECRET"),
  internalKey: envSecret("INTERNAL_KEY"),
  authUrl: env("AUTH_URL", "http://localhost:8081"),
  walletUrl: env("WALLET_URL", "http://localhost:8082"),
  gamesUrl: env("GAMES_URL", "http://localhost:8083"),
  webOrigin: env("WEB_ORIGIN", "http://localhost:5173"),
}).listen(port);
console.log(`gateway listening on ${port}`);
