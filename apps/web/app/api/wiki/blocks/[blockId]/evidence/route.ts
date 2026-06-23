import { NextResponse } from "next/server";

import { sanitizeErrorText } from "@code2wiki/shared";

import { getBlockEvidence } from "../../../../../../lib/wiki-read";

type Context = {
  params: Promise<{ blockId: string }>;
};

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: Context) {
  const { blockId } = await context.params;
  try {
    const evidence = await getBlockEvidence(blockId);

    if (!evidence) {
      return NextResponse.json({ error: "Wiki block not found." }, { status: 404 });
    }

    return NextResponse.json({ evidence });
  } catch (error) {
    return NextResponse.json({ error: sanitizeErrorText(error) }, { status: 503 });
  }
}
