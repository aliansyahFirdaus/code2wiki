import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  index,
  uniqueIndex
} from "drizzle-orm/pg-core";

export const repositoryRoleEnum = pgEnum("repository_role", ["FRONTEND", "BACKEND"]);
export const tagEventTypeEnum = pgEnum("tag_event_type", ["TAG", "RELEASE"]);
export const tagEventStatusEnum = pgEnum("tag_event_status", ["WAITING_FOR_PAIR", "PAIRED", "DUPLICATE", "IGNORED"]);
export const githubInstallationStatusEnum = pgEnum("github_installation_status", [
  "INSTALLED",
  "UPDATED",
  "REMOVED",
  "UNKNOWN"
]);
export const codeSummaryTypeEnum = pgEnum("code_summary_type", ["FILE", "MODULE"]);
export const generationRunStatusEnum = pgEnum("generation_run_status", [
  "QUEUED",
  "WAITING_FOR_PAIR",
  "CLONING",
  "CLONED",
  "SCANNING",
  "FACTS_EXTRACTED",
  "AI_GENERATING",
  "VALIDATING",
  "COMPLETED",
  "NEEDS_REVIEW",
  "FAILED",
  "AI_OUTPUT_INVALID"
]);
export const blockOriginEnum = pgEnum("block_origin", ["CODE", "MANUAL", "CODE_EDITED"]);
export const reviewStateEnum = pgEnum("review_state", ["VERIFIED", "NEEDS_REVIEW", "OPEN_QUESTION"]);
export const overlayTypeEnum = pgEnum("overlay_type", ["EDIT", "HIDE", "ADD_AFTER", "ADD_CHILD"]);
export const generationTaskTypeEnum = pgEnum("generation_task_type", [
  "DISCOVER_SURFACE",
  "TRACE_BEHAVIOR",
  "DISCOVER_RELATED_CONCEPTS",
  "CREATE_PAGE",
  "UPDATE_PAGE",
  "EVALUATE_COVERAGE"
]);
export const generationTaskStatusEnum = pgEnum("generation_task_status", [
  "QUEUED",
  "IN_PROGRESS",
  "SUCCEEDED",
  "READY_TO_WRITE",
  "WRITTEN",
  "NO_WIKI_VALUE",
  "NEEDS_REVIEW",
  "FAILED"
]);
export const generationTaskBranchStateEnum = pgEnum("generation_task_branch_state", [
  "FOUND_CHILDREN",
  "WAITING_RELATED_BRANCH",
  "NEEDS_FRONTEND_ANCHOR"
]);
export const wikiPageEvidenceCoverageRoleEnum = pgEnum("wiki_page_evidence_coverage_role", [
  "PRIMARY",
  "SUPPORTING",
  "EXCLUDED_NO_WIKI_VALUE",
  "NEEDS_REVIEW"
]);

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    githubInstallationId: text("github_installation_id").notNull(),
    accountLogin: text("account_login"),
    accountType: text("account_type"),
    setupAction: text("setup_action"),
    status: githubInstallationStatusEnum("status").notNull().default("UNKNOWN"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    githubInstallationUnique: uniqueIndex("github_installations_installation_unique").on(table.githubInstallationId)
  })
);

export const repositories = pgTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    role: repositoryRoleEnum("role").notNull(),
    tagPattern: text("tag_pattern").notNull(),
    githubInstallationId: text("github_installation_id").notNull(),
    githubRepositoryId: text("github_repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    defaultBranch: text("default_branch").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    workspaceRoleUnique: uniqueIndex("repositories_workspace_role_unique").on(table.workspaceId, table.role)
  })
);

export const tagEvents = pgTable(
  "tag_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    eventType: tagEventTypeEnum("event_type").notNull(),
    tag: text("tag").notNull(),
    commitSha: text("commit_sha").notNull(),
    githubDeliveryId: text("github_delivery_id").notNull(),
    status: tagEventStatusEnum("status").notNull().default("WAITING_FOR_PAIR"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    rawPayload: jsonb("raw_payload").notNull()
  },
  (table) => ({
    githubDeliveryUnique: uniqueIndex("tag_events_github_delivery_unique").on(table.githubDeliveryId),
    repositoryTagCommitUnique: uniqueIndex("tag_events_repository_tag_commit_unique").on(
      table.repositoryId,
      table.tag,
      table.commitSha
    )
  })
);

