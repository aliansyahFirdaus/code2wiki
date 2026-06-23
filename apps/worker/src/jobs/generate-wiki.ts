import { createHash } from "node:crypto";

import { buildRetrievalContexts, type CodeMap, type CodeSummary, type RetrievalContext } from "@code2wiki/analyzer";
import {
  buildAiUsageCall,
  buildAiUsageReport,
  createAIProvider,
  ProductWikiValidationError,
  resolveAIProviderConfig,
  StructuredOutputUnsupportedError,
  validateQuality,
  type AiUsageCall,
  type AiUsageReport,
  validateProductWikiOutput,
  type GenerateProductWikiEvidence,
  type GenerateProductWikiFact,
  type QualityReport,
  type ProductWikiPageGroup
} from "@code2wiki/ai";
import { codeFacts, codeMaps, codeSummaries, evidence, generationRuns, getDb, wikiBlocks, wikiPages } from "@code2wiki/db";
import type { ProductWikiBlock, ProductWikiOutput } from "@code2wiki/document";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import {
  blockStableKeys,
  buildEvidenceRemap,
  buildIncrementalReport,
  buildPageInput,
  buildPreviousPage,
  type IncrementalPageMeta,
  type IncrementalReport,
  pageInputHashVersion,
  remapReusedPage
} from "./incremental-wiki";

type GenerateWikiResult =
  | { status: "skipped"; reason: string }
  | { status: "completed"; generationRunId: string; generatedStatementCount: number; generatedStatementWithEvidenceCount: number }
  | { status: "invalid"; generationRunId: string; errorMessage: string }
  | { status: "failed"; generationRunId: string; errorMessage: string };

