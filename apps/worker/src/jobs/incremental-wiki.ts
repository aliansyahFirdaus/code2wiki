import { createHash } from "node:crypto";

import type { RetrievalContext } from "@code2wiki/analyzer";
import type { ProductWikiPageGroup } from "@code2wiki/ai";
import type { ProductWikiBlock, ProductWikiOutput } from "@code2wiki/document";

export const pageInputHashVersion = "page-input-v1";
export const incrementalReportVersion = 1;

export type GenerationStrategy = "GENERATED" | "REUSED";
export type IncrementalMode = "FULL" | "PARTIAL" | "REUSE_ONLY";

export type IncrementalPageMeta = {
  pageKey: string;
  inputHash: string;
  generationStrategy: GenerationStrategy;
  reusedFromGenerationRunId: string | null;
};

export type IncrementalReport = {
  version: number;
  baselineGenerationRunId: string | null;
  mode: IncrementalMode;
  generatedPageCount: number;
  reusedPageCount: number;
  affectedPageKeys: string[];
  reusedPageKeys: string[];
  reuseMissReasons: Record<string, string>;
  aiRequestCountSavedEstimate: number;
  pageInputHashVersion: string;
};

export type EvidenceFingerprintInput = {
  id: string;
  repositoryRole: "FRONTEND" | "BACKEND";
  repositoryFullName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  sourceKind: string;
  summary: string;
  codeSnippet: string;
};

export type WikiPageRowLike = {
  id: string;
  pageKey: string;
  title: string;
  inputHash: string | null;
};

export type WikiBlockRowLike = {
  id: string;
  parentBlockId: string | null;
  position: number;
  stableKey: string;
  type: string;
  origin: ProductWikiBlock["origin"];
  reviewState: ProductWikiBlock["reviewState"];
  sourceHash: string;
  contentHash: string;
  evidenceIds: string[];
  locked: boolean;
  blockJson: unknown;
};

export type PageInput = {
  pageKey: string;
  inputHash: string;
};

export function buildPageInput(input: {
  pageGroup: ProductWikiPageGroup;
  retrievalMode: "context" | "fallback";
  context?: RetrievalContext;
  evidenceById: Map<string, EvidenceFingerprintInput>;
}): PageInput {
  const fingerprintById = new Map([...input.evidenceById.entries()].map(([id, evidence]) => [id, evidenceFingerprint(evidence)]));
  const evidenceFingerprintForId = (id: string) => fingerprintById.get(id) ?? `missing:${id}`;

  const value = {
    version: pageInputHashVersion,
    pageKey: input.pageGroup.pageKey,
    title: input.pageGroup.title,
    retrievalMode: input.retrievalMode,
    facts: input.pageGroup.facts
      .map((fact) => ({
        repositoryRole: fact.repositoryRole,
        repositoryFullName: fact.repositoryFullName,
        factKind: fact.factKind,
        text: normalizeText(fact.text),
        confidence: fact.confidence,
        evidenceFingerprints: fact.evidenceIds.map(evidenceFingerprintForId).sort()
      }))
      .sort(compareCanonical),
    evidenceFingerprints: input.pageGroup.evidence.map((item) => evidenceFingerprintForId(item.id)).sort(),
    context: input.context ? canonicalContext(input.context, evidenceFingerprintForId) : null
  };

  return {
    pageKey: input.pageGroup.pageKey,
    inputHash: hashCanonical(value)
  };
}

export function evidenceFingerprint(evidence: EvidenceFingerprintInput) {
  return hashCanonical({
    version: "evidence-fingerprint-v1",
    repositoryRole: evidence.repositoryRole,
    repositoryFullName: evidence.repositoryFullName,
    filePath: evidence.filePath,
    startLine: evidence.startLine,
    endLine: evidence.endLine,
    sourceKind: evidence.sourceKind,
    codeSnippetHash: hashText(evidence.codeSnippet),
    summaryHash: hashText(normalizeText(evidence.summary))
  });
}

