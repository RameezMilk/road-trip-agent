import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { type Config, requireConfig } from "../config";
import * as schema from "./schema";

/** Driver-agnostic handle: Tiger Data (postgres-js) in production, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MIGRATIONS_DIR = new URL("../../drizzle/", import.meta.url);

export function createDb(config: Config) {
  const { DATABASE_URL } = requireConfig(config, "Tiger Data", ["DATABASE_URL"]);
  const sql = postgres(DATABASE_URL, { ssl: "require", max: 5 });
  return { db: drizzle(sql, { schema }), close: () => sql.end({ timeout: 5 }) };
}
