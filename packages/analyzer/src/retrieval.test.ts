import { describe, expect, it } from "vitest";

import { buildRetrievalContexts, type RetrievalEvidenceInput, type RetrievalFactInput } from "./retrieval";
import type { CodeMap, CodeMapEdge, CodeMapNode } from "./code-map";
import type { CodeSummary } from "./summaries";

describe("buildRetrievalContexts", () => {
  it("retrieves frontend page context and backend context through CALLS_API", () => {
    const input = fixture();
    const result = buildRetrievalContexts({ ...input, pageKeys: ["users"] });
    const context = result.contexts[0];

    expect(result.usedFallback).toBe(false);
    expect(context.pageKey).toBe("users");
    expect(context.frontend.nodes.map((node) => node.kind)).toContain("UI_ROUTE");
    expect(context.backend.nodes.map((node) => node.kind)).toContain("BACKEND_API_ROUTE");
    expect(context.crossRepoLinks).toHaveLength(1);
    expect(context.crossRepoLinks[0].kind).toBe("CALLS_API");
  });

  it("excludes unrelated backend endpoints without deterministic CALLS_API edges", () => {
    const input = fixture({ includeCallEdge: false, backendName: "billing" });
    const result = buildRetrievalContexts({ ...input, pageKeys: ["users"] });
    const context = result.contexts[0];

    expect(context.crossRepoLinks).toHaveLength(0);
    expect(context.backend.facts).toHaveLength(0);
  });

  it("includes semantically matching backend context when frontend API edges are missing", () => {
    const input = fixture({ includeCallEdge: false });
    const result = buildRetrievalContexts({ ...input, pageKeys: ["users"] });
    const context = result.contexts[0];

    expect(context.crossRepoLinks).toHaveLength(0);
    expect(context.backend.facts.map((fact) => fact.id)).toContain("be-route-fact");
    expect(context.backend.evidence.map((item) => item.id)).toContain("be-route");
  });

  it("preserves frontend and backend roles from repositoryRole", () => {
    const context = buildRetrievalContexts({ ...fixture(), pageKeys: ["users"] }).contexts[0];

    expect(context.frontend.facts.every((fact) => fact.repositoryRole === "FRONTEND")).toBe(true);
    expect(context.backend.facts.every((fact) => fact.repositoryRole === "BACKEND")).toBe(true);
    expect(context.frontend.evidence.every((item) => item.repositoryRole === "FRONTEND")).toBe(true);
    expect(context.backend.evidence.every((item) => item.repositoryRole === "BACKEND")).toBe(true);
  });

  it("keeps evidence-backed facts, summaries, nodes, and edges only", () => {
    const context = buildRetrievalContexts({ ...fixture(), pageKeys: ["users"] }).contexts[0];

    expect(context.facts.every((item) => item.evidenceIds.length > 0)).toBe(true);
    expect(context.summaries.every((item) => item.evidenceIds.length > 0)).toBe(true);
    expect([...context.frontend.nodes, ...context.backend.nodes].every((item) => item.evidenceIds.length > 0)).toBe(true);
    expect(context.crossRepoLinks.every((item) => item.evidenceIds.length > 0)).toBe(true);
  });

  it("selects valid same-generation evidence only", () => {
    const input = fixture();
    const context = buildRetrievalContexts({
      ...input,
      pageKeys: ["users"],
      evidence: [...input.evidence, evidence("other-run-evidence", "other-run", "FRONTEND", "app/other/page.tsx")],
      facts: [...input.facts, fact("other-run-fact", "other-run", "FRONTEND", "ROUTE", "Frontend route /other", ["other-run-evidence"])]
    }).contexts[0];
    const ids = new Set(context.evidence.map((item) => item.id));

    expect(ids.has("other-run-evidence")).toBe(false);
    expect(context.facts.flatMap((item) => item.evidenceIds).every((id) => ids.has(id))).toBe(true);
    expect(context.summaries.flatMap((item) => item.evidenceIds).every((id) => ids.has(id))).toBe(true);
  });

  it("reports budget truncation stats and warnings", () => {
    const input = fixture();
    const extraFacts = Array.from({ length: 6 }, (_, index) =>
      fact(`fe-extra-${index}`, "run-1", "FRONTEND", "UI_STATE", `Extra state ${index}`, ["fe-route"])
    );
    const context = buildRetrievalContexts({
      ...input,
      facts: [...input.facts, ...extraFacts],
      pageKeys: ["users"],
      budgets: { facts: 2 }
    }).contexts[0];

    expect(context.inputStats.truncated).toBe(true);
    expect(context.inputStats.omittedFactCount).toBeGreaterThan(0);
    expect(context.retrievalWarnings).toContain("RETRIEVAL_BUDGET_TRUNCATED");
    expect(context.retrievalWarnings).toContain("RETRIEVAL_FACTS_TRUNCATED");
  });

  it("omits absolute local checkout paths", () => {
    const input = fixture();
    const context = buildRetrievalContexts({
      ...input,
      pageKeys: ["users"],
      evidence: [...input.evidence, evidence("tmp-evidence", "run-1", "FRONTEND", "/private/tmp/checkout/app/users/page.tsx")],
      facts: [...input.facts, fact("tmp-fact", "run-1", "FRONTEND", "ROUTE", "Leaked route", ["tmp-evidence"])]
    }).contexts[0];
    const serialized = JSON.stringify(context);

    expect(serialized).not.toContain("/tmp");
    expect(serialized).not.toContain("/private");
    expect(serialized).not.toContain("/Users/");
  });

  it("is deterministic and sets sourceHash", () => {
    const input = fixture();
    const first = buildRetrievalContexts({ ...input, pageKeys: ["users"] });
    const second = buildRetrievalContexts({
      ...input,
      pageKeys: ["users"],
      facts: [...input.facts].reverse(),
      evidence: [...input.evidence].reverse(),
      summaries: [...input.summaries].reverse(),
      codeMap: { ...input.codeMap, nodes: [...input.codeMap.nodes].reverse(), edges: [...input.codeMap.edges].reverse() }
    });

    expect(first.sourceHash).toBe(second.sourceHash);
    expect(first.contexts[0].sourceHash).toBe(second.contexts[0].sourceHash);
  });

  it("returns an explicit fallback when map or summaries are missing", () => {
    const input = fixture();
    const result = buildRetrievalContexts({ ...input, codeMap: null });

    expect(result.usedFallback).toBe(true);
    expect(result.contexts).toEqual([]);
    expect(result.retrievalWarnings).toContain("RETRIEVAL_FALLBACK_MISSING_CODE_MAP_OR_SUMMARIES");
  });
});

