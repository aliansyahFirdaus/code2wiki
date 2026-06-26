import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeCode } from "./analyze-code";

const mocks = vi.hoisted(() => ({
  scanCode: vi.fn(),
  buildCodeMap: vi.fn(),
  buildCodeSummaries: vi.fn(),
  getDb: vi.fn(),
  createGitHubInstallationAccessToken: vi.fn(),
  cloneRepositoryAtCommit: vi.fn(),
  emitDebugEvent: vi.fn(),
  codeMaps: { generationRunId: "code_maps.generation_run_id" },
  codeSummaries: {
    generationRunId: "code_summaries.generation_run_id",
    summaryType: "code_summaries.summary_type",
    cacheKey: "code_summaries.cache_key"
  }
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  asc: vi.fn((value: unknown) => value),
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  sql: vi.fn((strings: TemplateStringsArray) => ({ sql: strings.join("") }))
}));

vi.mock("@code2wiki/analyzer", () => ({
  buildCodeMap: mocks.buildCodeMap,
  buildCodeSummaries: mocks.buildCodeSummaries,
  scanCode: mocks.scanCode
}));

vi.mock("@code2wiki/db", () => ({
  codeFacts: { generationRunId: "code_facts.generation_run_id" },
  codeMaps: mocks.codeMaps,
  codeSummaries: mocks.codeSummaries,
  evidence: { generationRunId: "evidence.generation_run_id" },
  generationRuns: {
    id: "generation_runs.id",
    status: "generation_runs.status",
    controlState: "generation_runs.control_state"
  },
  getDb: mocks.getDb,
  repositories: {
    id: "repositories.id",
    active: "repositories.active"
  }
}));

vi.mock("@code2wiki/github", () => ({
  cloneRepositoryAtCommit: mocks.cloneRepositoryAtCommit,
  createGitHubInstallationAccessToken: mocks.createGitHubInstallationAccessToken
}));

vi.mock("./self-expanding-generation/debug-events", () => ({
  emitDebugEvent: mocks.emitDebugEvent
}));

