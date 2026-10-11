CREATE TABLE "approvals" (
	"trip_id" text NOT NULL,
	"version" integer NOT NULL,
	"member_id" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_trip_id_version_member_id_pk" PRIMARY KEY("trip_id","version","member_id")
);
--> statement-breakpoint
CREATE TABLE "chat_events" (
	"event_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"chat_id" text NOT NULL,
	"trip_id" text,
	"member_id" text,
	"direction" text NOT NULL,
	"handle" text,
	"kind" text NOT NULL,
	"text" text,
	"content" jsonb NOT NULL,
	"metadata" jsonb NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_events_event_id_occurred_at_pk" PRIMARY KEY("event_id","occurred_at")
);
--> statement-breakpoint
CREATE TABLE "itinerary_versions" (
	"trip_id" text NOT NULL,
	"version" integer NOT NULL,
	"itinerary" jsonb NOT NULL,
	"change_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "itinerary_versions_trip_id_version_pk" PRIMARY KEY("trip_id","version")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"handle" text NOT NULL,
	"chat_id" text,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"name" text,
	"onboarding_ready" boolean DEFAULT false NOT NULL,
	"requirements_ready" boolean DEFAULT false NOT NULL,
	"card" jsonb,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "optional_requirements" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"member_id" text NOT NULL,
	"category" text NOT NULL,
	"text" text NOT NULL,
	"source_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"poll_id" text NOT NULL,
	"member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_votes" (
	"poll_id" text NOT NULL,
	"member_id" text NOT NULL,
	"option_id" text NOT NULL,
	"via" text NOT NULL,
	"raw_text" text,
	"cast_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poll_votes_poll_id_member_id_pk" PRIMARY KEY("poll_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"kind" text NOT NULL,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"status" text NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"sequence" integer NOT NULL,
	"winning_option_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "predefined_requirements" (
	"member_id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"start_location" text,
	"end_location" text,
	"start_date" date,
	"end_date" date,
	"trip_type" text,
	"budget_per_person_usd" double precision,
	"dietary_restrictions" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_events" (
	"event_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trip_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "trip_events_event_id_occurred_at_pk" PRIMARY KEY("event_id","occurred_at")
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"invite_code" text NOT NULL,
	"title" text NOT NULL,
	"phase" text NOT NULL,
	"time_zone" text NOT NULL,
	"resolved" jsonb,
	"current_version" integer DEFAULT 0 NOT NULL,
	"abort_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trips_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "trips_invite_code_unique" UNIQUE("invite_code")
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itinerary_versions" ADD CONSTRAINT "itinerary_versions_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optional_requirements" ADD CONSTRAINT "optional_requirements_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optional_requirements" ADD CONSTRAINT "optional_requirements_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_tokens" ADD CONSTRAINT "poll_tokens_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_tokens" ADD CONSTRAINT "poll_tokens_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predefined_requirements" ADD CONSTRAINT "predefined_requirements_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predefined_requirements" ADD CONSTRAINT "predefined_requirements_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_events_chat_time_idx" ON "chat_events" USING btree ("chat_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_events_trip_time_idx" ON "chat_events" USING btree ("trip_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "members_trip_handle_uq" ON "members" USING btree ("trip_id","handle");--> statement-breakpoint
CREATE INDEX "members_handle_idx" ON "members" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "optional_requirements_trip_idx" ON "optional_requirements" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "poll_tokens_poll_member_uq" ON "poll_tokens" USING btree ("poll_id","member_id");--> statement-breakpoint
CREATE INDEX "polls_trip_idx" ON "polls" USING btree ("trip_id","sequence");--> statement-breakpoint
CREATE INDEX "trip_events_trip_time_idx" ON "trip_events" USING btree ("trip_id","occurred_at" DESC NULLS LAST);