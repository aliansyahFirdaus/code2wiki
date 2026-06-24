import { beforeEach, describe, expect, it, vi } from "vitest";

import { evaluateCoverage } from "./coverage-evaluator";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  codeFacts: { generationRunId: "code_facts.generation_run_id" },
  codeMaps: { generationRunId: "code_maps.generation_run_id" },
  evidence: { generationRunId: "evidence.generation_run_id" },
  generationRuns: { id: "generation_runs.id" },
  generationDebugEvents: { id: "generation_debug_events.id" },
  generationTasks: {
    id: "generation_tasks.id",
    generationRunId: "generation_tasks.generation_run_id",
    dedupeKey: "generation_tasks.dedupe_key"
  },
  wikiPageEvidence: {
    id: "wiki_page_evidence.id",
    generationRunId: "wiki_page_evidence.generation_run_id"
  },
  wikiPages: {
    workspaceId: "wiki_pages.workspace_id",
    pageKey: "wiki_pages.page_key"
  }
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((field: string, value: unknown) => ({ type: "eq", field, value }))
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
  wikiPages: mocks.wikiPages
}));

describe("coverage evaluator", () => {
  beforeEach(() => vi.clearAllMocks());

  it("detects covered facts/evidence from PRIMARY and SUPPORTING", async () => {
    const db = new FakeDb({
      facts: [fact()],
      evidence: [evidenceRow()],
      pageEvidence: [pageEvidence({ coverageRole: "PRIMARY" })]
    });
    mocks.getDb.mockReturnValue(db);

    const result = await evaluateCoverage(run(), task());

    expect(result).toMatchObject({ ok: true, report: { acceptable: true, counts: { positiveCoverage: 1, uncovered: 0 } } });
    expect(db.tasks).toHaveLength(0);
    expect(db.debugEvents.some((event) => event.eventType === "COVERAGE_ACCEPTED")).toBe(true);
  });

  it("enqueues deterministic CREATE_PAGE for uncovered frontend anchor", async () => {
    const db = new FakeDb({ facts: [fact()], evidence: [evidenceRow()], codeMaps: [codeMap([uiRoute("/users")])] });
    mocks.getDb.mockReturnValue(db);

    const result = await evaluateCoverage(run(), task());

    expect(result).toMatchObject({ ok: true, queuedTaskDedupeKeys: ["create-page:users"], report: { counts: { routedGaps: 1, unroutedGaps: 0 } } });
    expect(db.tasks).toMatchObject([{ taskType: "CREATE_PAGE", pageKey: "users", dedupeKey: "create-page:users" }]);
  });

  it("enqueues deterministic UPDATE_PAGE when page exists", async () => {
    const db = new FakeDb({
      facts: [fact()],
      evidence: [evidenceRow()],
      codeMaps: [codeMap([uiRoute("/users")])],
      pages: [{ workspaceId: "workspace-1", pageKey: "users" }]
    });
    mocks.getDb.mockReturnValue(db);

    const result = await evaluateCoverage(run(), task());

    expect(result).toMatchObject({ ok: true, report: { counts: { routedGaps: 1, unroutedGaps: 0 } } });
    expect(db.tasks).toMatchObject([{ taskType: "UPDATE_PAGE", pageKey: "users", dedupeKey: "update-page:users" }]);
  });

  it("does not report queued task keys when dedupe conflict drops the insert", async () => {
    const db = new FakeDb({
      facts: [fact()],
      evidence: [evidenceRow()],
      codeMaps: [codeMap([uiRoute("/users")])],
      tasks: [{ generationRunId: "run-1", dedupeKey: "create-page:users", taskType: "CREATE_PAGE" }]
    });
    mocks.getDb.mockReturnValue(db);

    const result = await evaluateCoverage(run(), task());

    expect(result).toMatchObject({ ok: true, queuedTaskDedupeKeys: [], report: { counts: { queuedTasks: 0, routedGaps: 1, unroutedGaps: 0 } } });
    expect(db.tasks).toHaveLength(1);
  });

  it("enqueues UPDATE_PAGE for backend evidence with a frontend anchor on an existing page", async () => {
    const db = new FakeDb({
      evidence: [evidenceRow({ repositoryRole: "BACKEND", filePath: "app/api/users/route.ts" })],
      codeMaps: [codeMap([uiRoute("/users")])],
      pages: [{ workspaceId: "workspace-1", pageKey: "users" }]
    });
    mocks.getDb.mockReturnValue(db);

    const result = await evaluateCoverage(run(), task());

    expect(result).toMatchObject({ ok: true, queuedTaskDedupeKeys: ["update-page:users"], report: { counts: { routedGaps: 1, unroutedGaps: 0 } } });
    expect(db.tasks).toMatchObject([{ taskType: "UPDATE_PAGE", pageKey: "users", dedupeKey: "update-page:users" }]);
    expect(db.pageEvidence).toHaveLength(0);
  });

  it("writes EXCLUDED_NO_WIKI_VALUE for low-signal evidence", async () => {
    const db = new FakeDb({ evidence: [evidenceRow({ id: "ev-style", filePath: "app/users/styles.css", sourceKind: "STYLE" })] });
    mocks.getDb.mockReturnValue(db);

    const result = await evaluateCoverage(run(), task());

    expect(result).toMatchObject({ ok: true, report: { acceptable: true, counts: { routedGaps: 1, unroutedGaps: 0 } } });
    expect(db.pageEvidence).toMatchObject([{ evidenceId: "ev-style", coverageRole: "EXCLUDED_NO_WIKI_VALUE" }]);
  });

  it("writes NEEDS_REVIEW for backend-only/no-anchor evidence", async () => {
    const db = new FakeDb({ evidence: [evidenceRow({ repositoryRole: "BACKEND", filePath: "app/api/users/route.ts" })] });
    mocks.getDb.mockReturnValue(db);

    const result = await evaluateCoverage(run(), task());

    expect(result).toMatchObject({ ok: true, report: { acceptable: false, counts: { routedGaps: 1, unroutedGaps: 0 } } });
    expect(db.pageEvidence).toMatchObject([{ coverageRole: "NEEDS_REVIEW" }]);
    expect(db.debugEvents.some((event) => event.eventType === "COVERAGE_NEEDS_REVIEW")).toBe(true);
  });

  it("fails instead of silently skipping an unrouted frontend coverage gap", async () => {
    const db = new FakeDb({
      facts: [fact()],
      evidence: [evidenceRow()],
      codeMaps: [codeMap([uiRoute("/users")])],
      dropTaskInserts: true
    });
    mocks.getDb.mockReturnValue(db);

    const result = await evaluateCoverage(run(), task());

    expect(result).toEqual({ ok: false, errorMessage: "COVERAGE_GAP_UNROUTED" });
    expect(db.debugEvents.some((event) => event.eventType === "COVERAGE_GAP_UNROUTED")).toBe(true);
    expect(db.runs[0].coverageReportJson).toBeNull();
  });

  it("rerunning evaluator does not create new fingerprint churn from negative rows", async () => {
    const db = new FakeDb({ evidence: [evidenceRow({ repositoryRole: "BACKEND", filePath: "app/api/users/route.ts" })] });
    mocks.getDb.mockReturnValue(db);

    const first = await evaluateCoverage(run(), task({ id: "task-1" }));
    const second = await evaluateCoverage(run(), task({ id: "task-2" }));

    expect(first.ok && second.ok && first.report.fingerprint).toBe(second.ok && second.report.fingerprint);
    expect(second).toMatchObject({ ok: true, report: { acceptable: true, counts: { reviewGaps: 0, terminalNegativeCoverage: 1, uncovered: 0 } } });
    expect(db.pageEvidence).toHaveLength(1);
  });

  it("PRIMARY/SUPPORTING override stale negative rows for the same evidence/fact", async () => {
    const db = new FakeDb({
      facts: [fact()],
      evidence: [evidenceRow()],
      pageEvidence: [pageEvidence({ coverageRole: "NEEDS_REVIEW" }), pageEvidence({ id: "wpe-positive", coverageRole: "SUPPORTING" })]
    });
    mocks.getDb.mockReturnValue(db);

    const result = await evaluateCoverage(run(), task());

    expect(result).toMatchObject({ ok: true, report: { acceptable: true, counts: { positiveCoverage: 1, terminalNegativeCoverage: 0, uncovered: 0 } } });
    expect(db.tasks).toHaveLength(0);
  });
});

