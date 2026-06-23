import { createHash } from "node:crypto";

import type { RepositoryRole } from "@code2wiki/shared";

import type { CodeMap, CodeMapEdge, CodeMapNode } from "./code-map";

export const summaryTypes = ["FILE", "MODULE"] as const;
export const summaryConfidences = ["HIGH", "MEDIUM", "LOW", "NEEDS_REVIEW"] as const;

export type SummaryType = (typeof summaryTypes)[number];
export type SummaryConfidence = (typeof summaryConfidences)[number];

export type SummaryClaim = {
  text: string;
  kind: string;
  confidence: SummaryConfidence;
  evidenceIds: string[];
  sourceNodeKeys: string[];
};

export type SummaryInputStats = {
  factCount: number;
  evidenceCount: number;
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
  omittedFactCount: number;
  omittedEvidenceCount: number;
};

export type SummarySource = {
  generationRunId: string;
  codeMapSourceHash: string;
  repositoryRole: RepositoryRole;
  repositoryFullName: string;
  commitSha: string;
  filePath?: string;
  moduleKey?: string;
};

export type CodeSummary = {
  type: SummaryType;
  cacheKey: string;
  sourceHash: string;
  inputHash: string;
  outputHash: string;
  confidence: SummaryConfidence;
  claims: SummaryClaim[];
  evidenceIds: string[];
  sourceNodeKeys: string[];
  inputStats: SummaryInputStats;
  source: SummarySource;
};

export type CodeFileSummary = CodeSummary & {
  type: "FILE";
};

export type CodeModuleSummary = CodeSummary & {
  type: "MODULE";
  fileSummaryCacheKeys: string[];
};

export type BuildCodeSummariesInput = {
  generationRunId: string;
  codeMap: CodeMap;
  facts: SummaryFactInput[];
  evidence: SummaryEvidenceInput[];
};

export type SummaryFactInput = {
  id: string;
  generationRunId: string;
  repositoryRole: RepositoryRole;
  repositoryFullName: string;
  commitSha: string;
  factKind: string;
  text: string;
  evidenceIds: string[];
  confidence: number;
};

export type SummaryEvidenceInput = {
  id: string;
  generationRunId: string;
  repositoryRole: RepositoryRole;
  repositoryFullName: string;
  commitSha: string;
  filePath: string;
  sourceKind: string;
  summary: string;
};

export type BuildCodeSummariesResult = {
  fileSummaries: CodeFileSummary[];
  moduleSummaries: CodeModuleSummary[];
};

const maxFactsPerFile = 40;
const maxEvidencePerFile = 20;
const maxFilesPerModule = 12;

export function buildCodeSummaries(input: BuildCodeSummariesInput): BuildCodeSummariesResult {
  const evidenceById = new Map(input.evidence.filter((item) => item.generationRunId === input.generationRunId).map((item) => [item.id, item]));
  const fileSummaries = buildFileSummaries(input, evidenceById);
  const moduleSummaries = buildModuleSummaries(input, fileSummaries);

  return {
    fileSummaries,
    moduleSummaries
  };
}

function buildFileSummaries(input: BuildCodeSummariesInput, evidenceById: Map<string, SummaryEvidenceInput>): CodeFileSummary[] {
  const fileGroups = new Map<string, { evidence: SummaryEvidenceInput[]; facts: SummaryFactInput[]; nodes: CodeMapNode[] }>();

  for (const item of input.evidence.filter((row) => row.generationRunId === input.generationRunId).sort(compareEvidence)) {
    const key = fileGroupKey(item);
    const group = fileGroups.get(key) ?? { evidence: [], facts: [], nodes: [] };
    group.evidence.push(item);
    fileGroups.set(key, group);
  }

  for (const fact of input.facts.filter((row) => row.generationRunId === input.generationRunId).sort(compareFacts)) {
    const evidence = fact.evidenceIds.map((id) => evidenceById.get(id)).filter(isPresent);
    for (const item of evidence) {
      const key = fileGroupKey(item);
      const group = fileGroups.get(key);
      if (group) {
        group.facts.push(fact);
      }
    }
  }

  for (const node of input.codeMap.nodes.sort(compareNodes)) {
    const key = fileGroupKey(nodeToGroupSource(input.generationRunId, node, evidenceById));
    const group = fileGroups.get(key);
    if (group) {
      group.nodes.push(node);
    }
  }

  return [...fileGroups.entries()]
    .map(([, group]) => finalizeFileSummary(input, group))
    .filter(isPresent)
    .sort(compareSummaries);
}

