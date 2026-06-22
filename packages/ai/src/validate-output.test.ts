import { describe, expect, it } from "vitest";

import { ProductWikiValidationError, validateProductWikiOutput } from "./validate-output";

const baseInput = {
  generationRunId: "run_1",
  allowedPageKeys: ["crew.add"],
  validEvidenceIds: ["ev_1", "ev_2"]
};

describe("validateProductWikiOutput", () => {
  it("rejects freeform output and invented page keys", () => {
    expect(() => validateProductWikiOutput({ ...baseInput, output: "markdown text" })).toThrow(ProductWikiValidationError);
    expect(() =>
      validateProductWikiOutput({
        ...baseInput,
        output: {
          pages: [{ pageKey: "invented.page", title: "Invented", blocks: [] }]
        }
      })
    ).toThrow(/not allowed/);
  });

  it("rejects CODE statements without valid same-run evidence", () => {
    expect(() =>
      validateProductWikiOutput({
        ...baseInput,
        output: {
          pages: [
            {
              pageKey: "crew.add",
              title: "Add Crew",
              blocks: [{ type: "statement", text: "Crew can be added.", evidenceIds: ["ev_missing"] }]
            }
          ]
        }
      })
    ).toThrow(/missing valid evidence/);
  });

  it("normalizes authoritative block metadata locally", () => {
    const result = validateProductWikiOutput({
      ...baseInput,
      output: {
        pages: [
          {
            pageKey: "crew.add",
            title: "Add Crew",
            blocks: [
              {
                id: "ai_id",
                stableKey: "ai_stable",
                sourceHash: "ai_source",
                contentHash: "ai_content",
                locked: false,
                origin: "MANUAL",
                reviewState: "OPEN_QUESTION",
                type: "statement",
                text: "After saving, the user remains on the add crew page.",
                confidence: 0.91,
                evidenceIds: ["ev_1"]
              }
            ]
          }
        ]
      }
    });

    const block = result.pages[0].blocks[0];
    expect(block.id).not.toBe("ai_id");
    expect(block.stableKey).not.toBe("ai_stable");
    expect(block.sourceHash).not.toBe("ai_source");
    expect(block.contentHash).not.toBe("ai_content");
    expect(block.locked).toBe(true);
    expect(block.origin).toBe("CODE");
    expect(block.reviewState).toBe("VERIFIED");
    expect(block.type).toBe("statement");
    expect(block.evidenceIds).toEqual(["ev_1"]);
    expect(result.generatedStatementCount).toBe(1);
    expect(result.generatedStatementWithEvidenceCount).toBe(1);
  });

  it("allows completion with zero CODE statement counts when blocks are otherwise valid", () => {
    const result = validateProductWikiOutput({
      ...baseInput,
      output: {
        pages: [
          {
            pageKey: "crew.add",
            title: "Add Crew",
            blocks: [{ type: "heading", text: "Overview", level: 2 }]
          }
        ]
      }
    });

    expect(result.generatedStatementCount).toBe(0);
    expect(result.generatedStatementWithEvidenceCount).toBe(0);
  });
});
