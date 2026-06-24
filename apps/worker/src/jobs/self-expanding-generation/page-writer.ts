import { createHash } from "node:crypto";

import { buildRetrievalContexts, type CodeMap, type CodeSummary, type RetrievalContext } from "@code2wiki/analyzer";
import {
  buildAiUsageCall,
  buildAiUsageReport,
  createAIProvider,
  ProductWikiValidationError,
  resolveAIProviderConfig,
  StructuredOutputUnsupportedError,
  validateProductWikiOutput,
  validateQuality,
  type AiUsageCall,
  type AiUsageReport,
  type GenerateProductWikiEvidence,
  type GenerateProductWikiFact,
  type ProductWikiPageGroup,
  type QualityReport
} from "@code2wiki/ai";
import { codeFacts, codeMaps, codeSummaries, evidence, generationRuns, generationTasks, getDb, wikiBlocks, wikiPageEvidence, wikiPages, wikiRunPages } from "@code2wiki/db";
import type { ProductWikiBlock, ProductWikiOutput } from "@code2wiki/document";
import { and, eq, sql } from "drizzle-orm";
import { runPageValue } from "./incremental-planner";
import { emitDebugEvent } from "./debug-events";
import { pageInputHash } from "./page-input";

type GenerationRun = typeof generationRuns.$inferSelect;
type GenerationTask = typeof generationTasks.$inferSelect;
type PageGroupWithInputHash = ProductWikiPageGroup & { inputHash: string };
type PageWriteResult =
  | { ok: true; pageKey: string; qualityReport: QualityReport; aiUsageReport: AiUsageReport; generatedStatementCount: number; generatedStatementWithEvidenceCount: number }
  | { ok: false; status: "AI_OUTPUT_INVALID" | "FAILED"; errorMessage: string; qualityReport?: QualityReport; aiUsageReport?: AiUsageReport };

