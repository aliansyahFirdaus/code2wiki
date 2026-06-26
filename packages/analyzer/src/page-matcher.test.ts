import { describe, expect, it } from "vitest";

import { matchConceptsToPages } from "./page-matcher";
import type { ProductConcept } from "./product-concepts";

describe("page matcher", () => {
  it("updates exact existing pages", () => {
    const decisions = matchConceptsToPages({
      concepts: [concept("salary-component", ["ev-1"], "HIGH", 3, ["field"])],
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
      concepts: [concept("cut-off-period", ["ev-1"], "HIGH", 3, ["field", "validation"])],
      existingPageKeys: ["payroll.cut-off-period"],
      sourcePageKey: "payroll.monthly"
    });

    expect(decisions).toEqual([
      expect.objectContaining({
        disposition: "UPDATE_PAGE",
        pageKey: "payroll.cut-off-period",
        reason: "existing namespaced page absorbs related concept"
      })
    ]);
  });

  it("creates strong workflow concepts under the source namespace", () => {
    const decisions = matchConceptsToPages({
      concepts: [concept("export-payroll", ["ev-1"], "HIGH", 4, ["action", "async", "mutation"])],
      existingPageKeys: [],
      sourcePageKey: "payroll.monthly"
    });

    expect(decisions).toEqual([
      expect.objectContaining({
        disposition: "CREATE_PAGE",
        pageKey: "payroll.export-payroll",
        reason: "strong concept page under source namespace"
      })
    ]);
  });

  it("attaches fields and filters to the source page", () => {
    const decisions = matchConceptsToPages({
      concepts: [concept("status-filter", ["ev-1"], "HIGH", 2, ["action", "field"])],
      existingPageKeys: [],
      sourcePageKey: "payroll.monthly"
    });

    expect(decisions).toEqual([
      expect.objectContaining({
        disposition: "ATTACH_TO_PAGE",
        pageKey: "payroll",
        attachToPageKey: "payroll",
        score: 2
      })
    ]);
  });

  it("creates root pages for root-level concepts", () => {
    const decisions = matchConceptsToPages({
      concepts: [concept("vessel", ["ev-1"], "HIGH", 4, ["route", "action"])],
      existingPageKeys: [],
      sourcePageKey: "payroll.monthly"
    });

    expect(decisions).toEqual([
      expect.objectContaining({
        disposition: "CREATE_PAGE",
        pageKey: "vessel",
        reason: "strong root concept page"
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
      concepts: [concept("salary-component", ["ev-2"], "HIGH", 3, ["field"]), concept("salary-component", ["ev-1"], "HIGH", 3, ["field"])],
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

  it("excludes technical-only concepts", () => {
    const decisions = matchConceptsToPages({
      concepts: [concept("internal-api", ["ev-1"], "HIGH", 1, ["async"], "API_PATH", true)],
      existingPageKeys: []
    });

    expect(decisions).toEqual([
      expect.objectContaining({
        disposition: "EXCLUDED_NO_WIKI_VALUE",
        reason: "concept is implementation-only or technical-only"
      })
    ]);
  });

  it("does not create standalone pages from error-heavy concepts", () => {
    const decisions = matchConceptsToPages({
      concepts: [concept("failed-delete-contract-err", ["ev-1"], "HIGH", 4, ["error", "async", "mutation"])],
      existingPageKeys: [],
      sourcePageKey: "payroll.monthly"
    });

    expect(decisions).toEqual([
      expect.objectContaining({
        disposition: "ATTACH_TO_PAGE",
        pageKey: "payroll",
        attachToPageKey: "payroll",
        reason: "concept is not standalone page value and attaches to parent page"
      })
    ]);
  });
});

function concept(
  conceptKey: string,
  evidenceIds: string[],
  confidence: ProductConcept["confidence"] = "HIGH",
  score = 4,
  roles: ProductConcept["profile"]["roles"] = ["action", "async", "mutation"],
  source: ProductConcept["source"] = "FIELD_NAME",
  technicalOnly = false
): ProductConcept {
  return {
    conceptKey,
    label: conceptKey,
    source,
    confidence,
    evidenceIds,
    sourceNodeKeys: [],
    reasons: [`test ${conceptKey}`],
    profile: {
      roles,
      score,
      technicalOnly
    }
  };
}
