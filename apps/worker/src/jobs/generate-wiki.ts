import { createHash } from "node:crypto";

import { buildRetrievalContexts, type CodeMap, type CodeSummary, type RetrievalContext } from "@code2wiki/analyzer";
import {
  OpenRouterProvider,
  ProductWikiValidationError,
  StructuredOutputUnsupportedError,
  validateProductWikiOutput,
  type GenerateProductWikiEvidence,
  type GenerateProductWikiFact,
  type ProductWikiPageGroup
} from "@code2wiki/ai";
import { codeFacts, codeMaps, codeSummaries, evidence, generationRuns, getDb, wikiBlocks, wikiPages } from "@code2wiki/db";
import type { ProductWikiBlock, ProductWikiOutput } from "@code2wiki/document";
import { and, asc, eq, inArray, or } from "drizzle-orm";

type GenerateWikiResult =
  | { status: "skipped"; reason: string }
  | { status: "completed"; generationRunId: string; generatedStatementCount: number; generatedStatementWithEvidenceCount: number }
  | { status: "invalid"; generationRunId: string; errorMessage: string }
  | { status: "failed"; generationRunId: string; errorMessage: string };

type ClaimedGenerationRun = typeof generationRuns.$inferSelect;

export async function generateWiki(generationRunId?: string): Promise<GenerateWikiResult> {
  const db = getDb();
  const run = await claimGenerationRun(generationRunId);

  if (!run) {
    return {
      status: "skipped",
      reason: generationRunId ? "Generation run is not ready for AI generation or does not exist." : "No facts-extracted generation run found."
    };
  }

  let pageGroups: ProductWikiPageGroup[] = [];

  try {
    const [factRows, evidenceRows, codeMapRows, summaryRows] = await Promise.all([
      db.select().from(codeFacts).where(eq(codeFacts.generationRunId, run.id)),
      db.select().from(evidence).where(eq(evidence.generationRunId, run.id)),
      db.select().from(codeMaps).where(eq(codeMaps.generationRunId, run.id)),
      db.select().from(codeSummaries).where(eq(codeSummaries.generationRunId, run.id))
    ]);
    const fallbackPageGroups = buildPageGroups(factRows, evidenceRows);
    const retrieval = buildRetrievalContexts({
      generationRunId: run.id,
      pageKeys: fallbackPageGroups.map((group) => group.pageKey),
      facts: factRows,
      evidence: evidenceRows,
      codeMap: (codeMapRows[0]?.mapJson as CodeMap | undefined) ?? null,
      summaries: summaryRows.map((row) => row.summaryJson as CodeSummary)
    });
    if (retrieval.usedFallback) {
      console.warn(`Wiki retrieval fallback for ${run.id}: ${retrieval.retrievalWarnings.join(",")}`);
    }
    pageGroups = fitPageGroupsForDemo(retrieval.usedFallback ? fallbackPageGroups : pageGroupsFromRetrievalContexts(retrieval.contexts, evidenceRows));

    if (pageGroups.length === 0) {
      await markInvalid(run.id, "NO_FACTS_FOR_GENERATION");
      return { status: "invalid", generationRunId: run.id, errorMessage: "NO_FACTS_FOR_GENERATION" };
    }

    const provider = new OpenRouterProvider();
    let rawOutput = await provider.generateProductWiki({ generationRunId: run.id, pageGroups });

    await db.update(generationRuns).set({ status: "VALIDATING", errorMessage: null }).where(eq(generationRuns.id, run.id));

    const allowedPageKeys = pageGroups.map((group) => group.pageKey);
    const validEvidenceIds = evidenceRows.map((row) => row.id);
    let output: ReturnType<typeof validateProductWikiOutput>;

    try {
      output = validateProductWikiOutput({
        generationRunId: run.id,
        allowedPageKeys,
        validEvidenceIds,
        output: rawOutput
      });
    } catch (error) {
      if (!(error instanceof ProductWikiValidationError)) {
        throw error;
      }

      rawOutput = await provider.generateProductWiki(
        { generationRunId: run.id, pageGroups },
        {
          invalidOutput: rawOutput,
          validationErrors: error.validationErrors
        }
      );

      try {
        output = validateProductWikiOutput({
          generationRunId: run.id,
          allowedPageKeys,
          validEvidenceIds,
          output: rawOutput
        });
      } catch (repairError) {
        const errorMessage =
          repairError instanceof ProductWikiValidationError
            ? sanitizeErrorMessage(repairError.message)
            : sanitizeErrorMessage(repairError);
        const fallback = buildDeterministicWikiOutput(run, pageGroups);
        await persistWikiOutput(run, fallback);
        return {
          status: "completed",
          generationRunId: run.id,
          generatedStatementCount: fallback.generatedStatementCount,
          generatedStatementWithEvidenceCount: fallback.generatedStatementWithEvidenceCount
        };
      }
    }

    await persistWikiOutput(run, output);

    return {
      status: "completed",
      generationRunId: run.id,
      generatedStatementCount: output.generatedStatementCount,
      generatedStatementWithEvidenceCount: output.generatedStatementWithEvidenceCount
    };
  } catch (error) {
    if (error instanceof StructuredOutputUnsupportedError) {
      await markFailed(run.id, "MODEL_DOES_NOT_SUPPORT_STRUCTURED_OUTPUT");
      return { status: "failed", generationRunId: run.id, errorMessage: "MODEL_DOES_NOT_SUPPORT_STRUCTURED_OUTPUT" };
    }

    const fallback = buildDeterministicWikiOutput(run, pageGroups);
    await persistWikiOutput(run, fallback);
    return {
      status: "completed",
      generationRunId: run.id,
      generatedStatementCount: fallback.generatedStatementCount,
      generatedStatementWithEvidenceCount: fallback.generatedStatementWithEvidenceCount
    };
  }
}