export async function writePageTask(run: GenerationRun, task: GenerationTask): Promise<PageWriteResult> {
  const pageKey = task.pageKey;
  if (!pageKey) {
    return { ok: false, status: "FAILED", errorMessage: "PAGE_TASK_MISSING_PAGE_KEY" };
  }

  const db = getDb();
  const pageGroup = await buildPageGroup(run, task, pageKey);
  if (!pageGroup) {
    return { ok: false, status: "AI_OUTPUT_INVALID", errorMessage: "NO_FACTS_FOR_PAGE_TASK", qualityReport: invalidOutputQualityReport(), aiUsageReport: buildAiUsageReport([]) };
  }

  const provider = createAIProvider(resolveAIProviderConfig());
  const usageCalls: AiUsageCall[] = [];
  const validEvidenceIds = pageGroup.evidence.map((item) => item.id);

  try {
    await emitDebugEvent({
      generationRunId: run.id,
      stage: "page_writer",
      eventType: "AI_PAGE_WRITE_STARTED",
      message: "AI page write started.",
      payload: { taskId: task.id, taskType: task.taskType, pageKey, factCount: pageGroup.facts.length, evidenceCount: pageGroup.evidence.length }
    });
    let generationResult = await provider.generateProductWiki({ generationRunId: run.id, pageGroups: [pageGroup] });
    usageCalls.push(buildAiUsageCall("generation", generationResult.usage));
    let checked = checkOutput({
      generationRunId: run.id,
      pageKey,
      validEvidenceIds,
      evidence: pageGroup.evidence,
      output: generationResult.output
    });

    if (!checked.ok || checked.qualityReport.gateResult === "FAIL") {
      await emitDebugEvent({
        generationRunId: run.id,
        stage: "page_writer",
        eventType: "AI_PAGE_WRITE_REPAIR_STARTED",
        severity: "WARN",
        message: "AI page write repair started.",
        payload: { taskId: task.id, taskType: task.taskType, pageKey, qualityGateResult: checked.ok ? checked.qualityReport.gateResult : "INVALID_OUTPUT" }
      });
      generationResult = await provider.generateProductWiki(
        { generationRunId: run.id, pageGroups: [pageGroup] },
        {
          invalidOutput: generationResult.output,
          validationErrors: checked.ok ? checked.qualityReport.issues.map((issue) => `${issue.code}: ${issue.message}`) : checked.validationErrors
        }
      );
      usageCalls.push(buildAiUsageCall("repair", generationResult.usage));
      checked = checkOutput({
        generationRunId: run.id,
        pageKey,
        validEvidenceIds,
        evidence: pageGroup.evidence,
        output: generationResult.output
      });
    }

    if (!checked.ok) {
      return { ok: false, status: "AI_OUTPUT_INVALID", errorMessage: sanitizeErrorMessage(checked.validationErrors.join("; ")), qualityReport: invalidOutputQualityReport(), aiUsageReport: buildAiUsageReport(usageCalls) };
    }
    if (checked.qualityReport.gateResult === "FAIL") {
      return { ok: false, status: "AI_OUTPUT_INVALID", errorMessage: "QUALITY_GATE_FAILED", qualityReport: checked.qualityReport, aiUsageReport: buildAiUsageReport(usageCalls) };
    }

    await persistPageWrite({ run, task, page: checked.output.pages[0], pageGroup, qualityReport: checked.qualityReport, usageCalls });
    await emitDebugEvent({
      generationRunId: run.id,
      stage: "page_writer",
      eventType: "PAGE_WRITTEN",
      message: "Wiki page written.",
      payload: {
        taskId: task.id,
        taskType: task.taskType,
        pageKey,
        qualityGateResult: checked.qualityReport.gateResult,
        statementCount: checked.output.generatedStatementCount,
        statementWithEvidenceCount: checked.output.generatedStatementWithEvidenceCount,
        aiCallCount: usageCalls.length
      }
    });
    return {
      ok: true,
      pageKey,
      qualityReport: checked.qualityReport,
      aiUsageReport: buildAiUsageReport(usageCalls),
      generatedStatementCount: checked.output.generatedStatementCount,
      generatedStatementWithEvidenceCount: checked.output.generatedStatementWithEvidenceCount
    };
  } catch (error) {
    if (error instanceof ProductWikiValidationError) {
      return { ok: false, status: "AI_OUTPUT_INVALID", errorMessage: sanitizeErrorMessage(error.message), qualityReport: invalidOutputQualityReport(), aiUsageReport: buildAiUsageReport(usageCalls) };
    }
    if (error instanceof StructuredOutputUnsupportedError) {
      return { ok: false, status: "FAILED", errorMessage: "MODEL_DOES_NOT_SUPPORT_STRUCTURED_OUTPUT", qualityReport: invalidOutputQualityReport(), aiUsageReport: buildAiUsageReport(usageCalls) };
    }
    return { ok: false, status: "FAILED", errorMessage: sanitizeErrorMessage(error), qualityReport: invalidOutputQualityReport(), aiUsageReport: buildAiUsageReport(usageCalls) };
  }
}

function checkOutput(input: {
  generationRunId: string;
  pageKey: string;
  validEvidenceIds: string[];
  evidence: GenerateProductWikiEvidence[];
  output: unknown;
}):
  | { ok: true; output: ReturnType<typeof validateProductWikiOutput>; qualityReport: QualityReport }
  | { ok: false; validationErrors: string[]; qualityReport: QualityReport } {
  try {
    const output = validateProductWikiOutput({
      generationRunId: input.generationRunId,
      allowedPageKeys: [input.pageKey],
      validEvidenceIds: input.validEvidenceIds,
      output: input.output
    });
    const qualityReport = validateQuality({
      generationRunId: input.generationRunId,
      allowedPageKeys: [input.pageKey],
      evidence: input.evidence.map((item) => ({ id: item.id, generationRunId: input.generationRunId, repositoryRole: item.repositoryRole, userFacingText: item.summary })),
      output
    });
    return { ok: true, output, qualityReport };
  } catch (error) {
    return {
      ok: false,
      validationErrors: error instanceof ProductWikiValidationError ? error.validationErrors : [sanitizeErrorMessage(error)],
      qualityReport: invalidOutputQualityReport()
    };
  }
}