function run(): any {
  return { id: "run-1", workspaceId: "workspace-1", frontendRepositoryId: "repo-fe", coverageReportJson: null };
}

function task(overrides: Partial<Record<string, unknown>> = {}): any {
  return { id: "task-1", generationRunId: "run-1", workspaceId: "workspace-1", taskType: "EVALUATE_COVERAGE", ...overrides };
}

function fact() {
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
    confidence: 0.9
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
    sourceTaskId: "old-task",
    coverageRole: "PRIMARY",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides
  };
}

function codeMap(nodes: unknown[]) {
  return { generationRunId: "run-1", mapJson: { nodes } };
}

function uiRoute(path: string) {
  return {
    stableKey: `node:${path}`,
    kind: "UI_ROUTE",
    repositoryRole: "FRONTEND",
    repositoryFullName: "acme/web",
    label: path,
    filePath: "app/users/page.tsx",
    metadata: { path },
    evidenceIds: ["evidence-1"]
  };
}

class FakeDb {
  runs = [run()];
  codeMaps: any[];
  facts: any[];
  evidence: any[];
  pageEvidence: any[];
  pages: any[];
  tasks: any[] = [];
  debugEvents: any[] = [];

  dropTaskInserts: boolean;
  dropPageEvidenceInserts: boolean;

