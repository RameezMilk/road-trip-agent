/**
 * Prints and saves the latest chat events stored in Tiger Data, oldest → newest.
 *   npm run db:tail [-- --limit 100]
 * Writes exports/chat-events-<timestamp>.txt (gitignored: contains message text).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { count, desc } from "drizzle-orm";
import { loadConfig } from "../config";
import { createDb } from "./client";
import { chatEvents } from "./schema";

const { values } = parseArgs({ options: { limit: { type: "string", default: "50" } } });
const limit = Math.max(1, Math.min(1000, Number(values.limit) || 50));

const { db, close } = createDb(loadConfig());
const [total] = await db.select({ n: count() }).from(chatEvents);
const rows = (await db.select().from(chatEvents).orderBy(desc(chatEvents.occurredAt)).limit(limit)).reverse();
await close();

const lines = [
  "Tiger Data — chat_events (latest first fetched, shown oldest → newest)",
  `fetched:   ${new Date().toISOString()}`,
  `rows:      showing ${rows.length} of ${total?.n ?? 0}`,
  "",
  "occurred_at (UTC)          | dir | kind        | source | chat      | event_id                              | text / content",
  "-".repeat(150),
  ...rows.map((r) => {
    const body = r.text !== null ? JSON.stringify(r.text) : JSON.stringify(r.content);
    return [
      r.occurredAt.toISOString().padEnd(26),
      (r.direction === "inbound" ? "in" : "out").padEnd(3),
      r.kind.padEnd(11),
      r.source.padEnd(6),
      `…${r.chatId.slice(-4)}`.padEnd(9),
      r.eventId.slice(0, 38).padEnd(38),
      body.length > 120 ? `${body.slice(0, 120)}…` : body,
    ].join(" | ");
  }),
  "",
];

const outDir = fileURLToPath(new URL("../../../../exports/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const file = `${outDir}chat-events-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
writeFileSync(file, lines.join("\n"));
console.log(lines.join("\n"));
console.log(`saved → ${file}`);
