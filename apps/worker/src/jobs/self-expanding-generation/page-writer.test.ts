import { beforeEach, describe, expect, it, vi } from "vitest";

import { writePageTask } from "./page-writer";

const mocks = vi.hoisted(() => ({
  createAIProvider: vi.fn(),
  buildRetrievalContexts: vi.fn(),
  getDb: vi.fn(),
  codeFacts: { generationRunId: "code_facts.generation_run_id" },
  codeMaps: { generationRunId: "code_maps.generation_run_id" },
  codeSummaries: { generationRunId: "code_summaries.generation_run_id" },
  evidence: { generationRunId: "evidence.generation_run_id" },
  generationRuns: { id: "generation_runs.id" },
  generationDebugEvents: { id: "generation_debug_events.id" },
  generationTasks: {},
  wikiBlocks: { pageId: "wiki_blocks.page_id", generationRunId: "wiki_blocks.generation_run_id" },
  wikiPageEvidence: {
    generationRunId: "wiki_page_evidence.generation_run_id",
    pageKey: "wiki_page_evidence.page_key"
  },
  wikiPages: {
    id: "wiki_pages.id",
    workspaceId: "wiki_pages.workspace_id",
    pageKey: "wiki_pages.page_key"
  },
  wikiRunPages: {
    generationRunId: "wiki_run_pages.generation_run_id",
    pageKey: "wiki_run_pages.page_key"
  }
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => ({ type: "and", conditions })),
  eq: vi.fn((field: string, value: unknown) => ({ type: "eq", field, value })),
  sql: vi.fn(() => ({ type: "sql" }))
}));

vi.mock("@code2wiki/analyzer", () => ({
  buildRetrievalContexts: mocks.buildRetrievalContexts
}));

vi.mock("@code2wiki/db", () => ({
  codeFacts: mocks.codeFacts,
  codeMaps: mocks.codeMaps,
  codeSummaries: mocks.codeSummaries,
  evidence: mocks.evidence,
  generationRuns: mocks.generationRuns,
  generationDebugEvents: mocks.generationDebugEvents,
  generationTasks: mocks.generationTasks,
  getDb: mocks.getDb,
  wikiBlocks: mocks.wikiBlocks,
  wikiPageEvidence: mocks.wikiPageEvidence,
  wikiPages: mocks.wikiPages,
  wikiRunPages: mocks.wikiRunPages
}));

vi.mock("@code2wiki/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@code2wiki/ai")>();
  return {
    ...actual,
    createAIProvider: mocks.createAIProvider,
    resolveAIProviderConfig: vi.fn(() => ({ provider: "openrouter", model: "test-model" }))
  };
});

