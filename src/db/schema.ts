import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { CardRef, Itinerary, PollOption, ResolvedRequirements, TripPhase, TripType } from "../schemas";

// Tiger Data is the only operational store. jsonb columns hold Zod-validated documents
// (the repo parses them on read); everything else is a plain column so it can be queried in SQL.

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const trips = pgTable("trips", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  inviteCode: text("invite_code").notNull().unique(),
  title: text("title").notNull(),
  phase: text("phase").$type<TripPhase>().notNull(),
  timeZone: text("time_zone").notNull(),
  resolved: jsonb("resolved").$type<ResolvedRequirements>(),
  currentVersion: integer("current_version").notNull().default(0),
  abortReason: text("abort_reason"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const members = pgTable(
  "members",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id),
    handle: text("handle").notNull(),
    chatId: text("chat_id"),
    role: text("role").$type<"host" | "member">().notNull(),
    status: text("status").$type<"invited" | "joined">().notNull(),
    name: text("name"),
    onboardingReady: boolean("onboarding_ready").notNull().default(false),
    requirementsReady: boolean("requirements_ready").notNull().default(false),
    card: jsonb("card").$type<CardRef>(),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("members_trip_handle_uq").on(t.tripId, t.handle), index("members_handle_idx").on(t.handle)],
);

/** One row per member: their answers to the predefined (must-have) questions. */
export const predefinedRequirements = pgTable("predefined_requirements", {
  memberId: text("member_id")
    .primaryKey()
    .references(() => members.id),
  tripId: text("trip_id")
    .notNull()
    .references(() => trips.id),
  startLocation: text("start_location"),
  endLocation: text("end_location"),
  startDate: date("start_date", { mode: "string" }),
  endDate: date("end_date", { mode: "string" }),
  tripType: text("trip_type").$type<TripType>(),
  budgetPerPersonUsd: doublePrecision("budget_per_person_usd"),
  dietaryRestrictions: jsonb("dietary_restrictions").$type<string[]>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const optionalRequirements = pgTable(
  "optional_requirements",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    category: text("category").notNull(),
    text: text("text").notNull(),
    sourceEventId: text("source_event_id"),
    createdAt: createdAt(),
  },
  (t) => [index("optional_requirements_trip_idx").on(t.tripId)],
);

export const polls = pgTable(
  "polls",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id),
    kind: text("kind").$type<"route" | "dates" | "optional" | "itinerary">().notNull(),
    question: text("question").notNull(),
    options: jsonb("options").$type<PollOption[]>().notNull(),
    status: text("status").$type<"queued" | "open" | "closed">().notNull(),
    round: integer("round").notNull().default(1),
    sequence: integer("sequence").notNull(),
    winningOptionId: text("winning_option_id"),
    createdAt: createdAt(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [index("polls_trip_idx").on(t.tripId, t.sequence)],
);

export const pollVotes = pgTable(
  "poll_votes",
  {
    pollId: text("poll_id")
      .notNull()
      .references(() => polls.id),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    optionId: text("option_id").notNull(),
    via: text("via").$type<"number" | "other_text" | "widget">().notNull(),
    rawText: text("raw_text"),
    castAt: timestamp("cast_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.pollId, t.memberId] })],
);

/** Capability tokens for the poll-widget link, one per (poll, member), sent only in that member's DM. */
export const pollTokens = pgTable(
  "poll_tokens",
  {
    token: text("token").primaryKey(),
    pollId: text("poll_id")
      .notNull()
      .references(() => polls.id),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("poll_tokens_poll_member_uq").on(t.pollId, t.memberId)],
);

export const itineraryVersions = pgTable(
  "itinerary_versions",
  {
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id),
    version: integer("version").notNull(),
    itinerary: jsonb("itinerary").$type<Itinerary>().notNull(),
    changeSummary: text("change_summary"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tripId, t.version] })],
);

export const approvals = pgTable(
  "approvals",
  {
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id),
    version: integer("version").notNull(),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.tripId, t.version, t.memberId] })],
);

/**
 * Every message in or out, per member (hypertable on Tiger Data). Idempotent on (event_id, occurred_at):
 * Spectrum delivers at least once, so the insert doubles as the dedupe check.
 */
export const chatEvents = pgTable(
  "chat_events",
  {
    eventId: text("event_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    chatId: text("chat_id").notNull(),
    tripId: text("trip_id"),
    memberId: text("member_id"),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    handle: text("handle"),
    kind: text("kind").notNull(),
    text: text("text"),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.occurredAt] }),
    index("chat_events_chat_time_idx").on(t.chatId, t.occurredAt.desc()),
    index("chat_events_trip_time_idx").on(t.tripId, t.occurredAt.desc()),
  ],
);

/** Trip state transitions and decisions (hypertable on Tiger Data). */
export const tripEvents = pgTable(
  "trip_events",
  {
    eventId: text("event_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().default(sql`now()`),
    tripId: text("trip_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.occurredAt] }),
    index("trip_events_trip_time_idx").on(t.tripId, t.occurredAt.desc()),
  ],
);
