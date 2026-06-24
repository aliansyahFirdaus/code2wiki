import { createHash } from "node:crypto";

import type { RepositoryRole } from "@code2wiki/shared";

import type { CodeMap, CodeMapEdge, CodeMapNode } from "./code-map";
import type { CodeSummary } from "./summaries";

export type RetrievalFactInput = {
  id: string;
  generationRunId: string;
  repositoryRole: RepositoryRole;
  repositoryFullName: string;
  tag: string;
  commitSha: string;
  factKind: string;
  text: string;
  evidenceIds: string[];
  confidence: number;
};

export type RetrievalEvidenceInput = {
  id: string;
  generationRunId: string;
  repositoryRole: RepositoryRole;
  repositoryFullName: string;
  tag: string;
  commitSha: string;
  filePath: string;
  startLine: number;
  endLine: number;
  sourceKind: string;
  summary: string;
  githubUrl: string;
};

export type RetrievalBudgets = {
  moduleSummaries: number;
  fileSummaries: number;
  facts: number;
  evidence: number;
  nodes: number;
  edges: number;
  estimatedTokens: number;
};

export type RetrievalRequest = {
  generationRunId: string;
  pageKeys?: string[];
  facts: RetrievalFactInput[];
  evidence: RetrievalEvidenceInput[];
  codeMap?: CodeMap | null;
  summaries?: CodeSummary[] | null;
  budgets?: Partial<RetrievalBudgets>;
};

export type RetrievalInputStats = {
  factCount: number;
  evidenceCount: number;
  nodeCount: number;
  edgeCount: number;
  summaryCount: number;
  truncated: boolean;
  omittedFactCount: number;
  omittedEvidenceCount: number;
  omittedNodeCount: number;
  omittedEdgeCount: number;
  omittedSummaryCount: number;
};

export type RetrievalContext = {
  generationRunId: string;
  pageKey: string;
  moduleKeys: string[];
  frontend: {
    facts: RetrievalFactInput[];
    evidence: RetrievalEvidenceInput[];
    nodes: CodeMapNode[];
  };
  backend: {
    facts: RetrievalFactInput[];
    evidence: RetrievalEvidenceInput[];
    nodes: CodeMapNode[];
  };
  crossRepoLinks: CodeMapEdge[];
  summaries: CodeSummary[];
  facts: RetrievalFactInput[];
  evidence: RetrievalEvidenceInput[];
  openQuestions: string[];
  inputStats: RetrievalInputStats;
  retrievalWarnings: string[];
  sourceHash: string;
};

export type RetrievalResult = {
  generationRunId: string;
  usedFallback: boolean;
  contexts: RetrievalContext[];
  retrievalWarnings: string[];
  sourceHash: string;
};

const defaultBudgets: RetrievalBudgets = {
  moduleSummaries: 3,
  fileSummaries: 8,
  facts: 40,
  evidence: 24,
  nodes: 32,
  edges: 24,
  estimatedTokens: 6000
};

export function buildRetrievalContexts(request: RetrievalRequest): RetrievalResult {
  if (!request.codeMap || !request.summaries) {
    return fallbackResult(request.generationRunId, "RETRIEVAL_FALLBACK_MISSING_CODE_MAP_OR_SUMMARIES");
  }

  const budgets = { ...defaultBudgets, ...request.budgets };
  const evidenceById = new Map(validEvidence(request).map((item) => [item.id, item]));
  const facts = request.facts
    .filter((item) => item.generationRunId === request.generationRunId)
    .filter((item) => hasUsableEvidence(item.evidenceIds, evidenceById))
    .filter((item) => !hasLocalPath(item.evidenceIds.map((id) => evidenceById.get(id)?.filePath ?? "").join("|")))
    .sort(compareFacts);
  const summaries = request.summaries
    .filter((item) => item.source.generationRunId === request.generationRunId)
    .filter((item) => hasUsableEvidence(item.evidenceIds, evidenceById))
    .filter((item) => !hasLocalPath(item.source.filePath ?? ""))
    .sort(compareSummaries);
  const nodes = request.codeMap.nodes
    .filter((item) => hasUsableEvidence(item.evidenceIds, evidenceById))
    .filter((item) => !hasLocalPath(item.filePath))
    .sort(compareNodes);
  const edges = request.codeMap.edges
    .filter((item) => hasUsableEvidence(item.evidenceIds, evidenceById))
    .sort(compareEdges);

  const pageKeys = uniqueSorted(request.pageKeys?.length ? request.pageKeys : pageKeysFromNodes(nodes));
  const contexts = pageKeys.map((pageKey) => buildContext({ generationRunId: request.generationRunId, pageKey, facts, evidenceById, nodes, edges, summaries, budgets }));
  const retrievalWarnings = contexts.flatMap((context) => context.retrievalWarnings);

  return {
    generationRunId: request.generationRunId,
    usedFallback: false,
    contexts,
    retrievalWarnings: uniqueSorted(retrievalWarnings),
    sourceHash: hashStable({ generationRunId: request.generationRunId, contexts: contexts.map((context) => context.sourceHash) })
  };
}

