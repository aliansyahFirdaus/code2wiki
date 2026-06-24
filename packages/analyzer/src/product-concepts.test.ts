import { describe, expect, it } from "vitest";

import { deriveProductConcepts } from "./product-concepts";
import type { CodeMap, CodeMapEdge, CodeMapEvidenceInput, CodeMapFactInput, CodeMapNode } from "./code-map";

describe("product concepts", () => {
  it("derives concepts from UI text, fields, API paths, and actions", () => {
    const result = deriveProductConcepts({
      facts: [
        fact("action-export", "BUTTON_ACTION", "Button action <Button>Export Payroll</Button>", ["ev-export"]),
        fact("api-recalculate", "API_CALL", "API call fetch('/api/payroll/recalculate')", ["ev-api"])
      ],
      evidence: [
        evidence("ev-cutoff", "app/payroll/page.tsx", "FORM", '<label>Cut Off Period</label>'),
        evidence("ev-export", "app/payroll/page.tsx", "ACTION", "<Button>Export Payroll</Button>"),
        evidence("ev-api", "app/payroll/page.tsx", "API_CALL", "fetch('/api/payroll/recalculate')")
      ],
      codeMap: codeMap([
        node("field-vessel", "FORM_FIELD", "vesselId", "app/payroll/page.tsx", ["ev-vessel"], { fieldName: "vesselId" }),
        node("api-recalculate", "FRONTEND_API_CALL", "POST /api/payroll/recalculate", "app/payroll/page.tsx", ["ev-api"], { path: "/api/payroll/recalculate", method: "POST" })
      ])
    });

    expect(keys(result)).toEqual(expect.arrayContaining(["cut-off-period", "export-payroll", "payroll-recalculate", "vessel"]));
    expect(result.find((item) => item.conceptKey === "cut-off-period")).toMatchObject({
      source: "UI_TEXT",
      evidenceIds: ["ev-cutoff"]
    });
  });

  it("normalizes duplicate naming variants into one concept", () => {
    const result = deriveProductConcepts({
      facts: [fact("action", "BUTTON_ACTION", "Button action Salary Component", ["ev-action"])],
      evidence: [
        evidence("ev-label", "app/payroll/page.tsx", "FORM", "<label>Salary Component</label>"),
        evidence("ev-action", "app/payroll/page.tsx", "ACTION", "<Button>Salary Component</Button>")
      ],
      codeMap: codeMap([
        node("field-camel", "FORM_FIELD", "salaryComponentId", "app/payroll/page.tsx", ["ev-camel"], { fieldName: "salaryComponentId" }),
        node("field-snake", "FORM_FIELD", "salary_components", "app/payroll/page.tsx", ["ev-snake"], { fieldName: "salary_components" })
      ])
    });

    const concept = result.find((item) => item.conceptKey === "salary-component");
    expect(concept).toMatchObject({
      label: "Salary Component",
      evidenceIds: ["ev-action", "ev-camel", "ev-label", "ev-snake"]
    });
    expect(result.filter((item) => item.conceptKey === "salary-component")).toHaveLength(1);
  });

  it("skips implementation-only generic terms", () => {
    const result = deriveProductConcepts({
      facts: [fact("api", "API_CALL", "API call fetch('/api/handler/route')", ["ev-api"])],
      evidence: [evidence("ev-route", "app/page.tsx", "FORM", "<label>Component Handler Route</label>")],
      codeMap: codeMap([
        node("field", "FORM_FIELD", "componentId", "app/page.tsx", ["ev-field"], { fieldName: "componentId" }),
        node("api", "FRONTEND_API_CALL", "GET /api/handler/route", "app/page.tsx", ["ev-api"], { path: "/api/handler/route", method: "GET" })
      ])
    });

    expect(result).toEqual([]);
  });

  it("derives conservative concepts from code-map edges", () => {
    const form = node("form", "FORM", "Form in app/payroll/page.tsx", "app/payroll/page.tsx", ["ev-form"]);
    const field = node("cutoff", "FORM_FIELD", "cutOffPeriodId", "app/payroll/page.tsx", ["ev-field"], { fieldName: "cutOffPeriodId" });
    const result = deriveProductConcepts({
      facts: [],
      evidence: [evidence("ev-form", "app/payroll/page.tsx", "FORM", "<form />"), evidence("ev-field", "app/payroll/page.tsx", "FORM", "cutOffPeriodId")],
      codeMap: codeMap([form, field], [edge("form-field", "FORM_HAS_FIELD", form.stableKey, field.stableKey, ["ev-form", "ev-field"])])
    });

    expect(result.find((item) => item.conceptKey === "cut-off-period")).toMatchObject({
      evidenceIds: ["ev-field", "ev-form"],
      sourceNodeKeys: ["cutoff", "form"]
    });
  });
});

function keys(items: ReturnType<typeof deriveProductConcepts>) {
  return items.map((item) => item.conceptKey);
}

function codeMap(nodes: CodeMapNode[], edges: CodeMapEdge[] = []): CodeMap {
  return {
    generationRunId: "run-1",
    sourceHash: "hash",
    nodes,
    edges
  };
}

function node(
  stableKey: string,
  kind: CodeMapNode["kind"],
  label: string,
  filePath: string,
  evidenceIds: string[],
  metadata: Record<string, string | string[]> = {}
): CodeMapNode {
  return {
    stableKey,
    kind,
    repositoryRole: "FRONTEND",
    repositoryFullName: "acme/web",
    label,
    filePath,
    metadata,
    confidence: "HIGH",
    evidenceIds,
    sourceHash: `${stableKey}-hash`
  };
}

function edge(stableKey: string, kind: CodeMapEdge["kind"], fromStableKey: string, toStableKey: string, evidenceIds: string[]): CodeMapEdge {
  return {
    stableKey,
    kind,
    fromStableKey,
    toStableKey,
    confidence: "HIGH",
    evidenceIds,
    sourceHash: `${stableKey}-hash`
  };
}

function fact(id: string, factKind: string, text: string, evidenceIds: string[]): CodeMapFactInput {
  return {
    id,
    generationRunId: "run-1",
    repositoryRole: "FRONTEND",
    repositoryFullName: "acme/web",
    factKind,
    text,
    evidenceIds,
    confidence: 0.95
  };
}

function evidence(id: string, filePath: string, sourceKind: string, codeSnippet: string): CodeMapEvidenceInput {
  return {
    id,
    generationRunId: "run-1",
    repositoryRole: "FRONTEND",
    repositoryFullName: "acme/web",
    filePath,
    sourceKind,
    summary: id,
    codeSnippet
  };
}
