import { and, asc, desc, eq, gt, lt, or } from "drizzle-orm";

import { generationDebugEvents, generationRuns, generationTasks, getDb, wikiRunPages } from "@code2wiki/db";
import { sanitizeErrorText, sanitizeJson } from "@code2wiki/shared";

type GenerationRun = typeof generationRuns.$inferSelect;
type DebugEvent = typeof generationDebugEvents.$inferSelect;
type GenerationTask = typeof generationTasks.$inferSelect;
type WikiRunPage = typeof wikiRunPages.$inferSelect;

export async function loadGenerationDebugEvents(input: {
  generationRunId: string;
  afterId?: string | null;
  beforeId?: string | null;
  since?: string | null;
  limit?: number | null;
  tail?: boolean | null;
}) {
  const db = getDb();
  const [run] = await db.select().from(generationRuns).where(eq(generationRuns.id, input.generationRunId)).limit(1);
  if (!run) return null;

  const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
  const after = input.afterId
    ? (await db.select().from(generationDebugEvents).where(and(eq(generationDebugEvents.generationRunId, run.id), eq(generationDebugEvents.id, input.afterId))).limit(1))[0] ?? null
    : null;
  const before = input.beforeId
    ? (await db.select().from(generationDebugEvents).where(and(eq(generationDebugEvents.generationRunId, run.id), eq(generationDebugEvents.id, input.beforeId))).limit(1))[0] ?? null
    : null;
  const sinceDate = input.since && !after ? validDate(input.since) : null;
  const where = after
    ? and(
        eq(generationDebugEvents.generationRunId, run.id),
        or(gt(generationDebugEvents.createdAt, after.createdAt), and(eq(generationDebugEvents.createdAt, after.createdAt), gt(generationDebugEvents.id, after.id)))
      )
    : before
      ? and(
          eq(generationDebugEvents.generationRunId, run.id),
          or(lt(generationDebugEvents.createdAt, before.createdAt), and(eq(generationDebugEvents.createdAt, before.createdAt), lt(generationDebugEvents.id, before.id)))
        )
    : sinceDate
      ? and(eq(generationDebugEvents.generationRunId, run.id), gt(generationDebugEvents.createdAt, sinceDate))
      : eq(generationDebugEvents.generationRunId, run.id);
  const readNewestFirst = Boolean(input.tail || before);

  const [eventRows, allEventRows, tasks, pages] = await Promise.all([
    db.select().from(generationDebugEvents).where(where).orderBy(
      readNewestFirst ? desc(generationDebugEvents.createdAt) : asc(generationDebugEvents.createdAt),
      readNewestFirst ? desc(generationDebugEvents.id) : asc(generationDebugEvents.id)
    ).limit(limit + 1),
    db.select().from(generationDebugEvents).where(eq(generationDebugEvents.generationRunId, run.id)),
    db.select().from(generationTasks).where(eq(generationTasks.generationRunId, run.id)),
    db.select().from(wikiRunPages).where(eq(wikiRunPages.generationRunId, run.id))
  ]);
  const hasOverflow = eventRows.length > limit;
  const events = (hasOverflow ? eventRows.slice(0, limit) : eventRows).slice();
  if (readNewestFirst) events.reverse();
  const [latestAnalyzeEvent] = await db
    .select()
    .from(generationDebugEvents)
    .where(and(eq(generationDebugEvents.generationRunId, run.id), eq(generationDebugEvents.stage, "analyze")))
    .orderBy(desc(generationDebugEvents.createdAt), desc(generationDebugEvents.id))
    .limit(1);

  return {
    events: events.map(toEventResponse),
    nextAfterId: events.at(-1)?.id ?? null,
    previousBeforeId: events[0]?.id ?? null,
    hasMoreBefore: readNewestFirst ? hasOverflow : Boolean(before),
    hasMoreAfter: readNewestFirst ? false : hasOverflow,
    totalEventCount: allEventRows.length,
    run: runSnapshot(run),
    tasks: tasks.map(taskDetail),
    summary: buildDebugSummary(run, tasks, pages, events, latestAnalyzeEvent ?? null)
  };
}

export function buildDebugSummary(run: GenerationRun, tasks: GenerationTask[], pages: WikiRunPage[], events: DebugEvent[] = [], latestAnalyzeEvent: DebugEvent | null = null) {
  const coverage = coverageSummary(run.coverageReportJson);
  const incremental = incrementalSummary(run.incrementalReportJson);
  const lastError = [...events].reverse().find((event) => event.severity === "ERROR")?.message ?? run.errorMessage ?? null;
  return {
    currentStage: events.at(-1)?.stage ?? run.status,
    activeTask: tasks.find((task) => task.status === "IN_PROGRESS") ? taskSummary(tasks.find((task) => task.status === "IN_PROGRESS")!) : null,
    taskCounts: {
      queued: tasks.filter((task) => task.status === "QUEUED").length,
      inProgress: tasks.filter((task) => task.status === "IN_PROGRESS").length,
      ready: tasks.filter((task) => task.status === "READY_TO_WRITE").length,
      written: tasks.filter((task) => task.status === "WRITTEN").length,
      needsReview: tasks.filter((task) => task.status === "NEEDS_REVIEW").length,
      failed: tasks.filter((task) => task.status === "FAILED").length
    },
    pageKeys: {
      written: pages.filter((page) => page.materializationType === "WRITTEN").map((page) => page.pageKey).sort(),
      reused: pages.filter((page) => page.materializationType === "REUSED").map((page) => page.pageKey).sort(),
      affected: incremental.affectedPageKeys
    },
    coverage,
    analyze: analyzeSummary(run, latestAnalyzeEvent),
    quality: qualitySummary(run.qualityReportJson),
    lastError: lastError ? sanitizeErrorText(lastError) : null
  };
}