function buildContext(input: {
  generationRunId: string;
  pageKey: string;
  facts: RetrievalFactInput[];
  evidenceById: Map<string, RetrievalEvidenceInput>;
  nodes: CodeMapNode[];
  edges: CodeMapEdge[];
  summaries: CodeSummary[];
  budgets: RetrievalBudgets;
}): RetrievalContext {
  const pageNodes = input.nodes.filter((node) => nodeMatchesPage(node, input.pageKey));
  const pageFiles = new Set(pageNodes.map((node) => fileKey(node)));
  const pageApiCallNodes = input.nodes.filter((node) => node.kind === "FRONTEND_API_CALL" && pageFiles.has(fileKey(node)));
  const callEdges = input.edges.filter((edge) => edge.kind === "CALLS_API" && pageApiCallNodes.some((node) => node.stableKey === edge.fromStableKey));
  const semanticBackendNodes = input.nodes.filter((node) => node.repositoryRole === "BACKEND" && semanticMatch(input.pageKey, `${node.label} ${node.filePath}`));
  const linkedNodeKeys = new Set([...pageNodes.map((node) => node.stableKey), ...callEdges.flatMap((edge) => [edge.fromStableKey, edge.toStableKey]), ...semanticBackendNodes.map((node) => node.stableKey)]);
  const linkedFiles = new Set(input.nodes.filter((node) => linkedNodeKeys.has(node.stableKey)).map((node) => fileKey(node)));
  const facts = takeWithWarning(
    input.facts.filter((fact) => factMatchesContext(fact, input.evidenceById, linkedFiles, input.pageKey)).sort((left, right) => rankFact(input.pageKey, left, input.evidenceById, linkedFiles) - rankFact(input.pageKey, right, input.evidenceById, linkedFiles) || compareFacts(left, right)),
    input.budgets.facts,
    "facts"
  );
  const nodes = takeWithWarning(
    input.nodes.filter((node) => linkedNodeKeys.has(node.stableKey) || nodeMatchesPage(node, input.pageKey)).sort((left, right) => rankNode(input.pageKey, left, linkedNodeKeys) - rankNode(input.pageKey, right, linkedNodeKeys) || compareNodes(left, right)),
    input.budgets.nodes,
    "nodes"
  );
  const edges = takeWithWarning(
    input.edges.filter((edge) => callEdges.some((call) => call.stableKey === edge.stableKey) || nodes.items.some((node) => node.stableKey === edge.fromStableKey || node.stableKey === edge.toStableKey)).sort((left, right) => rankEdge(left) - rankEdge(right) || compareEdges(left, right)),
    input.budgets.edges,
    "edges"
  );
  const moduleSummaries = input.summaries
    .filter((summary) => summary.type === "MODULE")
    .filter((summary) => summaryMatchesContext(summary, linkedNodeKeys, linkedFiles, input.pageKey))
    .sort((left, right) => rankSummary(input.pageKey, left, linkedNodeKeys, linkedFiles) - rankSummary(input.pageKey, right, linkedNodeKeys, linkedFiles) || compareSummaries(left, right));
  const fileSummaries = input.summaries
    .filter((summary) => summary.type === "FILE")
    .filter((summary) => summaryMatchesContext(summary, linkedNodeKeys, linkedFiles, input.pageKey))
    .sort((left, right) => rankSummary(input.pageKey, left, linkedNodeKeys, linkedFiles) - rankSummary(input.pageKey, right, linkedNodeKeys, linkedFiles) || compareSummaries(left, right));
  const summaries = takeWithWarning(
    [...moduleSummaries.slice(0, input.budgets.moduleSummaries), ...fileSummaries.slice(0, input.budgets.fileSummaries)],
    input.budgets.moduleSummaries + input.budgets.fileSummaries,
    "summaries",
    Math.max(0, moduleSummaries.length - input.budgets.moduleSummaries) + Math.max(0, fileSummaries.length - input.budgets.fileSummaries)
  );

  const selectedEvidenceIds = uniqueSorted([
    ...facts.items.flatMap((item) => item.evidenceIds),
    ...nodes.items.flatMap((item) => item.evidenceIds),
    ...edges.items.flatMap((item) => item.evidenceIds),
    ...summaries.items.flatMap((item) => item.evidenceIds)
  ]).filter((id) => input.evidenceById.has(id));
  const evidence = takeWithWarning(
    selectedEvidenceIds.map((id) => input.evidenceById.get(id)).filter(isDefined).sort(compareEvidence),
    input.budgets.evidence,
    "evidence"
  );
  const keptEvidenceIds = new Set(evidence.items.map((item) => item.id));
  const context = finalizeContext({
    generationRunId: input.generationRunId,
    pageKey: input.pageKey,
    facts: facts.items.filter((item) => hasKeptEvidence(item.evidenceIds, keptEvidenceIds)),
    evidence: evidence.items,
    nodes: nodes.items.filter((item) => hasKeptEvidence(item.evidenceIds, keptEvidenceIds)),
    edges: edges.items.filter((item) => hasKeptEvidence(item.evidenceIds, keptEvidenceIds)),
    summaries: summaries.items.filter((item) => hasKeptEvidence(item.evidenceIds, keptEvidenceIds)),
    warnings: [...facts.warnings, ...nodes.warnings, ...edges.warnings, ...summaries.warnings, ...evidence.warnings],
    omitted: {
      facts: facts.omitted,
      evidence: evidence.omitted,
      nodes: nodes.omitted,
      edges: edges.omitted,
      summaries: summaries.omitted
    }
  });

  return trimByTokenBudget(context, input.budgets.estimatedTokens);
}