export const generationRuns = pgTable(
  "generation_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    frontendRepositoryId: text("frontend_repository_id").notNull(),
    backendRepositoryId: text("backend_repository_id").notNull(),
    frontendTag: text("frontend_tag").notNull(),
    frontendCommitSha: text("frontend_commit_sha").notNull(),
    backendTag: text("backend_tag").notNull(),
    backendCommitSha: text("backend_commit_sha").notNull(),
    status: generationRunStatusEnum("status").notNull().default("QUEUED"),
    totalEligibleFiles: integer("total_eligible_files").notNull().default(0),
    indexedEligibleFiles: integer("indexed_eligible_files").notNull().default(0),
    frontendTotalEligibleFiles: integer("frontend_total_eligible_files").notNull().default(0),
    frontendIndexedEligibleFiles: integer("frontend_indexed_eligible_files").notNull().default(0),
    backendTotalEligibleFiles: integer("backend_total_eligible_files").notNull().default(0),
    backendIndexedEligibleFiles: integer("backend_indexed_eligible_files").notNull().default(0),
    generatedStatementCount: integer("generated_statement_count").notNull().default(0),
    generatedStatementWithEvidenceCount: integer("generated_statement_with_evidence_count").notNull().default(0),
    qualityReportJson: jsonb("quality_report_json").$type<Record<string, unknown> | null>(),
    aiUsageJson: jsonb("ai_usage_json").$type<Record<string, unknown> | null>(),
    incrementalReportJson: jsonb("incremental_report_json").$type<Record<string, unknown> | null>(),
    coverageReportJson: jsonb("coverage_report_json").$type<Record<string, unknown> | null>(),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    generationPairUnique: uniqueIndex("generation_runs_pair_unique").on(
      table.workspaceId,
      table.frontendCommitSha,
      table.backendCommitSha
    )
  })
);

export const generationDebugEvents = pgTable(
  "generation_debug_events",
  {
    id: text("id").primaryKey(),
    generationRunId: text("generation_run_id").notNull(),
    stage: text("stage").notNull(),
    eventType: text("event_type").notNull(),
    severity: text("severity").notNull(),
    message: text("message").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    generationRunIdx: index("generation_debug_events_run_idx").on(table.generationRunId),
    generationRunOrderedIdx: index("generation_debug_events_run_ordered_idx").on(
      table.generationRunId,
      table.createdAt,
      table.id
    )
  })
);

