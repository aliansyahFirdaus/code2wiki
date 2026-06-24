import { beforeEach, describe, expect, it, vi } from "vitest";

import { runSelfExpandingGeneration } from "./task-queue";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  codeMaps: { generationRunId: "code_maps.generation_run_id" },
  generationRuns: {
    id: "generation_runs.id",
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
  }
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => ({ type: "and", conditions })),
  asc: vi.fn((field: string) => field),
  eq: vi.fn((field: string, value: unknown) => ({ type: "eq", field, value })),
  sql: vi.fn(() => ({ type: "inc_attempts" }))
}));

vi.mock("@code2wiki/db", () => ({
  codeMaps: mocks.codeMaps,
  generationRuns: mocks.generationRuns,
  generationTasks: mocks.generationTasks,
  getDb: mocks.getDb,
  wikiPages: mocks.wikiPages
}));

describe("self-expanding generation task queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("claims FACTS_EXTRACTED and seeds from frontend code-map surfaces", async () => {
    const db = new FakeDb({
      runs: [run("FACTS_EXTRACTED")],
      codeMaps: [codeMap([uiRoute("/users", "app/users/page.tsx"), reactComponent("/users", "app/users/page.tsx"), navigation("/users")])]
    });
    mocks.getDb.mockReturnValue(db);

    const result = await runSelfExpandingGeneration("run-1");

    expect(result).toMatchObject({ status: "tasks_processed", generationRunId: "run-1", ready: 1, failed: 0 });
    expect(db.runs[0].status).toBe("AI_GENERATING");
    expect(db.tasks.map((task) => task.taskType)).toEqual(["DISCOVER_SURFACE", "TRACE_BEHAVIOR", "CREATE_PAGE"]);
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

    expect(result).toMatchObject({ status: "tasks_processed", ready: 1 });
    expect(db.tasks.some((item) => item.taskType === "UPDATE_PAGE" && item.status === "READY_TO_WRITE")).toBe(true);
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

  it("marks EVALUATE_COVERAGE as NEEDS_REVIEW instead of silent noop success", async () => {
    const db = new FakeDb({
      runs: [run("AI_GENERATING")],
      tasks: [task({ taskType: "EVALUATE_COVERAGE", dedupeKey: "evaluate-coverage:v1" })]
    });
    mocks.getDb.mockReturnValue(db);

    const result = await runSelfExpandingGeneration("run-1");

    expect(result).toMatchObject({ status: "tasks_processed", needsReview: 1 });
    expect(db.tasks[0]).toMatchObject({
      status: "NEEDS_REVIEW",
      resultJson: { reason: "EVALUATE_COVERAGE_NOT_IMPLEMENTED_IN_PHASE_1" }
    });
  });
});

function run(status: string) {
  return {
    id: "run-1",
    workspaceId: "workspace-1",
    frontendRepositoryId: "repo-fe",
    backendRepositoryId: "repo-be",
    status,
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

class FakeDb {
  runs: any[];
  codeMaps: any[];
  tasks: any[];
  wikiPages: any[];
  wikiBlocks: any[];

  constructor(input: { runs?: any[]; codeMaps?: any[]; tasks?: any[]; wikiPages?: any[]; wikiBlocks?: any[] }) {
    this.runs = input.runs ?? [];
    this.codeMaps = input.codeMaps ?? [];
    this.tasks = input.tasks ?? [];
    this.wikiPages = input.wikiPages ?? [];
    this.wikiBlocks = input.wikiBlocks ?? [];
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
    if (table === mocks.codeMaps) return this.codeMaps;
    if (table === mocks.generationTasks) return this.tasks;
    if (table === mocks.wikiPages) return this.wikiPages;
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
      if (this.table === mocks.generationTasks) {
        for (const row of rows) {
          if (!this.db.tasks.some((task) => task.generationRunId === row.generationRunId && task.dedupeKey === row.dedupeKey)) {
            this.db.tasks.push(task({ id: row.id, ...row }));
          }
        }
      }
    };
    return { onConflictDoNothing: run, then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject) };
  }
}

function matches(row: Record<string, unknown>, condition: any): boolean {
  if (!condition) return true;
  if (condition.type === "and") return condition.conditions.every((item: unknown) => matches(row, item));
  if (condition.type === "eq") return row[columnName(condition.field)] === condition.value;
  return true;
}

function columnName(field: string) {
  return field.split(".").pop()?.replace(/_([a-z])/g, (_, char) => char.toUpperCase()) ?? field;
}

function isIncrement(value: unknown) {
  return Boolean(value && typeof value === "object" && (value as { type?: string }).type === "inc_attempts");
}
