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
});
