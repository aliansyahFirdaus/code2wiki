import { describe, expect, it, vi } from "vitest";

import { PATCH } from "./route";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  materializationCountsByGenerationRun: vi.fn(),
  pagesByGenerationRun: vi.fn()
}));

vi.mock("@code2wiki/db", () => ({
  generationRuns: { id: "id" },
  getDb: mocks.getDb
}));

vi.mock("../../../../lib/run-pages", () => ({
  materializationCountsByGenerationRun: mocks.materializationCountsByGenerationRun,
  pagesByGenerationRun: mocks.pagesByGenerationRun
}));

describe("generation run route", () => {
  it("updates execution mode and returns the refreshed run", async () => {
    const returning = vi.fn().mockResolvedValue([{
      id: "run-1",
      workspaceId: "demo",
      frontendRepositoryId: "repo-fe",
      backendRepositoryId: "repo-be",
      frontendTag: "fe-v1",
      frontendCommitSha: "a".repeat(40),
      backendTag: "be-v1",
      backendCommitSha: "b".repeat(40),
      status: "QUEUED",
      executionMode: "MANUAL",
      controlState: "ACTIVE",
      advanceRequestedAt: null,
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
      createdAt: new Date("2026-06-26T00:00:00Z")
    }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    mocks.getDb.mockReturnValue({ update: vi.fn(() => ({ set })) });
    mocks.pagesByGenerationRun.mockResolvedValue(new Map([["run-1", []]]));
    mocks.materializationCountsByGenerationRun.mockResolvedValue(new Map([["run-1", { written: 0, reused: 0 }]]));

    const response = await PATCH(new Request("http://test.local/api/generation-runs/run-1", {
      method: "PATCH",
      body: JSON.stringify({ executionMode: "MANUAL" })
    }), { params: Promise.resolve({ id: "run-1" }) });

    expect(response.status).toBe(200);
    expect(set).toHaveBeenCalledWith({ executionMode: "MANUAL", advanceRequestedAt: undefined });
    expect((await response.json()).generationRun).toMatchObject({
      id: "run-1",
      executionMode: "MANUAL",
      controlState: "ACTIVE",
      advanceRequestedAt: null
    });
  });

  it("rejects invalid execution mode", async () => {
    const response = await PATCH(new Request("http://test.local/api/generation-runs/run-1", {
      method: "PATCH",
      body: JSON.stringify({ executionMode: "LATER" })
    }), { params: Promise.resolve({ id: "run-1" }) });

    expect(response.status).toBe(400);
  });
});
