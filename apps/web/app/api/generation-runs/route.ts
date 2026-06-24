import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { generationRuns, getDb } from "@code2wiki/db";
import { sanitizeErrorText } from "@code2wiki/shared";
import { toGenerationRunResponse } from "../../../lib/generation-run-response";
import { pagesByGenerationRun } from "../../../lib/run-pages";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const workspaceId = new URL(request.url).searchParams.get("workspaceId")?.trim();
  if (!workspaceId) {
    return NextResponse.json({ error: { code: "WORKSPACE_ID_REQUIRED", message: "workspaceId is required." } }, { status: 400 });
  }

  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(generationRuns)
      .where(eq(generationRuns.workspaceId, workspaceId))
      .orderBy(desc(generationRuns.createdAt));
    const pagesByRun = await pagesByGenerationRun(rows.map((run) => run.id));

    return NextResponse.json({
      generationRuns: rows.map((run) => toGenerationRunResponse(run, pagesByRun.get(run.id) ?? []))
    });
  } catch (error) {
    return NextResponse.json(
      { error: { code: "GENERATION_RUNS_UNAVAILABLE", message: sanitizeErrorText(error) } },
      { status: 503 }
    );
  }
}
