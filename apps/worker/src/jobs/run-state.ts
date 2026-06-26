import { and, eq, inArray } from "drizzle-orm";

import { generationRuns, generationTasks, getDb } from "@code2wiki/db";

type RunStatus = typeof generationRuns.$inferSelect["status"];
type TaskStatus = typeof generationTasks.$inferSelect["status"];

const cancelableTaskStatuses: TaskStatus[] = ["QUEUED", "IN_PROGRESS", "READY_TO_WRITE"];

export async function readRunState(generationRunId: string) {
  try {
    const [run] = await getDb().select().from(generationRuns).where(eq(generationRuns.id, generationRunId)).limit(1);
    return run ?? null;
  } catch {
    return null;
  }
}

export async function checkpointRunControl(input: {
  generationRunId: string;
  runningStatus: RunStatus;
  pausedStatus: RunStatus;
}) {
  const run = await readRunState(input.generationRunId);
  if (!run) {
    return { action: "continue" as const, run: null };
  }
  if (run.controlState === "ACTIVE") {
    return { action: "continue" as const, run };
  }
  if (run.controlState === "PAUSED") {
    if (run.status === input.runningStatus) {
      await getDb()
        .update(generationRuns)
        .set({ status: input.pausedStatus })
        .where(and(eq(generationRuns.id, run.id), eq(generationRuns.status, input.runningStatus), eq(generationRuns.controlState, "PAUSED")));
    }
    return { action: "pause" as const, run };
  }

  await cancelRun(run.id, run.errorMessage);
  return { action: "cancel" as const, run };
}

export async function cancelRun(generationRunId: string, errorMessage: string | null = null) {
  const db = getDb();
  await db
    .update(generationTasks)
    .set({
      status: "CANCELED",
      errorMessage: errorMessage ?? "RUN_CANCELED",
      finishedAt: new Date(),
      updatedAt: new Date()
    })
    .where(and(eq(generationTasks.generationRunId, generationRunId), inArray(generationTasks.status, cancelableTaskStatuses)));
  await db
    .update(generationRuns)
    .set({
      status: "CANCELED",
      controlState: "ACTIVE",
      advanceRequestedAt: null,
      finishedAt: new Date(),
      errorMessage: errorMessage ?? "RUN_CANCELED"
    })
    .where(eq(generationRuns.id, generationRunId));
}
