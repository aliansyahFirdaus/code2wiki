import { beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeCode } from "./analyze-code";

const mocks = vi.hoisted(() => ({
  scanCode: vi.fn(),
  buildCodeMap: vi.fn(),
  getDb: vi.fn(),
  createGitHubInstallationAccessToken: vi.fn(),
  cloneRepositoryAtCommit: vi.fn(),
  codeMaps: { generationRunId: "code_maps.generation_run_id" }
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  asc: vi.fn((value: unknown) => value),
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right }))
}));

vi.mock("@code2wiki/analyzer", () => ({
  buildCodeMap: mocks.buildCodeMap,
  scanCode: mocks.scanCode
}));

vi.mock("@code2wiki/db", () => ({
  codeFacts: { generationRunId: "code_facts.generation_run_id" },
  codeMaps: mocks.codeMaps,
  evidence: { generationRunId: "evidence.generation_run_id" },
  generationRuns: {
    id: "generation_runs.id",
    status: "generation_runs.status"
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

describe("analyzeCode code map persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    const codeMapInserts: unknown[] = [];
    const upserts: unknown[] = [];

    mocks.buildCodeMap.mockReturnValue(codeMap);
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
                upserts.push(config);
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

    await expect(analyzeCode("run-1")).resolves.toMatchObject({ status: "facts_extracted", generationRunId: "run-1" });

    expect(codeMapInserts).toHaveLength(1);
    expect(codeMapInserts[0]).toMatchObject({
      id: "code_map_run-1",
      generationRunId: "run-1",
      sourceHash: "map-hash",
      mapJson: codeMap
    });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ target: mocks.codeMaps.generationRunId });
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
