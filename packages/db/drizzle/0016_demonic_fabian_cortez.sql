CREATE TYPE "public"."generation_run_execution_mode" AS ENUM('AUTO', 'MANUAL');--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "execution_mode" "generation_run_execution_mode" DEFAULT 'AUTO' NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "advance_requested_at" timestamp with time zone;
