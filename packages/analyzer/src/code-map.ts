import { createHash } from "node:crypto";

import type { RepositoryRole } from "@code2wiki/shared";

export const codeMapNodeKinds = [
  "UI_ROUTE",
  "REACT_COMPONENT",
  "FORM",
  "FORM_FIELD",
  "VALIDATION",
  "FRONTEND_API_CALL",
  "BACKEND_API_ROUTE",
  "BACKEND_HANDLER",
  "CONTRACT_HINT",
  "SCHEMA_ENTITY",
  "AUTH_CHECK",
  "NAVIGATION",
  "ERROR_STATE",
  "ENV_CONFIG",
  "TEST"
] as const;

export const codeMapEdgeKinds = [
  "ROUTE_RENDERS_COMPONENT",
  "COMPONENT_CONTAINS_FORM",
  "FORM_HAS_FIELD",
  "FIELD_HAS_VALIDATION",
  "CALLS_API",
  "API_ROUTE_HANDLED_BY",
  "HANDLER_USES_SCHEMA",
  "HANDLER_USES_AUTH",
  "NAVIGATES_TO",
  "HAS_ERROR_STATE",
  "USES_CONFIG",
  "COVERED_BY_TEST"
] as const;

export const codeMapConfidences = ["HIGH", "MEDIUM", "LOW", "NEEDS_REVIEW"] as const;

export type CodeMapNodeKind = (typeof codeMapNodeKinds)[number];
export type CodeMapEdgeKind = (typeof codeMapEdgeKinds)[number];
export type CodeMapConfidence = (typeof codeMapConfidences)[number];

export type CodeMapFactInput = {
  id: string;
  generationRunId: string;
  repositoryRole: RepositoryRole;
  repositoryFullName: string;
  factKind: string;
  text: string;
  evidenceIds: string[];
  confidence: number;
};

export type CodeMapEvidenceInput = {
  id: string;
  generationRunId: string;
  repositoryRole: RepositoryRole;
  repositoryFullName: string;
  filePath: string;
  sourceKind: string;
  summary: string;
  codeSnippet: string;
};

export type CodeMapNode = {
  stableKey: string;
  kind: CodeMapNodeKind;
  repositoryRole: RepositoryRole;
  repositoryFullName: string;
  label: string;
  filePath: string;
  metadata: Record<string, string | string[]>;
  confidence: CodeMapConfidence;
  evidenceIds: string[];
  sourceHash: string;
};

export type CodeMapEdge = {
  stableKey: string;
  kind: CodeMapEdgeKind;
  fromStableKey: string;
  toStableKey: string;
  confidence: CodeMapConfidence;
  evidenceIds: string[];
  sourceHash: string;
};

export type CodeMap = {
  generationRunId: string;
  sourceHash: string;
  nodes: CodeMapNode[];
  edges: CodeMapEdge[];
};

export type BuildCodeMapInput = {
  generationRunId: string;
  facts: CodeMapFactInput[];
  evidence: CodeMapEvidenceInput[];
};

type NodeDraft = Omit<CodeMapNode, "stableKey" | "sourceHash">;
type EdgeDraft = Omit<CodeMapEdge, "stableKey" | "sourceHash">;

export function buildCodeMap(input: BuildCodeMapInput): CodeMap {
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  const nodes = new Map<string, CodeMapNode>();
  const edges = new Map<string, CodeMapEdge>();

  for (const fact of input.facts.filter((item) => item.generationRunId === input.generationRunId).sort(compareFacts)) {
    const evidence = fact.evidenceIds.map((id) => evidenceById.get(id)).filter(isDefined);
    if (evidence.length === 0) {
      continue;
    }

    const filePath = evidence[0].filePath;
    const common = {
      repositoryRole: fact.repositoryRole,
      repositoryFullName: fact.repositoryFullName,
      filePath,
      evidenceIds: evidence.map((item) => item.id),
      confidence: confidenceFromScore(fact.confidence)
    };

    for (const draft of nodeDraftsForFact(fact, common)) {
      const node = finalizeNode(draft);
      nodes.set(node.stableKey, mergeNode(nodes.get(node.stableKey), node));
    }
  }

  const nodeList = [...nodes.values()].sort(compareNodes);
  for (const edge of edgeDraftsForNodes(nodeList)) {
    if (edge.evidenceIds.length === 0) {
      continue;
    }
    const finalized = finalizeEdge(edge);
    edges.set(finalized.stableKey, mergeEdge(edges.get(finalized.stableKey), finalized));
  }

  const finalNodes = [...nodes.values()].sort(compareNodes);
  const finalEdges = [...edges.values()].sort(compareEdges);
  const sourceHash = hash(
    JSON.stringify({
      facts: input.facts.filter((item) => item.generationRunId === input.generationRunId).sort(compareFacts),
      evidence: input.evidence.filter((item) => item.generationRunId === input.generationRunId).sort(compareEvidence),
      nodes: finalNodes,
      edges: finalEdges
    })
  );

  return {
    generationRunId: input.generationRunId,
    sourceHash,
    nodes: finalNodes,
    edges: finalEdges
  };
}

