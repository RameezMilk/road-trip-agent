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
let chatSince = new Date();
let tripSince = new Date();

for (;;) {
  try {
    const rows = await db
      .select()
      .from(chatEvents)
      .where(gt(chatEvents.ingestedAt, chatSince))
      .orderBy(asc(chatEvents.ingestedAt));
    for (const r of rows) {
      if (r.ingestedAt > chatSince) chatSince = r.ingestedAt;
      if (r.kind === "read") continue;
      const who = r.handle ? `…${r.handle.slice(-4)}` : "?";
      const body = (r.text ?? JSON.stringify(r.content)).replace(/\s+/g, " ").slice(0, 140);
      console.log(`${r.direction === "inbound" ? "IN " : "OUT"} ${who} [${r.kind}] ${body}`);
    }
    const events = await db
      .select()
      .from(tripEvents)
      .where(gt(tripEvents.occurredAt, tripSince))
      .orderBy(asc(tripEvents.occurredAt));
    for (const e of events) {
      if (e.occurredAt > tripSince) tripSince = e.occurredAt;
      console.log(`TRIP ${e.type} ${JSON.stringify(e.payload).slice(0, 120)}`);
    }
  } catch (error) {
    console.log(`watch_error ${String(error).slice(0, 160)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
