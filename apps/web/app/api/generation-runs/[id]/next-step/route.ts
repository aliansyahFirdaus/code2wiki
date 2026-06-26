import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { generationRuns, getDb } from "@code2wiki/db";
import { isAdvanceableGenerationStatus } from "@code2wiki/shared";
import { sanitizeErrorText } from "@code2wiki/shared";

type Context = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: Request, context: Context) {
  const { id } = await context.params;

  try {
    const db = getDb();
    const [run] = await db.select().from(generationRuns).where(eq(generationRuns.id, id)).limit(1);
    if (!run) {
      return NextResponse.json({ error: { code: "GENERATION_RUN_NOT_FOUND", message: "Generation run not found." } }, { status: 404 });
    }
    if (run.executionMode !== "MANUAL") {
      return NextResponse.json(
        { error: { code: "MANUAL_MODE_REQUIRED", message: "Switch the run to MANUAL before requesting the next step." } },
        { status: 400 }
      );
    }
    if (run.controlState !== "ACTIVE") {
      return NextResponse.json(
        { error: { code: "RUN_CONTROL_BLOCKED", message: "Resume the run before queueing the next step." } },
        { status: 400 }
      );
    }
    if (!isAdvanceableGenerationStatus(run.status)) {
      return NextResponse.json(
        { error: { code: "NEXT_STEP_UNAVAILABLE", message: "Next step is only available for queued, cloned, or facts extracted runs." } },
        { status: 400 }
      );
    }

    const [updatedRun] = await db
      .update(generationRuns)
      .set({ advanceRequestedAt: new Date() })
      .where(eq(generationRuns.id, id))
      .returning();

    return NextResponse.json({
      generationRunId: updatedRun.id,
      advanceRequestedAt: updatedRun.advanceRequestedAt?.toISOString() ?? null
    });
  } catch (error) {
    return NextResponse.json(
      { error: { code: "NEXT_STEP_REQUEST_FAILED", message: sanitizeErrorText(error) } },
      { status: 503 }
    );
  }
}
