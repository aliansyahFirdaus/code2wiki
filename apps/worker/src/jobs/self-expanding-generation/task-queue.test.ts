import { beforeEach, describe, expect, it, vi } from "vitest";

import { runSelfExpandingGeneration } from "./task-queue";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  codeFacts: { generationRunId: "code_facts.generation_run_id" },
  codeMaps: { generationRunId: "code_maps.generation_run_id" },
  evidence: { generationRunId: "evidence.generation_run_id" },
  generationRuns: {
    id: "generation_runs.id",
    workspaceId: "generation_runs.workspace_id",
    frontendRepositoryId: "generation_runs.frontend_repository_id",
    backendRepositoryId: "generation_runs.backend_repository_id",
    status: "generation_runs.status",
    createdAt: "generation_runs.created_at"
  },
  generationTasks: {
    id: "generation_tasks.id",
    generationRunId: "generation_tasks.generation_run_id",
    dedupeKey: "generation_tasks.dedupe_key",
    status: "generation_tasks.status",
    priority: "generation_tasks.priority",
    createdAt: "generation_tasks.created_at"
  },
  wikiPages: {
    workspaceId: "wiki_pages.workspace_id",
    pageKey: "wiki_pages.page_key"
  },
  wikiPageEvidence: {
    id: "wiki_page_evidence.id",
    generationRunId: "wiki_page_evidence.generation_run_id"
  },
  wikiRunPages: {
    generationRunId: "wiki_run_pages.generation_run_id",
    pageKey: "wiki_run_pages.page_key"
  },
  writePageTask: vi.fn()
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => ({ type: "and", conditions })),
  asc: vi.fn((field: string) => field),
  desc: vi.fn((field: string) => field),
  eq: vi.fn((field: string, value: unknown) => ({ type: "eq", field, value })),
  ne: vi.fn((field: string, value: unknown) => ({ type: "ne", field, value })),
  or: vi.fn((...conditions: unknown[]) => ({ type: "or", conditions })),
  sql: vi.fn(() => ({ type: "inc_attempts" }))
}));

vi.mock("@code2wiki/db", () => ({
  codeFacts: mocks.codeFacts,
  codeMaps: mocks.codeMaps,
  evidence: mocks.evidence,
  generationRuns: mocks.generationRuns,
  generationTasks: mocks.generationTasks,
  getDb: mocks.getDb,
  wikiPageEvidence: mocks.wikiPageEvidence,
  wikiPages: mocks.wikiPages,
  wikiRunPages: mocks.wikiRunPages
}));

vi.mock("./page-writer", () => ({
  writePageTask: mocks.writePageTask
}));

