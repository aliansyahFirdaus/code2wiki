import { deriveProductConcepts, matchConceptsToPages, type CodeMap, type ConceptPageDecision } from "@code2wiki/analyzer";
import { codeFacts, codeMaps, evidence as evidenceTable, generationRuns, generationTasks, getDb, wikiPages } from "@code2wiki/db";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { currentCoverageFingerprint, evaluateCoverage } from "./coverage-evaluator";
import { emitDebugEvent } from "./debug-events";
import { materializedPageCount, planIncrementalRun } from "./incremental-planner";
import { writePageTask } from "./page-writer";

const STALE_IN_PROGRESS_MS = 15 * 60 * 1000;
const FRONTEND_SURFACE_KINDS = new Set(["UI_ROUTE", "REACT_COMPONENT", "NAVIGATION"]);
const MAX_RELATED_DISCOVERY_DEPTH = 2;

type GenerationRun = typeof generationRuns.$inferSelect;
type GenerationTask = typeof generationTasks.$inferSelect;
type CodeMapNode = {
  stableKey: string;
  kind: string;
  repositoryRole: "FRONTEND" | "BACKEND";
  repositoryFullName: string;
  label: string;
  filePath: string;
  metadata?: Record<string, unknown>;
  evidenceIds?: string[];
};

export type SelfExpandingGenerationResult =
  | { status: "skipped"; reason: string }
  | {
      status: "tasks_processed";
      generationRunId: string;
      seeded: number;
      processed: number;
      queued: number;
      ready: number;
      written: number;
      needsReview: number;
      failed: number;
    }
  | { status: "failed"; generationRunId?: string; errorMessage: string };

export async function runSelfExpandingGeneration(generationRunId?: string): Promise<SelfExpandingGenerationResult> {
  const db = getDb();
  let run: GenerationRun | null = null;
  let requireSeedArtifact = false;

  try {
    run = await claimFactsExtractedRun(generationRunId);
    requireSeedArtifact = Boolean(run);
    if (!run) {
      run = await resumableAiGeneratingRun(generationRunId);
    }

    if (!run) {
      return { status: "skipped", reason: generationRunId ? "Generation run has no queue work." : "No generation queue work found." };
    }

    const incremental = requireSeedArtifact ? await planIncrementalRun(run) : { seeded: 0, mode: "FULL" as const };
    const seeded = incremental.seeded + (incremental.mode === "FULL" ? await seedDiscoverSurfaceTasks(run, requireSeedArtifact) : 0);
    let processed = 0;
    for (;;) {
      const task = await claimNextTask(run.id);
      if (!task) {
        if (!(await ensureCoverageEvaluationTask(run))) {
          break;
        }
        continue;
      }
      await processTask(run, task);
      processed += 1;
      if (task.taskType === "EVALUATE_COVERAGE") {
        break;
      }
    }

    await finalizeRunIfTerminal(run.id);
    const counts = await taskCounts(run.id);
    return { status: "tasks_processed", generationRunId: run.id, seeded, processed, ...counts };
  } catch (error) {
    const errorMessage = sanitizeErrorMessage(error);
    if (run) {
      await db.update(generationRuns).set({ status: "FAILED", errorMessage, finishedAt: new Date() }).where(eq(generationRuns.id, run.id));
      await emitDebugEvent({
        generationRunId: run.id,
        stage: "completion",
        eventType: "RUN_FAILED",
        severity: "ERROR",
        message: "Generation run failed.",
        payload: { errorMessage }
      });
    }
    return { status: "failed", generationRunId: run?.id, errorMessage };
  }
}

async function claimFactsExtractedRun(generationRunId?: string) {
  const db = getDb();

  if (generationRunId) {
    const [claimed] = await db
      .update(generationRuns)
      .set({
        status: "AI_GENERATING",
        generatedStatementCount: 0,
        generatedStatementWithEvidenceCount: 0,
        qualityReportJson: null,
        aiUsageJson: null,
        incrementalReportJson: null,
        coverageReportJson: null,
        errorMessage: null,
        finishedAt: null
      })
      .where(and(eq(generationRuns.id, generationRunId), eq(generationRuns.status, "FACTS_EXTRACTED")))
      .returning();
    return claimed ?? null;
  }

  return db.transaction(async (tx) => {
    const [nextRun] = await tx.select().from(generationRuns).where(eq(generationRuns.status, "FACTS_EXTRACTED")).orderBy(asc(generationRuns.createdAt)).limit(1);
    if (!nextRun) {
      return null;
    }
    const [claimed] = await tx
      .update(generationRuns)
      .set({
        status: "AI_GENERATING",
        generatedStatementCount: 0,
        generatedStatementWithEvidenceCount: 0,
        qualityReportJson: null,
        aiUsageJson: null,
        incrementalReportJson: null,
        coverageReportJson: null,
        errorMessage: null,
        finishedAt: null
      })
      .where(and(eq(generationRuns.id, nextRun.id), eq(generationRuns.status, "FACTS_EXTRACTED")))
      .returning();
    return claimed ?? null;
  });
}

