import type { generationRuns, wikiPages } from "@code2wiki/db";
import { sanitizeErrorText } from "@code2wiki/shared";

export function toGenerationRunResponse(run: typeof generationRuns.$inferSelect, pages: Array<typeof wikiPages.$inferSelect>) {
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