export const codeFacts = pgTable("code_facts", {
  id: text("id").primaryKey(),
  generationRunId: text("generation_run_id").notNull(),
  repositoryRole: repositoryRoleEnum("repository_role").notNull(),
  repositoryFullName: text("repository_full_name").notNull(),
  tag: text("tag").notNull(),
  commitSha: text("commit_sha").notNull(),
  factKind: text("fact_kind").notNull(),
  text: text("text").notNull(),
  evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull(),
  confidence: real("confidence").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const codeMaps = pgTable(
  "code_maps",
  {
    id: text("id").primaryKey(),
    generationRunId: text("generation_run_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    mapJson: jsonb("map_json").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    generationRunUnique: uniqueIndex("code_maps_generation_run_unique").on(table.generationRunId)
  })
);

export const codeSummaries = pgTable(
  "code_summaries",
  {
    id: text("id").primaryKey(),
    generationRunId: text("generation_run_id").notNull(),
    summaryType: codeSummaryTypeEnum("summary_type").notNull(),
    cacheKey: text("cache_key").notNull(),
    sourceHash: text("source_hash").notNull(),
    inputHash: text("input_hash").notNull(),
    outputHash: text("output_hash").notNull(),
    summaryJson: jsonb("summary_json").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    generationRunTypeCacheKeyUnique: uniqueIndex("code_summaries_generation_type_cache_unique").on(
      table.generationRunId,
      table.summaryType,
      table.cacheKey
    )
  })
);

export const generationTasks = pgTable(
  "generation_tasks",
  {
    id: text("id").primaryKey(),
    generationRunId: text("generation_run_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    repositoryRole: repositoryRoleEnum("repository_role"),
    repositoryId: text("repository_id"),
    taskType: generationTaskTypeEnum("task_type").notNull(),
    status: generationTaskStatusEnum("status").notNull().default("QUEUED"),
    branchState: generationTaskBranchStateEnum("branch_state"),
    priority: integer("priority").notNull().default(100),
    pageKey: text("page_key"),
    parentTaskId: text("parent_task_id"),
    rootTaskId: text("root_task_id"),
    dedupeKey: text("dedupe_key").notNull(),
    reason: text("reason").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull(),
    resultJson: jsonb("result_json").$type<Record<string, unknown> | null>(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    errorMessage: text("error_message"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    generationRunDedupeUnique: uniqueIndex("generation_tasks_run_dedupe_unique").on(table.generationRunId, table.dedupeKey),
    generationRunStatusCreatedAtIdx: index("generation_tasks_run_status_created_idx").on(table.generationRunId, table.status, table.createdAt),
    generationRunPageKeyIdx: index("generation_tasks_run_page_key_idx").on(table.generationRunId, table.pageKey)
  })
);

export const evidence = pgTable("evidence", {
  id: text("id").primaryKey(),
  generationRunId: text("generation_run_id").notNull(),
  repositoryRole: repositoryRoleEnum("repository_role").notNull(),
  repositoryFullName: text("repository_full_name").notNull(),
  tag: text("tag").notNull(),
  commitSha: text("commit_sha").notNull(),
  filePath: text("file_path").notNull(),
  startLine: integer("start_line").notNull(),
  endLine: integer("end_line").notNull(),
  sourceKind: text("source_kind").notNull(),
  summary: text("summary").notNull(),
  codeSnippet: text("code_snippet").notNull(),
  githubUrl: text("github_url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    generationRunId: text("generation_run_id").notNull(),
    pageKey: text("page_key").notNull(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    inputHash: text("input_hash"),
    generationStrategy: text("generation_strategy"),
    reusedFromGenerationRunId: text("reused_from_generation_run_id"),
    parentPageId: text("parent_page_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    workspacePageKeyUnique: uniqueIndex("wiki_pages_workspace_page_key_unique").on(table.workspaceId, table.pageKey)
  })
);

export const wikiRunPages = pgTable(
  "wiki_run_pages",
  {
    id: text("id").primaryKey(),
    generationRunId: text("generation_run_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    pageId: text("page_id").notNull(),
    pageKey: text("page_key").notNull(),
    materializationType: text("materialization_type").notNull(),
    sourceGenerationRunId: text("source_generation_run_id"),
    inputHash: text("input_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    generationRunPageUnique: uniqueIndex("wiki_run_pages_run_page_unique").on(table.generationRunId, table.pageKey),
    generationRunIdx: index("wiki_run_pages_run_idx").on(table.generationRunId),
    pageIdx: index("wiki_run_pages_page_idx").on(table.pageId)
  })
);

export const wikiBlocks = pgTable(
  "wiki_blocks",
  {
    id: text("id").primaryKey(),
    pageId: text("page_id").notNull(),
    generationRunId: text("generation_run_id").notNull(),
    parentBlockId: text("parent_block_id"),
    position: integer("position").notNull(),
    stableKey: text("stable_key").notNull(),
    type: text("type").notNull(),
    origin: blockOriginEnum("origin").notNull(),
    reviewState: reviewStateEnum("review_state").notNull(),
    sourceHash: text("source_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull().default([]),
    locked: boolean("locked").notNull().default(true),
    blockJson: jsonb("block_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    pageStableKeyUnique: uniqueIndex("wiki_blocks_page_stable_key_unique").on(table.pageId, table.stableKey)
  })
);

export const wikiPageEvidence = pgTable(
  "wiki_page_evidence",
  {
    id: text("id").primaryKey(),
    generationRunId: text("generation_run_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    pageKey: text("page_key").notNull(),
    evidenceId: text("evidence_id").notNull(),
    factId: text("fact_id"),
    sourceTaskId: text("source_task_id"),
    coverageRole: wikiPageEvidenceCoverageRoleEnum("coverage_role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    generationRunPageIdx: index("wiki_page_evidence_run_page_idx").on(table.generationRunId, table.pageKey)
  })
);

export const wikiBlockOverlays = pgTable("wiki_block_overlays", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  targetBlockId: text("target_block_id"),
  targetStableKey: text("target_stable_key").notNull(),
  overlayType: overlayTypeEnum("overlay_type").notNull(),
  overlayJson: jsonb("overlay_json").notNull(),
  createdBy: text("created_by").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