async function resumableAiGeneratingRun(generationRunId?: string) {
  const db = getDb();
  const query = generationRunId ? and(eq(generationRuns.id, generationRunId), eq(generationRuns.status, "AI_GENERATING")) : eq(generationRuns.status, "AI_GENERATING");
  const [run] = await db.select().from(generationRuns).where(query).orderBy(asc(generationRuns.createdAt)).limit(1);
  if (!run) {
    return null;
  }

  const [existingTask] = await db.select().from(generationTasks).where(eq(generationTasks.generationRunId, run.id)).limit(1);
  if (!existingTask) {
    return null;
  }

  const inProgress = await db.select().from(generationTasks).where(and(eq(generationTasks.generationRunId, run.id), eq(generationTasks.status, "IN_PROGRESS")));
  const cutoff = Date.now() - STALE_IN_PROGRESS_MS;
  if (inProgress.some((task) => task.claimedAt && task.claimedAt.getTime() > cutoff)) {
    return null;
  }

  for (const task of inProgress) {
    if (task.attempts >= task.maxAttempts) {
      await finishTask(task.id, {
        status: "FAILED",
        errorMessage: "STALE_TASK_RETRY_EXHAUSTED",
        resultJson: { reason: "stale in-progress task exceeded retry budget" }
      }, task);
      continue;
    }
    await db
      .update(generationTasks)
      .set({ status: "QUEUED", claimedAt: null, startedAt: null, updatedAt: new Date() })
      .where(and(eq(generationTasks.id, task.id), eq(generationTasks.status, "IN_PROGRESS")));
  }

  return run;
}

async function seedDiscoverSurfaceTasks(run: GenerationRun, requireArtifact: boolean) {
  const db = getDb();
  const [codeMapRow] = await db.select().from(codeMaps).where(eq(codeMaps.generationRunId, run.id)).limit(1);
  if (!codeMapRow && !requireArtifact) {
    return 0;
  }
  const nodes = readCodeMapNodes(codeMapRow?.mapJson);
  let seeded = 0;

  for (const node of nodes.filter((item) => item.repositoryRole === "FRONTEND" && FRONTEND_SURFACE_KINDS.has(item.kind))) {
    const pageKey = pageKeyFromNode(node);
    if (!pageKey) {
      continue;
    }
    await insertTask({
      generationRunId: run.id,
      workspaceId: run.workspaceId,
      repositoryRole: "FRONTEND",
      repositoryId: run.frontendRepositoryId,
      taskType: "DISCOVER_SURFACE",
      pageKey,
      dedupeKey: `discover-surface:${pageKey}`,
      reason: `frontend anchor ${node.kind.toLowerCase()}`,
      payloadJson: { nodeStableKey: node.stableKey, nodeKind: node.kind, filePath: node.filePath, evidenceIds: node.evidenceIds ?? [] }
    });
    seeded += 1;
  }

  return seeded;
}