  constructor(input: { codeMaps?: any[]; facts?: any[]; evidence?: any[]; pageEvidence?: any[]; pages?: any[]; tasks?: any[]; debugEvents?: any[]; dropTaskInserts?: boolean; dropPageEvidenceInserts?: boolean }) {
    this.codeMaps = input.codeMaps ?? [];
    this.facts = input.facts ?? [];
    this.evidence = input.evidence ?? [];
    this.pageEvidence = input.pageEvidence ?? [];
    this.pages = input.pages ?? [];
    this.tasks = input.tasks ?? [];
    this.debugEvents = input.debugEvents ?? [];
    this.dropTaskInserts = input.dropTaskInserts ?? false;
    this.dropPageEvidenceInserts = input.dropPageEvidenceInserts ?? false;
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
    if (table === mocks.wikiPageEvidence) return this.pageEvidence;
    if (table === mocks.wikiPages) return this.pages;
    if (table === mocks.generationDebugEvents) return this.debugEvents;
    return [];
  }
}

class SelectBuilder {
  private table: unknown;
  private condition: unknown;

  constructor(private db: FakeDb) {}

  from(table: unknown) {
    this.table = table;
    return this;
  }

  where(condition: unknown) {
    this.condition = condition;
    return this;
  }

  then(resolve: (value: any[]) => unknown, reject: (reason: unknown) => unknown) {
    return Promise.resolve(this.db.rows(this.table).filter((row) => matches(row, this.condition))).then(resolve, reject);
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

  values(value: Record<string, unknown>) {
    const rows = Array.isArray(value) ? value : [value];
    const run = async () => {
      const inserted: Record<string, unknown>[] = [];
      if (this.table === mocks.generationTasks) {
        if (this.db.dropTaskInserts) return inserted;
        for (const row of rows) {
          if (!this.db.tasks.some((task) => task.generationRunId === row.generationRunId && task.dedupeKey === row.dedupeKey)) {
            this.db.tasks.push(row);
            inserted.push(row);
          }
        }
      }
      if (this.table === mocks.wikiPageEvidence) {
        if (this.db.dropPageEvidenceInserts) return inserted;
        for (const row of rows) {
          if (!this.db.pageEvidence.some((item) => item.id === row.id)) {
            this.db.pageEvidence.push(row);
            inserted.push(row);
          }
        }
      }
      if (this.table === mocks.generationDebugEvents) {
        this.db.debugEvents.push(...rows);
        inserted.push(...rows);
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
  if (condition.type === "eq") return row[columnName(condition.field)] === condition.value;
  return true;
}

function columnName(field: string) {
  return field.split(".").pop()?.replace(/_([a-z])/g, (_, char) => char.toUpperCase()) ?? field;
}