export function buildEvidenceRemap(input: {
  previousEvidence: EvidenceFingerprintInput[];
  currentEvidence: EvidenceFingerprintInput[];
}): { ok: true; idMap: Map<string, string> } | { ok: false; reason: string } {
  const previous = uniqueFingerprintMap(input.previousEvidence);
  const current = uniqueFingerprintMap(input.currentEvidence);

  if (!previous.ok) return { ok: false, reason: "duplicate_previous_evidence_fingerprint" };
  if (!current.ok) return { ok: false, reason: "duplicate_current_evidence_fingerprint" };

  const idMap = new Map<string, string>();
  for (const evidence of input.previousEvidence) {
    const currentId = current.byFingerprint.get(evidenceFingerprint(evidence));
    if (currentId) {
      idMap.set(evidence.id, currentId);
    }
  }
  return { ok: true, idMap };
}

export function buildPreviousPage(page: WikiPageRowLike, blocks: WikiBlockRowLike[]): ProductWikiOutput["pages"][number] {
  return {
    pageKey: page.pageKey,
    title: page.title,
    blocks: buildBlockTree(blocks.filter((block) => block.parentBlockId === null || blocks.some((candidate) => candidate.id === block.parentBlockId)))
  };
}

export function remapReusedPage(input: {
  generationRunId: string;
  page: ProductWikiOutput["pages"][number];
  evidenceIdMap: Map<string, string>;
}): { ok: true; page: ProductWikiOutput["pages"][number] } | { ok: false; reason: string } {
  const blocks = remapBlocks({
    generationRunId: input.generationRunId,
    pageKey: input.page.pageKey,
    blocks: input.page.blocks,
    evidenceIdMap: input.evidenceIdMap
  });

  if (!blocks.ok) {
    return blocks;
  }

  return {
    ok: true,
    page: {
      ...input.page,
      blocks: blocks.blocks
    }
  };
}

export function blockStableKeys(page: ProductWikiOutput["pages"][number]) {
  return flattenBlocks(page.blocks).map((block) => block.stableKey);
}

export function buildIncrementalReport(input: {
  baselineGenerationRunId: string | null;
  affectedPageKeys: string[];
  reusedPageKeys: string[];
  reuseMissReasons: Record<string, string>;
}): IncrementalReport {
  const affectedPageKeys = [...input.affectedPageKeys].sort();
  const reusedPageKeys = [...input.reusedPageKeys].sort();
  const mode: IncrementalMode =
    input.baselineGenerationRunId === null || reusedPageKeys.length === 0
      ? "FULL"
      : affectedPageKeys.length === 0
        ? "REUSE_ONLY"
        : "PARTIAL";

  return {
    version: incrementalReportVersion,
    baselineGenerationRunId: input.baselineGenerationRunId,
    mode,
    generatedPageCount: affectedPageKeys.length,
    reusedPageCount: reusedPageKeys.length,
    affectedPageKeys,
    reusedPageKeys,
    reuseMissReasons: Object.fromEntries(Object.entries(input.reuseMissReasons).sort(([left], [right]) => left.localeCompare(right))),
    aiRequestCountSavedEstimate: mode === "REUSE_ONLY" ? 1 : 0,
    pageInputHashVersion
  };
}

function canonicalContext(context: RetrievalContext, evidenceFingerprintForId: (id: string) => string) {
  return {
    pageKey: context.pageKey,
    moduleKeys: [...context.moduleKeys].sort(),
    frontend: {
      nodes: context.frontend.nodes.map((node) => canonicalNode(node, evidenceFingerprintForId)).sort(compareCanonical)
    },
    backend: {
      nodes: context.backend.nodes.map((node) => canonicalNode(node, evidenceFingerprintForId)).sort(compareCanonical)
    },
    crossRepoLinks: context.crossRepoLinks.map((edge) => canonicalEdge(edge, evidenceFingerprintForId)).sort(compareCanonical),
    summaries: context.summaries.map((summary) => canonicalSummary(summary, evidenceFingerprintForId)).sort(compareCanonical),
    warnings: [...context.retrievalWarnings].sort()
  };
}

