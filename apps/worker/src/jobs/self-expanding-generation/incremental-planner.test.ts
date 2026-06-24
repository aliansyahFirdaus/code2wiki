import { describe, expect, it, vi } from "vitest";

import { planIncrementalRun } from "./incremental-planner";
import { pageInputHash } from "./page-input";

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
  generationDebugEvents: { id: "generation_debug_events.id" },
  generationTasks: {
    generationRunId: "generation_tasks.generation_run_id",
    dedupeKey: "generation_tasks.dedupe_key"
  },
  wikiPageEvidence: {
    id: "wiki_page_evidence.id",
    generationRunId: "wiki_page_evidence.generation_run_id"
  },
  wikiPages: { workspaceId: "wiki_pages.workspace_id" },
  wikiRunPages: {
    id: "wiki_run_pages.id",
    generationRunId: "wiki_run_pages.generation_run_id",
    pageKey: "wiki_run_pages.page_key"
  }
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => ({ type: "and", conditions })),
  desc: vi.fn((field: string) => field),
  eq: vi.fn((field: string, value: unknown) => ({ type: "eq", field, value })),
  ne: vi.fn((field: string, value: unknown) => ({ type: "ne", field, value }))
}));

vi.mock("@code2wiki/db", () => ({
  codeFacts: mocks.codeFacts,
  codeMaps: mocks.codeMaps,
  evidence: mocks.evidence,
  generationRuns: mocks.generationRuns,
  generationDebugEvents: mocks.generationDebugEvents,
  generationTasks: mocks.generationTasks,
  getDb: mocks.getDb,
  wikiPageEvidence: mocks.wikiPageEvidence,
  wikiPages: mocks.wikiPages,
  wikiRunPages: mocks.wikiRunPages
}));