function finalizeFileSummary(
  input: BuildCodeSummariesInput,
  group: { evidence: SummaryEvidenceInput[]; facts: SummaryFactInput[]; nodes: CodeMapNode[] }
): CodeFileSummary | null {
  const evidence = uniqueById(group.evidence).sort(compareEvidence);
  if (evidence.length === 0) {
    return null;
  }

  const facts = uniqueById(group.facts).sort(compareFacts);
  const nodes = uniqueByStableKey(group.nodes).sort(compareNodes);
  const source = evidence[0];
  const boundedFacts = facts.slice(0, maxFactsPerFile);
  const boundedEvidence = evidence.slice(0, maxEvidencePerFile);
  const evidenceIds = uniqueSorted(boundedEvidence.map((item) => item.id));
  const nodeKeys = uniqueSorted(nodes.map((node) => node.stableKey));
  const claims = boundedFacts
    .map((fact) => claimFromFact(fact, evidenceIds, nodeKeys))
    .filter(isPresent);
  const inputStats = stats({
    factCount: facts.length,
    evidenceCount: evidence.length,
    nodeCount: nodes.length,
    edgeCount: 0,
    omittedFactCount: Math.max(0, facts.length - boundedFacts.length),
    omittedEvidenceCount: Math.max(0, evidence.length - boundedEvidence.length)
  });
  const sourceHash = hashStable({ facts: boundedFacts, evidence: boundedEvidence, nodes });
  const inputHash = hashStable({ sourceHash, inputStats, source });
  const summaryCacheKey = makeCacheKey(["FILE", source.repositoryRole, source.repositoryFullName, source.commitSha, source.filePath, sourceHash]);

  const summary: CodeFileSummary = {
    type: "FILE",
    cacheKey: summaryCacheKey,
    sourceHash,
    inputHash,
    outputHash: "",
    confidence: confidenceFromClaims(claims),
    claims,
    evidenceIds: uniqueSorted(claims.flatMap((claim) => claim.evidenceIds)),
    sourceNodeKeys: nodeKeys,
    inputStats,
    source: {
      generationRunId: input.generationRunId,
      codeMapSourceHash: input.codeMap.sourceHash,
      repositoryRole: source.repositoryRole,
      repositoryFullName: source.repositoryFullName,
      commitSha: source.commitSha,
      filePath: source.filePath
    }
  };

  return withOutputHash(summary);
}

function buildModuleSummaries(input: BuildCodeSummariesInput, fileSummaries: CodeFileSummary[]): CodeModuleSummary[] {
  const filesByNodeKey = new Map(fileSummaries.map((summary) => [nodeFileIdentity(summary), summary]));
  const moduleGroups = new Map<string, { key: string; summaries: CodeFileSummary[]; edges: CodeMapEdge[] }>();
  const addModule = (key: string, summaries: CodeFileSummary[], edges: CodeMapEdge[] = []) => {
    const usable = uniqueByCacheKey(summaries).sort(compareSummaries).slice(0, maxFilesPerModule);
    if (usable.length === 0) {
      return;
    }
    const group = moduleGroups.get(key) ?? { key, summaries: [], edges: [] };
    group.summaries = uniqueByCacheKey([...group.summaries, ...usable]);
    group.edges = uniqueByStableKey([...group.edges, ...edges]);
    moduleGroups.set(key, group);
  };

  for (const edge of input.codeMap.edges.filter((item) => item.kind === "CALLS_API").sort(compareEdges)) {
    const from = input.codeMap.nodes.find((node) => node.stableKey === edge.fromStableKey);
    const to = input.codeMap.nodes.find((node) => node.stableKey === edge.toStableKey);
    if (!from || !to) {
      continue;
    }
    const summaries = [filesByNodeKey.get(nodeIdentity(from)), filesByNodeKey.get(nodeIdentity(to))].filter(isPresent);
    addModule(`flow:${labelForNode(from)}->${labelForNode(to)}`, summaries, [edge]);
  }

  for (const node of input.codeMap.nodes.sort(compareNodes)) {
    const summary = filesByNodeKey.get(nodeIdentity(node));
    if (!summary) {
      continue;
    }
    if (node.kind === "UI_ROUTE") {
      addModule(`frontend-route:${labelForNode(node)}`, [summary]);
    } else if (node.kind === "BACKEND_API_ROUTE") {
      addModule(`backend-api:${labelForNode(node)}`, [summary]);
    }
  }

  for (const summary of fileSummaries) {
    addModule(`folder:${summary.source.repositoryRole}:${folderKey(summary.source.filePath ?? "")}`, [summary]);
  }

  return [...moduleGroups.values()]
    .map((group) => finalizeModuleSummary(input, group))
    .filter(isPresent)
    .sort(compareSummaries);
}

