import { describe, expect, it } from "vitest";

import { assertGenerationRepositoryRoles, mapScanCoverage } from "./role-mapping";

describe("role mapping", () => {
  it("maps frontend scan coverage to frontend fields", () => {
    expect(mapScanCoverage([{ repositoryRole: "FRONTEND", totalEligibleFiles: 7, indexedEligibleFiles: 6 }])).toMatchObject({
      frontendTotalEligibleFiles: 7,
      frontendIndexedEligibleFiles: 6,
      backendTotalEligibleFiles: 0,
      backendIndexedEligibleFiles: 0
    });
  });

  it("maps backend scan coverage to backend fields", () => {
    expect(mapScanCoverage([{ repositoryRole: "BACKEND", totalEligibleFiles: 11, indexedEligibleFiles: 10 }])).toMatchObject({
      frontendTotalEligibleFiles: 0,
      frontendIndexedEligibleFiles: 0,
      backendTotalEligibleFiles: 11,
      backendIndexedEligibleFiles: 10
    });
  });

  it("rejects swapped generation run repository ids", () => {
    expect(() =>
      assertGenerationRepositoryRoles(
        { id: "repo-a", role: "BACKEND" },
        { id: "repo-b", role: "FRONTEND" }
      )
    ).toThrow("frontendRepositoryId repo-a resolved to BACKEND.");
  });
});