function canonicalNode(node: RetrievalContext["frontend"]["nodes"][number], evidenceFingerprintForId: (id: string) => string) {
  return {
    stableKey: node.stableKey,
    kind: node.kind,
    repositoryRole: node.repositoryRole,
    repositoryFullName: node.repositoryFullName,
    label: normalizeText(node.label),
    filePath: node.filePath,
    metadata: node.metadata,
    confidence: node.confidence,
    evidenceFingerprints: node.evidenceIds.map(evidenceFingerprintForId).sort()
  };
}

function canonicalEdge(edge: RetrievalContext["crossRepoLinks"][number], evidenceFingerprintForId: (id: string) => string) {
  return {
    stableKey: edge.stableKey,
    kind: edge.kind,
    fromStableKey: edge.fromStableKey,
    toStableKey: edge.toStableKey,
    confidence: edge.confidence,
    evidenceFingerprints: edge.evidenceIds.map(evidenceFingerprintForId).sort()
  };
}

function canonicalSummary(summary: RetrievalContext["summaries"][number], evidenceFingerprintForId: (id: string) => string) {
  return {
    type: summary.type,
    confidence: summary.confidence,
    claims: summary.claims
      .map((claim) => ({
        text: normalizeText(claim.text),
        kind: claim.kind,
        confidence: claim.confidence,
        evidenceFingerprints: claim.evidenceIds.map(evidenceFingerprintForId).sort(),
        sourceNodeKeys: [...claim.sourceNodeKeys].sort()
      }))
      .sort(compareCanonical),
    evidenceFingerprints: summary.evidenceIds.map(evidenceFingerprintForId).sort(),
    sourceNodeKeys: [...summary.sourceNodeKeys].sort(),
    source: {
      repositoryRole: summary.source.repositoryRole,
      repositoryFullName: summary.source.repositoryFullName,
      filePath: summary.source.filePath,
      moduleKey: summary.source.moduleKey
    }
  };
}

function uniqueFingerprintMap(evidenceRows: EvidenceFingerprintInput[]): { ok: true; byFingerprint: Map<string, string> } | { ok: false } {
  const byFingerprint = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const evidence of evidenceRows) {
    const fingerprint = evidenceFingerprint(evidence);
    if (byFingerprint.has(fingerprint)) {
      duplicates.add(fingerprint);
    }
    byFingerprint.set(fingerprint, evidence.id);
  }
  return duplicates.size > 0 ? { ok: false } : { ok: true, byFingerprint };
}

function buildBlockTree(rows: WikiBlockRowLike[]): ProductWikiBlock[] {
  const blocks = new Map<string, ProductWikiBlock>();
  const children = new Map<string | null, WikiBlockRowLike[]>();

  for (const row of rows) {
    children.set(row.parentBlockId, [...(children.get(row.parentBlockId) ?? []), row]);
    blocks.set(row.id, normalizeBlock(row));
  }

  for (const list of children.values()) {
    list.sort((left, right) => left.position - right.position);
  }

  for (const [parentId, list] of children) {
    if (!parentId) continue;
    const parent = blocks.get(parentId);
    if (parent) {
      parent.children = list.map((row) => blocks.get(row.id)).filter(isDefined);
    }
  }

  return (children.get(null) ?? []).map((row) => blocks.get(row.id)).filter(isDefined);
}

function normalizeBlock(row: WikiBlockRowLike): ProductWikiBlock {
  const raw = typeof row.blockJson === "object" && row.blockJson ? row.blockJson : {};
  return {
    ...raw,
    id: row.id,
    stableKey: row.stableKey,
    type: row.type,
    origin: row.origin,
    reviewState: row.reviewState,
    sourceHash: row.sourceHash,
    contentHash: row.contentHash,
    evidenceIds: row.evidenceIds,
    locked: row.locked
  } as ProductWikiBlock;
}

