import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { generationRuns, getDb } from "@code2wiki/db";
import { readEnv, sanitizeErrorText, type GenerationRunExecutionMode } from "@code2wiki/shared";
import { deleteGenerationRun } from "../../../../../worker/src/jobs/delete-generation-run";
import { toGenerationRunResponse } from "../../../../lib/generation-run-response";
import { materializationCountsByGenerationRun } from "../../../../lib/run-pages";
import { pagesByGenerationRun } from "../../../../lib/run-pages";

export const dynamic = "force-dynamic";
const configuredModelLabel = formatConfiguredModelLabel();

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
    const counts = (await materializationCountsByGenerationRun([run.id])).get(run.id) ?? { written: 0, reused: 0 };
    const response = toGenerationRunResponse(run, pages);
    return NextResponse.json({
      generationRun: {
        ...response,
        configuredModelLabel,
        writtenPageCount: counts.written,
        reusedPageCount: counts.reused,
        affectedPageCount: response.incrementalSummary?.affectedPageKeys.length ?? 0
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: { code: "GENERATION_RUN_UNAVAILABLE", message: sanitizeErrorText(error) } },
      { status: 503 }
    );
  }
}

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const executionMode = normalizeExecutionMode(body?.executionMode);

  if (!executionMode) {
    return NextResponse.json(
      { error: { code: "EXECUTION_MODE_INVALID", message: "executionMode must be AUTO or MANUAL." } },
      { status: 400 }
    );
  }

  try {
    const db = getDb();
    const [run] = await db
      .update(generationRuns)
      .set({
        executionMode,
        advanceRequestedAt: executionMode === "AUTO" ? null : undefined
      })
      .where(eq(generationRuns.id, id))
      .returning();

    if (!run) {
      return NextResponse.json({ error: { code: "GENERATION_RUN_NOT_FOUND", message: "Generation run not found." } }, { status: 404 });
    }

    const pages = (await pagesByGenerationRun([run.id])).get(run.id) ?? [];
    const counts = (await materializationCountsByGenerationRun([run.id])).get(run.id) ?? { written: 0, reused: 0 };
    const response = toGenerationRunResponse(run, pages);
    return NextResponse.json({
      generationRun: {
        ...response,
        configuredModelLabel,
        writtenPageCount: counts.written,
        reusedPageCount: counts.reused,
        affectedPageCount: response.incrementalSummary?.affectedPageKeys.length ?? 0
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: { code: "GENERATION_RUN_UPDATE_FAILED", message: sanitizeErrorText(error) } },
      { status: 503 }
    );
  }
}

function normalizeExecutionMode(value: unknown): GenerationRunExecutionMode | null {
  return value === "AUTO" || value === "MANUAL" ? value : null;
}

function formatConfiguredModelLabel() {
  const env = readEnv();
  if (!env.AI_MODEL) {
    return null;
  }
  return env.AI_PROVIDER ? `${env.AI_PROVIDER} / ${env.AI_MODEL}` : env.AI_MODEL;
}

export async function DELETE(_request: Request, context: Context) {
  const { id } = await context.params;

  try {
    const result = await deleteGenerationRun(id);
    if (result.status === "not_found") {
      return NextResponse.json({ error: { code: "GENERATION_RUN_NOT_FOUND", message: "Generation run not found." } }, { status: 404 });
    }
    if (result.status === "error") {
      return NextResponse.json({ error: { code: "GENERATION_RUN_DELETE_INVALID", message: result.errorMessage } }, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: { code: "GENERATION_RUN_DELETE_FAILED", message: sanitizeErrorText(error) } },
      { status: 503 }
    );
  }
}
