import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/** Driver-agnostic handle: Tiger Data (postgres-js) in production, PGlite in tests and the demo. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MIGRATIONS_DIR = new URL("../../drizzle/", import.meta.url);

export function createDb(databaseUrl: string): { db: Db; close: () => Promise<void> } {
  const sql = postgres(databaseUrl, { ssl: "require", max: 5, onnotice: () => {} });
  return { db: drizzle(sql, { schema }) as unknown as Db, close: () => sql.end({ timeout: 5 }) };
}