async function claimNextTask(generationRunId: string) {
  const db = getDb();
  const [nextTask] = await db
    .select()
    .from(generationTasks)
    .where(and(eq(generationTasks.generationRunId, generationRunId), or(eq(generationTasks.status, "QUEUED"), eq(generationTasks.status, "READY_TO_WRITE"))))
    .orderBy(asc(generationTasks.priority), asc(generationTasks.createdAt))
    .limit(1);
  if (!nextTask) {
    return null;
  }

  const [claimed] = await db
    .update(generationTasks)
    .set({
      status: "IN_PROGRESS",
      attempts: sql`${generationTasks.attempts} + 1`,
      claimedAt: new Date(),
      startedAt: new Date(),
      errorMessage: null,
      updatedAt: new Date()
    })
    .where(and(eq(generationTasks.id, nextTask.id), eq(generationTasks.status, "QUEUED")))
    .returning();
  if (claimed) {
    await emitDebugEvent({
      generationRunId,
      stage: "task_queue",
      eventType: "TASK_STARTED",
      message: "Generation task started.",
      payload: taskPayload(claimed)
    });
    return claimed;
  }

  const [claimedReady] = await db
    .update(generationTasks)
    .set({
      status: "IN_PROGRESS",
      attempts: sql`${generationTasks.attempts} + 1`,
      claimedAt: new Date(),
      startedAt: new Date(),
      errorMessage: null,
      updatedAt: new Date()
    })
    .where(and(eq(generationTasks.id, nextTask.id), eq(generationTasks.status, "READY_TO_WRITE")))
    .returning();
  if (claimedReady) {
    await emitDebugEvent({
      generationRunId,
      stage: "task_queue",
      eventType: "TASK_STARTED",
      message: "Generation task started.",
      payload: taskPayload(claimedReady)
    });
  }
  return claimedReady ?? null;
}

async function processTask(run: GenerationRun, task: GenerationTask) {
  if (task.repositoryRole === "BACKEND" && !hasFrontendAnchor(task)) {
    await finishTask(task.id, {
      status: "NEEDS_REVIEW",
      branchState: "NEEDS_FRONTEND_ANCHOR",
      resultJson: { reason: "backend task has no frontend anchor" }
    }, task);
    return;
  }

  if (task.taskType === "DISCOVER_SURFACE") {
    await insertTask({
      generationRunId: run.id,
      workspaceId: run.workspaceId,
      repositoryRole: "FRONTEND",
      repositoryId: run.frontendRepositoryId,
      taskType: "TRACE_BEHAVIOR",
      pageKey: task.pageKey,
      parentTaskId: task.id,
      rootTaskId: task.rootTaskId ?? task.id,
      dedupeKey: `trace-behavior:${task.pageKey}`,
      reason: "trace surface behavior",
      payloadJson: { frontendAnchor: task.payloadJson, pageKey: task.pageKey }
    });
    await finishTask(task.id, {
      status: "SUCCEEDED",
      branchState: "FOUND_CHILDREN",
      resultJson: { queued: [`trace-behavior:${task.pageKey}`] }
    }, task);
    return;
  }

  if (task.taskType === "TRACE_BEHAVIOR") {
    const writeType = (await pageExists(run.workspaceId, task.pageKey)) ? "UPDATE_PAGE" : "CREATE_PAGE";
    const dedupeKey = `${writeType === "UPDATE_PAGE" ? "update" : "create"}-page:${task.pageKey}`;
    const queued: string[] = [];
    if (await insertTask({
      generationRunId: run.id,
      workspaceId: run.workspaceId,
      repositoryRole: "FRONTEND",
      repositoryId: run.frontendRepositoryId,
      taskType: writeType,
      pageKey: task.pageKey,
      parentTaskId: task.id,
      rootTaskId: task.rootTaskId ?? task.id,
      dedupeKey,
      reason: `${writeType === "UPDATE_PAGE" ? "update" : "create"} page from traced behavior`,
      payloadJson: { pageKey: task.pageKey, frontendAnchor: task.payloadJson }
    })) {
      queued.push(dedupeKey);
    }

    const relatedDedupeKey = `discover-related:${task.rootTaskId ?? task.id}:${task.pageKey}:depth-1`;
    if (await insertTask({
      generationRunId: run.id,
      workspaceId: run.workspaceId,
      repositoryRole: "FRONTEND",
      repositoryId: run.frontendRepositoryId,
      taskType: "DISCOVER_RELATED_CONCEPTS",
      pageKey: task.pageKey,
      parentTaskId: task.id,
      rootTaskId: task.rootTaskId ?? task.id,
      dedupeKey: relatedDedupeKey,
      reason: "discover related product concepts",
      payloadJson: { depth: 1, sourcePageKey: task.pageKey, frontendAnchor: task.payloadJson }
    })) {
      queued.push(relatedDedupeKey);
    }

    await finishTask(task.id, {
      status: "SUCCEEDED",
      branchState: "WAITING_RELATED_BRANCH",
      resultJson: { queued }
    }, task);
    return;
  }

  if (task.taskType === "DISCOVER_RELATED_CONCEPTS") {
    await processRelatedConceptTask(run, task);
    return;
  }

  if (task.taskType === "CREATE_PAGE" || task.taskType === "UPDATE_PAGE") {
    const result = await writePageTask(run, task);
    if (result.ok) {
      await finishTask(task.id, {
        status: "WRITTEN",
        resultJson: {
          pageKey: result.pageKey,
          generatedStatementCount: result.generatedStatementCount,
          generatedStatementWithEvidenceCount: result.generatedStatementWithEvidenceCount,
          qualityGateResult: result.qualityReport.gateResult,
          aiCallCount: result.aiUsageReport.summary.callCount
        }
      }, task);
      return;
    }

    await finishTask(task.id, {
      status: "FAILED",
      errorMessage: result.errorMessage,
      resultJson: { reason: result.status, qualityGateResult: result.qualityReport?.gateResult, aiCallCount: result.aiUsageReport?.summary.callCount ?? 0 }
    }, task);
    await getDb()
      .update(generationRuns)
      .set({
        status: result.status,
        errorMessage: result.errorMessage,
        qualityReportJson: result.qualityReport,
        aiUsageJson: result.aiUsageReport,
        finishedAt: new Date()
      })
      .where(eq(generationRuns.id, run.id));
    await emitDebugEvent({
      generationRunId: run.id,
      stage: "completion",
      eventType: "RUN_FAILED",
      severity: "ERROR",
      message: "Generation run failed during page writing.",
      payload: { status: result.status, errorMessage: result.errorMessage }
    });
    return;
  }

  if (task.taskType === "EVALUATE_COVERAGE") {
    const result = await evaluateCoverage(run, task);
    if (!result.ok) {
      await finishTask(task.id, {
        status: "FAILED",
        errorMessage: result.errorMessage,
        resultJson: { reason: "COVERAGE_EVALUATOR_FAILED" }
      }, task);
      return;
    }
    if (result.queuedTaskDedupeKeys.length > 0) {
      await finishTask(task.id, {
        status: "SUCCEEDED",
        branchState: "FOUND_CHILDREN",
        resultJson: { fingerprint: result.report.fingerprint, queued: result.queuedTaskDedupeKeys }
      }, task);
      return;
    }
    if (result.reviewGaps.length > 0) {
      await finishTask(task.id, {
        status: "NEEDS_REVIEW",
        resultJson: { fingerprint: result.report.fingerprint, reason: "COVERAGE_REQUIRES_REVIEW", gaps: result.reviewGaps }
      }, task);
      return;
    }
    await finishTask(task.id, {
      status: "SUCCEEDED",
      resultJson: { fingerprint: result.report.fingerprint, acceptable: result.report.acceptable }
    }, task);
    return;
  }

  await finishTask(task.id, { status: "FAILED", errorMessage: "UNKNOWN_TASK_TYPE", resultJson: { reason: "unknown task type" } }, task);
}