type ClaimedGenerationRun = typeof generationRuns.$inferSelect;
type ReusePlan = {
  baselineGenerationRunId: string | null;
  affectedPageKeys: string[];
  reusedPages: Array<{ page: ProductWikiOutput["pages"][number]; stableKeys: string[] }>;
  reuseMissReasons: Record<string, string>;
};

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
  const usageCalls: AiUsageCall[] = [];
  let incrementalReport: IncrementalReport | undefined;

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
      incrementalReport = buildIncrementalReport({
        baselineGenerationRunId: null,
        affectedPageKeys: [],
        reusedPageKeys: [],
        reuseMissReasons: { __run: `no_page_inputs_${pageInputHashVersion}` }
      });
      await markInvalid(run.id, "NO_FACTS_FOR_GENERATION", invalidOutputQualityReport(), buildAiUsageReport([]), incrementalReport);
      return { status: "invalid", generationRunId: run.id, errorMessage: "NO_FACTS_FOR_GENERATION" };
    }

    const providerConfig = resolveAIProviderConfig();
    await db.update(generationRuns).set({ status: "VALIDATING", errorMessage: null }).where(eq(generationRuns.id, run.id));

    const allowedPageKeys = pageGroups.map((group) => group.pageKey);
    const validEvidenceIds = evidenceRows.map((row) => row.id);
    const pageInputByKey = new Map(
      pageGroups.map((pageGroup) => [
        pageGroup.pageKey,
        buildPageInput({
          pageGroup,
          retrievalMode: retrieval.usedFallback ? "fallback" : "context",
          context: retrieval.contexts.find((context) => context.pageKey === pageGroup.pageKey),
          evidenceById: new Map(evidenceRows.map((row) => [row.id, row]))
        })
      ])
    );
    const reusePlan = await buildReusePlan({
      run,
      pageGroups,
      pageInputByKey,
      currentEvidence: evidenceRows
    });
    const affectedPageKeys = new Set(reusePlan.affectedPageKeys);
    const reusedPages: ProductWikiOutput["pages"] = [];
    const reusedPageKeys = new Set<string>();
    const reuseMissReasons = { ...reusePlan.reuseMissReasons };

    for (const candidate of reusePlan.reusedPages) {
      try {
        const validated = validateProductWikiOutput({
          generationRunId: run.id,
          allowedPageKeys: [candidate.page.pageKey],
          validEvidenceIds,
          output: { pages: [candidate.page] }
        }).pages[0];
        if (blockStableKeys(validated).join("|") !== candidate.stableKeys.join("|")) {
          affectedPageKeys.add(candidate.page.pageKey);
          reuseMissReasons[candidate.page.pageKey] = "stable_key_changed";
          continue;
        }
        reusedPages.push(validated);
        reusedPageKeys.add(candidate.page.pageKey);
      } catch {
        affectedPageKeys.add(candidate.page.pageKey);
        reuseMissReasons[candidate.page.pageKey] = "reused_page_validation_failed";
      }
    }

    const affectedPageGroups = pageGroups.filter((group) => affectedPageKeys.has(group.pageKey));
    let generatedPages: ProductWikiOutput["pages"] = [];
    incrementalReport = buildIncrementalReport({
      baselineGenerationRunId: reusePlan.baselineGenerationRunId,
      affectedPageKeys: [...affectedPageKeys],
      reusedPageKeys: [...reusedPageKeys],
      reuseMissReasons
    });

    if (affectedPageGroups.length > 0) {
      const provider = createAIProvider(providerConfig);
      let generationResult = await provider.generateProductWiki({ generationRunId: run.id, pageGroups: affectedPageGroups });
      usageCalls.push(buildAiUsageCall("generation", generationResult.usage));
      let rawOutput = generationResult.output;

      try {
        generatedPages = validateProductWikiOutput({
          generationRunId: run.id,
          allowedPageKeys: affectedPageGroups.map((group) => group.pageKey),
          validEvidenceIds,
          output: rawOutput
        }).pages;
      } catch (error) {
        if (!(error instanceof ProductWikiValidationError)) {
          throw error;
        }

        generationResult = await provider.generateProductWiki(
          { generationRunId: run.id, pageGroups: affectedPageGroups },
          {
            invalidOutput: rawOutput,
            validationErrors: error.validationErrors
          }
        );
        usageCalls.push(buildAiUsageCall("repair", generationResult.usage));
        rawOutput = generationResult.output;

        try {
          generatedPages = validateProductWikiOutput({
            generationRunId: run.id,
            allowedPageKeys: affectedPageGroups.map((group) => group.pageKey),
            validEvidenceIds,
            output: rawOutput
          }).pages;
        } catch (repairError) {
          const errorMessage =
            repairError instanceof ProductWikiValidationError
              ? sanitizeErrorMessage(repairError.message)
              : sanitizeErrorMessage(repairError);
          incrementalReport = buildIncrementalReport({
            baselineGenerationRunId: reusePlan.baselineGenerationRunId,
            affectedPageKeys: [...affectedPageKeys],
            reusedPageKeys: [...reusedPageKeys],
            reuseMissReasons
          });
          await markInvalid(run.id, errorMessage, invalidOutputQualityReport(), buildAiUsageReport(usageCalls), incrementalReport);
          return { status: "invalid", generationRunId: run.id, errorMessage };
        }
      }
    }

    const finalPages = pageGroups
      .map((group) => generatedPages.find((page) => page.pageKey === group.pageKey) ?? reusedPages.find((page) => page.pageKey === group.pageKey))
      .filter(isDefined);
    let output: ReturnType<typeof validateProductWikiOutput>;
    try {
      output = validateProductWikiOutput({
        generationRunId: run.id,
        allowedPageKeys,
        validEvidenceIds,
        output: { pages: finalPages }
      });
    } catch (error) {
      if (!(error instanceof ProductWikiValidationError)) {
        throw error;
      }
      const errorMessage = sanitizeErrorMessage(error.message);
      incrementalReport = buildIncrementalReport({
        baselineGenerationRunId: reusePlan.baselineGenerationRunId,
        affectedPageKeys: [...affectedPageKeys],
        reusedPageKeys: [...reusedPageKeys],
        reuseMissReasons
      });
      await markInvalid(run.id, errorMessage, invalidOutputQualityReport(), buildAiUsageReport(usageCalls), incrementalReport);
      return { status: "invalid", generationRunId: run.id, errorMessage };
    }
    if (output.pages.length !== pageGroups.length) {
      const errorMessage = "AI output did not include full current page set.";
      incrementalReport = buildIncrementalReport({
        baselineGenerationRunId: reusePlan.baselineGenerationRunId,
        affectedPageKeys: [...affectedPageKeys],
        reusedPageKeys: [...reusedPageKeys],
        reuseMissReasons
      });
      await markInvalid(run.id, errorMessage, invalidOutputQualityReport(), buildAiUsageReport(usageCalls), incrementalReport);
      return { status: "invalid", generationRunId: run.id, errorMessage };
    }

    const qualityReport = validateQuality({
      generationRunId: run.id,
      allowedPageKeys,
      evidence: evidenceRows.map((row) => ({
        id: row.id,
        generationRunId: row.generationRunId,
        repositoryRole: row.repositoryRole
      })),
      output
    });
    const aiUsageReport = buildAiUsageReport(usageCalls);
    incrementalReport = buildIncrementalReport({
      baselineGenerationRunId: reusePlan.baselineGenerationRunId,
      affectedPageKeys: [...affectedPageKeys],
      reusedPageKeys: [...reusedPageKeys],
      reuseMissReasons
    });

    if (qualityReport.gateResult === "FAIL") {
      await markInvalid(run.id, "QUALITY_GATE_FAILED", qualityReport, aiUsageReport, incrementalReport);
      return { status: "invalid", generationRunId: run.id, errorMessage: "QUALITY_GATE_FAILED" };
    }

    const pageMeta = new Map(
      pageGroups.map((group) => [
        group.pageKey,
        {
          pageKey: group.pageKey,
          inputHash: pageInputByKey.get(group.pageKey)?.inputHash ?? "",
          generationStrategy: reusedPageKeys.has(group.pageKey) ? ("REUSED" as const) : ("GENERATED" as const),
          reusedFromGenerationRunId: reusedPageKeys.has(group.pageKey) ? reusePlan.baselineGenerationRunId : null
        }
      ])
    );

    await persistWikiOutput(run, output, qualityReport, aiUsageReport, incrementalReport, pageMeta);

    return {
      status: "completed",
      generationRunId: run.id,
      generatedStatementCount: output.generatedStatementCount,
      generatedStatementWithEvidenceCount: output.generatedStatementWithEvidenceCount
    };
  } catch (error) {
    const aiUsageReport = buildAiUsageReport(usageCalls);
    const qualityReport = invalidOutputQualityReport();
    if (error instanceof StructuredOutputUnsupportedError) {
      await markFailed(run.id, "MODEL_DOES_NOT_SUPPORT_STRUCTURED_OUTPUT", qualityReport, aiUsageReport, incrementalReport);
      return { status: "failed", generationRunId: run.id, errorMessage: "MODEL_DOES_NOT_SUPPORT_STRUCTURED_OUTPUT" };
    }

    const errorMessage = sanitizeErrorMessage(error);
    await markFailed(run.id, errorMessage, qualityReport, aiUsageReport, incrementalReport);
    return { status: "failed", generationRunId: run.id, errorMessage };
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

async function buildReusePlan(input: {
  run: ClaimedGenerationRun;
  pageGroups: ProductWikiPageGroup[];
  pageInputByKey: Map<string, { pageKey: string; inputHash: string }>;
  currentEvidence: Array<typeof evidence.$inferSelect>;
}): Promise<ReusePlan> {
  const db = getDb();
  const fullGeneration = (reason: string): ReusePlan => ({
    baselineGenerationRunId: null,
    affectedPageKeys: input.pageGroups.map((group) => group.pageKey),
    reusedPages: [],
    reuseMissReasons: Object.fromEntries(input.pageGroups.map((group) => [group.pageKey, reason]))
  });
  const candidateRuns = await db
    .select()
    .from(generationRuns)
    .where(
      and(
        eq(generationRuns.workspaceId, input.run.workspaceId),
        eq(generationRuns.frontendRepositoryId, input.run.frontendRepositoryId),
        eq(generationRuns.backendRepositoryId, input.run.backendRepositoryId),
        eq(generationRuns.status, "COMPLETED")
      )
    );
  const baselineRun = [...candidateRuns]
    .filter((candidate) => candidate.id !== input.run.id && candidate.createdAt < input.run.createdAt)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
  if (!baselineRun) {
    return fullGeneration("no_safe_baseline");
  }

  const qualityGate = qualityGateResult(baselineRun.qualityReportJson);
  if (qualityGate !== null && qualityGate !== "PASS" && qualityGate !== "WARN") {
    return fullGeneration("baseline_quality_gate_not_safe");
  }

  const baselinePages = await db.select().from(wikiPages).where(eq(wikiPages.generationRunId, baselineRun.id));
  if (baselinePages.length === 0 || baselinePages.some((page) => !page.inputHash)) {
    return fullGeneration("baseline_pages_missing_input_hash");
  }

  const baselineBlocks = await db.select().from(wikiBlocks).where(inArray(wikiBlocks.pageId, baselinePages.map((page) => page.id)));
  if (baselineBlocks.length === 0) {
    return fullGeneration("baseline_blocks_missing");
  }

  const previousEvidence = await db.select().from(evidence).where(eq(evidence.generationRunId, baselineRun.id));
  const remap = buildEvidenceRemap({ previousEvidence, currentEvidence: input.currentEvidence });
  const affectedPageKeys = new Set<string>();
  const reusedPages: ReusePlan["reusedPages"] = [];
  const reuseMissReasons: Record<string, string> = {};
  const baselinePageByKey = new Map(baselinePages.map((page) => [page.pageKey, page]));

  for (const pageGroup of input.pageGroups) {
    const currentInput = input.pageInputByKey.get(pageGroup.pageKey);
    const baselinePage = baselinePageByKey.get(pageGroup.pageKey);
    if (!baselinePage) {
      affectedPageKeys.add(pageGroup.pageKey);
      reuseMissReasons[pageGroup.pageKey] = "baseline_page_missing";
      continue;
    }
    if (!currentInput || baselinePage.inputHash !== currentInput.inputHash) {
      affectedPageKeys.add(pageGroup.pageKey);
      reuseMissReasons[pageGroup.pageKey] = "input_hash_mismatch";
      continue;
    }
    if (!remap.ok) {
      affectedPageKeys.add(pageGroup.pageKey);
      reuseMissReasons[pageGroup.pageKey] = remap.reason;
      continue;
    }

    const pageBlocks = baselineBlocks.filter((block) => block.pageId === baselinePage.id);
    if (pageBlocks.length === 0) {
      affectedPageKeys.add(pageGroup.pageKey);
      reuseMissReasons[pageGroup.pageKey] = "baseline_page_blocks_missing";
      continue;
    }

    const previousPage = buildPreviousPage(baselinePage, pageBlocks);
    const remappedPage = remapReusedPage({
      generationRunId: input.run.id,
      page: previousPage,
      evidenceIdMap: remap.idMap
    });
    if (!remappedPage.ok) {
      affectedPageKeys.add(pageGroup.pageKey);
      reuseMissReasons[pageGroup.pageKey] = remappedPage.reason;
      continue;
    }
    reusedPages.push({ page: remappedPage.page, stableKeys: blockStableKeys(previousPage) });
  }

  return {
    baselineGenerationRunId: baselineRun.id,
    affectedPageKeys: [...affectedPageKeys],
    reusedPages,
    reuseMissReasons
  };
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

async function persistWikiOutput(run: ClaimedGenerationRun, output: ProductWikiOutput & {
  generatedStatementCount: number;
  generatedStatementWithEvidenceCount: number;
}, qualityReport: QualityReport, aiUsageReport: AiUsageReport, incrementalReport: IncrementalReport, pageMeta: Map<string, IncrementalPageMeta>) {
  const db = getDb();
  const pageRows = output.pages.map((page) => ({
    id: pageId(run.workspaceId, page.pageKey),
    workspaceId: run.workspaceId,
    generationRunId: run.id,
    pageKey: page.pageKey,
    title: page.title,
    slug: page.pageKey.replace(/\./g, "/"),
    inputHash: pageMeta.get(page.pageKey)?.inputHash ?? null,
    generationStrategy: pageMeta.get(page.pageKey)?.generationStrategy ?? null,
    reusedFromGenerationRunId: pageMeta.get(page.pageKey)?.reusedFromGenerationRunId ?? null,
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
        qualityReportJson: qualityReport,
        aiUsageJson: aiUsageReport,
        incrementalReportJson: incrementalReport,
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

async function markInvalid(generationRunId: string, errorMessage: string, qualityReport?: QualityReport, aiUsageReport?: AiUsageReport, incrementalReport?: IncrementalReport) {
  const db = getDb();
  await db
    .update(generationRuns)
    .set({
      status: "AI_OUTPUT_INVALID",
      errorMessage: sanitizeErrorMessage(errorMessage),
      qualityReportJson: qualityReport,
      aiUsageJson: aiUsageReport,
      incrementalReportJson: incrementalReport,
      finishedAt: new Date()
    })
    .where(eq(generationRuns.id, generationRunId));
}

async function markFailed(generationRunId: string, errorMessage: string, qualityReport?: QualityReport, aiUsageReport?: AiUsageReport, incrementalReport?: IncrementalReport) {
  const db = getDb();
  await db
    .update(generationRuns)
    .set({
      status: "FAILED",
      errorMessage: sanitizeErrorMessage(errorMessage),
      qualityReportJson: qualityReport,
      aiUsageJson: aiUsageReport,
      incrementalReportJson: incrementalReport,
      finishedAt: new Date()
    })
    .where(eq(generationRuns.id, generationRunId));
}

function invalidOutputQualityReport(): QualityReport {
  return validateQuality({ generationRunId: "", allowedPageKeys: [], evidence: [], output: null });
}

function qualityGateResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("gateResult" in value)) {
    return null;
  }
  return value.gateResult === "PASS" || value.gateResult === "WARN" || value.gateResult === "FAIL" ? value.gateResult : null;
}

function sanitizeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\b(?:sk|pk|rk|or)-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/Authorization\s*:\s*Bearer\s+[A-Za-z0-9._-]+/gi, "Authorization: Bearer [redacted]")
    .replace(/\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^,\s"'`]+/g, "[redacted-env]")
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
