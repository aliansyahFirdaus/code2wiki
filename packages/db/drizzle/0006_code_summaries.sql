CREATE TYPE "public"."code_summary_type" AS ENUM('FILE', 'MODULE');--> statement-breakpoint
CREATE TABLE "code_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_run_id" text NOT NULL,
	"summary_type" "code_summary_type" NOT NULL,
	"cache_key" text NOT NULL,
	"source_hash" text NOT NULL,
	"input_hash" text NOT NULL,
	"output_hash" text NOT NULL,
	"summary_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "code_summaries_generation_type_cache_unique" ON "code_summaries" USING btree ("generation_run_id","summary_type","cache_key");
