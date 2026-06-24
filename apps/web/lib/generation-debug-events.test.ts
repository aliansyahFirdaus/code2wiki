import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadGenerationDebugEvents } from "./generation-debug-events";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  generationDebugEvents: {
    id: "generation_debug_events.id",
    generationRunId: "generation_debug_events.generation_run_id",
    createdAt: "generation_debug_events.created_at"
  },
  generationRuns: { id: "generation_runs.id" },
  generationTasks: { generationRunId: "generation_tasks.generation_run_id" },
  wikiRunPages: { generationRunId: "wiki_run_pages.generation_run_id" }
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => ({ type: "and", conditions })),
  asc: vi.fn((field: string) => field),
  eq: vi.fn((field: string, value: unknown) => ({ type: "eq", field, value })),
  gt: vi.fn((field: string, value: unknown) => ({ type: "gt", field, value })),
  or: vi.fn((...conditions: unknown[]) => ({ type: "or", conditions }))
}));

vi.mock("@code2wiki/db", () => ({
  generationDebugEvents: mocks.generationDebugEvents,
  generationRuns: mocks.generationRuns,
  generationTasks: mocks.generationTasks,
  getDb: mocks.getDb,
  wikiRunPages: mocks.wikiRunPages
}));

describe("loadGenerationDebugEvents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns ordered events after a scoped cursor with limit and summary", async () => {
    const db = new FakeDb();
    mocks.getDb.mockReturnValue(db);

    const result = await loadGenerationDebugEvents({ generationRunId: "run-1", afterId: "event-1", limit: 2 });

    expect(result?.events.map((event) => event.id)).toEqual(["event-2", "event-3"]);
    expect(result?.nextAfterId).toBe("event-3");
    expect(result?.summary.taskCounts).toMatchObject({ queued: 1, inProgress: 1, written: 1 });
    expect(result?.summary.pageKeys).toMatchObject({ written: ["users"], reused: ["settings"], affected: ["users"] });
    expect(result?.summary.coverage.gaps).toEqual([{ disposition: "NEEDS_REVIEW", pageKey: "users", evidenceId: "ev-1", factId: "fact-1", reason: "NO_FRONTEND_ANCHOR" }]);
  });

  it("uses since when afterId is absent", async () => {
    const db = new FakeDb();
    mocks.getDb.mockReturnValue(db);

    const result = await loadGenerationDebugEvents({ generationRunId: "run-1", since: "2026-01-01T00:00:01.500Z" });

    expect(result?.events.map((event) => event.id)).toEqual(["event-2", "event-3", "event-4"]);
  });
});

class FakeDb {
  runs = [{
    id: "run-1",
    status: "AI_GENERATING",
    incrementalReportJson: { affectedPageKeys: ["users"] },
    coverageReportJson: {
      counts: { reviewGaps: 1 },
      gaps: [{ disposition: "NEEDS_REVIEW", pageKey: "users", evidenceId: "ev-1", factId: "fact-1", reason: "NO_FRONTEND_ANCHOR", summary: "hidden" }]
    },
    errorMessage: null
  }];
  events = [
    event("event-1", "2026-01-01T00:00:01.000Z"),
    event("event-2", "2026-01-01T00:00:02.000Z"),
    event("event-3", "2026-01-01T00:00:03.000Z"),
    event("event-4", "2026-01-01T00:00:04.000Z")
  ];
  tasks = [
    { generationRunId: "run-1", id: "task-1", status: "QUEUED", taskType: "CREATE_PAGE", pageKey: "users", repositoryRole: "FRONTEND" },
    { generationRunId: "run-1", id: "task-2", status: "IN_PROGRESS", taskType: "EVALUATE_COVERAGE", pageKey: null, repositoryRole: null },
    { generationRunId: "run-1", id: "task-3", status: "WRITTEN", taskType: "UPDATE_PAGE", pageKey: "settings", repositoryRole: "FRONTEND" }
  ];
  pages = [
    { generationRunId: "run-1", pageKey: "users", materializationType: "WRITTEN" },
    { generationRunId: "run-1", pageKey: "settings", materializationType: "REUSED" }
  ];

  select() {
    return new SelectBuilder(this);
  }

  rows(table: unknown) {
    if (table === mocks.generationRuns) return this.runs;
    if (table === mocks.generationDebugEvents) return this.events;
    if (table === mocks.generationTasks) return this.tasks;
    if (table === mocks.wikiRunPages) return this.pages;
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
    rows.sort((left: any, right: any) => left.createdAt?.getTime?.() - right.createdAt?.getTime?.() || String(left.id).localeCompare(String(right.id)));
    return typeof this.limitValue === "number" ? rows.slice(0, this.limitValue) : rows;
  }
}

function event(id: string, createdAt: string) {
  return { id, generationRunId: "run-1", stage: "task_queue", eventType: "TASK_STARTED", severity: "INFO", message: id, payloadJson: {}, createdAt: new Date(createdAt) };
}

function matches(row: Record<string, unknown>, condition: any): boolean {
  if (!condition) return true;
  if (condition.type === "and") return condition.conditions.every((item: unknown) => matches(row, item));
  if (condition.type === "or") return condition.conditions.some((item: unknown) => matches(row, item));
  if (condition.type === "eq") return row[columnName(condition.field)] === condition.value;
  if (condition.type === "gt") return (row[columnName(condition.field)] as Date | string) > condition.value;
  return true;
}

function columnName(field: string) {
  return field.split(".").pop()?.replace(/_([a-z])/g, (_, char) => char.toUpperCase()) ?? field;
}
