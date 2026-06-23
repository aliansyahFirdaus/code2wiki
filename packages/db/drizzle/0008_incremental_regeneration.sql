ALTER TABLE "generation_runs" ADD COLUMN "incremental_report_json" jsonb;
ALTER TABLE "wiki_pages" ADD COLUMN "input_hash" text;
ALTER TABLE "wiki_pages" ADD COLUMN "generation_strategy" text;
ALTER TABLE "wiki_pages" ADD COLUMN "reused_from_generation_run_id" text;
