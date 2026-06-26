import { and, eq, inArray, ne } from "drizzle-orm";

import {
  codeFacts,
  codeMaps,
  codeSummaries,
  evidence,
  generationDebugEvents,
  generationRuns,
  generationTasks,
  getDb,
  wikiBlocks,
  wikiPageEvidence,
  wikiPages,
  wikiRunPages
} from "@code2wiki/db";

type DeletedCounts = {
  generationRun: number;
  debugEvents: number;
  tasks: number;
  pageEvidence: number;
  blocks: number;
  runPages: number;
  pages: number;
  codeSummaries: number;
  codeMaps: number;
  codeFacts: number;
  evidence: number;
};

export async function deleteGenerationRun(generationRunId?: string) {
  const runId = generationRunId?.trim();
  if (!runId) {
    return { status: "error" as const, errorMessage: "generationRunId is required." };
  }

  const db = getDb();
  return db.transaction(async (tx) => {
    const [run] = await tx.select({ id: generationRuns.id }).from(generationRuns).where(eq(generationRuns.id, runId)).limit(1);
    if (!run) {
      return { status: "not_found" as const, generationRunId: runId };
    }

    const ownedPages = await tx.select({ id: wikiPages.id }).from(wikiPages).where(eq(wikiPages.generationRunId, runId));
    const ownedPageIds = ownedPages.map((page) => page.id);
    const remainingReferences = ownedPageIds.length > 0
      ? await tx.select({ pageId: wikiRunPages.pageId }).from(wikiRunPages).where(and(inArray(wikiRunPages.pageId, ownedPageIds), ne(wikiRunPages.generationRunId, runId)))
      : [];
    const deletablePageIds = deletableOwnedPageIds(ownedPageIds, remainingReferences.map((row) => row.pageId));

    const deleted: DeletedCounts = {
      generationRun: 0,
      debugEvents: await deleteCount(tx.delete(generationDebugEvents).where(eq(generationDebugEvents.generationRunId, runId)).returning({ id: generationDebugEvents.id })),
      tasks: await deleteCount(tx.delete(generationTasks).where(eq(generationTasks.generationRunId, runId)).returning({ id: generationTasks.id })),
      pageEvidence: await deleteCount(tx.delete(wikiPageEvidence).where(eq(wikiPageEvidence.generationRunId, runId)).returning({ id: wikiPageEvidence.id })),
      blocks: 0,
      runPages: await deleteCount(tx.delete(wikiRunPages).where(eq(wikiRunPages.generationRunId, runId)).returning({ id: wikiRunPages.id })),
      pages: 0,
      codeSummaries: await deleteCount(tx.delete(codeSummaries).where(eq(codeSummaries.generationRunId, runId)).returning({ id: codeSummaries.id })),
      codeMaps: await deleteCount(tx.delete(codeMaps).where(eq(codeMaps.generationRunId, runId)).returning({ id: codeMaps.id })),
      codeFacts: await deleteCount(tx.delete(codeFacts).where(eq(codeFacts.generationRunId, runId)).returning({ id: codeFacts.id })),
      evidence: await deleteCount(tx.delete(evidence).where(eq(evidence.generationRunId, runId)).returning({ id: evidence.id }))
    };

    if (deletablePageIds.length > 0) {
      deleted.blocks = await deleteCount(tx.delete(wikiBlocks).where(inArray(wikiBlocks.pageId, deletablePageIds)).returning({ id: wikiBlocks.id }));
      deleted.pages = await deleteCount(tx.delete(wikiPages).where(inArray(wikiPages.id, deletablePageIds)).returning({ id: wikiPages.id }));
    }

    deleted.generationRun = await deleteCount(tx.delete(generationRuns).where(eq(generationRuns.id, runId)).returning({ id: generationRuns.id }));

    return { status: "deleted" as const, generationRunId: runId, deleted };
  });
}

export function deletableOwnedPageIds(ownedPageIds: string[], referencedPageIds: string[]) {
  const referenced = new Set(referencedPageIds);
  return ownedPageIds.filter((pageId) => !referenced.has(pageId));
}

async function deleteCount<T>(query: Promise<T[]>) {
  return (await query).length;
}