describe("page writer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildRetrievalContexts.mockReturnValue({ contexts: [], usedFallback: true, retrievalWarnings: [], sourceHash: "fallback" });
    mocks.createAIProvider.mockReturnValue({
      generateProductWiki: vi.fn().mockResolvedValue({
        output: {
          pages: [
            {
              pageKey: "users",
              title: "Users",
              blocks: [
                {
                  type: "statement",
                  text: "Users can be created after the required name is provided.",
                  evidenceIds: ["ev-1"],
                  confidence: 0.9
                },
                {
                  type: "statement",
                  text: "Saved users become available to the team.",
                  evidenceIds: ["ev-1"],
                  confidence: 0.9
                }
              ]
            }
          ]
        },
        usage: {
          provider: "openrouter",
          model: "test-model",
          promptTokenEstimate: 10,
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          inputCharCount: 100,
          outputCharCount: 100
        }
      })
    });
  });

  it("writes page, blocks, page evidence, and run metadata", async () => {
    const db = new FakeDb({
      runs: [run()],
      facts: [fact()],
      evidence: [evidenceRow()]
    });
    mocks.getDb.mockReturnValue(db);

    const result = await writePageTask(run(), task("CREATE_PAGE"));

    expect(result).toMatchObject({ ok: true, pageKey: "users", generatedStatementCount: 2, generatedStatementWithEvidenceCount: 2 });
    expect(db.pages).toMatchObject([{ pageKey: "users", generationRunId: "run-1", title: "Users" }]);
    expect(db.blocks).toHaveLength(2);
    expect(db.blocks.every((block) => block.generationRunId === "run-1" && block.evidenceIds.includes("ev-1"))).toBe(true);
    expect(db.pageEvidence).toMatchObject([{ generationRunId: "run-1", pageKey: "users", evidenceId: "ev-1", factId: "fact-1", sourceTaskId: "task-1", coverageRole: "PRIMARY" }]);
    expect(db.runs[0]).toMatchObject({
      generatedStatementCount: 2,
      generatedStatementWithEvidenceCount: 2,
      qualityReportJson: expect.objectContaining({ gateResult: "PASS" }),
      aiUsageJson: expect.objectContaining({ summary: expect.objectContaining({ callCount: 1 }) })
    });
    expect(mocks.createAIProvider.mock.results[0].value.generateProductWiki.mock.calls[0][0].pageGroups[0].evidence[0]).toMatchObject({
      id: "ev-1",
      codeSnippet: "name required"
    });
    expect(db.debugEvents.map((event) => event.eventType)).toEqual(["AI_PAGE_WRITE_STARTED", "PAGE_WRITTEN"]);
  });

  it("updates existing pages using the stored page id", async () => {
    const db = new FakeDb({
      runs: [run()],
      facts: [fact()],
      evidence: [evidenceRow()],
      pages: [{ id: "legacy-page-id", workspaceId: "workspace-1", generationRunId: "old-run", pageKey: "users", title: "Old Users", slug: "users", generationStrategy: "CREATE_PAGE" }],
      blocks: [{ ...oldBlock(), pageId: "legacy-page-id" }]
    });
    mocks.getDb.mockReturnValue(db);

    const result = await writePageTask(run(), task("UPDATE_PAGE"));

    expect(result).toMatchObject({ ok: true, pageKey: "users" });
    expect(db.pages).toMatchObject([{ id: "legacy-page-id", generationRunId: "run-1", title: "Users" }]);
    expect(db.blocks).toHaveLength(2);
    expect(db.blocks.every((block) => block.pageId === "legacy-page-id")).toBe(true);
    expect(db.blocks.some((block) => block.id === "old-block")).toBe(false);
  });

  it("falls back to synthetic facts when retrieval has evidence but no facts", async () => {
    const db = new FakeDb({
      runs: [run()],
      facts: [],
      evidence: [evidenceRow()]
    });
    mocks.getDb.mockReturnValue(db);
    mocks.buildRetrievalContexts.mockReturnValue({
      contexts: [{ pageKey: "users", facts: [], evidence: [{ id: "ev-1" }] }],
      usedFallback: false,
      retrievalWarnings: [],
      sourceHash: "retrieval"
    });

    const result = await writePageTask(run(), task("CREATE_PAGE"));

    expect(result).toMatchObject({ ok: true, pageKey: "users" });
    expect(db.pageEvidence).toMatchObject([{ factId: expect.stringMatching(/^synthetic_/) }]);
  });

  it("repairs thin internal-module output before persisting", async () => {
    const db = new FakeDb({
      runs: [run()],
      facts: [fact({ evidenceIds: ["ev-1", "ev-2", "ev-3"] })],
      evidence: [
        evidenceRow({ id: "ev-1", summary: "User creation requires a name." }),
        evidenceRow({ id: "ev-2", summary: "Saved users become available to the team." }),
        evidenceRow({ id: "ev-3", summary: "Users can be reviewed after creation." })
      ]
    });
    const provider = {
      generateProductWiki: vi.fn()
        .mockResolvedValueOnce({
          output: {
            pages: [
              {
                pageKey: "users",
                title: "Users",
                blocks: [{ type: "statement", text: "Users can be created after the required name is provided.", evidenceIds: ["ev-1"], confidence: 0.9 }]
              }
            ]
          },
          usage: usage()
        })
        .mockResolvedValueOnce({
          output: {
            pages: [
              {
                pageKey: "users",
                title: "Users",
                blocks: [
                  { type: "heading", text: "Ringkasan", level: 2 },
                  { type: "statement", text: "Users can be created after the required name is provided.", evidenceIds: ["ev-1"], confidence: 0.9 },
                  { type: "heading", text: "Siapa Yang Menggunakan Modul Ini", level: 2 },
                  { type: "statement", text: "Saved users become available to the team.", evidenceIds: ["ev-2"], confidence: 0.9 },
                  { type: "heading", text: "Alur Kerja Utama", level: 2 },
                  { type: "statement", text: "Users can be reviewed after creation.", evidenceIds: ["ev-3"], confidence: 0.9 }
                ]
              }
            ]
          },
          usage: usage()
        })
    };
    mocks.getDb.mockReturnValue(db);
    mocks.createAIProvider.mockReturnValue(provider);

    const result = await writePageTask(run(), task("CREATE_PAGE", { payloadJson: { evidenceIds: ["ev-1", "ev-2", "ev-3"] } }));

    expect(result).toMatchObject({ ok: true, generatedStatementCount: 3, generatedStatementWithEvidenceCount: 3 });
    expect(provider.generateProductWiki).toHaveBeenCalledTimes(2);
    expect(provider.generateProductWiki.mock.calls[1][1].validationErrors).toEqual(expect.arrayContaining([expect.stringContaining("INTERNAL_MODULE_THIN_PAGE")]));
    expect(db.blocks).toHaveLength(6);
    expect(db.runs[0].aiUsageJson).toMatchObject({ summary: { callCount: 2 } });
    expect(db.debugEvents.map((event) => event.eventType)).toEqual(["AI_PAGE_WRITE_STARTED", "AI_PAGE_WRITE_REPAIR_STARTED", "PAGE_WRITTEN"]);
  });
});