describe("self-expanding generation task queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writePageTask.mockImplementation(async (run: any, task: any) => {
      const db = mocks.getDb();
      db.runPages.push({ generationRunId: run.id, workspaceId: run.workspaceId, pageId: `page-${task.pageKey}`, pageKey: task.pageKey, materializationType: "WRITTEN" });
      return {
      ok: true,
      pageKey: task.pageKey ?? "users",
      qualityReport: { gateResult: "PASS", issues: [], metrics: [] },
      aiUsageReport: { calls: [], summary: { callCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsdMicros: null, pricingSource: null } },
      generatedStatementCount: 1,
      generatedStatementWithEvidenceCount: 1
      };
    });
  });

  it("claims FACTS_EXTRACTED and seeds from frontend code-map surfaces", async () => {
    const db = new FakeDb({
      runs: [run("FACTS_EXTRACTED")],
      codeMaps: [codeMap([uiRoute("/users", "app/users/page.tsx"), reactComponent("/users", "app/users/page.tsx"), navigation("/users")])]
    });
    mocks.getDb.mockReturnValue(db);

    const result = await runSelfExpandingGeneration("run-1");

    expect(result).toMatchObject({ status: "tasks_processed", generationRunId: "run-1", written: 1, failed: 0 });
    expect(db.runs[0].status).toBe("COMPLETED");
    expect(db.tasks.map((task) => task.taskType)).toEqual(["DISCOVER_SURFACE", "TRACE_BEHAVIOR", "CREATE_PAGE", "EVALUATE_COVERAGE"]);
    expect(db.wikiPages).toHaveLength(0);
    expect(db.wikiBlocks).toHaveLength(0);
  });

  it("skips AI_GENERATING with no existing tasks", async () => {
    const db = new FakeDb({ runs: [run("AI_GENERATING")], codeMaps: [codeMap([uiRoute("/users", "app/users/page.tsx")])] });
    mocks.getDb.mockReturnValue(db);

    await expect(runSelfExpandingGeneration("run-1")).resolves.toMatchObject({ status: "skipped" });
    expect(db.tasks).toHaveLength(0);
  });

  it("skips AI_GENERATING when a non-stale IN_PROGRESS task exists", async () => {
    const db = new FakeDb({
      runs: [run("AI_GENERATING")],
      tasks: [task({ status: "IN_PROGRESS", claimedAt: new Date() })]
    });
    mocks.getDb.mockReturnValue(db);

    await expect(runSelfExpandingGeneration("run-1")).resolves.toMatchObject({ status: "skipped" });
    expect(db.tasks[0].status).toBe("IN_PROGRESS");
  });

  it("resumes AI_GENERATING when stale IN_PROGRESS can retry", async () => {
    const db = new FakeDb({
      runs: [run("AI_GENERATING")],
      tasks: [task({ status: "IN_PROGRESS", claimedAt: new Date(Date.now() - 16 * 60 * 1000) })],
      wikiPages: [{ workspaceId: "workspace-1", pageKey: "users" }]
    });
    mocks.getDb.mockReturnValue(db);

    const result = await runSelfExpandingGeneration("run-1");

    expect(result).toMatchObject({ status: "tasks_processed", written: 1 });
    expect(db.tasks.some((item) => item.taskType === "UPDATE_PAGE" && item.status === "WRITTEN")).toBe(true);
  });

  it("marks stale IN_PROGRESS as FAILED when retry budget is exhausted", async () => {
    const db = new FakeDb({
      runs: [run("AI_GENERATING")],
      tasks: [task({ status: "IN_PROGRESS", attempts: 3, maxAttempts: 3, claimedAt: new Date(Date.now() - 16 * 60 * 1000) })]
    });
    mocks.getDb.mockReturnValue(db);

    const result = await runSelfExpandingGeneration("run-1");

    expect(result).toMatchObject({ status: "tasks_processed", failed: 1, queued: 0 });
    expect(db.tasks[0]).toMatchObject({ status: "FAILED", errorMessage: "STALE_TASK_RETRY_EXHAUSTED" });
  });

  it("dedupes repeated seed calls by dedupeKey", async () => {
    const db = new FakeDb({ runs: [run("FACTS_EXTRACTED")], codeMaps: [codeMap([uiRoute("/users", "app/users/page.tsx")])] });
    mocks.getDb.mockReturnValue(db);

    await runSelfExpandingGeneration("run-1");
    db.runs[0].status = "AI_GENERATING";
    await runSelfExpandingGeneration("run-1");

    expect(db.tasks.filter((task) => task.dedupeKey === "discover-surface:users")).toHaveLength(1);
    expect(db.tasks.filter((task) => task.dedupeKey === "trace-behavior:users")).toHaveLength(1);
    expect(db.tasks.filter((task) => task.dedupeKey === "create-page:users")).toHaveLength(1);
  });

  it("keeps FOUND_CHILDREN and WAITING_RELATED_BRANCH as branch state, not completion status", async () => {
    const db = new FakeDb({ runs: [run("FACTS_EXTRACTED")], codeMaps: [codeMap([uiRoute("/settings", "app/settings/page.tsx")])] });
    mocks.getDb.mockReturnValue(db);

    await runSelfExpandingGeneration("run-1");

    expect(db.tasks.find((task) => task.taskType === "DISCOVER_SURFACE")).toMatchObject({ status: "SUCCEEDED", branchState: "FOUND_CHILDREN" });
    expect(db.tasks.find((task) => task.taskType === "TRACE_BEHAVIOR")).toMatchObject({ status: "SUCCEEDED", branchState: "WAITING_RELATED_BRANCH" });
  });

  it("marks backend-only work as NEEDS_REVIEW", async () => {
    const db = new FakeDb({
      runs: [run("AI_GENERATING")],
      tasks: [task({ taskType: "TRACE_BEHAVIOR", repositoryRole: "BACKEND", pageKey: null, payloadJson: { filePath: "app/api/users/route.ts" } })]
    });
    mocks.getDb.mockReturnValue(db);

    await runSelfExpandingGeneration("run-1");

    expect(db.tasks[0]).toMatchObject({ status: "NEEDS_REVIEW", branchState: "NEEDS_FRONTEND_ANCHOR" });
  });

  it("fails sanitized on missing or invalid code map artifacts", async () => {
    const db = new FakeDb({ runs: [run("FACTS_EXTRACTED")], codeMaps: [] });
    mocks.getDb.mockReturnValue(db);

    const result = await runSelfExpandingGeneration("run-1");

    expect(result).toEqual({ status: "failed", generationRunId: "run-1", errorMessage: "INVALID_CODE_MAP" });
    expect(db.runs[0]).toMatchObject({ status: "FAILED", errorMessage: "INVALID_CODE_MAP" });
  });

  it("marks EVALUATE_COVERAGE as NEEDS_REVIEW when coverage has review gaps", async () => {
    const db = new FakeDb({
      runs: [run("AI_GENERATING")],
      evidence: [evidenceRow({ repositoryRole: "BACKEND", filePath: "app/api/users/route.ts" })],
      tasks: [task({ taskType: "EVALUATE_COVERAGE", dedupeKey: "evaluate-coverage:v1" })]
    });
    mocks.getDb.mockReturnValue(db);

    const result = await runSelfExpandingGeneration("run-1");

    expect(result).toMatchObject({ status: "tasks_processed", needsReview: 1 });
    expect(db.tasks[0]).toMatchObject({
      status: "NEEDS_REVIEW",
      resultJson: { reason: "COVERAGE_REQUIRES_REVIEW" }
    });
  });

  it("idle queue triggers evaluator", async () => {
    const db = new FakeDb({
      runs: [run("AI_GENERATING")],
      tasks: [task({ status: "WRITTEN", taskType: "CREATE_PAGE", dedupeKey: "create-page:users" })],
      runPages: [runPage()],
      pageEvidence: [pageEvidence({ coverageRole: "PRIMARY" })]
    });
    mocks.getDb.mockReturnValue(db);

    await runSelfExpandingGeneration("run-1");

    expect(db.tasks.some((item) => item.taskType === "EVALUATE_COVERAGE" && item.status === "SUCCEEDED")).toBe(true);
  });

  it("run cannot complete before evaluator success", async () => {
    const db = new FakeDb({
      runs: [run("AI_GENERATING")],
      tasks: [task({ status: "WRITTEN", taskType: "CREATE_PAGE", dedupeKey: "create-page:users" })],
      runPages: [runPage()]
    });
    mocks.getDb.mockReturnValue(db);

    await runSelfExpandingGeneration("run-1");

    expect(db.runs[0].status).toBe("COMPLETED");
    expect(db.tasks.some((item) => item.taskType === "EVALUATE_COVERAGE")).toBe(true);
  });

  it("unresolved evaluator review gaps move run to NEEDS_REVIEW", async () => {
    const db = new FakeDb({
      runs: [run("AI_GENERATING")],
      evidence: [evidenceRow({ repositoryRole: "BACKEND", filePath: "app/api/users/route.ts" })],
      tasks: [task({ status: "WRITTEN", taskType: "CREATE_PAGE", dedupeKey: "create-page:users" })],
      runPages: [runPage()]
    });
    mocks.getDb.mockReturnValue(db);

    await runSelfExpandingGeneration("run-1");

    expect(db.runs[0]).toMatchObject({ status: "NEEDS_REVIEW", errorMessage: "COVERAGE_REQUIRES_REVIEW" });
  });

  it("evaluator-created tasks keep run in AI_GENERATING", async () => {
    const db = new FakeDb({
      runs: [run("AI_GENERATING")],
      facts: [fact()],
      evidence: [evidenceRow()],
      tasks: [task({ status: "WRITTEN", taskType: "CREATE_PAGE", dedupeKey: "create-page:seed" })],
      runPages: [runPage({ pageKey: "seed" })]
    });
    mocks.getDb.mockReturnValue(db);

    await runSelfExpandingGeneration("run-1");

    expect(db.tasks.some((item) => item.dedupeKey === "create-page:users")).toBe(true);
    expect(db.tasks.find((item) => item.taskType === "EVALUATE_COVERAGE")).toMatchObject({ status: "SUCCEEDED", branchState: "FOUND_CHILDREN", resultJson: { queued: ["create-page:users"] } });
    expect(db.runs[0].status).toBe("AI_GENERATING");
  });

  it("dedupe-conflicted evaluator tasks do not report FOUND_CHILDREN or hang the run", async () => {
    const db = new FakeDb({
      runs: [run("AI_GENERATING")],
      facts: [fact()],
      evidence: [evidenceRow()],
      codeMaps: [codeMap([uiRoute("/users", "app/users/page.tsx")])],
      tasks: [
        task({ id: "written-task", status: "WRITTEN", taskType: "CREATE_PAGE", dedupeKey: "create-page:seed" }),
        task({ id: "existing-users-task", status: "NEEDS_REVIEW", taskType: "CREATE_PAGE", dedupeKey: "create-page:users" })
      ],
      runPages: [runPage({ pageKey: "seed" })]
    });
    mocks.getDb.mockReturnValue(db);

    await runSelfExpandingGeneration("run-1");

    const evaluator = db.tasks.find((item) => item.taskType === "EVALUATE_COVERAGE");
    expect(evaluator).toMatchObject({ status: "SUCCEEDED", branchState: undefined, resultJson: { acceptable: false } });
    expect(db.runs[0]).toMatchObject({ status: "NEEDS_REVIEW", errorMessage: "COVERAGE_REQUIRES_REVIEW" });
  });
});