function finalizeModuleSummary(
  input: BuildCodeSummariesInput,
  group: { key: string; summaries: CodeFileSummary[]; edges: CodeMapEdge[] }
): CodeModuleSummary | null {
  const summaries = uniqueByCacheKey(group.summaries).sort(compareSummaries);
  if (summaries.length === 0) {
    return null;
  }

  const boundedSummaries = summaries.slice(0, maxFilesPerModule);
  const edgeClaims = group.edges.map((edge) => claimFromEdge(edge)).filter(isPresent);
  const claims = [...boundedSummaries.flatMap((summary) => summary.claims.slice(0, 5)), ...edgeClaims];
  const source = boundedSummaries[0].source;
  const evidenceIds = uniqueSorted(claims.flatMap((claim) => claim.evidenceIds));
  const nodeKeys = uniqueSorted([...boundedSummaries.flatMap((summary) => summary.sourceNodeKeys), ...group.edges.flatMap((edge) => [edge.fromStableKey, edge.toStableKey])]);
  const inputStats = stats({
    factCount: boundedSummaries.reduce((count, summary) => count + summary.inputStats.factCount, 0),
    evidenceCount: boundedSummaries.reduce((count, summary) => count + summary.inputStats.evidenceCount, 0),
    nodeCount: nodeKeys.length,
    edgeCount: group.edges.length,
    omittedFactCount: boundedSummaries.reduce((count, summary) => count + summary.inputStats.omittedFactCount, 0),
    omittedEvidenceCount: boundedSummaries.reduce((count, summary) => count + summary.inputStats.omittedEvidenceCount, 0)
  });
  const sourceHash = hashStable({
    groupKey: group.key,
    fileHashes: boundedSummaries.map((summary) => summary.outputHash),
    edges: group.edges
  });
  const inputHash = hashStable({ sourceHash, inputStats, groupKey: group.key });
  const summaryCacheKey = makeCacheKey(["MODULE", input.generationRunId, group.key, sourceHash]);

  const summary: CodeModuleSummary = {
    type: "MODULE",
    cacheKey: summaryCacheKey,
    sourceHash,
    inputHash,
    outputHash: "",
    confidence: confidenceFromClaims(claims),
    claims,
    evidenceIds,
    sourceNodeKeys: nodeKeys,
    inputStats,
    source: {
      generationRunId: input.generationRunId,
      codeMapSourceHash: input.codeMap.sourceHash,
      repositoryRole: source.repositoryRole,
      repositoryFullName: source.repositoryFullName,
      commitSha: source.commitSha,
      moduleKey: group.key
    },
    fileSummaryCacheKeys: boundedSummaries.map((summary) => summary.cacheKey)
  };

  return withOutputHash(summary);
}

function claimFromFact(fact: SummaryFactInput, allowedEvidenceIds: string[], sourceNodeKeys: string[]): SummaryClaim | null {
  const evidenceIds = fact.evidenceIds.filter((id) => allowedEvidenceIds.includes(id)).sort();
  if (evidenceIds.length === 0) {
    return null;
  }
  return {
    text: fact.text,
    kind: fact.factKind,
    confidence: confidenceFromScore(fact.confidence),
    evidenceIds,
    sourceNodeKeys
  };
}