function finalizeContext(input: {
  generationRunId: string;
  pageKey: string;
  facts: RetrievalFactInput[];
  evidence: RetrievalEvidenceInput[];
  nodes: CodeMapNode[];
  edges: CodeMapEdge[];
  summaries: CodeSummary[];
  warnings: string[];
  omitted: { facts: number; evidence: number; nodes: number; edges: number; summaries: number };
}): RetrievalContext {
  const frontendEvidenceIds = new Set(input.evidence.filter((item) => item.repositoryRole === "FRONTEND").map((item) => item.id));
  const backendEvidenceIds = new Set(input.evidence.filter((item) => item.repositoryRole === "BACKEND").map((item) => item.id));
  const frontendFacts = input.facts.filter((item) => item.repositoryRole === "FRONTEND");
  const backendFacts = input.facts.filter((item) => item.repositoryRole === "BACKEND");
  const frontendNodes = input.nodes.filter((item) => item.repositoryRole === "FRONTEND");
  const backendNodes = input.nodes.filter((item) => item.repositoryRole === "BACKEND");
  const moduleKeys = uniqueSorted(input.summaries.map((summary) => summary.source.moduleKey).filter(isDefined));
  const stats = {
    factCount: input.facts.length,
    evidenceCount: input.evidence.length,
    nodeCount: input.nodes.length,
    edgeCount: input.edges.length,
    summaryCount: input.summaries.length,
    truncated: Object.values(input.omitted).some((count) => count > 0),
    omittedFactCount: input.omitted.facts,
    omittedEvidenceCount: input.omitted.evidence,
    omittedNodeCount: input.omitted.nodes,
    omittedEdgeCount: input.omitted.edges,
    omittedSummaryCount: input.omitted.summaries
  };
  const warnings = [...input.warnings];
  if (stats.truncated) {
    warnings.push("RETRIEVAL_BUDGET_TRUNCATED");
  }

  const context = {
    generationRunId: input.generationRunId,
    pageKey: input.pageKey,
    moduleKeys,
    frontend: {
      facts: frontendFacts,
      evidence: input.evidence.filter((item) => frontendEvidenceIds.has(item.id)),
      nodes: frontendNodes
    },
    backend: {
      facts: backendFacts,
      evidence: input.evidence.filter((item) => backendEvidenceIds.has(item.id)),
      nodes: backendNodes
    },
    crossRepoLinks: input.edges.filter((item) => item.kind === "CALLS_API"),
    summaries: input.summaries,
    facts: input.facts,
    evidence: input.evidence,
    openQuestions: [],
    inputStats: stats,
    retrievalWarnings: uniqueSorted(warnings),
    sourceHash: ""
  } satisfies RetrievalContext;

  return { ...context, sourceHash: hashStable({ ...context, sourceHash: "" }) };
}

