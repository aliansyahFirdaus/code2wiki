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
    incrementalSummary: incrementalSummary(run.incrementalReportJson),
    coverageSummary: coverageSummary(run.coverageReportJson),
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

function incrementalSummary(value: unknown) {
  if (!isRecord(value)) return null;
  return {
    mode: typeof value.mode === "string" ? value.mode : null,
    baselineGenerationRunId: typeof value.baselineGenerationRunId === "string" ? value.baselineGenerationRunId : null,
    generatedPageCount: numberOrNull(value.generatedPageCount),
    reusedPageCount: numberOrNull(value.reusedPageCount),
    affectedPageKeys: stringArray(value.affectedPageKeys),
    reusedPageKeys: stringArray(value.reusedPageKeys),
    aiRequestCountSavedEstimate: numberOrNull(value.aiRequestCountSavedEstimate),
    pageInputHashVersion: typeof value.pageInputHashVersion === "string" ? value.pageInputHashVersion : null
  };
}

function coverageSummary(value: unknown) {
  if (!isRecord(value)) return null;
  return {
    acceptable: typeof value.acceptable === "boolean" ? value.acceptable : null,
    counts: isRecord(value.counts) ? {
      facts: numberOrNull(value.counts.facts),
      evidence: numberOrNull(value.counts.evidence),
      positiveCoverage: numberOrNull(value.counts.positiveCoverage),
      terminalNegativeCoverage: numberOrNull(value.counts.terminalNegativeCoverage),
      uncovered: numberOrNull(value.counts.uncovered),
      queuedTasks: numberOrNull(value.counts.queuedTasks),
      reviewGaps: numberOrNull(value.counts.reviewGaps)
    } : null,
    gaps: Array.isArray(value.gaps)
      ? value.gaps.map((gap) => isRecord(gap) ? {
          disposition: typeof gap.disposition === "string" ? gap.disposition : null,
          pageKey: typeof gap.pageKey === "string" ? gap.pageKey : null,
          evidenceId: typeof gap.evidenceId === "string" ? gap.evidenceId : null,
          factId: typeof gap.factId === "string" ? gap.factId : null,
          reason: typeof gap.reason === "string" ? gap.reason : null
        } : null).filter(Boolean)
      : []
  };
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
