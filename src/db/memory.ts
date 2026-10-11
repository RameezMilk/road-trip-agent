import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { type Db, MIGRATIONS_DIR } from "./client";
import * as schema from "./schema";

/**
 * In-process Postgres with the real migrations applied (the hypertable step is a no-op without TimescaleDB).
 * Tests and the labeled demo only — the agent itself always runs on Tiger Data.
 */
export async function createMemoryDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(MIGRATIONS_DIR) });
  return db as unknown as Db;
}