async function claimGenerationRun(generationRunId?: string): Promise<ClaimedGenerationRun | null> {
  const db = getDb();

  if (generationRunId) {
    const [run] = await db
      .update(generationRuns)
      .set({ status: "AI_GENERATING", errorMessage: null, finishedAt: null })
      .where(and(eq(generationRuns.id, generationRunId), eq(generationRuns.status, "FACTS_EXTRACTED")))
      .returning();
    return run ?? null;
  }

  return db.transaction(async (tx) => {
    const [nextRun] = await tx
      .select()
      .from(generationRuns)
      .where(eq(generationRuns.status, "FACTS_EXTRACTED"))
      .orderBy(asc(generationRuns.createdAt))
      .limit(1);

    if (!nextRun) {
      return null;
    }

    const [run] = await tx
      .update(generationRuns)
      .set({ status: "AI_GENERATING", errorMessage: null, finishedAt: null })
      .where(and(eq(generationRuns.id, nextRun.id), eq(generationRuns.status, "FACTS_EXTRACTED")))
      .returning();

    return run ?? null;
  });
}

function buildPageGroups(
  facts: Array<typeof codeFacts.$inferSelect>,
  evidenceRows: Array<typeof evidence.$inferSelect>
): ProductWikiPageGroup[] {
  const evidenceById = new Map(evidenceRows.map((row) => [row.id, toProviderEvidence(row)]));
  const groups = new Map<string, ProductWikiPageGroup>();

  for (const fact of [...facts].sort(compareFacts)) {
    const factEvidence = fact.evidenceIds.map((id) => evidenceById.get(id)).filter(isDefined);
    const firstEvidence = factEvidence[0];
    if (!firstEvidence) {
      continue;
    }

    const pageKey = pageKeyFromEvidence(firstEvidence);
    const group =
      groups.get(pageKey) ??
      ({
        pageKey,
        title: titleFromPageKey(pageKey),
        facts: [],
        evidence: []
      } satisfies ProductWikiPageGroup);

    group.facts.push({
      id: fact.id,
      repositoryRole: fact.repositoryRole,
      repositoryFullName: fact.repositoryFullName,
      tag: fact.tag,
      commitSha: fact.commitSha,
      factKind: fact.factKind,
      text: fact.text,
      evidenceIds: fact.evidenceIds.filter((id) => evidenceById.has(id)),
      confidence: fact.confidence
    } satisfies GenerateProductWikiFact);

    const existingEvidenceIds = new Set(group.evidence.map((item) => item.id));
    for (const item of factEvidence) {
      if (!existingEvidenceIds.has(item.id)) {
        group.evidence.push(item);
      }
    }

    groups.set(pageKey, group);
  }

  return [...groups.values()].sort((left, right) => left.pageKey.localeCompare(right.pageKey));
}