function trimByTokenBudget(context: RetrievalContext, budget: number): RetrievalContext {
  if (estimateTokens(context) <= budget) {
    return context;
  }
  return finalizeContext({
    generationRunId: context.generationRunId,
    pageKey: context.pageKey,
    facts: context.facts.slice(0, Math.max(1, Math.floor(context.facts.length / 2))),
    evidence: context.evidence,
    nodes: context.frontend.nodes.concat(context.backend.nodes).slice(0, Math.max(1, Math.floor(context.inputStats.nodeCount / 2))),
    edges: context.crossRepoLinks.slice(0, Math.max(0, Math.floor(context.crossRepoLinks.length / 2))),
    summaries: context.summaries.slice(0, Math.max(1, Math.floor(context.summaries.length / 2))),
    warnings: [...context.retrievalWarnings, "RETRIEVAL_TOKEN_BUDGET_TRUNCATED"],
    omitted: {
      facts: context.inputStats.omittedFactCount + Math.ceil(context.facts.length / 2),
      evidence: context.inputStats.omittedEvidenceCount,
      nodes: context.inputStats.omittedNodeCount + Math.ceil(context.inputStats.nodeCount / 2),
      edges: context.inputStats.omittedEdgeCount + Math.ceil(context.crossRepoLinks.length / 2),
      summaries: context.inputStats.omittedSummaryCount + Math.ceil(context.summaries.length / 2)
    }
  });
}

function takeWithWarning<T>(items: T[], limit: number, label: string, extraOmitted = 0) {
  const omitted = Math.max(0, items.length - limit) + extraOmitted;
  return {
    items: items.slice(0, limit),
    omitted,
    warnings: omitted > 0 ? [`RETRIEVAL_${label.toUpperCase()}_TRUNCATED`] : []
  };
}

function fallbackResult(generationRunId: string, warning: string): RetrievalResult {
  return {
    generationRunId,
    usedFallback: true,
    contexts: [],
    retrievalWarnings: [warning],
    sourceHash: hashStable({ generationRunId, warning })
  };
}

function validEvidence(request: RetrievalRequest) {
  return request.evidence
    .filter((item) => item.generationRunId === request.generationRunId)
    .filter((item) => !hasLocalPath(item.filePath))
    .sort(compareEvidence);
}

function hasUsableEvidence(evidenceIds: string[], evidenceById: Map<string, RetrievalEvidenceInput>) {
  return evidenceIds.some((id) => evidenceById.has(id));
}

function hasKeptEvidence(evidenceIds: string[], keptEvidenceIds: Set<string>) {
  return evidenceIds.some((id) => keptEvidenceIds.has(id));
}

function factMatchesContext(fact: RetrievalFactInput, evidenceById: Map<string, RetrievalEvidenceInput>, linkedFiles: Set<string>, pageKey: string) {
  if (fact.repositoryRole === "BACKEND" && semanticMatch(pageKey, fact.text)) {
    return true;
  }
  return fact.evidenceIds.some((id) => {
    const evidence = evidenceById.get(id);
    return evidence ? linkedFiles.has(fileKey(evidence)) || pageKeyFromPath(evidence.filePath) === pageKey || (evidence.repositoryRole === "BACKEND" && semanticMatch(pageKey, `${evidence.filePath} ${evidence.summary}`)) : false;
  });
}

function summaryMatchesContext(summary: CodeSummary, linkedNodeKeys: Set<string>, linkedFiles: Set<string>, pageKey: string) {
  return (
    summary.sourceNodeKeys.some((key) => linkedNodeKeys.has(key)) ||
    (summary.source.filePath ? linkedFiles.has(fileKey({ ...summary.source, filePath: summary.source.filePath })) || pageKeyFromPath(summary.source.filePath) === pageKey : false) ||
    summary.source.moduleKey === `frontend-route:${pageKey}`
  );
}

function nodeMatchesPage(node: CodeMapNode, pageKey: string) {
  return node.kind === "UI_ROUTE" && (pageKeyFromPath(String(node.metadata.path ?? node.filePath)) === pageKey || normalizePage(node.label) === pageKey);
}

function pageKeysFromNodes(nodes: CodeMapNode[]) {
  return nodes.filter((node) => node.kind === "UI_ROUTE").map((node) => pageKeyFromPath(String(node.metadata.path ?? node.filePath)));
}

function rankFact(pageKey: string, fact: RetrievalFactInput, evidenceById: Map<string, RetrievalEvidenceInput>, linkedFiles: Set<string>) {
  const evidence = fact.evidenceIds.map((id) => evidenceById.get(id)).filter(isDefined);
  return Math.min(...evidence.map((item) => (pageKeyFromPath(item.filePath) === pageKey ? 0 : linkedFiles.has(fileKey(item)) ? 2 : item.repositoryRole === "BACKEND" && semanticMatch(pageKey, `${item.filePath} ${item.summary}`) ? 3 : 8))) - fact.confidence;
}

