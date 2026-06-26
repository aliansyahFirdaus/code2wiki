import { NextResponse } from "next/server";
import { eq, inArray, and } from "drizzle-orm";

import { generationRuns, generationTasks, getDb } from "@code2wiki/db";
import { sanitizeErrorText } from "@code2wiki/shared";

type Context = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: Request, context: Context) {
  const { id } = await context.params;

  try {
    const db = getDb();
    const [existingRun] = await db.select().from(generationRuns).where(eq(generationRuns.id, id)).limit(1);
    if (!existingRun) {
      return NextResponse.json({ error: { code: "GENERATION_RUN_NOT_FOUND", message: "Generation run not found." } }, { status: 404 });
    }

    if (existingRun.status === "QUEUED" || existingRun.status === "CLONED" || existingRun.status === "FACTS_EXTRACTED") {
      await db
        .update(generationTasks)
        .set({ status: "CANCELED", errorMessage: "RUN_CANCELED", finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(generationTasks.generationRunId, id), inArray(generationTasks.status, ["QUEUED", "IN_PROGRESS", "READY_TO_WRITE"])));
      const [run] = await db
        .update(generationRuns)
        .set({ status: "CANCELED", controlState: "ACTIVE", advanceRequestedAt: null, finishedAt: new Date(), errorMessage: "RUN_CANCELED" })
        .where(eq(generationRuns.id, id))
        .returning();
      return NextResponse.json({ generationRunId: run.id, controlState: run.controlState, status: run.status });
    }

    const [run] = await db
      .update(generationRuns)
      .set({ controlState: "CANCEL_REQUESTED", advanceRequestedAt: null })
      .where(eq(generationRuns.id, id))
      .returning();
    return NextResponse.json({ generationRunId: run.id, controlState: run.controlState, status: run.status });
  } catch (error) {
    return NextResponse.json({ error: { code: "GENERATION_RUN_CANCEL_FAILED", message: sanitizeErrorText(error) } }, { status: 503 });
  }
}
