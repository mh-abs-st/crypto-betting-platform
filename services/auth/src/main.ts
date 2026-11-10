import { envPort, envSecret } from "@yuubet/service-kit";
import { buildAuthRouter } from "./app";

const port = envPort("AUTH_PORT", 8081);
await buildAuthRouter({ jwtSecret: envSecret("JWT_SECRET"), internalKey: envSecret("INTERNAL_KEY") }).listen(port);
console.log(`auth service listening on ${port}`);
