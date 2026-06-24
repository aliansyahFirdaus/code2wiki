import { NextResponse } from "next/server";

import { sanitizeErrorText } from "@code2wiki/shared";
import { loadGenerationDebugEvents } from "../../../../../lib/generation-debug-events";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const searchParams = new URL(request.url).searchParams;

  try {
    const result = await loadGenerationDebugEvents({
      generationRunId: id,
      afterId: searchParams.get("afterId"),
      since: searchParams.get("since"),
      limit: Number(searchParams.get("limit")) || null
    });
    if (!result) {
      return NextResponse.json({ error: { code: "GENERATION_RUN_NOT_FOUND", message: "Generation run not found." } }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: { code: "GENERATION_DEBUG_EVENTS_UNAVAILABLE", message: sanitizeErrorText(error) } },
      { status: 503 }
    );
  }
}