function run() {
  return {
    id: "run-1",
    workspaceId: "workspace-1",
    frontendRepositoryId: "repo-fe",
    backendRepositoryId: "repo-be",
    frontendTag: "v1",
    frontendCommitSha: "sha-fe",
    backendTag: "v1",
    backendCommitSha: "sha-be",
    status: "AI_GENERATING" as const,
    totalEligibleFiles: 0,
    indexedEligibleFiles: 0,
    frontendTotalEligibleFiles: 0,
    frontendIndexedEligibleFiles: 0,
    backendTotalEligibleFiles: 0,
    backendIndexedEligibleFiles: 0,
    generatedStatementCount: 0,
    generatedStatementWithEvidenceCount: 0,
    qualityReportJson: null,
    aiUsageJson: null,
    incrementalReportJson: null,
    coverageReportJson: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z")
  };
}

function task(taskType: "CREATE_PAGE" | "UPDATE_PAGE", overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "task-1",
    generationRunId: "run-1",
    workspaceId: "workspace-1",
    repositoryRole: "FRONTEND" as const,
    repositoryId: "repo-fe",
    taskType,
    status: "IN_PROGRESS" as const,
    branchState: null,
    priority: 100,
    pageKey: "users",
    parentTaskId: null,
    rootTaskId: null,
    dedupeKey: "create-page:users",
    reason: "test",
    payloadJson: { evidenceIds: ["ev-1"] },
    resultJson: null,
    attempts: 1,
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
    repositoryRole: "FRONTEND" as const,
    repositoryFullName: "acme/web",
    tag: "v1",
    commitSha: "sha-fe",
    factKind: "FORM",
    text: "Users can be created after name validation.",
    evidenceIds: ["ev-1"],
    confidence: 0.95,
    ...overrides
  };
}

function evidenceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ev-1",
    generationRunId: "run-1",
    repositoryRole: "FRONTEND" as const,
    repositoryFullName: "acme/web",
    tag: "v1",
    commitSha: "sha-fe",
    filePath: "app/users/page.tsx",
    startLine: 1,
    endLine: 4,
    sourceKind: "FORM",
    summary: "User creation requires a name.",
    codeSnippet: "name required",
    githubUrl: "https://github.com/acme/web/blob/sha/app/users/page.tsx#L1-L4",
    ...overrides
  };
}

function usage() {
  return {
    provider: "openrouter",
    model: "test-model",
    promptTokenEstimate: 10,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    inputCharCount: 100,
    outputCharCount: 100
  };
}

function oldBlock() {
  return {
    id: "old-block",
    generationRunId: "old-run",
    parentBlockId: null,
    stableKey: "old-block",
    type: "statement",
    position: 0,
    origin: "CODE",
    reviewState: "VERIFIED",
    sourceHash: "old",
    contentHash: "old",
    evidenceIds: ["ev-old"],
    blockJson: { text: "Old content." },
    locked: true,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z")
  };
}

class FakeDb {
  runs: any[];
  facts: any[];
  evidence: any[];
  codeMaps: any[];
  summaries: any[];
  pages: any[];
  blocks: any[];
  pageEvidence: any[];
  runPages: any[];
  debugEvents: any[];

  constructor(input: { runs?: any[]; facts?: any[]; evidence?: any[]; codeMaps?: any[]; summaries?: any[]; pages?: any[]; blocks?: any[]; pageEvidence?: any[]; runPages?: any[]; debugEvents?: any[] }) {
    this.runs = input.runs ?? [];
    this.facts = input.facts ?? [];
    this.evidence = input.evidence ?? [];
    this.codeMaps = input.codeMaps ?? [];
    this.summaries = input.summaries ?? [];
    this.pages = input.pages ?? [];
    this.blocks = input.blocks ?? [];
    this.pageEvidence = input.pageEvidence ?? [];
    this.runPages = input.runPages ?? [];
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

  delete(table: unknown) {
    return new DeleteBuilder(this, table);
  }

  rows(table: unknown) {
    if (table === mocks.generationRuns) return this.runs;
    if (table === mocks.codeFacts) return this.facts;
    if (table === mocks.evidence) return this.evidence;
    if (table === mocks.codeMaps) return this.codeMaps;
    if (table === mocks.codeSummaries) return this.summaries;
    if (table === mocks.wikiPages) return this.pages;
    if (table === mocks.wikiBlocks) return this.blocks;
    if (table === mocks.wikiPageEvidence) return this.pageEvidence;
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
      for (const row of rows) Object.assign(row, this.value);
      return rows;
    };
    return { returning: run, then: (resolve: (value: any[]) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject) };
  }
}

class InsertBuilder {
  constructor(private db: FakeDb, private table: unknown) {}

  values(value: Record<string, unknown> | Array<Record<string, unknown>>) {
    const rows = Array.isArray(value) ? value : [value];
    const run = async () => {
      this.db.rows(this.table).push(...rows);
    };
    return {
      onConflictDoUpdate: () => run(),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject)
    };
  }
}

class DeleteBuilder {
  constructor(private db: FakeDb, private table: unknown) {}

  where(condition: unknown) {
    const run = async () => {
      const rows = this.db.rows(this.table);
      const kept = rows.filter((row) => !matches(row, condition));
      rows.splice(0, rows.length, ...kept);
    };
    return { then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject) };
  }
}

function matches(row: Record<string, unknown>, condition: any): boolean {
  if (!condition) return true;
  if (condition.type === "and") return condition.conditions.every((item: unknown) => matches(row, item));
  if (condition.type === "eq") return row[columnName(condition.field)] === condition.value;
  if (condition.type === "inArray") return condition.values.includes(row[columnName(condition.field)]);
  return true;
}

function columnName(field: string) {
  return field.split(".").pop()?.replace(/_([a-z])/g, (_, char) => char.toUpperCase()) ?? field;
}
