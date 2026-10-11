/** `npm run db:check` — confirms the tables exist and which ones are TimescaleDB hypertables. */
import { sql } from "drizzle-orm";
import { loadConfig, requireConfig } from "../config";
import { createDb } from "../db/client";

const config = requireConfig(loadConfig(), "Tiger Data", ["DATABASE_URL"]);
const { db, close } = createDb(config.DATABASE_URL);
const tables = await db.execute(
  sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
);
console.log("tables:", (tables as unknown as Array<{ table_name: string }>).map((r) => r.table_name).join(", "));
try {
  const hyper = await db.execute(sql`select hypertable_name from timescaledb_information.hypertables order by 1`);
  console.log(
    "hypertables:",
    (hyper as unknown as Array<{ hypertable_name: string }>).map((r) => r.hypertable_name).join(", "),
  );
} catch {
  console.log("hypertables: TimescaleDB not available");
}
await close();
