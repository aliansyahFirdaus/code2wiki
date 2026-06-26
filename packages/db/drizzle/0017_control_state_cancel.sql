ALTER TYPE "public"."generation_run_status" ADD VALUE 'CANCELED' BEFORE 'NEEDS_REVIEW';--> statement-breakpoint
ALTER TYPE "public"."generation_task_status" ADD VALUE 'CANCELED' BEFORE 'FAILED';--> statement-breakpoint
CREATE TYPE "public"."generation_run_control_state" AS ENUM('ACTIVE', 'PAUSED', 'CANCEL_REQUESTED');--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "control_state" "generation_run_control_state" DEFAULT 'ACTIVE' NOT NULL;