function claimFromEdge(edge: CodeMapEdge): SummaryClaim | null {
  if (edge.evidenceIds.length === 0) {
    return null;
  }
  return {
    text: `${edge.kind} ${edge.fromStableKey} -> ${edge.toStableKey}`,
    kind: edge.kind,
    confidence: edge.confidence,
    evidenceIds: uniqueSorted(edge.evidenceIds),
    sourceNodeKeys: uniqueSorted([edge.fromStableKey, edge.toStableKey])
  };
}

function withOutputHash<T extends CodeSummary>(summary: T): T {
  const outputHash = hashStable({ ...summary, outputHash: "" });
  return { ...summary, outputHash };
}

function stats(input: Omit<SummaryInputStats, "truncated">): SummaryInputStats {
  return {
    ...input,
    truncated: input.omittedFactCount > 0 || input.omittedEvidenceCount > 0
  };
}

function nodeToGroupSource(generationRunId: string, node: CodeMapNode, evidenceById: Map<string, SummaryEvidenceInput>): SummaryEvidenceInput {
  const evidence = node.evidenceIds.map((id) => evidenceById.get(id)).filter(isDefined)[0];
  return (
    evidence ?? {
      id: node.stableKey,
      generationRunId,
      repositoryRole: node.repositoryRole,
      repositoryFullName: node.repositoryFullName,
      commitSha: "",
      filePath: node.filePath,
      sourceKind: node.kind,
      summary: node.label
    }
  );
}

function fileGroupKey(item: Pick<SummaryEvidenceInput, "repositoryRole" | "repositoryFullName" | "commitSha" | "filePath">) {
  return [item.repositoryRole, item.repositoryFullName, item.commitSha, item.filePath].join("|");
}

function nodeFileIdentity(summary: CodeFileSummary) {
  return [summary.source.repositoryRole, summary.source.repositoryFullName, summary.source.filePath].join("|");
}

function nodeIdentity(node: CodeMapNode) {
  return [node.repositoryRole, node.repositoryFullName, node.filePath].join("|");
}

function labelForNode(node: CodeMapNode) {
  const path = typeof node.metadata.path === "string" ? node.metadata.path : node.label;
  return normalizePart(path);
}

function folderKey(filePath: string) {
  const parts = filePath.split("/").filter(Boolean).slice(0, 2);
  return parts.length > 0 ? parts.join("/") : "root";
}

function confidenceFromScore(score: number): SummaryConfidence {
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

function confidenceFromClaims(claims: SummaryClaim[]): SummaryConfidence {
  if (claims.some((claim) => claim.confidence === "HIGH")) {
    return "HIGH";
  }
  if (claims.some((claim) => claim.confidence === "MEDIUM")) {
    return "MEDIUM";
  }
  if (claims.some((claim) => claim.confidence === "LOW")) {
    return "LOW";
  }
  return "NEEDS_REVIEW";
}

function makeCacheKey(parts: string[]) {
  return `summary_${hashStable(parts.map(normalizePart))}`;
}

function hashStable(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function normalizePart(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}

function uniqueById<T extends { id: string }>(items: T[]) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function uniqueByStableKey<T extends { stableKey: string }>(items: T[]) {
  return [...new Map(items.map((item) => [item.stableKey, item])).values()];
}

function uniqueByCacheKey<T extends { cacheKey: string }>(items: T[]) {
  return [...new Map(items.map((item) => [item.cacheKey, item])).values()];
}

function compareFacts(left: SummaryFactInput, right: SummaryFactInput) {
  return left.repositoryRole.localeCompare(right.repositoryRole) || left.repositoryFullName.localeCompare(right.repositoryFullName) || left.factKind.localeCompare(right.factKind) || left.text.localeCompare(right.text) || left.id.localeCompare(right.id);
}

function compareEvidence(left: SummaryEvidenceInput, right: SummaryEvidenceInput) {
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

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