function nodeDraftsForFact(
  fact: CodeMapFactInput,
  common: Pick<NodeDraft, "repositoryRole" | "repositoryFullName" | "filePath" | "evidenceIds" | "confidence">
): NodeDraft[] {
  switch (fact.factKind) {
    case "ROUTE": {
      const routePath = readRoutePath(fact.text);
      return routePath
        ? [{ ...common, kind: "UI_ROUTE", label: routePath, metadata: { path: routePath } }]
        : [];
    }
    case "PAGE_COMPONENT": {
      const routePath = readRoutePath(fact.text);
      return [{ ...common, kind: "REACT_COMPONENT", label: routePath ? `Page ${routePath}` : fact.text, metadata: routePath ? { path: routePath } : {} }];
    }
    case "FORM_FIELD": {
      const fieldName = readAttributeValue(fact.text, "name") ?? readAttributeValue(fact.text, "id") ?? fact.text;
      return [
        { ...common, kind: "FORM", label: `Form in ${common.filePath}`, metadata: {} },
        { ...common, kind: "FORM_FIELD", label: fieldName, metadata: { fieldName } }
      ];
    }
    case "VALIDATION_HINT":
    case "VALIDATION_RULE":
      return [{ ...common, kind: "VALIDATION", label: fact.text, metadata: {} }];
    case "API_CALL": {
      const api = readApiCall(fact.text);
      return api
        ? [{ ...common, kind: "FRONTEND_API_CALL", label: `${api.method} ${api.path}`, metadata: api }]
        : [{ ...common, kind: "FRONTEND_API_CALL", label: fact.text, metadata: {} }];
    }
    case "API_ROUTE": {
      const routePath = readRoutePath(fact.text);
      return routePath
        ? [{ ...common, kind: "BACKEND_API_ROUTE", label: routePath, metadata: { path: routePath } }]
        : [];
    }
    case "CONTROLLER_HANDLER": {
      const method = readHandlerMethod(fact.text);
      return [{ ...common, kind: "BACKEND_HANDLER", label: method ? `${method} handler` : fact.text, metadata: method ? { method } : {} }];
    }
    case "DATABASE_ENTITY":
      return [{ ...common, kind: "SCHEMA_ENTITY", label: fact.text, metadata: {} }];
    case "PERMISSION_HINT":
    case "PERMISSION_CHECK":
      return [{ ...common, kind: "AUTH_CHECK", label: fact.text, metadata: {} }];
    case "NAVIGATION": {
      const target = readNavigationTarget(fact.text);
      return [{ ...common, kind: "NAVIGATION", label: target ?? fact.text, metadata: target ? { target } : {} }];
    }
    case "ERROR_RESPONSE":
    case "UI_STATE":
      return [{ ...common, kind: "ERROR_STATE", label: fact.text, metadata: {} }];
    default:
      return [];
  }
}

function edgeDraftsForNodes(nodes: CodeMapNode[]): EdgeDraft[] {
  return [
    ...sameFileEdges(nodes, "UI_ROUTE", "REACT_COMPONENT", "ROUTE_RENDERS_COMPONENT", "HIGH"),
    ...sameFileEdges(nodes, "REACT_COMPONENT", "FORM", "COMPONENT_CONTAINS_FORM", "MEDIUM"),
    ...sameFileEdges(nodes, "FORM", "FORM_FIELD", "FORM_HAS_FIELD", "HIGH"),
    ...sameFileEdges(nodes, "FORM_FIELD", "VALIDATION", "FIELD_HAS_VALIDATION", "MEDIUM"),
    ...apiCallEdges(nodes),
    ...sameFileEdges(nodes, "BACKEND_API_ROUTE", "BACKEND_HANDLER", "API_ROUTE_HANDLED_BY", "HIGH"),
    ...sameFileEdges(nodes, "BACKEND_HANDLER", "SCHEMA_ENTITY", "HANDLER_USES_SCHEMA", "MEDIUM"),
    ...sameFileEdges(nodes, "BACKEND_HANDLER", "AUTH_CHECK", "HANDLER_USES_AUTH", "MEDIUM"),
    ...sameFileEdges(nodes, "BACKEND_HANDLER", "ERROR_STATE", "HAS_ERROR_STATE", "MEDIUM"),
    ...navigationEdges(nodes)
  ];
}