async function insertTask(value: {
  generationRunId: string;
  workspaceId: string;
  repositoryRole?: "FRONTEND" | "BACKEND";
  repositoryId?: string | null;
  taskType: "DISCOVER_SURFACE" | "TRACE_BEHAVIOR" | "DISCOVER_RELATED_CONCEPTS" | "CREATE_PAGE" | "UPDATE_PAGE" | "EVALUATE_COVERAGE";
  pageKey?: string | null;
  parentTaskId?: string | null;
  rootTaskId?: string | null;
  dedupeKey: string;
  reason: string;
  payloadJson: Record<string, unknown>;
}) {
  const db = getDb();
  const inserted = await db
    .insert(generationTasks)
    .values({
      id: crypto.randomUUID(),
      generationRunId: value.generationRunId,
      workspaceId: value.workspaceId,
      repositoryRole: value.repositoryRole,
      repositoryId: value.repositoryId,
      taskType: value.taskType,
      pageKey: value.pageKey,
      parentTaskId: value.parentTaskId,
      rootTaskId: value.rootTaskId,
      dedupeKey: value.dedupeKey,
      reason: value.reason,
      payloadJson: value.payloadJson,
      updatedAt: new Date()
    })
    .onConflictDoNothing({ target: [generationTasks.generationRunId, generationTasks.dedupeKey] })
    .returning({ id: generationTasks.id });
  if (inserted.length > 0) {
    await emitDebugEvent({
      generationRunId: value.generationRunId,
      stage: "task_queue",
      eventType: "TASK_QUEUED",
      message: "Generation task queued.",
      payload: {
        taskId: inserted[0].id,
        taskType: value.taskType,
        pageKey: value.pageKey ?? null,
        dedupeKey: value.dedupeKey,
        repositoryRole: value.repositoryRole ?? null
      }
    });
  }
  return inserted.length > 0;
}

