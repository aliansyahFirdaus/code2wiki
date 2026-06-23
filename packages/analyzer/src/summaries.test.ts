import { describe, expect, it } from "vitest";

import { buildCodeMap, type CodeMapEvidenceInput, type CodeMapFactInput } from "./code-map";
import { buildCodeSummaries, type SummaryEvidenceInput, type SummaryFactInput } from "./summaries";

describe("buildCodeSummaries", () => {
  it("builds file summaries from facts, evidence, and code map", () => {
    const result = buildCodeSummaries(fixture());

    expect(result.fileSummaries.length).toBeGreaterThan(0);
    expect(result.fileSummaries[0]).toMatchObject({
      type: "FILE",
      source: expect.objectContaining({ generationRunId: "run-1" }),
      inputStats: expect.objectContaining({ truncated: false })
    });
  });

  it("builds module summaries from file summaries and Code Map edges", () => {
    const result = buildCodeSummaries(fixture());

    expect(result.moduleSummaries.length).toBeGreaterThan(0);
    expect(result.moduleSummaries.some((summary) => summary.source.moduleKey?.startsWith("flow:"))).toBe(true);
  });

  it("keeps module grouping deterministic", () => {
    const first = buildCodeSummaries(fixture()).moduleSummaries.map((summary) => summary.cacheKey);
    const second = buildCodeSummaries(fixture()).moduleSummaries.map((summary) => summary.cacheKey);

    expect(second).toEqual(first);
  });

  it("attaches evidence to every summary claim", () => {
    const summaries = allSummaries(buildCodeSummaries(fixture()));

    expect(summaries.every((summary) => summary.claims.every((claim) => claim.evidenceIds.length > 0))).toBe(true);
  });

  it("does not leak local checkout paths into summary JSON", () => {
    const serialized = JSON.stringify(allSummaries(buildCodeSummaries(fixture())));

    expect(serialized).not.toContain("/tmp/");
    expect(serialized).not.toContain("/private/");
  });

  it("creates deterministic file and module cache/input/output hashes", () => {
    const first = buildCodeSummaries(fixture());
    const second = buildCodeSummaries(fixture());

    expect(second.fileSummaries.map(hashTuple)).toEqual(first.fileSummaries.map(hashTuple));
    expect(second.moduleSummaries.map(hashTuple)).toEqual(first.moduleSummaries.map(hashTuple));
  });

  it("sets truncated metadata when bounded inputs omit facts or evidence", () => {
    const result = buildCodeSummaries(fixture({ extraFrontendFacts: 45, extraFrontendEvidence: 45 }));
    const frontend = result.fileSummaries.find((summary) => summary.source.filePath === "app/users/page.tsx");

    expect(frontend?.inputStats.truncated).toBe(true);
    expect(frontend?.inputStats.omittedFactCount).toBeGreaterThan(0);
    expect(frontend?.inputStats.omittedEvidenceCount).toBeGreaterThan(0);
  });

  it("preserves repositoryRole and cannot swap frontend/backend summaries", () => {
    const result = buildCodeSummaries(fixture());
    const frontend = result.fileSummaries.find((summary) => summary.source.filePath === "app/users/page.tsx");
    const backend = result.fileSummaries.find((summary) => summary.source.filePath === "app/api/users/route.ts");

    expect(frontend?.source.repositoryRole).toBe("FRONTEND");
    expect(backend?.source.repositoryRole).toBe("BACKEND");
  });
});

