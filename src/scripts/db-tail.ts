/** `npm run db:tail -- --limit 50` — latest chat_events rows from Tiger Data (handles shown as last 4 digits). */
import { loadConfig, requireConfig } from "../config";
import { createDb } from "../db/client";
import { Repo } from "../db/repo";

const arg = process.argv.indexOf("--limit");
const limit = Math.min(1000, Math.max(1, Number(arg > -1 ? process.argv[arg + 1] : 50) || 50));
const config = requireConfig(loadConfig(), "Tiger Data", ["DATABASE_URL"]);
const { db, close } = createDb(config.DATABASE_URL);
const rows = await new Repo(db).latestChatEvents(limit);
for (const r of rows.reverse()) {
  const who = r.handle ? `…${r.handle.slice(-4)}` : "?";
  const arrow = r.direction === "inbound" ? "→" : "←";
  console.log(
    `${r.occurredAt.toISOString()} ${arrow} ${who} [${r.kind}] trip=${r.tripId ?? "-"} ${JSON.stringify(r.text ?? r.content).slice(0, 160)}`,
  );
}
console.log(`${rows.length} row(s)`);
await close();