async function buildPageGroup(run: GenerationRun, task: GenerationTask, pageKey: string): Promise<PageGroupWithInputHash | null> {
  const db = getDb();
  const [factRows, evidenceRows, codeMapRows, summaryRows, existingPages] = await Promise.all([
    db.select().from(codeFacts).where(eq(codeFacts.generationRunId, run.id)),
    db.select().from(evidence).where(eq(evidence.generationRunId, run.id)),
    db.select().from(codeMaps).where(eq(codeMaps.generationRunId, run.id)),
    db.select().from(codeSummaries).where(eq(codeSummaries.generationRunId, run.id)),
    db.select().from(wikiPages).where(and(eq(wikiPages.workspaceId, run.workspaceId), eq(wikiPages.pageKey, pageKey))).limit(1)
  ]);
  const retrieval = buildRetrievalContexts({
    generationRunId: run.id,
    pageKeys: [pageKey],
    facts: factRows,
    evidence: evidenceRows,
    codeMap: (codeMapRows[0]?.mapJson as CodeMap | undefined) ?? null,
    summaries: summaryRows.map((row) => row.summaryJson as CodeSummary)
  });
  const context = retrieval.contexts.find((item) => item.pageKey === pageKey && item.evidence.length > 0);
  const fromContext = context ? pageGroupFromContext(pageKey, context, evidenceRows) : null;
  const pageGroup = usablePageGroup(fromContext) ? fromContext : fallbackPageGroup(pageKey, task, factRows, evidenceRows, context?.evidence.map((item) => item.id));
  if (!pageGroup || pageGroup.facts.length === 0 || pageGroup.evidence.length === 0) {
    return null;
  }

  const inputHash = pageInputHash(pageKey, pageGroup.facts, pageGroup.evidence, codeMapRows[0]?.mapJson ?? null);
  const existingPage = existingPages[0] ? await existingPageForPrompt(existingPages[0]) : undefined;
  return { ...pageGroup, ...(existingPage ? { existingPage } : {}), inputHash };
}

function pageGroupFromContext(pageKey: string, context: RetrievalContext, evidenceRows: Array<typeof evidence.$inferSelect>): ProductWikiPageGroup {
  const evidenceById = new Map(evidenceRows.map((row) => [row.id, toProviderEvidence(row)]));
  const evidenceIds = new Set(context.evidence.map((item) => item.id));
  return {
    pageKey,
    title: titleFromPageKey(pageKey),
    facts: context.facts
      .map((fact) => ({
        id: fact.id,
        repositoryRole: fact.repositoryRole,
        repositoryFullName: fact.repositoryFullName,
        tag: fact.tag,
        commitSha: fact.commitSha,
        factKind: fact.factKind,
        text: fact.text,
        evidenceIds: fact.evidenceIds.filter((id) => evidenceIds.has(id)),
        confidence: fact.confidence
      }))
      .filter((fact) => fact.evidenceIds.length > 0),
    evidence: context.evidence.map((item) => evidenceById.get(item.id)).filter(isDefined)
  };
}

