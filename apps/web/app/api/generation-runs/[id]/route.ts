import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { generationRuns, getDb } from "@code2wiki/db";
import { sanitizeErrorText } from "@code2wiki/shared";
import { toGenerationRunResponse } from "../../../../lib/generation-run-response";
import { pagesByGenerationRun } from "../../../../lib/run-pages";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;

  try {
    const db = getDb();
    const [run] = await db.select().from(generationRuns).where(eq(generationRuns.id, id)).limit(1);
    if (!run) {
      return NextResponse.json({ error: { code: "GENERATION_RUN_NOT_FOUND", message: "Generation run not found." } }, { status: 404 });
    }

    const pages = (await pagesByGenerationRun([run.id])).get(run.id) ?? [];
    return NextResponse.json({ generationRun: toGenerationRunResponse(run, pages) });
  } catch (error) {
    return NextResponse.json(
      { error: { code: "GENERATION_RUN_UNAVAILABLE", message: sanitizeErrorText(error) } },
      { status: 503 }
    );
  }
}
