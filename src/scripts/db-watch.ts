/**
 * `npm run db:watch` — follows live traffic in Tiger Data: every chat message (in/out, per member, handles
 * shown as last 4 digits) and every trip event. Read receipts are skipped. Ctrl-C to stop.
 */
import { asc, gt } from "drizzle-orm";
import { loadConfig, requireConfig } from "../config";
import { createDb } from "../db/client";
import { chatEvents, tripEvents } from "../db/schema";

const config = requireConfig(loadConfig(), "Tiger Data", ["DATABASE_URL"]);
const { db } = createDb(config.DATABASE_URL);
// Postgres keeps microseconds but JS Dates only milliseconds, so re-read a short window and skip seen rows.
const LOOKBACK_MS = 10_000;
let chatSince = new Date();
let tripSince = new Date();
const seen = new Set<string>();
const firstSight = (key: string) => {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > 5000) seen.delete(seen.values().next().value as string);
  return true;
};

for (;;) {
  try {
    const rows = await db
      .select()
      .from(chatEvents)
      .where(gt(chatEvents.ingestedAt, new Date(chatSince.getTime() - LOOKBACK_MS)))
      .orderBy(asc(chatEvents.ingestedAt));
    for (const r of rows) {
      if (r.ingestedAt > chatSince) chatSince = r.ingestedAt;
      if (!firstSight(`chat:${r.eventId}:${r.occurredAt.getTime()}`) || r.kind === "read") continue;
      const who = r.handle ? `…${r.handle.slice(-4)}` : "?";
      const body = (r.text ?? JSON.stringify(r.content)).replace(/\s+/g, " ").slice(0, 140);
      console.log(`${r.direction === "inbound" ? "IN " : "OUT"} ${who} [${r.kind}] ${body}`);
    }
    const events = await db
      .select()
      .from(tripEvents)
      .where(gt(tripEvents.occurredAt, new Date(tripSince.getTime() - LOOKBACK_MS)))
      .orderBy(asc(tripEvents.occurredAt));
    for (const e of events) {
      if (e.occurredAt > tripSince) tripSince = e.occurredAt;
      if (!firstSight(`trip:${e.eventId}`)) continue;
      console.log(`TRIP ${e.type} ${JSON.stringify(e.payload).slice(0, 120)}`);
    }
  } catch (error) {
    console.log(`watch_error ${String(error).slice(0, 160)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