function fixture(options: { includeCallEdge?: boolean; backendName?: string } = {}) {
  const includeCallEdge = options.includeCallEdge ?? true;
  const backendName = options.backendName ?? "users";
  const evidenceRows = [
    evidence("fe-route", "run-1", "FRONTEND", "app/users/page.tsx"),
    evidence("fe-call", "run-1", "FRONTEND", "app/users/page.tsx", "API_CALL"),
    evidence("be-route", "run-1", "BACKEND", `app/api/${backendName}/route.ts`),
    evidence("be-handler", "run-1", "BACKEND", `app/api/${backendName}/route.ts`, "HANDLER"),
    evidence("be-duplicate", "run-1", "BACKEND", `app/api/${backendName}-copy/route.ts`)
  ];
  const facts = [
    fact("fe-route-fact", "run-1", "FRONTEND", "ROUTE", "Frontend route /users", ["fe-route"], 0.95),
    fact("fe-call-fact", "run-1", "FRONTEND", "API_CALL", "fetch('/api/users', { method: 'POST' })", ["fe-call"], 0.95),
    fact("be-route-fact", "run-1", "BACKEND", "API_ROUTE", `Backend API route /api/${backendName}`, ["be-route"], 0.95),
    fact("be-handler-fact", "run-1", "BACKEND", "CONTROLLER_HANDLER", "POST handler", ["be-handler"], 0.9),
    fact("be-dupe-fact", "run-1", "BACKEND", "API_ROUTE", `Backend API route /api/${backendName}`, ["be-duplicate"], 0.95)
  ];
  const nodes = [
    node("node-fe-route", "UI_ROUTE", "FRONTEND", "app/users/page.tsx", "/users", ["fe-route"], { path: "/users" }),
    node("node-fe-call", "FRONTEND_API_CALL", "FRONTEND", "app/users/page.tsx", "POST /api/users", ["fe-call"], { path: "/api/users", method: "POST" }),
    node("node-be-route", "BACKEND_API_ROUTE", "BACKEND", `app/api/${backendName}/route.ts`, `/api/${backendName}`, ["be-route"], { path: `/api/${backendName}` }),
    node("node-be-handler", "BACKEND_HANDLER", "BACKEND", `app/api/${backendName}/route.ts`, "POST handler", ["be-handler"], { method: "POST" }),
    node("node-be-duplicate", "BACKEND_API_ROUTE", "BACKEND", `app/api/${backendName}-copy/route.ts`, `/api/${backendName}`, ["be-duplicate"], { path: `/api/${backendName}` })
  ] satisfies CodeMapNode[];
  const edges = includeCallEdge ? [edge("edge-call", "CALLS_API", "node-fe-call", "node-be-route", ["fe-call", "be-route"])] : [];
  const codeMap = { generationRunId: "run-1", sourceHash: "map-source", nodes, edges } satisfies CodeMap;
  const summaries = [
    summary("FILE", "file-fe", "FRONTEND", "app/users/page.tsx", undefined, ["fe-route", "fe-call"], ["node-fe-route", "node-fe-call"]),
    summary("FILE", "file-be", "BACKEND", "app/api/users/route.ts", undefined, ["be-route", "be-handler"], ["node-be-route", "node-be-handler"]),
    summary("MODULE", "module-users", "FRONTEND", undefined, "frontend-route:users", ["fe-route", "be-route"], ["node-fe-route", "node-be-route"])
  ];

  return { generationRunId: "run-1", facts, evidence: evidenceRows, codeMap, summaries };
}

