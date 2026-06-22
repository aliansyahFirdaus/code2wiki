ALTER TABLE "generation_runs" ADD COLUMN "frontend_total_eligible_files" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "frontend_indexed_eligible_files" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "backend_total_eligible_files" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "backend_indexed_eligible_files" integer DEFAULT 0 NOT NULL;