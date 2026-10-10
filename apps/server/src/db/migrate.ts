import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadConfig } from "../config";
import { createDb, MIGRATIONS_DIR } from "./client";

const { db, close } = createDb(loadConfig());
await migrate(db, { migrationsFolder: fileURLToPath(MIGRATIONS_DIR) });
await close();
console.log("migrations applied");