describe("analyzeCode code map persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CODE2WIKI_SCAN_ROOTS;
    delete process.env.CODE2WIKI_FRONTEND_SCAN_ROOTS;
    delete process.env.CODE2WIKI_BACKEND_SCAN_ROOTS;
    delete process.env.CODE2WIKI_SCAN_MAX_FILES;
    delete process.env.CODE2WIKI_FRONTEND_SCAN_MAX_FILES;
    delete process.env.CODE2WIKI_BACKEND_SCAN_MAX_FILES;
  });

  afterEach(() => {
    delete process.env.CODE2WIKI_SCAN_ROOTS;
    delete process.env.CODE2WIKI_FRONTEND_SCAN_ROOTS;
    delete process.env.CODE2WIKI_BACKEND_SCAN_ROOTS;
    delete process.env.CODE2WIKI_SCAN_MAX_FILES;
    delete process.env.CODE2WIKI_FRONTEND_SCAN_MAX_FILES;
    delete process.env.CODE2WIKI_BACKEND_SCAN_MAX_FILES;
  });

  it("does not return scan warnings when scope env is unset", async () => {
    const db = {
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })) }))
    };
    mocks.getDb.mockReturnValue(db);

    await expect(analyzeCode("run-1")).resolves.not.toHaveProperty("scanWarnings");
  });

  it("upserts one code_maps row for the generation run", async () => {
    const run = {
      id: "run-1",
      frontendRepositoryId: "repo-fe",
      backendRepositoryId: "repo-be",
      frontendCommitSha: "fe-sha",
      backendCommitSha: "be-sha",
      frontendTag: "fe-v1",
      backendTag: "be-v1"
    };
    const frontendRepository = repository("repo-fe", "FRONTEND", "acme/web");
    const backendRepository = repository("repo-be", "BACKEND", "acme/api");
    const codeMap = { generationRunId: "run-1", sourceHash: "map-hash", nodes: [], edges: [] };
    const fileSummary = summary("FILE", "file-key");
    const moduleSummary = summary("MODULE", "module-key");
    const codeMapInserts: unknown[] = [];
    const summaryInserts: unknown[] = [];
    const upserts: unknown[] = [];

    mocks.buildCodeMap.mockReturnValue(codeMap);
    mocks.buildCodeSummaries.mockReturnValue({ fileSummaries: [fileSummary], moduleSummaries: [moduleSummary] });
    mocks.createGitHubInstallationAccessToken.mockResolvedValue({ token: "token" });
    mocks.cloneRepositoryAtCommit
      .mockResolvedValueOnce({ path: "/tmp/frontend", head: "fe-sha", cleanup: vi.fn() })
      .mockResolvedValueOnce({ path: "/tmp/backend", head: "be-sha", cleanup: vi.fn() });
    mocks.scanCode
      .mockResolvedValueOnce(scanResult("FRONTEND", "fe-evidence", "fe-fact"))
      .mockResolvedValueOnce(scanResult("BACKEND", "be-evidence", "be-fact"));

    const tx = {
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((value: unknown) => {
          if (table === mocks.codeMaps) {
            codeMapInserts.push(value);
            return {
              onConflictDoUpdate: vi.fn((config: unknown) => {
                upserts.push({ table: "codeMaps", config });
                return Promise.resolve();
              })
            };
          }
          if (table === mocks.codeSummaries) {
            summaryInserts.push(value);
            return {
              onConflictDoUpdate: vi.fn((config: unknown) => {
                upserts.push({ table: "codeSummaries", config });
                return Promise.resolve();
              })
            };
          }
          return Promise.resolve();
        })
      })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) }))
    };
    const db = {
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([run]) })) })) })),
      select: vi
        .fn()
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([frontendRepository]) })) })) })
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([backendRepository]) })) })) }),
      transaction: vi.fn((callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx))
    };
    mocks.getDb.mockReturnValue(db);

    const result = await analyzeCode("run-1");
    expect(result).toMatchObject({
      status: "facts_extracted",
      generationRunId: "run-1"
    });

    expect(mocks.scanCode).toHaveBeenNthCalledWith(1, {
      repositoryRole: "FRONTEND",
      repositoryRoot: "/tmp/frontend",
      includePaths: [],
      maxFiles: undefined,
      shouldStop: expect.any(Function)
    });
    expect(mocks.scanCode).toHaveBeenNthCalledWith(2, {
      repositoryRole: "BACKEND",
      repositoryRoot: "/tmp/backend",
      includePaths: [],
      maxFiles: undefined,
      shouldStop: expect.any(Function)
    });
    expect(codeMapInserts).toHaveLength(1);
    expect(codeMapInserts[0]).toMatchObject({
      id: "code_map_run-1",
      generationRunId: "run-1",
      sourceHash: "map-hash",
      mapJson: codeMap
    });
    expect(upserts).toHaveLength(2);
    expect(upserts).toEqual(expect.arrayContaining([expect.objectContaining({ table: "codeMaps", config: expect.objectContaining({ target: mocks.codeMaps.generationRunId }) })]));
    expect(summaryInserts).toHaveLength(1);
    expect(summaryInserts[0]).toHaveLength(2);
    expect(upserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "codeSummaries",
          config: expect.objectContaining({
            target: [mocks.codeSummaries.generationRunId, mocks.codeSummaries.summaryType, mocks.codeSummaries.cacheKey]
          })
        })
      ])
    );
    expect(mocks.emitDebugEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "ANALYZE_STARTED", stage: "analyze" }));
    expect(mocks.emitDebugEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "ANALYZE_DONE",
      stage: "analyze",
      payload: expect.objectContaining({
        scanScope: expect.objectContaining({ envGuardActive: false, maxFilesGuardActive: false }),
        files: {
          frontend: expect.objectContaining({ eligibleFiles: ["app/page.tsx"], ignoredFiles: [{ filePath: "README.md", reason: "outside scan roots" }] }),
          backend: expect.objectContaining({ eligibleFiles: ["app/api/users/route.ts"] })
        }
      })
    }));
  });

  it("passes env scan roots and max files into scanner", async () => {
    process.env.CODE2WIKI_FRONTEND_SCAN_ROOTS = "src/app/(home)/payroll, /src/app/payroll";
    process.env.CODE2WIKI_BACKEND_SCAN_ROOTS = "internal/handler/gin/route";
    process.env.CODE2WIKI_FRONTEND_SCAN_MAX_FILES = "40";
    process.env.CODE2WIKI_BACKEND_SCAN_MAX_FILES = "10";
    const run = {
      id: "run-1",
      frontendRepositoryId: "repo-fe",
      backendRepositoryId: "repo-be",
      frontendCommitSha: "fe-sha",
      backendCommitSha: "be-sha",
      frontendTag: "fe-v1",
      backendTag: "be-v1"
    };
    const frontendRepository = repository("repo-fe", "FRONTEND", "acme/web");
    const backendRepository = repository("repo-be", "BACKEND", "acme/api");
    const tx = {
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) }))
    };
    const db = {
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([run]) })) })) })),
      select: vi
        .fn()
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([frontendRepository]) })) })) })
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([backendRepository]) })) })) }),
      transaction: vi.fn((callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx))
    };

    mocks.getDb.mockReturnValue(db);
    mocks.createGitHubInstallationAccessToken.mockResolvedValue({ token: "token" });
    mocks.cloneRepositoryAtCommit
      .mockResolvedValueOnce({ path: "/tmp/frontend", head: "fe-sha", cleanup: vi.fn() })
      .mockResolvedValueOnce({ path: "/tmp/backend", head: "be-sha", cleanup: vi.fn() });
    mocks.scanCode
      .mockResolvedValueOnce(emptyScanResult())
      .mockResolvedValueOnce(emptyScanResult());

    const result = await analyzeCode("run-1");

    expect(result).toMatchObject({
      status: "failed",
      errorMessage: "NO_ELIGIBLE_FILES",
      scanWarnings: [
        "SCAN_ROOTS_ACTIVE: generation is scoped to FE roots [src/app/(home)/payroll, src/app/payroll] and BE roots [internal/handler/gin/route]; coverage is not full-repository coverage.",
        "SCAN_MAX_FILES_ACTIVE: generation indexes at most FE 40 files and BE 10 files; coverage is capped."
      ]
    });
    expect(mocks.scanCode).toHaveBeenNthCalledWith(1, {
      repositoryRole: "FRONTEND",
      repositoryRoot: "/tmp/frontend",
      includePaths: ["src/app/(home)/payroll", "src/app/payroll"],
      maxFiles: 40,
      shouldStop: expect.any(Function)
    });
    expect(mocks.scanCode).toHaveBeenNthCalledWith(2, {
      repositoryRole: "BACKEND",
      repositoryRoot: "/tmp/backend",
      includePaths: ["internal/handler/gin/route"],
      maxFiles: 10,
      shouldStop: expect.any(Function)
    });
    expect(mocks.emitDebugEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "ANALYZE_FAILED",
      payload: expect.objectContaining({
        scanScope: expect.objectContaining({
          envGuardActive: true,
          maxFilesGuardActive: true,
          frontend: { includePaths: ["src/app/(home)/payroll", "src/app/payroll"], maxFiles: 40 },
          backend: { includePaths: ["internal/handler/gin/route"], maxFiles: 10 }
        }),
        files: expect.objectContaining({
          frontend: expect.objectContaining({ eligibleCount: 0, ignoredCount: 1 })
        })
      })
    }));
  });
});