async function processRelatedConceptTask(run: GenerationRun, task: GenerationTask) {
  const db = getDb();
  const depth = taskDepth(task);
  const sourcePageKey = taskSourcePageKey(task);

  if (depth >= MAX_RELATED_DISCOVERY_DEPTH) {
    await finishTask(task.id, {
      status: "SUCCEEDED",
      resultJson: { depth, sourcePageKey, stopped: "MAX_DEPTH" }
    }, task);
    return;
  }

  const [factRows, evidenceRows, codeMapRows, existingPages] = await Promise.all([
    db.select().from(codeFacts).where(eq(codeFacts.generationRunId, run.id)),
    db.select().from(evidenceTable).where(eq(evidenceTable.generationRunId, run.id)),
    db.select().from(codeMaps).where(eq(codeMaps.generationRunId, run.id)).limit(1),
    db.select().from(wikiPages).where(eq(wikiPages.workspaceId, run.workspaceId))
  ]);
  const codeMap = readCodeMap(codeMapRows[0]?.mapJson);
  const concepts = deriveProductConcepts({ facts: factRows, evidence: evidenceRows, codeMap });
  const decisions = matchConceptsToPages({
    concepts,
    existingPageKeys: existingPages.map((page) => page.pageKey).filter((pageKey): pageKey is string => typeof pageKey === "string"),
    sourcePageKey
  });

  const queued: string[] = [];
  const needsReview = decisions.filter((decision) => decision.disposition === "NEEDS_REVIEW");
  const excluded = decisions.filter((decision) => decision.disposition === "EXCLUDED_NO_WIKI_VALUE");
  for (const decision of decisions.filter(isWritableDecision)) {
    const dedupeKey = `${decision.disposition === "UPDATE_PAGE" ? "update" : "create"}-page:${decision.pageKey}`;
    if (await insertTask({
      generationRunId: run.id,
      workspaceId: run.workspaceId,
      repositoryRole: "FRONTEND",
      repositoryId: run.frontendRepositoryId,
      taskType: decision.disposition,
      pageKey: decision.pageKey,
      parentTaskId: task.id,
      rootTaskId: task.rootTaskId ?? task.id,
      dedupeKey,
      reason: decision.reason,
      payloadJson: {
        pageKey: decision.pageKey,
        conceptKey: decision.conceptKey,
        evidenceIds: decision.evidenceIds,
        sourcePageKey,
        depth,
        relatedConcept: decision
      }
    })) {
      queued.push(dedupeKey);
    }
  }

  if (queued.length > 0) {
    await finishTask(task.id, {
      status: "SUCCEEDED",
      branchState: "FOUND_CHILDREN",
      resultJson: { depth, sourcePageKey, queued, needsReview, excluded }
    }, task);
    return;
  }

  if (needsReview.length > 0) {
    await finishTask(task.id, {
      status: "NEEDS_REVIEW",
      resultJson: { depth, sourcePageKey, reason: "RELATED_CONCEPTS_NEED_REVIEW", needsReview, excluded }
    }, task);
    return;
  }

  await finishTask(task.id, {
    status: "SUCCEEDED",
    resultJson: { depth, sourcePageKey, queued, needsReview, excluded }
  }, task);
}

async function finishTask(
  taskId: string,
  value: {
    status: "SUCCEEDED" | "READY_TO_WRITE" | "WRITTEN" | "NO_WIKI_VALUE" | "NEEDS_REVIEW" | "FAILED";
    branchState?: "FOUND_CHILDREN" | "WAITING_RELATED_BRANCH" | "NEEDS_FRONTEND_ANCHOR";
    resultJson?: Record<string, unknown>;
    errorMessage?: string | null;
  },
  task?: GenerationTask
) {
  const db = getDb();
  await db
    .update(generationTasks)
    .set({
      status: value.status,
      branchState: value.branchState,
      resultJson: value.resultJson,
      errorMessage: value.errorMessage ?? null,
      finishedAt: new Date(),
      updatedAt: new Date()
    })
    .where(eq(generationTasks.id, taskId));
  if (task) {
    await emitDebugEvent({
      generationRunId: task.generationRunId,
      stage: "task_queue",
      eventType: value.status === "FAILED" ? "TASK_FAILED" : "TASK_FINISHED",
      severity: value.status === "FAILED" ? "ERROR" : value.status === "NEEDS_REVIEW" ? "WARN" : "INFO",
      message: value.status === "FAILED" ? "Generation task failed." : "Generation task finished.",
      payload: { ...taskPayload(task), status: value.status, errorMessage: value.errorMessage ?? null }
    });
  }
}