function sameFileEdges(
  nodes: CodeMapNode[],
  fromKind: CodeMapNodeKind,
  toKind: CodeMapNodeKind,
  kind: CodeMapEdgeKind,
  confidence: CodeMapConfidence
) {
  const edges: EdgeDraft[] = [];
  for (const from of nodes.filter((item) => item.kind === fromKind)) {
    for (const to of nodes.filter((item) => item.kind === toKind && item.repositoryRole === from.repositoryRole && item.filePath === from.filePath)) {
      edges.push({
        kind,
        fromStableKey: from.stableKey,
        toStableKey: to.stableKey,
        confidence,
        evidenceIds: uniqueSorted([...from.evidenceIds, ...to.evidenceIds])
      });
    }
  }
  return edges;
}

function apiCallEdges(nodes: CodeMapNode[]) {
  const edges: EdgeDraft[] = [];
  const routes = nodes.filter((item) => item.kind === "BACKEND_API_ROUTE");
  const handlers = nodes.filter((item) => item.kind === "BACKEND_HANDLER");

  for (const call of nodes.filter((item) => item.kind === "FRONTEND_API_CALL")) {
    const pathValue = stringMetadata(call, "path");
    const methodValue = stringMetadata(call, "method");
    if (!pathValue || !methodValue) {
      continue;
    }

    const matches = routes.filter((route) => {
      if (stringMetadata(route, "path") !== pathValue) {
        return false;
      }
      const methods = handlers
        .filter((handler) => handler.repositoryRole === route.repositoryRole && handler.filePath === route.filePath)
        .map((handler) => stringMetadata(handler, "method"))
        .filter(isDefined);
      return methods.includes(methodValue);
    });

    if (matches.length !== 1) {
      continue;
    }

    edges.push({
      kind: "CALLS_API",
      fromStableKey: call.stableKey,
      toStableKey: matches[0].stableKey,
      confidence: "HIGH",
      evidenceIds: uniqueSorted([...call.evidenceIds, ...matches[0].evidenceIds])
    });
  }

  return edges;
}

function navigationEdges(nodes: CodeMapNode[]) {
  const edges: EdgeDraft[] = [];
  const routes = nodes.filter((item) => item.kind === "UI_ROUTE");

  for (const navigation of nodes.filter((item) => item.kind === "NAVIGATION")) {
    const target = stringMetadata(navigation, "target");
    if (!target) {
      continue;
    }
    const matches = routes.filter((route) => stringMetadata(route, "path") === target);
    if (matches.length !== 1) {
      continue;
    }
    edges.push({
      kind: "NAVIGATES_TO",
      fromStableKey: navigation.stableKey,
      toStableKey: matches[0].stableKey,
      confidence: "MEDIUM",
      evidenceIds: uniqueSorted([...navigation.evidenceIds, ...matches[0].evidenceIds])
    });
  }

  return edges;
}

function finalizeNode(node: NodeDraft): CodeMapNode {
  const stableKey = makeStableKey(["node", node.kind, node.repositoryRole, node.repositoryFullName, node.filePath, node.label, JSON.stringify(node.metadata)]);
  return {
    ...node,
    stableKey,
    evidenceIds: uniqueSorted(node.evidenceIds),
    sourceHash: hash(JSON.stringify({ ...node, stableKey, evidenceIds: uniqueSorted(node.evidenceIds) }))
  };
}

function finalizeEdge(edge: EdgeDraft): CodeMapEdge {
  const stableKey = makeStableKey(["edge", edge.kind, edge.fromStableKey, edge.toStableKey]);
  return {
    ...edge,
    stableKey,
    evidenceIds: uniqueSorted(edge.evidenceIds),
    sourceHash: hash(JSON.stringify({ ...edge, stableKey, evidenceIds: uniqueSorted(edge.evidenceIds) }))
  };
}

