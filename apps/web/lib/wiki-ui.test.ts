import { describe, expect, it } from "vitest";

import { groupEvidenceByRoleAndFile, pageStatusLabel } from "./wiki-ui";

describe("wiki ui helpers", () => {
  it("maps page generation labels without backend lookups", () => {
    expect(pageStatusLabel({ generationStrategy: "CREATE_PAGE" })).toBe("Create Page");
    expect(pageStatusLabel({ generationStrategy: "UPDATE_PAGE", reusedFromGenerationRunId: "run-old" })).toBe("Reused");
    expect(pageStatusLabel({ generationStrategy: null })).toBe("Generated");
  });

  it("groups evidence by role and file with a simple missing-data fallback", () => {
    const groups = groupEvidenceByRoleAndFile([
      { id: "1", repositoryRole: "FRONTEND", filePath: "app/page.tsx" },
      { id: "2", repositoryRole: "FRONTEND", filePath: "app/page.tsx" },
      { id: "3", repositoryRole: "BACKEND", filePath: "api/users.ts" },
      { id: "4", repositoryRole: null, filePath: null }
    ]);

    expect(groups).toEqual([
      { role: "FRONTEND", files: [{ filePath: "app/page.tsx", items: [expect.objectContaining({ id: "1" }), expect.objectContaining({ id: "2" })] }] },
      { role: "BACKEND", files: [{ filePath: "api/users.ts", items: [expect.objectContaining({ id: "3" })] }] },
      { role: "Ungrouped", files: [{ filePath: "Unknown file", items: [expect.objectContaining({ id: "4" })] }] }
    ]);
  });
});