async function pageExists(workspaceId: string, pageKey: string | null) {
  if (!pageKey) {
    return false;
  }
  const db = getDb();
  const [page] = await db.select().from(wikiPages).where(and(eq(wikiPages.workspaceId, workspaceId), eq(wikiPages.pageKey, pageKey))).limit(1);
  return Boolean(page);
}

async function taskCounts(generationRunId: string) {
  const rows = await getDb().select().from(generationTasks).where(eq(generationTasks.generationRunId, generationRunId));
  return {
    queued: rows.filter((task) => task.status === "QUEUED" || task.status === "IN_PROGRESS").length,
    ready: rows.filter((task) => task.status === "READY_TO_WRITE").length,
    written: rows.filter((task) => task.status === "WRITTEN").length,
    needsReview: rows.filter((task) => task.status === "NEEDS_REVIEW").length,
    failed: rows.filter((task) => task.status === "FAILED").length
  };
}

async function ensureCoverageEvaluationTask(run: GenerationRun) {
  const db = getDb();
  const tasks = await db.select().from(generationTasks).where(eq(generationTasks.generationRunId, run.id));
  if (tasks.some((task) => task.status === "QUEUED" || task.status === "IN_PROGRESS" || task.status === "READY_TO_WRITE")) {
    return false;
  }
  const fingerprint = await currentCoverageFingerprint(run);
  const dedupeKey = `evaluate-coverage:${fingerprint}`;
  if (tasks.some((task) => task.taskType === "EVALUATE_COVERAGE" && task.dedupeKey === dedupeKey && (task.status === "SUCCEEDED" || task.status === "NEEDS_REVIEW"))) {
    return false;
  }
  await insertTask({
    generationRunId: run.id,
    workspaceId: run.workspaceId,
    taskType: "EVALUATE_COVERAGE",
    dedupeKey,
    reason: "evaluate deterministic coverage",
    payloadJson: { fingerprint }
  });
  return true;
}

async function finalizeRunIfTerminal(generationRunId: string) {
  const db = getDb();
  const [run] = await db.select().from(generationRuns).where(eq(generationRuns.id, generationRunId)).limit(1);
  if (!run || (run.status !== "AI_GENERATING" && run.status !== "VALIDATING")) {
    return;
  }

  const tasks = await db.select().from(generationTasks).where(eq(generationTasks.generationRunId, generationRunId));
  if (tasks.length === 0 || tasks.some((task) => task.status === "QUEUED" || task.status === "IN_PROGRESS" || task.status === "READY_TO_WRITE")) {
    return;
  }
  if (tasks.some((task) => task.taskType === "EVALUATE_COVERAGE" && task.status === "SUCCEEDED" && task.branchState === "FOUND_CHILDREN")) {
    return;
  }
  if (tasks.some((task) => task.status === "FAILED")) {
    await db.update(generationRuns).set({ status: "FAILED", finishedAt: new Date(), errorMessage: "GENERATION_TASK_FAILED" }).where(eq(generationRuns.id, generationRunId));
    await emitDebugEvent({
      generationRunId,
      stage: "completion",
      eventType: "RUN_FAILED",
      severity: "ERROR",
      message: "Generation run failed.",
      payload: { errorMessage: "GENERATION_TASK_FAILED" }
    });
    return;
  }

  const fingerprint = await currentCoverageFingerprint(run);
  const currentEvaluatorSucceeded = tasks.some(
    (task) => task.taskType === "EVALUATE_COVERAGE" && task.dedupeKey === `evaluate-coverage:${fingerprint}` && task.status === "SUCCEEDED"
  );
  const coverageReport = readCoverageReport(run.coverageReportJson);
  const materializedPages = await materializedPageCount(generationRunId);
  const hasMaterializedPage = materializedPages > 0;
  const status = currentEvaluatorSucceeded && coverageReport?.acceptable === true && hasMaterializedPage ? "COMPLETED" : "NEEDS_REVIEW";

  await db
    .update(generationRuns)
    .set({
      status,
      finishedAt: new Date(),
      errorMessage: status === "COMPLETED" ? null : hasMaterializedPage ? "COVERAGE_REQUIRES_REVIEW" : "NO_PAGE_MATERIALIZED"
    })
    .where(eq(generationRuns.id, generationRunId));
  await emitDebugEvent({
    generationRunId,
    stage: "completion",
    eventType: status === "COMPLETED" ? "RUN_COMPLETED" : "RUN_NEEDS_REVIEW",
    severity: status === "COMPLETED" ? "INFO" : "WARN",
    message: status === "COMPLETED" ? "Generation run completed." : "Generation run needs review.",
    payload: { status, materializedPages, coverageAcceptable: coverageReport?.acceptable === true }
  });
}

