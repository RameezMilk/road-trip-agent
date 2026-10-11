import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadConfig, requireConfig } from "../config";
import { createDb, MIGRATIONS_DIR } from "./client";

const config = requireConfig(loadConfig(), "Tiger Data", ["DATABASE_URL"]);
const { db, close } = createDb(config.DATABASE_URL);
// biome-ignore lint/suspicious/noExplicitAny: the postgres-js migrator wants its own driver type
await migrate(db as any, { migrationsFolder: fileURLToPath(MIGRATIONS_DIR) });
await close();
console.log("migrations applied");