function fallbackPageGroup(
  pageKey: string,
  task: GenerationTask,
  factRows: Array<typeof codeFacts.$inferSelect>,
  evidenceRows: Array<typeof evidence.$inferSelect>,
  contextEvidenceIds: string[] = []
): ProductWikiPageGroup | null {
  const payloadEvidenceIds = new Set([...readEvidenceIds(task.payloadJson), ...contextEvidenceIds]);
  const selectedEvidence = evidenceRows.filter((row) => payloadEvidenceIds.has(row.id) || pageKeyFromPath(row.filePath) === pageKey);
  const selectedEvidenceIds = new Set(selectedEvidence.map((row) => row.id));
  const facts = factRows.filter((fact) => fact.evidenceIds.some((id) => selectedEvidenceIds.has(id)));
  if (selectedEvidence.length === 0) {
    return null;
  }

  return {
    pageKey,
    title: titleFromPageKey(pageKey),
    facts: facts.length
      ? facts.map(toProviderFact)
      : selectedEvidence.map((item) => ({
          id: `synthetic_${hash(item.id)}`,
          repositoryRole: item.repositoryRole,
          repositoryFullName: item.repositoryFullName,
          tag: item.tag,
          commitSha: item.commitSha,
          factKind: `EVIDENCE_${item.sourceKind}`,
          text: item.summary,
          evidenceIds: [item.id],
          confidence: 0.7
        })),
    evidence: selectedEvidence.map(toProviderEvidence)
  };
}

function usablePageGroup(pageGroup: ProductWikiPageGroup | null): pageGroup is ProductWikiPageGroup {
  return Boolean(pageGroup && pageGroup.facts.length > 0 && pageGroup.evidence.length > 0);
}

async function existingPageForPrompt(page: typeof wikiPages.$inferSelect) {
  const blockRows = await getDb().select().from(wikiBlocks).where(eq(wikiBlocks.pageId, page.id));
  return {
    title: page.title,
    blocks: buildBlockTree(blockRows)
  };
}

async function persistPageWrite(input: {
  run: GenerationRun;
  task: GenerationTask;
  page: ProductWikiOutput["pages"][number];
  pageGroup: PageGroupWithInputHash;
  qualityReport: QualityReport;
  usageCalls: AiUsageCall[];
}) {
  const db = getDb();
  const pageEvidenceRows = pageEvidenceLinks({
    run: input.run,
    task: input.task,
    pageKey: input.page.pageKey,
    pageGroup: input.pageGroup,
    blocks: input.page.blocks
  });
  const inputHash =
    typeof input.task.payloadJson.inputHash === "string" ? input.task.payloadJson.inputHash : input.pageGroup.inputHash;

  await db.transaction(async (tx) => {
    const [existingPage] = await tx.select().from(wikiPages).where(and(eq(wikiPages.workspaceId, input.run.workspaceId), eq(wikiPages.pageKey, input.page.pageKey))).limit(1);
    const targetPageId = existingPage?.id ?? pageId(input.run.workspaceId, input.page.pageKey);
    const blockRows = flattenBlocks({
      blocks: input.page.blocks,
      pageId: targetPageId,
      generationRunId: input.run.id,
      parentBlockId: null
    });

    if (existingPage) {
      await tx.delete(wikiBlocks).where(eq(wikiBlocks.pageId, targetPageId));
      await tx
        .update(wikiPages)
        .set({
          generationRunId: input.run.id,
          title: input.page.title,
          slug: input.page.pageKey.replace(/\./g, "/"),
          inputHash,
          generationStrategy: input.task.taskType,
          reusedFromGenerationRunId: null,
          updatedAt: new Date()
        })
        .where(eq(wikiPages.id, existingPage.id));
    } else {
      await tx.insert(wikiPages).values({
        id: targetPageId,
        workspaceId: input.run.workspaceId,
        generationRunId: input.run.id,
        pageKey: input.page.pageKey,
        title: input.page.title,
        slug: input.page.pageKey.replace(/\./g, "/"),
        inputHash,
        generationStrategy: input.task.taskType,
        reusedFromGenerationRunId: null,
        updatedAt: new Date()
      });
    }

    await tx
      .insert(wikiRunPages)
      .values(runPageValue(input.run, { ...(existingPage ?? { id: targetPageId }), pageKey: input.page.pageKey } as typeof wikiPages.$inferSelect, "WRITTEN", null, inputHash))
      .onConflictDoUpdate({
        target: [wikiRunPages.generationRunId, wikiRunPages.pageKey],
        set: {
          pageId: sql`excluded.page_id`,
          materializationType: sql`excluded.materialization_type`,
          sourceGenerationRunId: null,
          inputHash: sql`excluded.input_hash`,
          updatedAt: new Date()
        }
      });

    await tx.delete(wikiPageEvidence).where(and(eq(wikiPageEvidence.generationRunId, input.run.id), eq(wikiPageEvidence.pageKey, input.page.pageKey)));
    if (blockRows.length > 0) {
      await tx.insert(wikiBlocks).values(blockRows);
    }
    if (pageEvidenceRows.length > 0) {
      await tx.insert(wikiPageEvidence).values(pageEvidenceRows);
    }

    const [currentRun] = await tx.select().from(generationRuns).where(eq(generationRuns.id, input.run.id)).limit(1);
    const currentRunBlocks = await tx.select().from(wikiBlocks).where(eq(wikiBlocks.generationRunId, input.run.id));
    await tx
      .update(generationRuns)
      .set({
        generatedStatementCount: currentRunBlocks.filter((block) => block.type === "statement").length,
        generatedStatementWithEvidenceCount: currentRunBlocks.filter((block) => block.type === "statement" && block.evidenceIds.length > 0).length,
        qualityReportJson: mergeQualityReports(currentRun?.qualityReportJson, input.qualityReport),
        aiUsageJson: buildAiUsageReport([...readUsageCalls(currentRun?.aiUsageJson), ...input.usageCalls]),
        errorMessage: null
      })
      .where(eq(generationRuns.id, input.run.id));
  });
}

