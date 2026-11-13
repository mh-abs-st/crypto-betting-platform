import { createPool } from "@yuubet/db";
import { envPort, envSecret } from "@yuubet/service-kit";
import { buildAuthRouter } from "./app";
import { PgUserStore } from "./pg-users";
import { MemoryUserStore, type UserStore } from "./users";

const port = envPort("AUTH_PORT", 8081);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl && process.env.NODE_ENV === "production") {
  throw new Error("DATABASE_URL is required in production");
}
const users: UserStore = databaseUrl
  ? new PgUserStore(createPool(databaseUrl, { applicationName: "yuubet-auth" }))
  : new MemoryUserStore();

await buildAuthRouter({ jwtSecret: envSecret("JWT_SECRET"), internalKey: envSecret("INTERNAL_KEY") }, users).listen(port);
console.log(`auth service listening on ${port}${databaseUrl ? "" : " (in memory: accounts are lost on restart)"}`);
