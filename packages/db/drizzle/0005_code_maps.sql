CREATE TABLE "code_maps" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_run_id" text NOT NULL,
	"source_hash" text NOT NULL,
	"map_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "code_maps_generation_run_unique" ON "code_maps" USING btree ("generation_run_id");
