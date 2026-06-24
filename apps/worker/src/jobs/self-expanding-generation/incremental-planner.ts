import { createHash } from "node:crypto";

import { codeFacts, codeMaps, evidence, generationRuns, generationTasks, getDb, wikiPageEvidence, wikiPages, wikiRunPages } from "@code2wiki/db";
import { and, desc, eq, ne } from "drizzle-orm";
import { evidenceFingerprint, factFingerprint, PAGE_INPUT_HASH_VERSION, pageInputHash, pageKeyFromPath } from "./page-input";

type GenerationRun = typeof generationRuns.$inferSelect;
type CodeFact = typeof codeFacts.$inferSelect;
type Evidence = typeof evidence.$inferSelect;
type WikiPage = typeof wikiPages.$inferSelect;
type BaselinePage = { page: WikiPage; inputHash: string | null };

type IncrementalReport = {
  version: 1;
  baselineGenerationRunId: string | null;
  mode: "FULL" | "INCREMENTAL";
  generatedPageCount: number;
  reusedPageCount: number;
  affectedPageKeys: string[];
  reusedPageKeys: string[];
  reuseMissReasons: Record<string, string>;
  pageInputHashVersion: typeof PAGE_INPUT_HASH_VERSION;
};

export async function planIncrementalRun(run: GenerationRun): Promise<{ seeded: number; mode: "FULL" | "INCREMENTAL" }> {
  const db = getDb();
  const baseline = await latestBaselineRun(run);
  if (!baseline) {
    await db.update(generationRuns).set({ incrementalReportJson: report(null, "FULL", [], [], {}) }).where(eq(generationRuns.id, run.id));
    return { seeded: 0, mode: "FULL" };
  }

  const [currentFacts, currentEvidence, currentCodeMapRows, baselineFacts, baselineEvidence, workspacePages, baselineRunPages, baselinePageEvidence] = await Promise.all([
    db.select().from(codeFacts).where(eq(codeFacts.generationRunId, run.id)),
    db.select().from(evidence).where(eq(evidence.generationRunId, run.id)),
    db.select().from(codeMaps).where(eq(codeMaps.generationRunId, run.id)),
    db.select().from(codeFacts).where(eq(codeFacts.generationRunId, baseline.id)),
    db.select().from(evidence).where(eq(evidence.generationRunId, baseline.id)),
    db.select().from(wikiPages).where(eq(wikiPages.workspaceId, run.workspaceId)),
    db.select().from(wikiRunPages).where(eq(wikiRunPages.generationRunId, baseline.id)),
    db.select().from(wikiPageEvidence).where(eq(wikiPageEvidence.generationRunId, baseline.id))
  ]);

  const currentCodeMap = currentCodeMapRows[0]?.mapJson ?? null;
  const pageKeys = [
    ...new Set([
      ...frontendCodeMapPageKeys(currentCodeMap),
      ...baselinePageKeys(workspacePages, baselineRunPages, baseline.id)
    ])
  ].sort();
  const pagesByKey = baselinePagesByKey(workspacePages, baselineRunPages, baseline.id);
  const baselineEvidenceById = new Map(baselineEvidence.map((item) => [item.id, item]));
  const baselineEvidenceFingerprintById = new Map(baselineEvidence.map((item) => [item.id, evidenceFingerprint(item)]));
  const currentEvidenceByFingerprint = new Map(currentEvidence.map((item) => [evidenceFingerprint(item), item]));
  const currentFactsByFingerprint = factMap(currentFacts, currentEvidence);
  const baselineFactsById = new Map(baselineFacts.map((fact) => [fact.id, fact]));
  const currentEvidenceByPage = groupEvidenceByPage(currentEvidence);
  const currentHashes = new Map(pageKeys.map((pageKey) => [pageKey, pageInputHash(pageKey, currentFacts, currentEvidenceByPage.get(pageKey) ?? [], currentCodeMap)]));
  const reused: string[] = [];
  const affected: string[] = [];
  const miss: Record<string, string> = {};

  await db.transaction(async (tx) => {
    for (const pageKey of pageKeys) {
      const baselinePage = pagesByKey.get(pageKey);
      const inputHash = currentHashes.get(pageKey) ?? null;
      if (!baselinePage) {
        affected.push(pageKey);
        miss[pageKey] = "missing_baseline_page";
        await enqueuePageTask(tx, run, pageKey, workspacePages.some((item) => item.pageKey === pageKey) ? "UPDATE_PAGE" : "CREATE_PAGE", inputHash);
        continue;
      }
      if (!baselinePage.inputHash || baselinePage.inputHash !== inputHash) {
        affected.push(pageKey);
        miss[pageKey] = baselinePage.inputHash ? "input_hash_mismatch" : "missing_baseline_input_hash";
        await enqueuePageTask(tx, run, pageKey, "UPDATE_PAGE", inputHash);
        continue;
      }
      const mappedRows = remapPageEvidence({
        run,
        pageKey,
        baselineRows: baselinePageEvidence.filter((row) => row.pageKey === pageKey && (row.coverageRole === "PRIMARY" || row.coverageRole === "SUPPORTING")),
        baselineEvidenceById,
        baselineEvidenceFingerprintById,
        currentEvidenceByFingerprint,
        baselineFactsById,
        currentFactsByFingerprint
      });
      if (!mappedRows) {
        affected.push(pageKey);
        miss[pageKey] = "evidence_remap_failed";
        await enqueuePageTask(tx, run, pageKey, "UPDATE_PAGE", inputHash);
        continue;
      }
      await tx.insert(wikiRunPages).values(runPageValue(run, baselinePage.page, "REUSED", baseline.id, inputHash)).onConflictDoNothing({ target: [wikiRunPages.generationRunId, wikiRunPages.pageKey] });
      if (mappedRows.length > 0) {
        await tx.insert(wikiPageEvidence).values(mappedRows).onConflictDoNothing({ target: wikiPageEvidence.id });
      }
      reused.push(pageKey);
    }

    await tx
      .update(generationRuns)
      .set({ incrementalReportJson: report(baseline.id, "INCREMENTAL", affected, reused, miss) })
      .where(eq(generationRuns.id, run.id));
  });

  return { seeded: affected.length, mode: "INCREMENTAL" };
}

