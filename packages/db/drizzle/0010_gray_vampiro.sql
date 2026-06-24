CREATE TYPE "public"."wiki_page_evidence_coverage_role" AS ENUM('PRIMARY', 'SUPPORTING', 'EXCLUDED_NO_WIKI_VALUE', 'NEEDS_REVIEW');--> statement-breakpoint
ALTER TYPE "public"."generation_run_status" ADD VALUE 'NEEDS_REVIEW' BEFORE 'FAILED';--> statement-breakpoint
CREATE TABLE "wiki_page_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"page_key" text NOT NULL,
	"evidence_id" text NOT NULL,
	"fact_id" text,
	"source_task_id" text,
	"coverage_role" "wiki_page_evidence_coverage_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "wiki_page_evidence_run_page_idx" ON "wiki_page_evidence" USING btree ("generation_run_id","page_key");