function run(status: string) {
  return {
    id: "run-1",
    workspaceId: "workspace-1",
    frontendRepositoryId: "repo-fe",
    backendRepositoryId: "repo-be",
    status,
    coverageReportJson: null,
    createdAt: new Date("2026-01-01T00:00:00Z")
  };
}

function codeMap(nodes: unknown[]) {
  return { generationRunId: "run-1", mapJson: { generationRunId: "run-1", sourceHash: "hash", nodes, edges: [] } };
}

function uiRoute(path: string, filePath: string) {
  return {
    stableKey: `node:${path}`,
    kind: "UI_ROUTE",
    repositoryRole: "FRONTEND",
    repositoryFullName: "acme/web",
    label: path,
    filePath,
    metadata: { path },
    evidenceIds: ["evidence-1"]
  };
}

function reactComponent(path: string, filePath: string) {
  return {
    stableKey: `component:${path}`,
    kind: "REACT_COMPONENT",
    repositoryRole: "FRONTEND",
    repositoryFullName: "acme/web",
    label: `Page ${path}`,
    filePath,
    metadata: { path },
    evidenceIds: ["evidence-2"]
  };
}

function navigation(target: string) {
  return {
    stableKey: `navigation:${target}`,
    kind: "NAVIGATION",
    repositoryRole: "FRONTEND",
    repositoryFullName: "acme/web",
    label: target,
    filePath: "app/layout.tsx",
    metadata: { target },
    evidenceIds: ["evidence-3"]
  };
}