export async function materializedPageCount(generationRunId: string) {
  return (await getDb().select().from(wikiRunPages).where(eq(wikiRunPages.generationRunId, generationRunId))).length;
}

export function runPageId(generationRunId: string, pageKey: string) {
  return `wrp_${hash([generationRunId, pageKey].join("|"))}`;
}

export function runPageValue(run: GenerationRun, page: WikiPage, materializationType: "WRITTEN" | "REUSED", sourceGenerationRunId: string | null, inputHash: string | null) {
  return {
    id: runPageId(run.id, page.pageKey),
    generationRunId: run.id,
    workspaceId: run.workspaceId,
    pageId: page.id,
    pageKey: page.pageKey,
    materializationType,
    sourceGenerationRunId,
    inputHash,
    updatedAt: new Date()
  };
}

async function latestBaselineRun(run: GenerationRun) {
  const [baseline] = await getDb()
    .select()
    .from(generationRuns)
    .where(
      and(
        eq(generationRuns.workspaceId, run.workspaceId),
        eq(generationRuns.frontendRepositoryId, run.frontendRepositoryId),
        eq(generationRuns.backendRepositoryId, run.backendRepositoryId),
        eq(generationRuns.status, "COMPLETED"),
        ne(generationRuns.id, run.id)
      )
    )
    .orderBy(desc(generationRuns.createdAt))
    .limit(1);
  return baseline ?? null;
}

function report(baselineGenerationRunId: string | null, mode: "FULL" | "INCREMENTAL", affectedPageKeys: string[], reusedPageKeys: string[], reuseMissReasons: Record<string, string>): IncrementalReport {
  return {
    version: 1,
    baselineGenerationRunId,
    mode,
    generatedPageCount: affectedPageKeys.length,
    reusedPageCount: reusedPageKeys.length,
    affectedPageKeys,
    reusedPageKeys,
    reuseMissReasons,
    pageInputHashVersion: PAGE_INPUT_HASH_VERSION
  };
}

function baselinePagesByKey(workspacePages: WikiPage[], baselineRunPages: Array<typeof wikiRunPages.$inferSelect>, baselineRunId: string): Map<string, BaselinePage> {
  const pagesById = new Map(workspacePages.map((page) => [page.id, page]));
  if (baselineRunPages.length > 0) {
    return new Map(
      baselineRunPages
        .map((row) => {
          const page = pagesById.get(row.pageId);
          return page ? ([row.pageKey, { page, inputHash: row.inputHash ?? page.inputHash ?? null }] as const) : null;
        })
        .filter((item): item is readonly [string, BaselinePage] => Boolean(item))
    );
  }
  return new Map(workspacePages.filter((page) => page.generationRunId === baselineRunId).map((page) => [page.pageKey, { page, inputHash: page.inputHash ?? null }]));
}

function baselinePageKeys(workspacePages: WikiPage[], baselineRunPages: Array<typeof wikiRunPages.$inferSelect>, baselineRunId: string) {
  return baselineRunPages.length > 0 ? baselineRunPages.map((item) => item.pageKey) : workspacePages.filter((page) => page.generationRunId === baselineRunId).map((page) => page.pageKey);
}

