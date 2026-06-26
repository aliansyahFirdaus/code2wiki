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
        executionMode: "AUTO",
        controlState: "ACTIVE",
        advanceRequestedAt: null,
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
        incrementalReportJson: null,
        coverageReportJson: null,
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
        executionMode: "MANUAL",
        controlState: "ACTIVE",
        advanceRequestedAt: new Date("2026-01-02T00:00:00Z"),
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
            provider: "nvidia",
            model: "meta/llama-3.1-8b-instruct",
            callCount: 1,
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            estimatedCostUsdMicros: 42,
            pricingSource: "env"
          }
        },
        incrementalReportJson: {
          version: 1,
          baselineGenerationRunId: "run-old",
          mode: "PARTIAL",
          generatedPageCount: 1,
          reusedPageCount: 2,
          affectedPageKeys: ["crew.add"],
          reusedPageKeys: ["crew.list", "crew.detail"],
          reuseMissReasons: { "crew.add": "input_hash_mismatch" },
          aiRequestCountSavedEstimate: 0,
          pageInputHashVersion: "page-input-v1"
        },
        coverageReportJson: {
          acceptable: false,
          counts: { facts: 1, evidence: 2, positiveCoverage: 1, terminalNegativeCoverage: 0, uncovered: 1, queuedTasks: 0, reviewGaps: 1 },
          gaps: [{ disposition: "NEEDS_REVIEW", pageKey: "users", evidenceId: "ev-1", factId: "fact-1", reason: "NO_FRONTEND_ANCHOR", summary: "hidden", codeSnippet: "hidden" }]
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
    expect(response.qualityIssues).toEqual([
      { severity: "WARN", code: "LOW_STATEMENT_COUNT", message: "Low statement count." },
      { severity: "ERROR", code: "EMPTY_PAGE", message: "Empty page." }
    ]);
    expect(response.aiUsageSummary).toEqual({
      provider: "nvidia",
      model: "meta/llama-3.1-8b-instruct",
      callCount: 1,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      estimatedCostUsdMicros: 42,
      pricingSource: "env"
    });
    expect(response.incrementalSummary).toEqual({
      mode: "PARTIAL",
      baselineGenerationRunId: "run-old",
      generatedPageCount: 1,
      reusedPageCount: 2,
      affectedPageKeys: ["crew.add"],
      reusedPageKeys: ["crew.list", "crew.detail"],
      aiRequestCountSavedEstimate: 0,
      pageInputHashVersion: "page-input-v1"
    });
    expect(response.coverageSummary).toEqual({
      acceptable: false,
      counts: { facts: 1, evidence: 2, positiveCoverage: 1, terminalNegativeCoverage: 0, uncovered: 1, queuedTasks: 0, reviewGaps: 1 },
      gaps: [{ disposition: "NEEDS_REVIEW", pageKey: "users", evidenceId: "ev-1", factId: "fact-1", reason: "NO_FRONTEND_ANCHOR" }]
    });
    expect(response.executionMode).toBe("MANUAL");
    expect(response.controlState).toBe("ACTIVE");
    expect(response.advanceRequestedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(response).not.toHaveProperty("qualityReportJson");
    expect(response).not.toHaveProperty("aiUsageJson");
    expect(response).not.toHaveProperty("incrementalReportJson");
    expect(response).not.toHaveProperty("coverageReportJson");
  });
});
