CREATE TABLE "wiki_run_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"page_id" text NOT NULL,
	"page_key" text NOT NULL,
	"materialization_type" text NOT NULL,
	"source_generation_run_id" text,
	"input_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "wiki_run_pages" (
	"id",
	"generation_run_id",
	"workspace_id",
	"page_id",
	"page_key",
	"materialization_type",
	"source_generation_run_id",
	"input_hash",
	"created_at",
	"updated_at"
)
SELECT
	'wrp_' || substr(md5("generation_run_id" || '|' || "page_key"), 1, 24),
	"generation_run_id",
	"workspace_id",
	"id",
	"page_key",
	'WRITTEN',
	NULL,
	"input_hash",
	"created_at",
	"updated_at"
FROM "wiki_pages"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_run_pages_run_page_unique" ON "wiki_run_pages" USING btree ("generation_run_id","page_key");--> statement-breakpoint
CREATE INDEX "wiki_run_pages_run_idx" ON "wiki_run_pages" USING btree ("generation_run_id");--> statement-breakpoint
CREATE INDEX "wiki_run_pages_page_idx" ON "wiki_run_pages" USING btree ("page_id");
