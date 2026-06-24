import { codeMaps, generationRuns, generationTasks, getDb, wikiPages } from "@code2wiki/db";
import { and, asc, eq, sql } from "drizzle-orm";

const STALE_IN_PROGRESS_MS = 15 * 60 * 1000;
const FRONTEND_SURFACE_KINDS = new Set(["UI_ROUTE", "REACT_COMPONENT", "NAVIGATION"]);

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

    const seeded = await seedDiscoverSurfaceTasks(run, requireSeedArtifact);
    let processed = 0;
    for (;;) {
      const task = await claimNextTask(run.id);
      if (!task) {
        break;
      }
      await processTask(run, task);
      processed += 1;
    }

    const counts = await taskCounts(run.id);
    return { status: "tasks_processed", generationRunId: run.id, seeded, processed, ...counts };
  } catch (error) {
    const errorMessage = sanitizeErrorMessage(error);
    if (run) {
      await db.update(generationRuns).set({ status: "FAILED", errorMessage, finishedAt: new Date() }).where(eq(generationRuns.id, run.id));
    }
    return { status: "failed", generationRunId: run?.id, errorMessage };
  }
}

async function claimFactsExtractedRun(generationRunId?: string) {
  const db = getDb();

  if (generationRunId) {
    const [claimed] = await db
      .update(generationRuns)
      .set({ status: "AI_GENERATING", errorMessage: null, finishedAt: null })
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
      .set({ status: "AI_GENERATING", errorMessage: null, finishedAt: null })
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
      });
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
    .where(and(eq(generationTasks.generationRunId, generationRunId), eq(generationTasks.status, "QUEUED")))
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
  return claimed ?? null;
}

async function processTask(run: GenerationRun, task: GenerationTask) {
  if (task.repositoryRole === "BACKEND" && !hasFrontendAnchor(task)) {
    await finishTask(task.id, {
      status: "NEEDS_REVIEW",
      branchState: "NEEDS_FRONTEND_ANCHOR",
      resultJson: { reason: "backend task has no frontend anchor" }
    });
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
    });
    return;
  }

  if (task.taskType === "TRACE_BEHAVIOR") {
    const writeType = (await pageExists(run.workspaceId, task.pageKey)) ? "UPDATE_PAGE" : "CREATE_PAGE";
    const dedupeKey = `${writeType === "UPDATE_PAGE" ? "update" : "create"}-page:${task.pageKey}`;
    await insertTask({
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
    });
    await finishTask(task.id, {
      status: "SUCCEEDED",
      branchState: "WAITING_RELATED_BRANCH",
      resultJson: { queued: [dedupeKey] }
    });
    return;
  }

  if (task.taskType === "CREATE_PAGE" || task.taskType === "UPDATE_PAGE") {
    await finishTask(task.id, { status: "READY_TO_WRITE", resultJson: { phase: "phase_2_writes_this_task" } });
    return;
  }

  if (task.taskType === "EVALUATE_COVERAGE") {
    await finishTask(task.id, {
      status: "NEEDS_REVIEW",
      resultJson: { reason: "EVALUATE_COVERAGE_NOT_IMPLEMENTED_IN_PHASE_1" }
    });
    return;
  }

  await finishTask(task.id, { status: "FAILED", errorMessage: "UNKNOWN_TASK_TYPE", resultJson: { reason: "unknown task type" } });
}

async function insertTask(value: {
  generationRunId: string;
  workspaceId: string;
  repositoryRole?: "FRONTEND" | "BACKEND";
  repositoryId?: string | null;
  taskType: "DISCOVER_SURFACE" | "TRACE_BEHAVIOR" | "CREATE_PAGE" | "UPDATE_PAGE" | "EVALUATE_COVERAGE";
  pageKey?: string | null;
  parentTaskId?: string | null;
  rootTaskId?: string | null;
  dedupeKey: string;
  reason: string;
  payloadJson: Record<string, unknown>;
}) {
  const db = getDb();
  await db
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
    .onConflictDoNothing({ target: [generationTasks.generationRunId, generationTasks.dedupeKey] });
}

async function finishTask(
  taskId: string,
  value: {
    status: "SUCCEEDED" | "READY_TO_WRITE" | "NO_WIKI_VALUE" | "NEEDS_REVIEW" | "FAILED";
    branchState?: "FOUND_CHILDREN" | "WAITING_RELATED_BRANCH" | "NEEDS_FRONTEND_ANCHOR";
    resultJson?: Record<string, unknown>;
    errorMessage?: string | null;
  }
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
    needsReview: rows.filter((task) => task.status === "NEEDS_REVIEW").length,
    failed: rows.filter((task) => task.status === "FAILED").length
  };
}

function readCodeMapNodes(value: unknown) {
  if (!value || typeof value !== "object" || !Array.isArray((value as { nodes?: unknown }).nodes)) {
    throw new Error("INVALID_CODE_MAP");
  }
  return (value as { nodes: unknown[] }).nodes.filter(isCodeMapNode);
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
    return value.replace(/^\/+/, "").split("/").filter(Boolean).slice(0, 4).join(".").replace(/\s+/g, ".").replace(/^\.+|\.+$/g, "").toLowerCase() || "frontend";
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
  return withoutExtension.replace(/^api\//, "api/").split("/").filter(Boolean).slice(0, 4).join(".").replace(/\s+/g, ".").replace(/^\.+|\.+$/g, "").toLowerCase() || "frontend";
}

function sanitizeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.replace(/[A-Za-z0-9+/=]{24,}/g, "[redacted]").slice(0, 300) : "UNKNOWN_ERROR";
}