function pageEvidenceLinks(input: {
  run: GenerationRun;
  task: GenerationTask;
  pageKey: string;
  pageGroup: ProductWikiPageGroup;
  blocks: ProductWikiBlock[];
}): Array<typeof wikiPageEvidence.$inferInsert> {
  const primaryIds = new Set(flattenProductBlocks(input.blocks).filter((block) => block.type === "statement").flatMap((block) => block.evidenceIds ?? []));
  const allEvidenceIds = new Set([...input.pageGroup.evidence.map((item) => item.id), ...flattenProductBlocks(input.blocks).flatMap((block) => block.evidenceIds ?? [])]);
  const factByEvidenceId = new Map<string, string>();
  for (const fact of input.pageGroup.facts) {
    for (const evidenceId of fact.evidenceIds) {
      factByEvidenceId.set(evidenceId, fact.id);
    }
  }

  return [...allEvidenceIds].sort().map((evidenceId) => {
    const factId = factByEvidenceId.get(evidenceId) ?? null;
    const coverageRole = primaryIds.has(evidenceId) ? "PRIMARY" : "SUPPORTING";
    return {
      id: wikiPageEvidenceId(input.run.id, input.pageKey, evidenceId, factId, coverageRole),
      generationRunId: input.run.id,
      workspaceId: input.run.workspaceId,
      pageKey: input.pageKey,
      evidenceId,
      factId,
      sourceTaskId: input.task.id,
      coverageRole
    };
  });
}

function buildBlockTree(rows: Array<typeof wikiBlocks.$inferSelect>): ProductWikiBlock[] {
  const byParent = new Map<string | null, Array<typeof wikiBlocks.$inferSelect>>();
  for (const row of rows) {
    byParent.set(row.parentBlockId, [...(byParent.get(row.parentBlockId) ?? []), row]);
  }
  for (const list of byParent.values()) {
    list.sort((left, right) => left.position - right.position);
  }
  const build = (parentId: string | null): ProductWikiBlock[] =>
    (byParent.get(parentId) ?? []).map((row) => {
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
        locked: row.locked,
        children: build(row.id)
      } as ProductWikiBlock;
    });
  return build(null);
}