async function enqueuePageTask(tx: { insert: ReturnType<typeof getDb>["insert"] }, run: GenerationRun, pageKey: string, taskType: "CREATE_PAGE" | "UPDATE_PAGE", inputHash: string | null) {
  const verb = taskType === "UPDATE_PAGE" ? "update" : "create";
  await tx
    .insert(generationTasks)
    .values({
      id: crypto.randomUUID(),
      generationRunId: run.id,
      workspaceId: run.workspaceId,
      repositoryRole: "FRONTEND",
      repositoryId: run.frontendRepositoryId,
      taskType,
      pageKey,
      dedupeKey: `${verb}-page:${pageKey}`,
      reason: "incremental run affected page",
      payloadJson: { pageKey, inputHash },
      updatedAt: new Date()
    })
    .onConflictDoNothing({ target: [generationTasks.generationRunId, generationTasks.dedupeKey] });
}

function groupEvidenceByPage(rows: Evidence[]) {
  const byPage = new Map<string, Evidence[]>();
  for (const row of rows) {
    const pageKey = pageKeyFromPath(row.filePath);
    byPage.set(pageKey, [...(byPage.get(pageKey) ?? []), row]);
  }
  return byPage;
}

function remapPageEvidence(input: {
  run: GenerationRun;
  pageKey: string;
  baselineRows: Array<typeof wikiPageEvidence.$inferSelect>;
  baselineEvidenceById: Map<string, Evidence>;
  baselineEvidenceFingerprintById: Map<string, string>;
  currentEvidenceByFingerprint: Map<string, Evidence>;
  baselineFactsById: Map<string, CodeFact>;
  currentFactsByFingerprint: Map<string, CodeFact>;
}) {
  const mappedRows: Array<typeof wikiPageEvidence.$inferInsert> = [];
  for (const row of input.baselineRows) {
    const baselineEvidence = input.baselineEvidenceById.get(row.evidenceId);
    if (!baselineEvidence) return null;
    const currentEvidence = input.currentEvidenceByFingerprint.get(evidenceFingerprint(baselineEvidence));
    if (!currentEvidence) return null;
    const baselineFact = row.factId ? input.baselineFactsById.get(row.factId) : null;
    const factId = baselineFact ? input.currentFactsByFingerprint.get(factFingerprint(baselineFact, input.baselineEvidenceFingerprintById))?.id ?? null : null;
    if (row.factId && !factId) return null;
    mappedRows.push({
      id: wikiPageEvidenceId(input.run.id, input.pageKey, currentEvidence.id, factId, row.coverageRole),
      generationRunId: input.run.id,
      workspaceId: input.run.workspaceId,
      pageKey: input.pageKey,
      evidenceId: currentEvidence.id,
      factId,
      sourceTaskId: null,
      coverageRole: row.coverageRole
    });
  }
  return mappedRows;
}

function factMap(facts: CodeFact[], evidenceRows: Evidence[]) {
  const evidenceById = new Map(evidenceRows.map((item) => [item.id, evidenceFingerprint(item)]));
  return new Map(facts.map((fact) => [factFingerprint(fact, evidenceById), fact]));
}

function frontendCodeMapPageKeys(value: unknown) {
  if (!value || typeof value !== "object" || !Array.isArray((value as { nodes?: unknown }).nodes)) return [];
  return (value as { nodes: Array<Record<string, unknown>> }).nodes.filter(isFrontendSurfaceNode).map(pageKeyFromNode);
}

function isFrontendSurfaceNode(node: Record<string, unknown>) {
  return node.repositoryRole === "FRONTEND" && (node.kind === "UI_ROUTE" || node.kind === "REACT_COMPONENT" || node.kind === "NAVIGATION");
}

function pageKeyFromNode(node: Record<string, unknown>) {
  const metadata = node.metadata && typeof node.metadata === "object" ? (node.metadata as Record<string, unknown>) : {};
  const raw = String(node.kind === "NAVIGATION" ? metadata.target ?? "" : metadata.path ?? node.filePath ?? "");
  return raw.startsWith("/") ? raw.replace(/^\/+/, "").split("/").filter(Boolean).slice(0, 4).join(".").toLowerCase() || "frontend" : pageKeyFromPath(raw);
}

function wikiPageEvidenceId(generationRunId: string, pageKey: string, evidenceId: string, factId: string | null, coverageRole: string) {
  return `wpe_${hash([generationRunId, pageKey, evidenceId, factId ?? "", coverageRole].join("|"))}`;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
