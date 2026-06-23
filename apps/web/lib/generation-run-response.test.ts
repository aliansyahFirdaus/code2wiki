import { describe, expect, it } from "vitest";

import { toGenerationRunResponse } from "./generation-run-response";

describe("toGenerationRunResponse", () => {
  it("does not swap frontend and backend coverage fields", () => {
    const response = toGenerationRunResponse(
      {
        id: "run",
        workspaceId: "workspace",
        frontendRepositoryId: "frontend-repo",
        backendRepositoryId: "backend-repo",
        frontendTag: "fe-v1",
        frontendCommitSha: "fe-sha",
        backendTag: "be-v1",
        backendCommitSha: "be-sha",
        status: "COMPLETED",
        totalEligibleFiles: 30,
        indexedEligibleFiles: 27,
        frontendTotalEligibleFiles: 10,
        frontendIndexedEligibleFiles: 9,
        backendTotalEligibleFiles: 20,
        backendIndexedEligibleFiles: 18,
        generatedStatementCount: 3,
        generatedStatementWithEvidenceCount: 2,
        qualityReportJson: null,
        aiUsageJson: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z")
      },
      []
    );

    expect(response.frontendTotalEligibleFiles).toBe(10);
    expect(response.frontendIndexedEligibleFiles).toBe(9);
    expect(response.backendTotalEligibleFiles).toBe(20);
    expect(response.backendIndexedEligibleFiles).toBe(18);
  });

  it("exposes only quality and AI usage summary fields", () => {
    const response = toGenerationRunResponse(
      {
        id: "run",
        workspaceId: "workspace",
        frontendRepositoryId: "frontend-repo",
        backendRepositoryId: "backend-repo",
        frontendTag: "fe-v1",
        frontendCommitSha: "fe-sha",
        backendTag: "be-v1",
        backendCommitSha: "be-sha",
        status: "COMPLETED",
        totalEligibleFiles: 0,
        indexedEligibleFiles: 0,
        frontendTotalEligibleFiles: 0,
        frontendIndexedEligibleFiles: 0,
        backendTotalEligibleFiles: 0,
        backendIndexedEligibleFiles: 0,
        generatedStatementCount: 0,
        generatedStatementWithEvidenceCount: 0,
        qualityReportJson: {
          gateResult: "WARN",
          issues: [
            { severity: "WARN", code: "LOW_STATEMENT_COUNT", message: "Low statement count." },
            { severity: "ERROR", code: "EMPTY_PAGE", message: "Empty page." }
          ],
          metrics: [{ name: "raw", value: 1 }]
        },
        aiUsageJson: {
          calls: [{ raw: "hidden" }],
          summary: {
            callCount: 1,
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            estimatedCostUsdMicros: 42,
            pricingSource: "env"
          }
        },
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z")
      },
      []
    );

    expect(response.qualityGateResult).toBe("WARN");
    expect(response.qualityIssueCounts).toEqual({ error: 1, warn: 1 });
    expect(response.aiUsageSummary).toEqual({
      callCount: 1,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      estimatedCostUsdMicros: 42,
      pricingSource: "env"
    });
    expect(response).not.toHaveProperty("qualityReportJson");
    expect(response).not.toHaveProperty("aiUsageJson");
  });
});
