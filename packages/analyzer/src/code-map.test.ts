import { describe, expect, it } from "vitest";

import { buildCodeMap, type CodeMapEvidenceInput, type CodeMapFactInput } from "./code-map";

describe("buildCodeMap", () => {
  it("builds frontend UI_ROUTE, REACT_COMPONENT, FORM, and FORM_FIELD nodes", () => {
    const map = buildCodeMap(fixture());

    expect(kinds(map.nodes)).toEqual(expect.arrayContaining(["UI_ROUTE", "REACT_COMPONENT", "FORM", "FORM_FIELD"]));
  });

  it("builds backend route, handler, schema, auth, and error nodes", () => {
    const map = buildCodeMap(fixture());

    expect(kinds(map.nodes)).toEqual(
      expect.arrayContaining(["BACKEND_API_ROUTE", "BACKEND_HANDLER", "SCHEMA_ENTITY", "AUTH_CHECK", "ERROR_STATE"])
    );
  });

  it("links frontend API call to backend route on exact normalized path and method match", () => {
    const map = buildCodeMap(fixture());

    expect(map.edges).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "CALLS_API" })]));
    const edge = map.edges.find((item) => item.kind === "CALLS_API");
    const from = map.nodes.find((item) => item.stableKey === edge?.fromStableKey);
    const to = map.nodes.find((item) => item.stableKey === edge?.toStableKey);
    expect(from?.kind).toBe("FRONTEND_API_CALL");
    expect(to?.kind).toBe("BACKEND_API_ROUTE");
  });

  it("does not link ambiguous endpoints", () => {
    const input = fixture({
      extraFacts: [
        fact("be-route-2", "BACKEND", "API_ROUTE", "Backend API route /api/users", ["be-route-2"]),
        fact("be-handler-2", "BACKEND", "CONTROLLER_HANDLER", "Controller handler export async function POST", ["be-handler-2"])
      ],
      extraEvidence: [
        evidence("be-route-2", "BACKEND", "app/api/duplicate/route.ts", "ROUTE", "Backend API route /api/users"),
        evidence("be-handler-2", "BACKEND", "app/api/duplicate/route.ts", "HANDLER", "export async function POST() {}")
      ]
    });

    expect(buildCodeMap(input).edges.some((item) => item.kind === "CALLS_API")).toBe(false);
  });

  it("attaches evidence to every node and edge", () => {
    const map = buildCodeMap(fixture());

    expect(map.nodes.length).toBeGreaterThan(0);
    expect(map.nodes.every((node) => node.evidenceIds.length > 0)).toBe(true);
    expect(map.edges.length).toBeGreaterThan(0);
    expect(map.edges.every((edge) => edge.evidenceIds.length > 0)).toBe(true);
  });

  it("creates deterministic stable keys and source hash", () => {
    const first = buildCodeMap(fixture());
    const second = buildCodeMap(fixture());

    expect(second.nodes.map((node) => node.stableKey)).toEqual(first.nodes.map((node) => node.stableKey));
    expect(second.edges.map((edge) => edge.stableKey)).toEqual(first.edges.map((edge) => edge.stableKey));
    expect(second.sourceHash).toBe(first.sourceHash);
  });

  it("preserves frontend and backend repository roles without swapping", () => {
    const map = buildCodeMap(fixture());
    const apiCall = map.nodes.find((node) => node.kind === "FRONTEND_API_CALL");
    const apiRoute = map.nodes.find((node) => node.kind === "BACKEND_API_ROUTE");

    expect(apiCall?.repositoryRole).toBe("FRONTEND");
    expect(apiRoute?.repositoryRole).toBe("BACKEND");
  });
});

function fixture(input: { extraFacts?: CodeMapFactInput[]; extraEvidence?: CodeMapEvidenceInput[] } = {}) {
  const facts = [
    fact("fe-route", "FRONTEND", "ROUTE", "Frontend route /users", ["fe-route"]),
    fact("fe-component", "FRONTEND", "PAGE_COMPONENT", "Page component for /users", ["fe-component"]),
    fact("fe-field", "FRONTEND", "FORM_FIELD", 'Form field <input name="email" />', ["fe-field"]),
    fact("fe-validation", "FRONTEND", "VALIDATION_HINT", "Validation hint z.string().min(1)", ["fe-validation"]),
    fact("fe-call", "FRONTEND", "API_CALL", "API call fetch('/api/users', { method: 'POST' })", ["fe-call"]),
    fact("be-route", "BACKEND", "API_ROUTE", "Backend API route /api/users", ["be-route"]),
    fact("be-handler", "BACKEND", "CONTROLLER_HANDLER", "Controller handler export async function POST", ["be-handler"]),
    fact("be-schema", "BACKEND", "DATABASE_ENTITY", "Database entity db.insert(users)", ["be-schema"]),
    fact("be-auth", "BACKEND", "PERMISSION_CHECK", "Permission check session.user", ["be-auth"]),
    fact("be-error", "BACKEND", "ERROR_RESPONSE", "Error response status: 400", ["be-error"]),
    ...(input.extraFacts ?? [])
  ];
  const evidenceRows = [
    evidence("fe-route", "FRONTEND", "app/users/page.tsx", "ROUTE", "export default function UsersPage() {}"),
    evidence("fe-component", "FRONTEND", "app/users/page.tsx", "COMPONENT", "export default function UsersPage() {}"),
    evidence("fe-field", "FRONTEND", "app/users/page.tsx", "FORM", '<input name="email" />'),
    evidence("fe-validation", "FRONTEND", "app/users/page.tsx", "VALIDATION", "z.string().min(1)"),
    evidence("fe-call", "FRONTEND", "app/users/page.tsx", "API_CALL", "fetch('/api/users', { method: 'POST' })"),
    evidence("be-route", "BACKEND", "app/api/users/route.ts", "ROUTE", "export async function POST() {}"),
    evidence("be-handler", "BACKEND", "app/api/users/route.ts", "HANDLER", "export async function POST() {}"),
    evidence("be-schema", "BACKEND", "app/api/users/route.ts", "MODEL", "db.insert(users)"),
    evidence("be-auth", "BACKEND", "app/api/users/route.ts", "PERMISSION", "session.user"),
    evidence("be-error", "BACKEND", "app/api/users/route.ts", "HANDLER", "status: 400"),
    ...(input.extraEvidence ?? [])
  ];
  return { generationRunId: "run-1", facts, evidence: evidenceRows };
}

function fact(
  id: string,
  repositoryRole: "FRONTEND" | "BACKEND",
  factKind: string,
  text: string,
  evidenceIds: string[]
): CodeMapFactInput {
  return {
    id,
    generationRunId: "run-1",
    repositoryRole,
    repositoryFullName: repositoryRole === "FRONTEND" ? "acme/web" : "acme/api",
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
  codeSnippet: string
): CodeMapEvidenceInput {
  return {
    id,
    generationRunId: "run-1",
    repositoryRole,
    repositoryFullName: repositoryRole === "FRONTEND" ? "acme/web" : "acme/api",
    filePath,
    sourceKind,
    summary: id,
    codeSnippet
  };
}

function kinds<T extends { kind: string }>(items: T[]) {
  return items.map((item) => item.kind);
}