function mergeNode(existing: CodeMapNode | undefined, next: CodeMapNode): CodeMapNode {
  if (!existing) {
    return next;
  }
  return finalizeNode({
    ...existing,
    evidenceIds: uniqueSorted([...existing.evidenceIds, ...next.evidenceIds]),
    confidence: strongerConfidence(existing.confidence, next.confidence)
  });
}

function mergeEdge(existing: CodeMapEdge | undefined, next: CodeMapEdge): CodeMapEdge {
  if (!existing) {
    return next;
  }
  return finalizeEdge({
    ...existing,
    evidenceIds: uniqueSorted([...existing.evidenceIds, ...next.evidenceIds]),
    confidence: strongerConfidence(existing.confidence, next.confidence)
  });
}

function readRoutePath(text: string) {
  const match = text.match(/(?:route|for)\s+(\/[A-Za-z0-9_./:[\]-]*)/i);
  return match ? normalizePath(match[1]) : null;
}

function readApiCall(text: string) {
  const pathMatch = text.match(/["'`](\/api\/[^"'`)\s,]+)["'`]/);
  if (!pathMatch) {
    return null;
  }
  const methodMatch =
    text.match(/\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i) ??
    text.match(/\b(?:axios|client|api)\.(get|post|put|patch|delete)\s*\(/i);
  return {
    path: normalizePath(pathMatch[1]),
    method: (methodMatch?.[1] ?? "GET").toUpperCase()
  };
}

function readHandlerMethod(text: string) {
  return text.match(/\b(GET|POST|PUT|PATCH|DELETE)\b/)?.[1].toUpperCase() ?? null;
}

function readNavigationTarget(text: string) {
  const match = text.match(/["'`](\/(?!api\/)[^"'`)]+)["'`]/);
  return match ? normalizePath(match[1]) : null;
}

function readAttributeValue(text: string, name: string) {
  return text.match(new RegExp(`\\b${name}=(?:["']([^"']+)["']|\\{["']([^"']+)["']\\})`))?.slice(1).find(Boolean) ?? null;
}

function normalizePath(value: string) {
  const cleaned = value.trim().replace(/\/+$/, "");
  return cleaned || "/";
}

function confidenceFromScore(score: number): CodeMapConfidence {
  if (score >= 0.9) {
    return "HIGH";
  }
  if (score >= 0.75) {
    return "MEDIUM";
  }
  if (score > 0) {
    return "LOW";
  }
  return "NEEDS_REVIEW";
}

function strongerConfidence(left: CodeMapConfidence, right: CodeMapConfidence): CodeMapConfidence {
  const rank: Record<CodeMapConfidence, number> = { NEEDS_REVIEW: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
  return rank[right] > rank[left] ? right : left;
}

function stringMetadata(node: CodeMapNode, key: string) {
  const value = node.metadata[key];
  return typeof value === "string" ? value : undefined;
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}

function makeStableKey(parts: string[]) {
  return `${parts[0]}_${hash(parts.map(normalizePart).join("|"))}`;
}

function normalizePart(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function compareFacts(left: CodeMapFactInput, right: CodeMapFactInput) {
  return (
    left.repositoryRole.localeCompare(right.repositoryRole) ||
    left.repositoryFullName.localeCompare(right.repositoryFullName) ||
    left.factKind.localeCompare(right.factKind) ||
    left.text.localeCompare(right.text) ||
    left.id.localeCompare(right.id)
  );
}

function compareEvidence(left: CodeMapEvidenceInput, right: CodeMapEvidenceInput) {
  return (
    left.repositoryRole.localeCompare(right.repositoryRole) ||
    left.repositoryFullName.localeCompare(right.repositoryFullName) ||
    left.filePath.localeCompare(right.filePath) ||
    left.sourceKind.localeCompare(right.sourceKind) ||
    left.id.localeCompare(right.id)
  );
}

function compareNodes(left: CodeMapNode, right: CodeMapNode) {
  return left.kind.localeCompare(right.kind) || left.stableKey.localeCompare(right.stableKey);
}

function compareEdges(left: CodeMapEdge, right: CodeMapEdge) {
  return left.kind.localeCompare(right.kind) || left.stableKey.localeCompare(right.stableKey);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
