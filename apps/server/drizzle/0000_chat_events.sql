CREATE TABLE "chat_events" (
	"event_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"chat_id" text NOT NULL,
	"chat_type" text NOT NULL,
	"platform" text NOT NULL,
	"direction" text NOT NULL,
	"sender_handle" text,
	"kind" text NOT NULL,
	"text" text,
	"content" jsonb NOT NULL,
	"metadata" jsonb NOT NULL,
	"source" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_events_event_id_occurred_at_pk" PRIMARY KEY("event_id","occurred_at")
);
--> statement-breakpoint
CREATE INDEX "chat_events_chat_time_idx" ON "chat_events" USING btree ("chat_id","occurred_at" DESC NULLS LAST);