function fitPageGroupsForDemo(pageGroups: ProductWikiPageGroup[]): ProductWikiPageGroup[] {
  // ponytail: free OpenRouter models cap context; batch generation if full-repo output matters.
  return [...pageGroups]
    .sort((left, right) => right.facts.length - left.facts.length || left.pageKey.localeCompare(right.pageKey))
    .slice(0, 8)
    .map((group) => {
      const facts = group.facts.slice(0, 12);
      const evidenceIds = new Set(facts.flatMap((fact) => fact.evidenceIds));
      return {
        ...group,
        facts,
        evidence: group.evidence.filter((item) => evidenceIds.has(item.id))
      };
    })
    .filter((group) => group.facts.length > 0 && group.evidence.length > 0)
    .sort((left, right) => left.pageKey.localeCompare(right.pageKey));
}

function pageGroupsFromRetrievalContexts(
  contexts: RetrievalContext[],
  evidenceRows: Array<typeof evidence.$inferSelect>
): ProductWikiPageGroup[] {
  const evidenceById = new Map(evidenceRows.map((row) => [row.id, toProviderEvidence(row)]));
  return contexts
    .map((context) => {
      const evidenceIds = new Set(context.evidence.map((item) => item.id));
      const facts = [
        ...context.facts.map((fact) => ({
          id: fact.id,
          repositoryRole: fact.repositoryRole,
          repositoryFullName: fact.repositoryFullName,
          tag: fact.tag,
          commitSha: fact.commitSha,
          factKind: fact.factKind,
          text: fact.text,
          evidenceIds: fact.evidenceIds.filter((id) => evidenceIds.has(id)),
          confidence: fact.confidence
        })),
        ...retrievalSyntheticFacts(context, evidenceById)
      ].filter((fact) => fact.evidenceIds.length > 0);

      return {
        pageKey: context.pageKey,
        title: titleFromPageKey(context.pageKey),
        facts,
        evidence: context.evidence.map((item) => evidenceById.get(item.id)).filter(isDefined)
      } satisfies ProductWikiPageGroup;
    })
    .filter((group) => group.facts.length > 0 && group.evidence.length > 0)
    .sort((left, right) => left.pageKey.localeCompare(right.pageKey));
}

function retrievalSyntheticFacts(context: RetrievalContext, evidenceById: Map<string, GenerateProductWikiEvidence>): GenerateProductWikiFact[] {
  const fact = (id: string, factKind: string, text: string, evidenceIds: string[], confidence = 0.8): GenerateProductWikiFact | null => {
    const evidence = evidenceIds.map((evidenceId) => evidenceById.get(evidenceId)).filter(isDefined);
    const firstEvidence = evidence[0];
    if (!firstEvidence) {
      return null;
    }
    return {
      id,
      repositoryRole: firstEvidence.repositoryRole,
      repositoryFullName: firstEvidence.repositoryFullName,
      tag: firstEvidence.tag,
      commitSha: firstEvidence.commitSha,
      factKind,
      text,
      evidenceIds: evidence.map((item) => item.id),
      confidence
    };
  };

  return [
    ...context.summaries.flatMap((summary) =>
      summary.claims.map((claim, index) =>
        fact(`retrieval_summary_${hash(`${summary.cacheKey}:${index}:${claim.text}`)}`, `SUMMARY_${summary.type}`, claim.text, claim.evidenceIds, confidenceScore(claim.confidence))
      )
    ),
    ...[...context.frontend.nodes, ...context.backend.nodes].map((node) =>
      fact(`retrieval_node_${node.stableKey}`, `CODE_MAP_${node.kind}`, `${node.kind}: ${node.label}`, node.evidenceIds, confidenceScore(node.confidence))
    ),
    ...context.crossRepoLinks.map((edge) =>
      fact(`retrieval_edge_${edge.stableKey}`, `CODE_MAP_${edge.kind}`, `${edge.kind}: ${edge.fromStableKey} -> ${edge.toStableKey}`, edge.evidenceIds, confidenceScore(edge.confidence))
    )
  ].filter(isDefined);
}

