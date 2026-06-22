CREATE TYPE "public"."block_origin" AS ENUM('CODE', 'MANUAL', 'CODE_EDITED');--> statement-breakpoint
CREATE TYPE "public"."generation_run_status" AS ENUM('QUEUED', 'WAITING_FOR_PAIR', 'CLONING', 'SCANNING', 'AI_GENERATING', 'VALIDATING', 'COMPLETED', 'FAILED', 'AI_OUTPUT_INVALID');--> statement-breakpoint
CREATE TYPE "public"."github_installation_status" AS ENUM('INSTALLED', 'UPDATED', 'REMOVED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."overlay_type" AS ENUM('EDIT', 'HIDE', 'ADD_AFTER', 'ADD_CHILD');--> statement-breakpoint
CREATE TYPE "public"."repository_role" AS ENUM('FRONTEND', 'BACKEND');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('VERIFIED', 'NEEDS_REVIEW', 'OPEN_QUESTION');--> statement-breakpoint
CREATE TYPE "public"."tag_event_status" AS ENUM('WAITING_FOR_PAIR', 'PAIRED', 'DUPLICATE', 'IGNORED');--> statement-breakpoint
CREATE TYPE "public"."tag_event_type" AS ENUM('TAG', 'RELEASE');--> statement-breakpoint
CREATE TABLE "code_facts" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_run_id" text NOT NULL,
	"repository_role" "repository_role" NOT NULL,
	"repository_full_name" text NOT NULL,
	"tag" text NOT NULL,
	"commit_sha" text NOT NULL,
	"fact_kind" text NOT NULL,
	"text" text NOT NULL,
	"evidence_ids" jsonb NOT NULL,
	"confidence" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_run_id" text NOT NULL,
	"repository_role" "repository_role" NOT NULL,
	"repository_full_name" text NOT NULL,
	"tag" text NOT NULL,
	"commit_sha" text NOT NULL,
	"file_path" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"source_kind" text NOT NULL,
	"summary" text NOT NULL,
	"code_snippet" text NOT NULL,
	"github_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"frontend_repository_id" text NOT NULL,
	"backend_repository_id" text NOT NULL,
	"frontend_tag" text NOT NULL,
	"frontend_commit_sha" text NOT NULL,
	"backend_tag" text NOT NULL,
	"backend_commit_sha" text NOT NULL,
	"status" "generation_run_status" DEFAULT 'QUEUED' NOT NULL,
	"total_eligible_files" integer DEFAULT 0 NOT NULL,
	"indexed_eligible_files" integer DEFAULT 0 NOT NULL,
	"generated_statement_count" integer DEFAULT 0 NOT NULL,
	"generated_statement_with_evidence_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"github_installation_id" text NOT NULL,
	"account_login" text,
	"account_type" text,
	"setup_action" text,
	"status" "github_installation_status" DEFAULT 'UNKNOWN' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"role" "repository_role" NOT NULL,
	"tag_pattern" text NOT NULL,
	"github_installation_id" text NOT NULL,
	"github_repository_id" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"default_branch" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"event_type" "tag_event_type" NOT NULL,
	"tag" text NOT NULL,
	"commit_sha" text NOT NULL,
	"github_delivery_id" text NOT NULL,
	"status" "tag_event_status" DEFAULT 'WAITING_FOR_PAIR' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"raw_payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_block_overlays" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"target_block_id" text,
	"target_stable_key" text NOT NULL,
	"overlay_type" "overlay_type" NOT NULL,
	"overlay_json" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"generation_run_id" text NOT NULL,
	"parent_block_id" text,
	"position" integer NOT NULL,
	"stable_key" text NOT NULL,
	"type" text NOT NULL,
	"origin" "block_origin" NOT NULL,
	"review_state" "review_state" NOT NULL,
	"source_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"locked" boolean DEFAULT true NOT NULL,
	"block_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"generation_run_id" text NOT NULL,
	"page_key" text NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"parent_page_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "generation_runs_pair_unique" ON "generation_runs" USING btree ("workspace_id","frontend_commit_sha","backend_commit_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_installation_unique" ON "github_installations" USING btree ("github_installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_workspace_role_unique" ON "repositories" USING btree ("workspace_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_events_github_delivery_unique" ON "tag_events" USING btree ("github_delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_blocks_page_stable_key_unique" ON "wiki_blocks" USING btree ("page_id","stable_key");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_pages_workspace_page_key_unique" ON "wiki_pages" USING btree ("workspace_id","page_key");