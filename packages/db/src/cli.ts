import { env } from "@yuubet/service-kit";
import { loadMigrations, migrate } from "./migrate";
import { createPool } from "./pool";

// npm run db:migrate. Connects as the owner of the schemas, not as a service role.
const pool = createPool(env("DATABASE_URL"), { max: 1, applicationName: "yuubet-migrate" });
try {
  const applied = await migrate(pool, await loadMigrations(), console.log);
  console.log(applied.length ? `${applied.length} migration(s) applied` : "database is up to date");
} finally {
  await pool.end();
}