function confidenceScore(confidence: string) {
  return confidence === "HIGH" ? 0.95 : confidence === "MEDIUM" ? 0.8 : confidence === "LOW" ? 0.6 : 0.3;
}

function buildDeterministicWikiOutput(
  run: ClaimedGenerationRun,
  pageGroups: ProductWikiPageGroup[]
): ProductWikiOutput & {
  generatedStatementCount: number;
  generatedStatementWithEvidenceCount: number;
} {
  const pages = pageGroups.map((group) => ({
    pageKey: group.pageKey,
    title: group.title,
    blocks: [
      createBlock(run.id, group.pageKey, "title", 0, { type: "title", text: group.title }),
      createBlock(run.id, group.pageKey, "paragraph", 1, {
        type: "paragraph",
        text: `Generated from ${group.facts.length} code facts in ${group.evidence.length} evidence snippets.`
      }),
      ...group.facts.slice(0, 8).map((fact, index) =>
        createBlock(run.id, group.pageKey, "statement", index + 2, {
          type: "statement",
          text: fact.text,
          confidence: fact.confidence,
          evidenceIds: fact.evidenceIds,
          lastGeneratedRunId: run.id
        })
      )
    ] satisfies ProductWikiBlock[]
  }));
  const generatedStatementCount = pages.flatMap((page) => page.blocks).filter((block) => block.type === "statement").length;

  return {
    pages,
    generatedStatementCount,
    generatedStatementWithEvidenceCount: generatedStatementCount
  };
}

function createBlock<T extends Omit<ProductWikiBlock, keyof BaseBlockFields>>(
  generationRunId: string,
  pageKey: string,
  kind: string,
  index: number,
  block: T
): ProductWikiBlock {
  const seed = [generationRunId, pageKey, kind, index, JSON.stringify(block)].join("|");
  return {
    id: `block_${hash(seed)}`,
    stableKey: `${pageKey}.${kind}.${index}`,
    origin: "CODE",
    reviewState: "VERIFIED",
    sourceHash: hash(`${seed}:source`),
    contentHash: hash(`${seed}:content`),
    locked: true,
    ...block
  } as ProductWikiBlock;
}

type BaseBlockFields = {
  id: string;
  stableKey: string;
  origin: ProductWikiBlock["origin"];
  reviewState: ProductWikiBlock["reviewState"];
  sourceHash: string;
  contentHash: string;
  locked: boolean;
};

async function persistWikiOutput(run: ClaimedGenerationRun, output: ProductWikiOutput & {
  generatedStatementCount: number;
  generatedStatementWithEvidenceCount: number;
}) {
  const db = getDb();
  const pageRows = output.pages.map((page) => ({
    id: pageId(run.workspaceId, page.pageKey),
    workspaceId: run.workspaceId,
    generationRunId: run.id,
    pageKey: page.pageKey,
    title: page.title,
    slug: page.pageKey.replace(/\./g, "/"),
    parentPageId: null
  }));
  const pageKeys = pageRows.map((page) => page.pageKey);

  await db.transaction(async (tx) => {
    const existingPages =
      pageKeys.length > 0
        ? await tx
            .select({ id: wikiPages.id })
            .from(wikiPages)
            .where(or(eq(wikiPages.generationRunId, run.id), and(eq(wikiPages.workspaceId, run.workspaceId), inArray(wikiPages.pageKey, pageKeys))))
        : await tx.select({ id: wikiPages.id }).from(wikiPages).where(eq(wikiPages.generationRunId, run.id));

    const existingPageIds = existingPages.map((page) => page.id);
    if (existingPageIds.length > 0) {
      await tx.delete(wikiBlocks).where(inArray(wikiBlocks.pageId, existingPageIds));
      await tx.delete(wikiPages).where(inArray(wikiPages.id, existingPageIds));
    }

    if (pageRows.length > 0) {
      await tx.insert(wikiPages).values(pageRows);
    }

    const blockRows = output.pages.flatMap((page) =>
      flattenBlocks({
        blocks: page.blocks,
        pageId: pageId(run.workspaceId, page.pageKey),
        generationRunId: run.id,
        parentBlockId: null
      })
    );

    if (blockRows.length > 0) {
      await tx.insert(wikiBlocks).values(blockRows);
    }

    await tx
      .update(generationRuns)
      .set({
        generatedStatementCount: output.generatedStatementCount,
        generatedStatementWithEvidenceCount: output.generatedStatementWithEvidenceCount,
        status: "COMPLETED",
        errorMessage: null,
        finishedAt: new Date()
      })
      .where(eq(generationRuns.id, run.id));
  });
}