function task(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: String(overrides.id ?? "task-1"),
    generationRunId: "run-1",
    workspaceId: "workspace-1",
    repositoryRole: "FRONTEND",
    repositoryId: "repo-fe",
    taskType: "TRACE_BEHAVIOR",
    status: "QUEUED",
    branchState: null,
    priority: 100,
    pageKey: "users",
    parentTaskId: null,
    rootTaskId: null,
    dedupeKey: "trace-behavior:users",
    reason: "test",
    payloadJson: { frontendAnchor: { nodeStableKey: "node:/users" } },
    resultJson: null,
    attempts: 0,
    maxAttempts: 3,
    errorMessage: null,
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides
  };
}

function fact(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "fact-1",
    generationRunId: "run-1",
    repositoryRole: "FRONTEND",
    repositoryFullName: "acme/web",
    tag: "v1",
    commitSha: "sha",
    factKind: "FORM",
    text: "Users can be created.",
    evidenceIds: ["evidence-1"],
    confidence: 0.9,
    ...overrides
  };
}

function evidenceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "evidence-1",
    generationRunId: "run-1",
    repositoryRole: "FRONTEND",
    repositoryFullName: "acme/web",
    tag: "v1",
    commitSha: "sha",
    filePath: "app/users/page.tsx",
    startLine: 1,
    endLine: 3,
    sourceKind: "FORM",
    summary: "User form",
    codeSnippet: "form",
    githubUrl: "https://example.test",
    ...overrides
  };
}