function taskPayload(task: GenerationTask) {
  return {
    taskId: task.id,
    taskType: task.taskType,
    pageKey: task.pageKey,
    repositoryRole: task.repositoryRole,
    dedupeKey: task.dedupeKey,
    attempts: task.attempts
  };
}

function readCoverageReport(value: unknown): { acceptable?: unknown } | null {
  return value && typeof value === "object" ? (value as { acceptable?: unknown }) : null;
}

function readCodeMapNodes(value: unknown) {
  if (!value || typeof value !== "object" || !Array.isArray((value as { nodes?: unknown }).nodes)) {
    throw new Error("INVALID_CODE_MAP");
  }
  return (value as { nodes: unknown[] }).nodes.filter(isCodeMapNode);
}

function readCodeMap(value: unknown): CodeMap {
  if (!value || typeof value !== "object" || !Array.isArray((value as { nodes?: unknown }).nodes) || !Array.isArray((value as { edges?: unknown }).edges)) {
    throw new Error("INVALID_CODE_MAP");
  }
  return value as CodeMap;
}

function taskDepth(task: GenerationTask) {
  const depth = task.payloadJson && typeof task.payloadJson === "object" ? (task.payloadJson as { depth?: unknown }).depth : null;
  return typeof depth === "number" && Number.isFinite(depth) ? depth : 1;
}

function taskSourcePageKey(task: GenerationTask) {
  const sourcePageKey = task.payloadJson && typeof task.payloadJson === "object" ? (task.payloadJson as { sourcePageKey?: unknown }).sourcePageKey : null;
  return typeof sourcePageKey === "string" && sourcePageKey ? sourcePageKey : task.pageKey ?? undefined;
}

function isWritableDecision(decision: ConceptPageDecision): decision is ConceptPageDecision & { disposition: "CREATE_PAGE" | "UPDATE_PAGE" } {
  return decision.disposition === "CREATE_PAGE" || decision.disposition === "UPDATE_PAGE";
}

function isCodeMapNode(value: unknown): value is CodeMapNode {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as CodeMapNode).stableKey === "string" &&
      typeof (value as CodeMapNode).kind === "string" &&
      ((value as CodeMapNode).repositoryRole === "FRONTEND" || (value as CodeMapNode).repositoryRole === "BACKEND") &&
      typeof (value as CodeMapNode).repositoryFullName === "string" &&
      typeof (value as CodeMapNode).label === "string" &&
      typeof (value as CodeMapNode).filePath === "string"
  );
}

function hasFrontendAnchor(task: GenerationTask) {
  return Boolean(task.pageKey || (task.payloadJson && typeof task.payloadJson === "object" && "frontendAnchor" in task.payloadJson));
}

function pageKeyFromNode(node: CodeMapNode) {
  if (node.kind === "NAVIGATION") {
    return pageKeyFromRouteLike(String(node.metadata?.target ?? ""));
  }
  return pageKeyFromRouteLike(String(node.metadata?.path ?? node.filePath));
}

function pageKeyFromRouteLike(value: string) {
  if (!value) {
    return "";
  }
  if (value.startsWith("/")) {
    return normalizePageKey(value.replace(/^\/+/, "").split("/").filter(Boolean).slice(0, 4).join(".")) || "frontend";
  }
  return pageKeyFromPath(value);
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

function sanitizeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.replace(/[A-Za-z0-9+/=]{24,}/g, "[redacted]").slice(0, 300) : "UNKNOWN_ERROR";
}