describe("incremental planner", () => {
  it("hashes page input by evidence substance, not random evidence ids", () => {
    const firstEvidence = evidenceRow("run-a", { id: "ev-random-a" });
    const secondEvidence = evidenceRow("run-b", { id: "ev-random-b" });

    expect(
      pageInputHash(
        "users",
        [fact("run-a", ["ev-random-a"], { id: "fact-random-a" })] as any,
        [firstEvidence] as any,
        { nodes: [{ kind: "UI_ROUTE", repositoryRole: "FRONTEND", filePath: "app/users/page.tsx", metadata: { path: "/users" }, evidenceIds: ["ev-random-a"] }] }
      )
    ).toBe(
      pageInputHash(
        "users",
        [fact("run-b", ["ev-random-b"], { id: "fact-random-b" })] as any,
        [secondEvidence] as any,
        { nodes: [{ kind: "UI_ROUTE", repositoryRole: "FRONTEND", filePath: "app/users/page.tsx", metadata: { path: "/users" }, evidenceIds: ["ev-random-b"] }] }
      )
    );
  });

  it("uses full mode when no completed baseline exists", async () => {
    const db = new FakeDb({ runs: [run("run-new", "FACTS_EXTRACTED")] });
    mocks.getDb.mockReturnValue(db);

    await expect(planIncrementalRun(run("run-new", "FACTS_EXTRACTED") as any)).resolves.toEqual({ seeded: 0, mode: "FULL" });
    expect(db.runs[0].incrementalReportJson).toMatchObject({ mode: "FULL", baselineGenerationRunId: null });
    expect(db.debugEvents.map((event) => event.eventType)).toContain("BASELINE_MISSING");
  });

  it("reuses unchanged baseline page without rewriting blocks", async () => {
    const currentEvidence = evidenceRow("run-new");
    const currentFact = fact("run-new", [currentEvidence.id]);
    const baselineEvidence = evidenceRow("run-old", { id: "ev-old" });
    const baselineFact = fact("run-old", [baselineEvidence.id], { id: "fact-old" });
    const inputHash = pageInputHash("users", [currentFact] as any, [currentEvidence] as any, null);
    const db = new FakeDb({
      runs: [run("run-new", "FACTS_EXTRACTED"), run("run-old", "COMPLETED")],
      facts: [currentFact, baselineFact],
      evidence: [currentEvidence, baselineEvidence],
      pages: [page({ generationRunId: "run-old", inputHash })],
      pageEvidence: [pageEvidence({ generationRunId: "run-old", evidenceId: "ev-old", factId: "fact-old" })],
      blocks: [{ id: "baseline-block" }]
    });
    mocks.getDb.mockReturnValue(db);

    await expect(planIncrementalRun(run("run-new", "FACTS_EXTRACTED") as any)).resolves.toEqual({ seeded: 0, mode: "INCREMENTAL" });
    expect(db.runPages).toMatchObject([{ generationRunId: "run-new", pageKey: "users", materializationType: "REUSED", sourceGenerationRunId: "run-old" }]);
    expect(db.pageEvidence.some((row) => row.generationRunId === "run-new" && row.evidenceId === "ev-new")).toBe(true);
    expect(db.blocks).toEqual([{ id: "baseline-block" }]);
    expect(db.debugEvents.map((event) => event.eventType)).toEqual(expect.arrayContaining(["BASELINE_FOUND", "PAGE_CANDIDATES_BUILT", "PAGE_REUSED"]));
  });

  it("uses baseline run-page ownership even when canonical page belongs to an older run", async () => {
    const currentEvidence = evidenceRow("run-new");
    const currentFact = fact("run-new", [currentEvidence.id]);
    const baselineEvidence = evidenceRow("run-old", { id: "ev-old" });
    const baselineFact = fact("run-old", [baselineEvidence.id], { id: "fact-old" });
    const inputHash = pageInputHash("users", [currentFact] as any, [currentEvidence] as any, null);
    const db = new FakeDb({
      runs: [run("run-new", "FACTS_EXTRACTED"), run("run-old", "COMPLETED")],
      facts: [currentFact, baselineFact],
      evidence: [currentEvidence, baselineEvidence],
      pages: [page({ generationRunId: "run-older", inputHash: "stale-canonical-hash" })],
      pageEvidence: [pageEvidence({ generationRunId: "run-old", evidenceId: "ev-old", factId: "fact-old" })],
      runPages: [{ id: "wrp-old", generationRunId: "run-old", workspaceId: "workspace-1", pageId: "page-users", pageKey: "users", materializationType: "REUSED", sourceGenerationRunId: "run-older", inputHash }]
    });
    mocks.getDb.mockReturnValue(db);

    await expect(planIncrementalRun(run("run-new", "FACTS_EXTRACTED") as any)).resolves.toEqual({ seeded: 0, mode: "INCREMENTAL" });
    expect(db.tasks).toHaveLength(0);
    expect(db.runPages.some((row) => row.generationRunId === "run-new" && row.pageKey === "users" && row.materializationType === "REUSED")).toBe(true);
  });

  it("does not enqueue backend-only evidence without a frontend anchor", async () => {
    const db = new FakeDb({
      runs: [run("run-new", "FACTS_EXTRACTED"), run("run-old", "COMPLETED")],
      facts: [fact("run-new", ["ev-backend"], { repositoryRole: "BACKEND" })],
      evidence: [evidenceRow("run-new", { id: "ev-backend", repositoryRole: "BACKEND", filePath: "app/api/payroll/route.ts" })],
      codeMaps: [{ generationRunId: "run-new", mapJson: { nodes: [{ kind: "API_ROUTE", repositoryRole: "BACKEND", filePath: "app/api/payroll/route.ts" }] } }]
    });
    mocks.getDb.mockReturnValue(db);

    await expect(planIncrementalRun(run("run-new", "FACTS_EXTRACTED") as any)).resolves.toEqual({ seeded: 0, mode: "INCREMENTAL" });
    expect(db.tasks).toHaveLength(0);
    expect(db.runs[0].incrementalReportJson).toMatchObject({ affectedPageKeys: [], reusedPageKeys: [] });
  });

  it("does not turn frontend helper evidence into a page without a surface anchor", async () => {
    const db = new FakeDb({
      runs: [run("run-new", "FACTS_EXTRACTED"), run("run-old", "COMPLETED")],
      facts: [fact("run-new", ["ev-helper"])],
      evidence: [evidenceRow("run-new", { id: "ev-helper", filePath: "src/lib/firebase.ts", sourceKind: "OTHER", summary: "Firebase helper" })],
      codeMaps: [{ generationRunId: "run-new", mapJson: { nodes: [{ kind: "ENV_CONFIG", repositoryRole: "FRONTEND", filePath: "src/lib/firebase.ts" }] } }]
    });
    mocks.getDb.mockReturnValue(db);

    await expect(planIncrementalRun(run("run-new", "FACTS_EXTRACTED") as any)).resolves.toEqual({ seeded: 0, mode: "INCREMENTAL" });
    expect(db.tasks).toHaveLength(0);
    expect(db.runs[0].incrementalReportJson).toMatchObject({ affectedPageKeys: [], reusedPageKeys: [] });
  });

  it("enqueues an update when page input hash changed", async () => {
    const currentEvidence = evidenceRow("run-new", { summary: "Changed user form" });
    const currentFact = fact("run-new", [currentEvidence.id], { text: "Changed user flow." });
    const db = new FakeDb({
      runs: [run("run-new", "FACTS_EXTRACTED"), run("run-old", "COMPLETED")],
      facts: [currentFact, fact("run-old", ["ev-old"], { id: "fact-old" })],
      evidence: [currentEvidence, evidenceRow("run-old", { id: "ev-old" })],
      pages: [page({ generationRunId: "run-old", inputHash: "old-hash" })]
    });
    mocks.getDb.mockReturnValue(db);

    await planIncrementalRun(run("run-new", "FACTS_EXTRACTED") as any);

    expect(db.tasks).toMatchObject([{ generationRunId: "run-new", taskType: "UPDATE_PAGE", pageKey: "users", dedupeKey: "update-page:users" }]);
    expect(db.runs[0].incrementalReportJson).toMatchObject({ mode: "INCREMENTAL", affectedPageKeys: ["users"], reuseMissReasons: { users: "input_hash_mismatch" } });
    expect(db.debugEvents.map((event) => event.eventType)).toEqual(expect.arrayContaining(["PAGE_AFFECTED", "TASK_QUEUED"]));
  });
});

