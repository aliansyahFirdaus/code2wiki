import { and, asc, eq, gt, or } from "drizzle-orm";

import { generationDebugEvents, generationRuns, generationTasks, getDb, wikiRunPages } from "@code2wiki/db";
import { sanitizeErrorText } from "@code2wiki/shared";

type GenerationRun = typeof generationRuns.$inferSelect;
type DebugEvent = typeof generationDebugEvents.$inferSelect;
type GenerationTask = typeof generationTasks.$inferSelect;
type WikiRunPage = typeof wikiRunPages.$inferSelect;

export async function loadGenerationDebugEvents(input: {
  generationRunId: string;
  afterId?: string | null;
  since?: string | null;
  limit?: number | null;
}) {
  const db = getDb();
  const [run] = await db.select().from(generationRuns).where(eq(generationRuns.id, input.generationRunId)).limit(1);
  if (!run) return null;

  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const after = input.afterId
    ? (await db.select().from(generationDebugEvents).where(and(eq(generationDebugEvents.generationRunId, run.id), eq(generationDebugEvents.id, input.afterId))).limit(1))[0] ?? null
    : null;
  const sinceDate = input.since && !after ? validDate(input.since) : null;
  const where = after
    ? and(
        eq(generationDebugEvents.generationRunId, run.id),
        or(gt(generationDebugEvents.createdAt, after.createdAt), and(eq(generationDebugEvents.createdAt, after.createdAt), gt(generationDebugEvents.id, after.id)))
      )
    : sinceDate
      ? and(eq(generationDebugEvents.generationRunId, run.id), gt(generationDebugEvents.createdAt, sinceDate))
      : eq(generationDebugEvents.generationRunId, run.id);

  const [events, tasks, pages] = await Promise.all([
    db.select().from(generationDebugEvents).where(where).orderBy(asc(generationDebugEvents.createdAt), asc(generationDebugEvents.id)).limit(limit),
    db.select().from(generationTasks).where(eq(generationTasks.generationRunId, run.id)),
    db.select().from(wikiRunPages).where(eq(wikiRunPages.generationRunId, run.id))
  ]);

  return {
    events: events.map(toEventResponse),
    nextAfterId: events.at(-1)?.id ?? null,
    summary: buildDebugSummary(run, tasks, pages, events)
  };
}

export function buildDebugSummary(run: GenerationRun, tasks: GenerationTask[], pages: WikiRunPage[], events: DebugEvent[] = []) {
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
