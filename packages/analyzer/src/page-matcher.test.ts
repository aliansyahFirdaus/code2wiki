import { describe, expect, it } from "vitest";

import { matchConceptsToPages } from "./page-matcher";
import type { ProductConcept } from "./product-concepts";

describe("page matcher", () => {
  it("updates exact existing pages", () => {
    const decisions = matchConceptsToPages({
      concepts: [concept("salary-component", ["ev-1"])],
      existingPageKeys: ["salary-component"]
    });

    expect(decisions).toEqual([
      expect.objectContaining({
        disposition: "UPDATE_PAGE",
        pageKey: "salary-component",
        conceptKey: "salary-component"
      })
    ]);
  });

  it("prefers existing namespaced pages for source page concepts", () => {
    const decisions = matchConceptsToPages({
      concepts: [concept("cut-off-period", ["ev-1"])],
      existingPageKeys: ["payroll.cut-off-period"],
      sourcePageKey: "payroll.monthly"
    });

    expect(decisions).toEqual([
      expect.objectContaining({
        disposition: "UPDATE_PAGE",
        pageKey: "payroll.cut-off-period",
        reason: "existing namespaced page matched concept"
      })
    ]);
  });

  it("creates strong related concepts under the source namespace", () => {
    const decisions = matchConceptsToPages({
      concepts: [concept("export-payroll", ["ev-1"])],
      existingPageKeys: [],
      sourcePageKey: "payroll.monthly"
    });

    expect(decisions).toEqual([
      expect.objectContaining({
        disposition: "CREATE_PAGE",
        pageKey: "payroll.export-payroll",
        reason: "new concept page under source namespace"
      })
    ]);
  });

  it("creates root pages for root-level concepts", () => {
    const decisions = matchConceptsToPages({
      concepts: [concept("vessel", ["ev-1"])],
      existingPageKeys: [],
      sourcePageKey: "payroll.monthly"
    });

    expect(decisions).toEqual([
      expect.objectContaining({
        disposition: "CREATE_PAGE",
        pageKey: "vessel",
        reason: "new root concept page"
      })
    ]);
  });

  it("sends weak concepts to review", () => {
    const decisions = matchConceptsToPages({
      concepts: [concept("crew-rank", ["ev-1"], "LOW")],
      existingPageKeys: [],
      sourcePageKey: "contract.detail"
    });

    expect(decisions).toEqual([
      expect.objectContaining({
        disposition: "NEEDS_REVIEW",
        pageKey: "contract.crew-rank",
        reason: "concept confidence is LOW"
      })
    ]);
  });

  it("excludes concepts without evidence", () => {
    const decisions = matchConceptsToPages({
      concepts: [concept("payroll-export", [])],
      existingPageKeys: []
    });

    expect(decisions).toEqual([
      expect.objectContaining({
        disposition: "EXCLUDED_NO_WIKI_VALUE",
        pageKey: "payroll-export",
        reason: "concept has no evidence"
      })
    ]);
  });

  it("dedupes stable page decisions and merges evidence", () => {
    const decisions = matchConceptsToPages({
      concepts: [concept("salary-component", ["ev-2"]), concept("salary-component", ["ev-1"])],
      existingPageKeys: ["salary-component"]
    });

    expect(decisions).toEqual([
      expect.objectContaining({
        disposition: "UPDATE_PAGE",
        pageKey: "salary-component",
        evidenceIds: ["ev-1", "ev-2"]
      })
    ]);
  });
});

function concept(conceptKey: string, evidenceIds: string[], confidence: ProductConcept["confidence"] = "HIGH"): ProductConcept {
  return {
    conceptKey,
    label: conceptKey,
    source: "FIELD_NAME",
    confidence,
    evidenceIds,
    sourceNodeKeys: [],
    reasons: [`test ${conceptKey}`]
  };
}
