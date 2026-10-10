import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, MIGRATIONS_DIR } from "../db/client";
import * as schema from "../db/schema";
import { type ChatEvent, createChatEventSink } from "./chat-events";

// Runs the real migrations on in-process Postgres (PGlite). The hypertable step is skipped there by design —
// TimescaleDB only exists on Tiger Data.
let db: Db;
beforeAll(async () => {
  const pg = drizzle(new PGlite(), { schema });
  await migrate(pg, { migrationsFolder: fileURLToPath(MIGRATIONS_DIR) });
  db = pg as unknown as Db;
});

const event: ChatEvent = {
  eventId: "spc-msg-1",
  occurredAt: new Date("2026-10-10T20:17:15.226Z"),
  chatId: "any;-;+15555550101",
  chatType: "dm",
  platform: "imessage",
  direction: "inbound",
  senderHandle: "+15555550101",
  kind: "text",
  text: "/poll",
  content: {},
  metadata: { isDelivered: true },
  source: "stream",
};

describe("chat event sink", () => {
  it("stores an event once even when delivered twice", async () => {
    const errors: unknown[] = [];
    const sink = createChatEventSink(db, (_e, err) => errors.push(err));
    await sink.record(event);
    await sink.record(event); // at-least-once redelivery
    const rows = await db.select().from(schema.chatEvents);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventId: "spc-msg-1", text: "/poll", metadata: { isDelivered: true } });
    expect(rows[0]?.occurredAt.toISOString()).toBe("2026-10-10T20:17:15.226Z");
  });

  it("reports a failed write instead of throwing", async () => {
    const errors: unknown[] = [];
    const sink = createChatEventSink(db, (_e, err) => errors.push(err));
    await sink.record({ ...event, eventId: "bad", chatId: null as unknown as string });
    expect(errors).toHaveLength(1);
  });
});
