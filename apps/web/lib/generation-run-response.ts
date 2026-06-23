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
    qualityGateResult: qualityGateResult(run.qualityReportJson),
    qualityIssueCounts: qualityIssueCounts(run.qualityReportJson),
    aiUsageSummary: aiUsageSummary(run.aiUsageJson),
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

function qualityGateResult(value: unknown) {
  if (!isRecord(value)) return null;
  return value.gateResult === "PASS" || value.gateResult === "WARN" || value.gateResult === "FAIL" ? value.gateResult : null;
}

function qualityIssueCounts(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.issues)) {
    return { error: 0, warn: 0 };
  }
  return value.issues.reduce(
    (counts, issue) => {
      if (isRecord(issue) && issue.severity === "ERROR") counts.error += 1;
      if (isRecord(issue) && issue.severity === "WARN") counts.warn += 1;
      return counts;
    },
    { error: 0, warn: 0 }
  );
}

function aiUsageSummary(value: unknown) {
  if (!isRecord(value) || !isRecord(value.summary)) return null;
  const summary = value.summary;
  return {
    callCount: numberOrNull(summary.callCount),
    promptTokens: numberOrNull(summary.promptTokens),
    completionTokens: numberOrNull(summary.completionTokens),
    totalTokens: numberOrNull(summary.totalTokens),
    estimatedCostUsdMicros: numberOrNull(summary.estimatedCostUsdMicros),
    pricingSource: typeof summary.pricingSource === "string" ? summary.pricingSource : null
  };
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