function pageEvidence(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "wpe-1",
    generationRunId: "run-1",
    workspaceId: "workspace-1",
    pageKey: "users",
    evidenceId: "evidence-1",
    factId: "fact-1",
    sourceTaskId: "task-1",
    coverageRole: "PRIMARY",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides
  };
}

function runPage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "wrp-1",
    generationRunId: "run-1",
    workspaceId: "workspace-1",
    pageId: "page-users",
    pageKey: "users",
    materializationType: "WRITTEN",
    sourceGenerationRunId: null,
    inputHash: null,
    ...overrides
  };
}

class FakeDb {
  runs: any[];
  codeMaps: any[];
  tasks: any[];
  wikiPages: any[];
  wikiBlocks: any[];
  facts: any[];
  evidence: any[];
  pageEvidence: any[];
  runPages: any[];

  constructor(input: { runs?: any[]; codeMaps?: any[]; tasks?: any[]; wikiPages?: any[]; wikiBlocks?: any[]; facts?: any[]; evidence?: any[]; pageEvidence?: any[]; runPages?: any[] }) {
    this.runs = input.runs ?? [];
    this.codeMaps = input.codeMaps ?? [];
    this.tasks = input.tasks ?? [];
    this.wikiPages = input.wikiPages ?? [];
    this.wikiBlocks = input.wikiBlocks ?? [];
    this.facts = input.facts ?? [];
    this.evidence = input.evidence ?? [];
    this.pageEvidence = input.pageEvidence ?? [];
    this.runPages = input.runPages ?? [];
  }

  transaction(callback: (tx: FakeDb) => Promise<unknown>) {
    return callback(this);
  }

  select() {
    return new SelectBuilder(this);
  }

  update(table: unknown) {
    return new UpdateBuilder(this, table);
  }

  insert(table: unknown) {
    return new InsertBuilder(this, table);
  }

