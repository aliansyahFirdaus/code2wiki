import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { generationRuns, getDb } from "@code2wiki/db";
import { sanitizeErrorText } from "@code2wiki/shared";

type Context = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: Request, context: Context) {
  const { id } = await context.params;

  try {
    const [run] = await getDb()
      .update(generationRuns)
      .set({ controlState: "ACTIVE" })
      .where(eq(generationRuns.id, id))
      .returning();
    if (!run) {
      return NextResponse.json({ error: { code: "GENERATION_RUN_NOT_FOUND", message: "Generation run not found." } }, { status: 404 });
    }
    return NextResponse.json({ generationRunId: run.id, controlState: run.controlState, status: run.status });
  } catch (error) {
    return NextResponse.json({ error: { code: "GENERATION_RUN_RESUME_FAILED", message: sanitizeErrorText(error) } }, { status: 503 });
  }
}