function toEventResponse(event: DebugEvent) {
  return {
    id: event.id,
    generationRunId: event.generationRunId,
    stage: event.stage,
    eventType: event.eventType,
    severity: event.severity,
    message: event.message,
    payloadJson: event.payloadJson,
    createdAt: event.createdAt.toISOString()
  };
}

function taskSummary(task: GenerationTask) {
  return {
    id: task.id,
    taskType: task.taskType,
    status: task.status,
    pageKey: task.pageKey,
    repositoryRole: task.repositoryRole
  };
}

function runSnapshot(run: GenerationRun) {
  return {
    id: run.id,
    status: run.status,
    workspaceId: run.workspaceId,
    frontendRepositoryId: run.frontendRepositoryId,
    backendRepositoryId: run.backendRepositoryId,
    frontendTag: run.frontendTag,
    frontendCommitSha: run.frontendCommitSha,
    backendTag: run.backendTag,
    backendCommitSha: run.backendCommitSha,
    totalEligibleFiles: run.totalEligibleFiles,
    indexedEligibleFiles: run.indexedEligibleFiles,
    frontendTotalEligibleFiles: run.frontendTotalEligibleFiles,
    frontendIndexedEligibleFiles: run.frontendIndexedEligibleFiles,
    backendTotalEligibleFiles: run.backendTotalEligibleFiles,
    backendIndexedEligibleFiles: run.backendIndexedEligibleFiles,
    generatedStatementCount: run.generatedStatementCount,
    generatedStatementWithEvidenceCount: run.generatedStatementWithEvidenceCount,
    incrementalReportJson: sanitizeJson(run.incrementalReportJson),
    coverageReportJson: sanitizeJson(run.coverageReportJson),
    errorMessage: run.errorMessage ? sanitizeErrorText(run.errorMessage) : null,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString()
  };
}

function taskDetail(task: GenerationTask) {
  return {
    id: task.id,
    generationRunId: task.generationRunId,
    workspaceId: task.workspaceId,
    repositoryRole: task.repositoryRole,
    repositoryId: task.repositoryId,
    taskType: task.taskType,
    status: task.status,
    branchState: task.branchState,
    priority: task.priority,
    pageKey: task.pageKey,
    parentTaskId: task.parentTaskId,
    rootTaskId: task.rootTaskId,
    dedupeKey: task.dedupeKey,
    reason: task.reason,
    payloadJson: sanitizeJson(task.payloadJson),
    resultJson: sanitizeJson(task.resultJson),
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    errorMessage: task.errorMessage ? sanitizeErrorText(task.errorMessage) : null,
    claimedAt: task.claimedAt?.toISOString() ?? null,
    startedAt: task.startedAt?.toISOString() ?? null,
    finishedAt: task.finishedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString()
  };
}

function coverageSummary(value: unknown) {
  if (!isRecord(value)) return { counts: null, gaps: [] };
  return {
    counts: isRecord(value.counts) ? value.counts : null,
    gaps: Array.isArray(value.gaps)
      ? value.gaps.map((gap) => isRecord(gap) ? {
          disposition: stringOrNull(gap.disposition),
          pageKey: stringOrNull(gap.pageKey),
          evidenceId: stringOrNull(gap.evidenceId),
          factId: stringOrNull(gap.factId),
          reason: stringOrNull(gap.reason)
        } : null).filter(Boolean)
      : []
  };
}

function incrementalSummary(value: unknown) {
  return {
    affectedPageKeys: isRecord(value) && Array.isArray(value.affectedPageKeys)
      ? value.affectedPageKeys.filter((item): item is string => typeof item === "string")
      : []
  };
}

function analyzeSummary(run: GenerationRun, event: DebugEvent | null) {
  const payload = isRecord(event?.payloadJson) ? event.payloadJson : null;
  return {
    totalEligibleFiles: run.totalEligibleFiles,
    indexedEligibleFiles: run.indexedEligibleFiles,
    frontendTotalEligibleFiles: run.frontendTotalEligibleFiles,
    frontendIndexedEligibleFiles: run.frontendIndexedEligibleFiles,
    backendTotalEligibleFiles: run.backendTotalEligibleFiles,
    backendIndexedEligibleFiles: run.backendIndexedEligibleFiles,
    factCount: numberOrNull(payload?.factCount),
    evidenceCount: numberOrNull(payload?.evidenceCount),
    codeSummaryCount: numberOrNull(payload?.codeSummaryCount),
    scanScope: isRecord(payload?.scanScope) ? payload?.scanScope : null,
    files: isRecord(payload?.files) ? payload?.files : null,
    scanWarnings: stringArray(payload?.scanWarnings)
  };
}

function qualitySummary(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.issues)) {
    return [];
  }
  return value.issues
    .filter(isRecord)
    .map((issue) => ({
      severity: stringOrNull(issue.severity),
      code: stringOrNull(issue.code),
      message: stringOrNull(issue.message)
    }))
    .filter((issue) => issue.message)
    .slice(0, 5);
}

function validDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
