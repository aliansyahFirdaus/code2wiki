CREATE TYPE "public"."generation_task_branch_state" AS ENUM('FOUND_CHILDREN', 'WAITING_RELATED_BRANCH', 'NEEDS_FRONTEND_ANCHOR');--> statement-breakpoint
CREATE TYPE "public"."generation_task_status" AS ENUM('QUEUED', 'IN_PROGRESS', 'SUCCEEDED', 'READY_TO_WRITE', 'WRITTEN', 'NO_WIKI_VALUE', 'NEEDS_REVIEW', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."generation_task_type" AS ENUM('DISCOVER_SURFACE', 'TRACE_BEHAVIOR', 'CREATE_PAGE', 'UPDATE_PAGE', 'EVALUATE_COVERAGE');--> statement-breakpoint
CREATE TABLE "generation_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"repository_role" "repository_role",
	"repository_id" text,
	"task_type" "generation_task_type" NOT NULL,
	"status" "generation_task_status" DEFAULT 'QUEUED' NOT NULL,
	"branch_state" "generation_task_branch_state",
	"priority" integer DEFAULT 100 NOT NULL,
	"page_key" text,
	"parent_task_id" text,
	"root_task_id" text,
	"dedupe_key" text NOT NULL,
	"reason" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"result_json" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"error_message" text,
	"claimed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "generation_tasks_run_dedupe_unique" ON "generation_tasks" USING btree ("generation_run_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "generation_tasks_run_status_created_idx" ON "generation_tasks" USING btree ("generation_run_id","status","created_at");--> statement-breakpoint
CREATE INDEX "generation_tasks_run_page_key_idx" ON "generation_tasks" USING btree ("generation_run_id","page_key");