function remapBlocks(input: {
  generationRunId: string;
  pageKey: string;
  blocks: ProductWikiBlock[];
  evidenceIdMap: Map<string, string>;
}): { ok: true; blocks: ProductWikiBlock[] } | { ok: false; reason: string } {
  const blocks: ProductWikiBlock[] = [];
  for (const block of input.blocks) {
    const remapped = remapBlock({ ...input, block });
    if (!remapped.ok) return remapped;
    blocks.push(remapped.block);
  }
  return { ok: true, blocks };
}

function remapBlock(input: {
  generationRunId: string;
  pageKey: string;
  block: ProductWikiBlock;
  evidenceIdMap: Map<string, string>;
}): { ok: true; block: ProductWikiBlock } | { ok: false; reason: string } {
  const evidenceIds = remapIds(input.block.evidenceIds ?? [], input.evidenceIdMap);
  if (!evidenceIds.ok) return evidenceIds;

  const relatedEvidenceIds = "relatedEvidenceIds" in input.block && input.block.relatedEvidenceIds
    ? remapIds(input.block.relatedEvidenceIds, input.evidenceIdMap)
    : { ok: true as const, ids: undefined };
  if (!relatedEvidenceIds.ok) return relatedEvidenceIds;

  const children = input.block.children
    ? remapBlocks({ ...input, blocks: input.block.children })
    : { ok: true as const, blocks: undefined };
  if (!children.ok) return children;

  const base = {
    ...input.block,
    id: `blk_${hashText([input.generationRunId, input.block.stableKey].join("|"))}`,
    evidenceIds: evidenceIds.ids,
    sourceHash: hashText([input.pageKey, input.block.type, ...evidenceIds.ids, ...(relatedEvidenceIds.ids ?? [])].join("|")),
    children: children.blocks
  };

  const withRelated =
    relatedEvidenceIds.ids && "relatedEvidenceIds" in base
      ? ({ ...base, relatedEvidenceIds: relatedEvidenceIds.ids } as ProductWikiBlock)
      : (base as ProductWikiBlock);
  const withRun =
    withRelated.type === "statement"
      ? ({ ...withRelated, lastGeneratedRunId: input.generationRunId } satisfies ProductWikiBlock)
      : withRelated;

  return {
    ok: true,
    block: {
      ...withRun,
      contentHash: hashText(JSON.stringify(blockContent(withRun)))
    }
  };
}

function remapIds(ids: string[], evidenceIdMap: Map<string, string>): { ok: true; ids: string[] } | { ok: false; reason: string } {
  const mapped: string[] = [];
  for (const id of ids) {
    const next = evidenceIdMap.get(id);
    if (!next) return { ok: false, reason: "missing_evidence_remap" };
    mapped.push(next);
  }
  return { ok: true, ids: mapped };
}

function blockContent(block: ProductWikiBlock) {
  return {
    type: block.type,
    text: "text" in block ? block.text : undefined,
    level: "level" in block ? block.level : undefined,
    confidence: "confidence" in block ? block.confidence : undefined,
    evidenceIds: block.evidenceIds,
    question: block.type === "open_question" ? block.question : undefined,
    reason: block.type === "open_question" ? block.reason : undefined,
    relatedEvidenceIds: block.type === "open_question" ? block.relatedEvidenceIds : undefined,
    tone: block.type === "callout" ? block.tone : undefined,
    pageId: block.type === "related_page" ? block.pageId : undefined,
    title: block.type === "related_page" ? block.title : undefined
  };
}

function flattenBlocks(blocks: ProductWikiBlock[]): ProductWikiBlock[] {
  return blocks.flatMap((block) => [block, ...(block.children ? flattenBlocks(block.children) : [])]);
}

function compareCanonical(left: unknown, right: unknown) {
  return JSON.stringify(canonicalize(left)).localeCompare(JSON.stringify(canonicalize(right)));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

function hashCanonical(value: unknown) {
  return hashText(JSON.stringify(canonicalize(value)));
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