  rows(table: unknown) {
    if (table === mocks.generationRuns) return this.runs;
    if (table === mocks.codeFacts) return this.facts;
    if (table === mocks.codeMaps) return this.codeMaps;
    if (table === mocks.evidence) return this.evidence;
    if (table === mocks.generationTasks) return this.tasks;
    if (table === mocks.wikiPages) return this.wikiPages;
    if (table === mocks.wikiPageEvidence) return this.pageEvidence;
    if (table === mocks.wikiRunPages) return this.runPages;
    return [];
  }
}

class SelectBuilder {
  private table: unknown;
  private condition: unknown;
  private limitValue?: number;

  constructor(private db: FakeDb) {}

  from(table: unknown) {
    this.table = table;
    return this;
  }

  where(condition: unknown) {
    this.condition = condition;
    return this;
  }

  orderBy() {
    return this;
  }

  limit(value: number) {
    this.limitValue = value;
    return this.exec();
  }

  then(resolve: (value: any[]) => unknown, reject: (reason: unknown) => unknown) {
    return this.exec().then(resolve, reject);
  }

  private async exec() {
    const rows = this.db.rows(this.table).filter((row) => matches(row, this.condition));
    return typeof this.limitValue === "number" ? rows.slice(0, this.limitValue) : rows;
  }
}

class UpdateBuilder {
  private value: Record<string, unknown> = {};

  constructor(private db: FakeDb, private table: unknown) {}

  set(value: Record<string, unknown>) {
    this.value = value;
    return this;
  }

  where(condition: unknown) {
    const run = async () => {
      const rows = this.db.rows(this.table).filter((row) => matches(row, condition));
      for (const row of rows) {
        for (const [key, value] of Object.entries(this.value)) {
          row[key] = isIncrement(value) ? (row[key] ?? 0) + 1 : value;
        }
      }
      return rows;
    };
    return { returning: run, then: (resolve: (value: any[]) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject) };
  }
}

class InsertBuilder {
  constructor(private db: FakeDb, private table: unknown) {}

  values(value: Record<string, unknown>) {
    const rows = Array.isArray(value) ? value : [value];
    const run = async () => {
      const inserted: Record<string, unknown>[] = [];
      if (this.table === mocks.generationTasks) {
        for (const row of rows) {
          if (!this.db.tasks.some((task) => task.generationRunId === row.generationRunId && task.dedupeKey === row.dedupeKey)) {
            const insertedTask = task({ id: row.id, ...row });
            this.db.tasks.push(insertedTask);
            inserted.push(insertedTask);
          }
        }
      }
      if (this.table === mocks.wikiPageEvidence) {
        for (const row of rows) {
          if (!this.db.pageEvidence.some((item) => item.id === row.id)) {
            this.db.pageEvidence.push(row);
            inserted.push(row);
          }
        }
      }
      if (this.table === mocks.wikiRunPages) {
        for (const row of rows) {
          if (!this.db.runPages.some((item) => item.generationRunId === row.generationRunId && item.pageKey === row.pageKey)) {
            this.db.runPages.push(row);
            inserted.push(row);
          }
        }
      }
      return inserted;
    };
    return {
      onConflictDoNothing: () => ({ returning: () => run(), then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject) }),
      onConflictDoUpdate: () => run(),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject)
    };
  }
}

function matches(row: Record<string, unknown>, condition: any): boolean {
  if (!condition) return true;
  if (condition.type === "and") return condition.conditions.every((item: unknown) => matches(row, item));
  if (condition.type === "or") return condition.conditions.some((item: unknown) => matches(row, item));
  if (condition.type === "eq") return row[columnName(condition.field)] === condition.value;
  if (condition.type === "ne") return row[columnName(condition.field)] !== condition.value;
  return true;
}

function columnName(field: string) {
  return field.split(".").pop()?.replace(/_([a-z])/g, (_, char) => char.toUpperCase()) ?? field;
}

function isIncrement(value: unknown) {
  return Boolean(value && typeof value === "object" && (value as { type?: string }).type === "inc_attempts");
}