function fact(
  id: string,
  generationRunId: string,
  repositoryRole: "FRONTEND" | "BACKEND",
  factKind: string,
  text: string,
  evidenceIds: string[],
  confidence = 0.8
): RetrievalFactInput {
  return {
    id,
    generationRunId,
    repositoryRole,
    repositoryFullName: repositoryRole === "FRONTEND" ? "acme/web" : "acme/api",
    tag: "v1",
    commitSha: repositoryRole === "FRONTEND" ? "fe-sha" : "be-sha",
    factKind,
    text,
    evidenceIds,
    confidence
  };
}

function evidence(
  id: string,
  generationRunId: string,
  repositoryRole: "FRONTEND" | "BACKEND",
  filePath: string,
  sourceKind = "ROUTE"
): RetrievalEvidenceInput {
  return {
    id,
    generationRunId,
    repositoryRole,
    repositoryFullName: repositoryRole === "FRONTEND" ? "acme/web" : "acme/api",
    tag: "v1",
    commitSha: repositoryRole === "FRONTEND" ? "fe-sha" : "be-sha",
    filePath,
    startLine: 1,
    endLine: 2,
    sourceKind,
    summary: id,
    githubUrl: `https://github.com/acme/${repositoryRole.toLowerCase()}/blob/main/${filePath}`
  };
}

function node(
  stableKey: string,
  kind: CodeMapNode["kind"],
  repositoryRole: "FRONTEND" | "BACKEND",
  filePath: string,
  label: string,
  evidenceIds: string[],
  metadata: Record<string, string>
): CodeMapNode {
  return {
    stableKey,
    kind,
    repositoryRole,
    repositoryFullName: repositoryRole === "FRONTEND" ? "acme/web" : "acme/api",
    label,
    filePath,
    metadata,
    confidence: "HIGH",
    evidenceIds,
    sourceHash: `${stableKey}-hash`
  };
}

function edge(
  stableKey: string,
  kind: CodeMapEdge["kind"],
  fromStableKey: string,
  toStableKey: string,
  evidenceIds: string[]
): CodeMapEdge {
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

function summary(
  type: "FILE" | "MODULE",
  cacheKey: string,
  repositoryRole: "FRONTEND" | "BACKEND",
  filePath: string | undefined,
  moduleKey: string | undefined,
  evidenceIds: string[],
  sourceNodeKeys: string[]
): CodeSummary {
  return {
    type,
    cacheKey,
    sourceHash: `${cacheKey}-source`,
    inputHash: `${cacheKey}-input`,
    outputHash: `${cacheKey}-output`,
    confidence: "HIGH",
    claims: [{ text: `${cacheKey} claim`, kind: "ROUTE", confidence: "HIGH", evidenceIds, sourceNodeKeys }],
    evidenceIds,
    sourceNodeKeys,
    inputStats: {
      factCount: 1,
      evidenceCount: evidenceIds.length,
      nodeCount: sourceNodeKeys.length,
      edgeCount: 0,
      truncated: false,
      omittedFactCount: 0,
      omittedEvidenceCount: 0
    },
    source: {
      generationRunId: "run-1",
      codeMapSourceHash: "map-source",
      repositoryRole,
      repositoryFullName: repositoryRole === "FRONTEND" ? "acme/web" : "acme/api",
      commitSha: repositoryRole === "FRONTEND" ? "fe-sha" : "be-sha",
      ...(filePath ? { filePath } : {}),
      ...(moduleKey ? { moduleKey } : {})
    }
  };
}