function repository(id: string, role: "FRONTEND" | "BACKEND", repositoryFullName: string) {
  return {
    id,
    role,
    repositoryFullName,
    owner: "acme",
    repo: role.toLowerCase(),
    githubInstallationId: `installation-${role}`
  };
}

function scanResult(repositoryRole: "FRONTEND" | "BACKEND", evidenceKey: string, factKey: string) {
  return {
    totalEligibleFiles: 1,
    indexedEligibleFiles: 1,
    eligibleFiles: [repositoryRole === "FRONTEND" ? "app/page.tsx" : "app/api/users/route.ts"],
    indexedFiles: [repositoryRole === "FRONTEND" ? "app/page.tsx" : "app/api/users/route.ts"],
    ignoredFiles: repositoryRole === "FRONTEND" ? [{ filePath: "README.md", reason: "outside scan roots" }] : [],
    evidence: [
      {
        evidenceKey,
        repositoryRole,
        filePath: repositoryRole === "FRONTEND" ? "app/page.tsx" : "app/api/users/route.ts",
        startLine: 1,
        endLine: 1,
        sourceKind: "ROUTE",
        summary: evidenceKey,
        codeSnippet: "export {}"
      }
    ],
    facts: [
      {
        factKey,
        factKind: repositoryRole === "FRONTEND" ? "ROUTE" : "API_ROUTE",
        text: repositoryRole === "FRONTEND" ? "Frontend route /users" : "Backend API route /api/users",
        evidenceKeys: [evidenceKey],
        confidence: 0.95
      }
    ]
  };
}

function emptyScanResult() {
  return {
    totalEligibleFiles: 0,
    indexedEligibleFiles: 0,
    eligibleFiles: [],
    indexedFiles: [],
    ignoredFiles: [{ filePath: "src/app/outside/page.tsx", reason: "outside scan roots" }],
    evidence: [],
    facts: []
  };
}

function summary(type: "FILE" | "MODULE", cacheKey: string) {
  return {
    type,
    cacheKey,
    sourceHash: `${cacheKey}-source`,
    inputHash: `${cacheKey}-input`,
    outputHash: `${cacheKey}-output`,
    confidence: "HIGH",
    claims: [{ text: cacheKey, kind: "ROUTE", confidence: "HIGH", evidenceIds: ["fe-evidence"], sourceNodeKeys: ["node"] }],
    evidenceIds: ["fe-evidence"],
    sourceNodeKeys: ["node"],
    inputStats: {
      factCount: 1,
      evidenceCount: 1,
      nodeCount: 1,
      edgeCount: 0,
      truncated: false,
      omittedFactCount: 0,
      omittedEvidenceCount: 0
    },
    source: {
      generationRunId: "run-1",
      codeMapSourceHash: "map-hash",
      repositoryRole: "FRONTEND",
      repositoryFullName: "acme/web",
      commitSha: "fe-sha",
      ...(type === "FILE" ? { filePath: "app/page.tsx" } : { moduleKey: "module" })
    }
  };
}