function rankNode(pageKey: string, node: CodeMapNode, linkedNodeKeys: Set<string>) {
  if (nodeMatchesPage(node, pageKey)) {
    return 0;
  }
  if (node.kind === "FRONTEND_API_CALL") {
    return 1;
  }
  if (linkedNodeKeys.has(node.stableKey)) {
    return node.repositoryRole === "BACKEND" ? 3 : 2;
  }
  return 9;
}

function rankEdge(edge: CodeMapEdge) {
  return edge.kind === "CALLS_API" ? 0 : 4;
}

function rankSummary(pageKey: string, summary: CodeSummary, linkedNodeKeys: Set<string>, linkedFiles: Set<string>) {
  if (summary.source.moduleKey === `frontend-route:${pageKey}`) {
    return 0;
  }
  if (summary.source.moduleKey?.startsWith("flow:")) {
    return 1;
  }
  if (summary.source.filePath && pageKeyFromPath(summary.source.filePath) === pageKey) {
    return 2;
  }
  if (summary.sourceNodeKeys.some((key) => linkedNodeKeys.has(key))) {
    return 3;
  }
  if (summary.source.filePath && linkedFiles.has(fileKey({ ...summary.source, filePath: summary.source.filePath }))) {
    return 4;
  }
  return 9;
}

function fileKey(item: { repositoryRole: RepositoryRole; repositoryFullName: string; filePath: string }) {
  return [item.repositoryRole, item.repositoryFullName, item.filePath].join("|");
}

function pageKeyFromPath(filePath: string) {
  const withoutExtension = filePath
    .replace(/^src\//, "")
    .replace(/^app\//, "")
    .replace(/^pages\//, "")
    .replace(/\/page\.(tsx|jsx|ts|js)$/, "")
    .replace(/\/route\.(ts|js)$/, "")
    .replace(/\.(tsx|jsx|ts|js)$/, "")
    .replace(/\/index$/, "")
    .replace(/^\/+/, "");
  return normalizePage(withoutExtension.replace(/^api\//, "api/").split("/").filter(Boolean).slice(0, 4).join(".")) || "frontend";
}

function normalizePage(value: string) {
  return value
    .replace(/\$\{[^}]+\}/g, "id")
    .replace(/\[[^\]]+\]/g, "id")
    .replace(/^\/+/, "")
    .replace(/\//g, ".")
    .replace(/\s+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
}

function semanticMatch(pageKey: string, value: string) {
  const tokens = pageTokens(pageKey);
  if (tokens.length === 0) {
    return false;
  }
  const normalized = value.toLowerCase();
  return tokens.some((token) => normalized.includes(token));
}

function pageTokens(pageKey: string) {
  const stopWords = new Set(["admin", "internal", "page", "detail", "create", "edit", "manage", "list", "id"]);
  return pageKey
    .replace(/\$\{[^}]+\}/g, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .split(/[^a-z0-9]+/i)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 4 && !stopWords.has(token));
}

function hasLocalPath(value: string) {
  return /(^|[ "'`])(?:\/tmp\/|\/private\/|\/Users\/|\/home\/|[A-Za-z]:\\)/.test(value);
}

function estimateTokens(value: unknown) {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function hashStable(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}

function compareFacts(left: RetrievalFactInput, right: RetrievalFactInput) {
  return (
    left.repositoryRole.localeCompare(right.repositoryRole) ||
    left.repositoryFullName.localeCompare(right.repositoryFullName) ||
    left.factKind.localeCompare(right.factKind) ||
    left.text.localeCompare(right.text) ||
    left.id.localeCompare(right.id)
  );
}

function compareEvidence(left: RetrievalEvidenceInput, right: RetrievalEvidenceInput) {
  return left.repositoryRole.localeCompare(right.repositoryRole) || left.repositoryFullName.localeCompare(right.repositoryFullName) || left.filePath.localeCompare(right.filePath) || left.sourceKind.localeCompare(right.sourceKind) || left.id.localeCompare(right.id);
}

function compareNodes(left: CodeMapNode, right: CodeMapNode) {
  return left.kind.localeCompare(right.kind) || left.stableKey.localeCompare(right.stableKey);
}

function compareEdges(left: CodeMapEdge, right: CodeMapEdge) {
  return left.kind.localeCompare(right.kind) || left.stableKey.localeCompare(right.stableKey);
}

function compareSummaries(left: CodeSummary, right: CodeSummary) {
  return left.type.localeCompare(right.type) || left.cacheKey.localeCompare(right.cacheKey);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