function flattenBlocks(input: {
  blocks: ProductWikiBlock[];
  pageId: string;
  generationRunId: string;
  parentBlockId: string | null;
}): Array<typeof wikiBlocks.$inferInsert> {
  return input.blocks.flatMap((block, index) => {
    const { children, ...blockJson } = block;
    return [
      {
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
      },
      ...(children ? flattenBlocks({ blocks: children, pageId: input.pageId, generationRunId: input.generationRunId, parentBlockId: block.id }) : [])
    ];
  });
}

function flattenProductBlocks(blocks: ProductWikiBlock[]): ProductWikiBlock[] {
  return blocks.flatMap((block) => [block, ...flattenProductBlocks(block.children ?? [])]);
}

function toProviderFact(row: typeof codeFacts.$inferSelect): GenerateProductWikiFact {
  return {
    id: row.id,
    repositoryRole: row.repositoryRole,
    repositoryFullName: row.repositoryFullName,
    tag: row.tag,
    commitSha: row.commitSha,
    factKind: row.factKind,
    text: row.text,
    evidenceIds: row.evidenceIds,
    confidence: row.confidence
  };
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
    codeSnippet: row.codeSnippet,
    githubUrl: row.githubUrl
  };
}

function invalidOutputQualityReport(): QualityReport {
  return validateQuality({ generationRunId: "", allowedPageKeys: [], evidence: [], output: null });
}

function mergeQualityReports(existing: unknown, next: QualityReport): QualityReport {
  const previous = readQualityReport(existing);
  if (!previous) {
    return next;
  }
  const issues = [...previous.issues, ...next.issues];
  return {
    gateResult: issues.some((issue) => issue.severity === "ERROR") ? "FAIL" : issues.some((issue) => issue.severity === "WARN") ? "WARN" : "PASS",
    issues,
    metrics: next.metrics
  };
}

function readQualityReport(value: unknown): QualityReport | null {
  if (!value || typeof value !== "object" || !("issues" in value) || !Array.isArray(value.issues)) {
    return null;
  }
  return value as QualityReport;
}

function readUsageCalls(value: unknown): AiUsageCall[] {
  if (!value || typeof value !== "object" || !("calls" in value) || !Array.isArray(value.calls)) {
    return [];
  }
  return value.calls as AiUsageCall[];
}

function readEvidenceIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(readEvidenceIds);
  }
  if (value && typeof value === "object") {
    const direct = "evidenceIds" in value && Array.isArray(value.evidenceIds) ? value.evidenceIds.filter((item): item is string => typeof item === "string") : [];
    return [...direct, ...Object.values(value).flatMap(readEvidenceIds)];
  }
  return [];
}

function titleFromPageKey(pageKey: string) {
  return pageKey
    .split(".")
    .map((part) => part.replace(/[-_]/g, " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
  return normalizePageKey(withoutExtension.replace(/^api\//, "api/").split("/").filter(Boolean).slice(0, 4).join(".")) || "frontend";
}

function normalizePageKey(value: string) {
  return value
    .replace(/\$\{[^}]+\}/g, "id")
    .replace(/\[[^\]]+\]/g, "id")
    .replace(/\s+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
}

function pageId(workspaceId: string, pageKey: string) {
  return `page_${hash([workspaceId, pageKey].join("|"))}`;
}

function wikiPageEvidenceId(generationRunId: string, pageKey: string, evidenceId: string, factId: string | null, coverageRole: string) {
  return `wpe_${hash([generationRunId, pageKey, evidenceId, factId ?? "", coverageRole].join("|"))}`;
}

function sanitizeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\b(?:sk|pk|rk|or)-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/Authorization\s*:\s*Bearer\s+[A-Za-z0-9._-]+/gi, "Authorization: Bearer [redacted]")
    .replace(/\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^,\s\"'`]+/g, "[redacted-env]")
    .slice(0, 1000);
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
