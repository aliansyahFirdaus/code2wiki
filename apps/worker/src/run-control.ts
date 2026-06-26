import { and, asc, eq, isNotNull, or } from "drizzle-orm";

import { generationRuns, getDb } from "@code2wiki/db";
import { nextTopLevelStageForStatus, type TopLevelGenerationStage } from "@code2wiki/shared";

type RunnableRun = typeof generationRuns.$inferSelect;

export type DaemonRunClaim =
  | {
      generationRunId: string;
      stage: TopLevelGenerationStage;
      executionMode: "AUTO" | "MANUAL";
    }
  | null;

export async function claimNextDaemonRun(): Promise<DaemonRunClaim> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(generationRuns)
      .where(
        and(
          or(
            eq(generationRuns.status, "QUEUED"),
            eq(generationRuns.status, "CLONED"),
            eq(generationRuns.status, "FACTS_EXTRACTED"),
            eq(generationRuns.status, "AI_GENERATING")
          ),
          eq(generationRuns.controlState, "ACTIVE"),
          or(
            eq(generationRuns.executionMode, "AUTO"),
            eq(generationRuns.status, "AI_GENERATING"),
            and(eq(generationRuns.executionMode, "MANUAL"), isNotNull(generationRuns.advanceRequestedAt))
          )
        )
      )
      .orderBy(asc(generationRuns.createdAt))
      .limit(1);

    if (!run) {
      return null;
    }

    const stage = nextRunnableStage(run);
    if (!stage) {
      return null;
    }

    if (run.executionMode === "AUTO") {
      return { generationRunId: run.id, stage, executionMode: "AUTO" };
    }
    if (run.status === "AI_GENERATING") {
      return { generationRunId: run.id, stage, executionMode: "MANUAL" };
    }

    const [claimedManualRun] = await tx
      .update(generationRuns)
      .set({ advanceRequestedAt: null })
      .where(and(eq(generationRuns.id, run.id), isNotNull(generationRuns.advanceRequestedAt)))
      .returning();

    if (!claimedManualRun) {
      return null;
    }

    return { generationRunId: claimedManualRun.id, stage, executionMode: "MANUAL" };
  });
}

export function nextRunnableStage(run: Pick<RunnableRun, "status">) {
  return nextTopLevelStageForStatus(run.status);
}
