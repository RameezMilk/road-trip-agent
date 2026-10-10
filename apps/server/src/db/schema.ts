import { index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// Tiger Data is the sole operational store. Trip tables (groups, trips, members, private submissions, candidates,
// votes, plan versions, approvals, outbox, `trip_events`) come with the core slice — see docs/spec.md.

/**
 * Every chat event the agent sees or sends — messages, reactions, read receipts, poll taps — written live from the
 * Spectrum stream. A TimescaleDB hypertable on `occurred_at` (see drizzle/0001_chat_events_hypertable.sql).
 * Hypertable unique keys must include the time column, hence the (event_id, occurred_at) primary key.
 */
export const chatEvents = pgTable(
  "chat_events",
  {
    eventId: text("event_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    chatId: text("chat_id").notNull(),
    chatType: text("chat_type").notNull(),
    platform: text("platform").notNull(),
    direction: text("direction").notNull(),
    /** E.164/email of the human sender; null for the agent's own messages. */
    senderHandle: text("sender_handle"),
    /** Spectrum content type: text, attachment, voice, reaction, read, poll, poll_option, app, … */
    kind: text("kind").notNull(),
    text: text("text"),
    /** Type-specific details (attachment name/mime/size, reaction target, poll option, card URL…). No bytes. */
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    /** Provider metadata as delivered (iMessage delivery/read/edit dates, part index, card session…). */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    /** `stream` = arrived on the Spectrum message stream; `send` = recorded when the agent sent it. */
    source: text("source").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.occurredAt] }),
    index("chat_events_chat_time_idx").on(t.chatId, t.occurredAt.desc()),
  ],
);
