import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { generationRuns, getDb, wikiPages } from "@code2wiki/db";
import { sanitizeErrorText } from "@code2wiki/shared";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;

  try {
    const db = getDb();
    const [run] = await db.select().from(generationRuns).where(eq(generationRuns.id, id)).limit(1);
    if (!run) {
      return NextResponse.json({ error: { code: "GENERATION_RUN_NOT_FOUND", message: "Generation run not found." } }, { status: 404 });
    }

    const pages = await db.select().from(wikiPages).where(eq(wikiPages.generationRunId, run.id));
    return NextResponse.json({ generationRun: toRunResponse(run, pages) });
  } catch (error) {
    return NextResponse.json(
      { error: { code: "GENERATION_RUN_UNAVAILABLE", message: sanitizeErrorText(error) } },
      { status: 503 }
    );
  }
}

function toRunResponse(run: typeof generationRuns.$inferSelect, pages: Array<typeof wikiPages.$inferSelect>) {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    frontendRepositoryId: run.frontendRepositoryId,
    backendRepositoryId: run.backendRepositoryId,
    frontendTag: run.frontendTag,
    frontendCommitSha: run.frontendCommitSha,
    backendTag: run.backendTag,
    backendCommitSha: run.backendCommitSha,
    status: run.status,
    totalEligibleFiles: run.totalEligibleFiles,
    indexedEligibleFiles: run.indexedEligibleFiles,
    frontendTotalEligibleFiles: run.frontendTotalEligibleFiles,
    frontendIndexedEligibleFiles: run.frontendIndexedEligibleFiles,
    backendTotalEligibleFiles: run.backendTotalEligibleFiles,
    backendIndexedEligibleFiles: run.backendIndexedEligibleFiles,
    generatedStatementCount: run.generatedStatementCount,
    generatedStatementWithEvidenceCount: run.generatedStatementWithEvidenceCount,
    errorMessage: run.errorMessage ? sanitizeErrorText(run.errorMessage) : null,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    wikiPages: pages.map((page) => ({
      id: page.id,
      title: page.title,
      pageKey: page.pageKey,
      href: `/wiki/${page.id}`
    }))
  };
}