function fixture(input: { extraFrontendFacts?: number; extraFrontendEvidence?: number } = {}) {
  const facts = [
    fact("fe-route", "FRONTEND", "ROUTE", "Frontend route /users", ["fe-route"], "fe-sha"),
    fact("fe-component", "FRONTEND", "PAGE_COMPONENT", "Page component for /users", ["fe-component"], "fe-sha"),
    fact("fe-field", "FRONTEND", "FORM_FIELD", 'Form field <input name="email" />', ["fe-field"], "fe-sha"),
    fact("fe-validation", "FRONTEND", "VALIDATION_HINT", "Validation hint z.string().min(1)", ["fe-validation"], "fe-sha"),
    fact("fe-call", "FRONTEND", "API_CALL", "API call fetch('/api/users', { method: 'POST' })", ["fe-call"], "fe-sha"),
    fact("be-route", "BACKEND", "API_ROUTE", "Backend API route /api/users", ["be-route"], "be-sha"),
    fact("be-handler", "BACKEND", "CONTROLLER_HANDLER", "Controller handler export async function POST", ["be-handler"], "be-sha"),
    fact("be-schema", "BACKEND", "DATABASE_ENTITY", "Database entity db.insert(users)", ["be-schema"], "be-sha"),
    fact("be-auth", "BACKEND", "PERMISSION_CHECK", "Permission check session.user", ["be-auth"], "be-sha"),
    fact("be-error", "BACKEND", "ERROR_RESPONSE", "Error response status: 400", ["be-error"], "be-sha"),
    ...Array.from({ length: input.extraFrontendFacts ?? 0 }, (_, index) =>
      fact(`fe-extra-fact-${index}`, "FRONTEND", "UI_STATE", `UI state extra ${index}`, [`fe-extra-evidence-${index}`], "fe-sha")
    )
  ];
  const evidenceRows = [
    evidence("fe-route", "FRONTEND", "app/users/page.tsx", "ROUTE", "fe-sha"),
    evidence("fe-component", "FRONTEND", "app/users/page.tsx", "COMPONENT", "fe-sha"),
    evidence("fe-field", "FRONTEND", "app/users/page.tsx", "FORM", "fe-sha"),
    evidence("fe-validation", "FRONTEND", "app/users/page.tsx", "VALIDATION", "fe-sha"),
    evidence("fe-call", "FRONTEND", "app/users/page.tsx", "API_CALL", "fe-sha"),
    evidence("be-route", "BACKEND", "app/api/users/route.ts", "ROUTE", "be-sha"),
    evidence("be-handler", "BACKEND", "app/api/users/route.ts", "HANDLER", "be-sha"),
    evidence("be-schema", "BACKEND", "app/api/users/route.ts", "MODEL", "be-sha"),
    evidence("be-auth", "BACKEND", "app/api/users/route.ts", "PERMISSION", "be-sha"),
    evidence("be-error", "BACKEND", "app/api/users/route.ts", "HANDLER", "be-sha"),
    ...Array.from({ length: input.extraFrontendEvidence ?? 0 }, (_, index) =>
      evidence(`fe-extra-evidence-${index}`, "FRONTEND", "app/users/page.tsx", "OTHER", "fe-sha")
    )
  ];
  const codeMap = buildCodeMap({
    generationRunId: "run-1",
    facts: facts.map(toCodeMapFact),
    evidence: evidenceRows.map(toCodeMapEvidence)
  });

  return { generationRunId: "run-1", codeMap, facts, evidence: evidenceRows };
}

function fact(
  id: string,
  repositoryRole: "FRONTEND" | "BACKEND",
  factKind: string,
  text: string,
  evidenceIds: string[],
  commitSha: string
): SummaryFactInput {
  return {
    id,
    generationRunId: "run-1",
    repositoryRole,
    repositoryFullName: repositoryRole === "FRONTEND" ? "acme/web" : "acme/api",
    commitSha,
    factKind,
    text,
    evidenceIds,
    confidence: 0.95
  };
}

function evidence(
  id: string,
  repositoryRole: "FRONTEND" | "BACKEND",
  filePath: string,
  sourceKind: string,
  commitSha: string
): SummaryEvidenceInput {
  return {
    id,
    generationRunId: "run-1",
    repositoryRole,
    repositoryFullName: repositoryRole === "FRONTEND" ? "acme/web" : "acme/api",
    commitSha,
    filePath,
    sourceKind,
    summary: id
  };
}

function toCodeMapFact(fact: SummaryFactInput): CodeMapFactInput {
  const { commitSha, ...rest } = fact;
  return rest;
}

function toCodeMapEvidence(item: SummaryEvidenceInput): CodeMapEvidenceInput {
  return {
    ...item,
    codeSnippet: item.summary
  };
}

function allSummaries(result: ReturnType<typeof buildCodeSummaries>) {
  return [...result.fileSummaries, ...result.moduleSummaries];
}

function hashTuple(summary: { cacheKey: string; inputHash: string; outputHash: string }) {
  return [summary.cacheKey, summary.inputHash, summary.outputHash];
}