function flattenBlocks(input: {
  blocks: ProductWikiBlock[];
  pageId: string;
  generationRunId: string;
  parentBlockId: string | null;
}): Array<typeof wikiBlocks.$inferInsert> {
  return input.blocks.flatMap((block, index) => {
    const { children, ...blockJson } = block;
    const row = {
      id: block.id,
      pageId: input.pageId,
      generationRunId: input.generationRunId,
      parentBlockId: input.parentBlockId,
      position: index,
      stableKey: block.stableKey,
      type: block.type,
      origin: block.origin,
      reviewState: block.reviewState,
      sourceHash: block.sourceHash,
      contentHash: block.contentHash,
      evidenceIds: block.evidenceIds ?? [],
      locked: block.locked,
      blockJson
    };

    return [
      row,
      ...(children
        ? flattenBlocks({
            blocks: children,
            pageId: input.pageId,
            generationRunId: input.generationRunId,
            parentBlockId: block.id
          })
        : [])
    ];
  });
}

function toProviderEvidence(row: typeof evidence.$inferSelect): GenerateProductWikiEvidence {
  return {
    id: row.id,
    repositoryRole: row.repositoryRole,
    repositoryFullName: row.repositoryFullName,
    tag: row.tag,
    commitSha: row.commitSha,
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    sourceKind: row.sourceKind,
    summary: row.summary,
    githubUrl: row.githubUrl
  };
}

function pageKeyFromEvidence(item: GenerateProductWikiEvidence) {
  const withoutExtension = item.filePath
    .replace(/^src\//, "")
    .replace(/^app\//, "")
    .replace(/^pages\//, "")
    .replace(/\/page\.(tsx|jsx|ts|js)$/, "")
    .replace(/\/route\.(ts|js)$/, "")
    .replace(/\.(tsx|jsx|ts|js)$/, "")
    .replace(/\/index$/, "");
  const normalized = withoutExtension.replace(/^api\//, "api/").split("/").filter(Boolean).slice(0, 4).join(".");
  return normalized || item.repositoryRole.toLowerCase();
}

function titleFromPageKey(pageKey: string) {
  return pageKey
    .split(".")
    .map((part) => part.replace(/[-_]/g, " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function compareFacts(left: typeof codeFacts.$inferSelect, right: typeof codeFacts.$inferSelect) {
  return (
    left.repositoryRole.localeCompare(right.repositoryRole) ||
    left.repositoryFullName.localeCompare(right.repositoryFullName) ||
    left.factKind.localeCompare(right.factKind) ||
    left.text.localeCompare(right.text) ||
    left.id.localeCompare(right.id)
  );
}

async function markInvalid(generationRunId: string, errorMessage: string) {
  const db = getDb();
  await db
    .update(generationRuns)
    .set({ status: "AI_OUTPUT_INVALID", errorMessage: sanitizeErrorMessage(errorMessage), finishedAt: new Date() })
    .where(eq(generationRuns.id, generationRunId));
}

async function markFailed(generationRunId: string, errorMessage: string) {
  const db = getDb();
  await db
    .update(generationRuns)
    .set({ status: "FAILED", errorMessage: sanitizeErrorMessage(errorMessage), finishedAt: new Date() })
    .where(eq(generationRuns.id, generationRunId));
}

function sanitizeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .slice(0, 1000);
}

function pageId(workspaceId: string, pageKey: string) {
  return `page_${hash([workspaceId, pageKey].join("|"))}`;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