function run(id: string, status: string) {
  return {
    id,
    workspaceId: "workspace-1",
    frontendRepositoryId: "repo-fe",
    backendRepositoryId: "repo-be",
    status,
    createdAt: new Date(id === "run-old" ? "2026-01-01T00:00:00Z" : "2026-02-01T00:00:00Z"),
    incrementalReportJson: null
  };
}

function evidenceRow(generationRunId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "ev-new",
    generationRunId,
    repositoryRole: "FRONTEND",
    filePath: "app/users/page.tsx",
    startLine: 1,
    endLine: 3,
    sourceKind: "FORM",
    summary: "User form",
    ...overrides
  };
}

function fact(generationRunId: string, evidenceIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    id: "fact-new",
    generationRunId,
    repositoryRole: "FRONTEND",
    factKind: "FORM",
    text: "Users can be created.",
    evidenceIds,
    confidence: 0.9,
    ...overrides
  };
}

function page(overrides: Record<string, unknown>) {
  return { id: "page-users", workspaceId: "workspace-1", pageKey: "users", title: "Users", slug: "users", ...overrides };
}

function pageEvidence(overrides: Record<string, unknown>) {
  return { id: "wpe-old", workspaceId: "workspace-1", pageKey: "users", coverageRole: "PRIMARY", sourceTaskId: null, ...overrides };
}

class FakeDb {
  runs: any[];
  facts: any[];
  evidence: any[];
  pages: any[];
  pageEvidence: any[];
  blocks: any[];
  tasks: any[] = [];
  runPages: any[] = [];
  codeMaps: any[] = [];
  debugEvents: any[] = [];

  constructor(input: { runs: any[]; facts?: any[]; evidence?: any[]; pages?: any[]; pageEvidence?: any[]; blocks?: any[]; runPages?: any[]; codeMaps?: any[]; debugEvents?: any[] }) {
    this.runs = input.runs;
    this.facts = input.facts ?? [];
    this.evidence = input.evidence ?? [];
    this.pages = input.pages ?? [];
    this.pageEvidence = input.pageEvidence ?? [];
    this.blocks = input.blocks ?? [];
    this.runPages = input.runPages ?? [];
    this.codeMaps = input.codeMaps ?? [];
    this.debugEvents = input.debugEvents ?? [];
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
    if (table === mocks.evidence) return this.evidence;
    if (table === mocks.codeMaps) return this.codeMaps;
    if (table === mocks.wikiPages) return this.pages;
    if (table === mocks.wikiPageEvidence) return this.pageEvidence;
    if (table === mocks.generationTasks) return this.tasks;
    if (table === mocks.wikiRunPages) return this.runPages;
    if (table === mocks.generationDebugEvents) return this.debugEvents;
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
    const rows = this.db.rows(this.table).filter((row) => matches(row, condition));
    for (const row of rows) Object.assign(row, this.value);
    return Promise.resolve(rows);
  }
}

class InsertBuilder {
  constructor(private db: FakeDb, private table: unknown) {}
  values(value: Record<string, unknown> | Array<Record<string, unknown>>) {
    const rows = Array.isArray(value) ? value : [value];
    const run = async () => {
      const inserted: Record<string, unknown>[] = [];
      const target = this.db.rows(this.table);
      for (const row of rows) {
        const duplicate =
          this.table === mocks.generationTasks
            ? target.some((item) => item.generationRunId === row.generationRunId && item.dedupeKey === row.dedupeKey)
            : this.table === mocks.wikiRunPages
              ? target.some((item) => item.generationRunId === row.generationRunId && item.pageKey === row.pageKey)
              : target.some((item) => item.id === row.id);
        if (!duplicate) {
          target.push(row);
          inserted.push(row);
        }
      }
      return inserted;
    };
    return {
      onConflictDoNothing: () => ({ returning: () => run(), then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject) }),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject)
    };
  }
}

function matches(row: Record<string, unknown>, condition: any): boolean {
  if (!condition) return true;
  if (condition.type === "and") return condition.conditions.every((item: unknown) => matches(row, item));
  if (condition.type === "eq") return row[columnName(condition.field)] === condition.value;
  if (condition.type === "ne") return row[columnName(condition.field)] !== condition.value;
  return true;
}

function columnName(field: string) {
  return field.split(".").pop()?.replace(/_([a-z])/g, (_, char) => char.toUpperCase()) ?? field;
}
