CREATE TABLE "generation_debug_events" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_run_id" text NOT NULL,
	"stage" text NOT NULL,
	"event_type" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "generation_debug_events_run_idx" ON "generation_debug_events" USING btree ("generation_run_id");--> statement-breakpoint
CREATE INDEX "generation_debug_events_run_ordered_idx" ON "generation_debug_events" USING btree ("generation_run_id","created_at","id");