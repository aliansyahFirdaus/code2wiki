import { NextResponse } from "next/server";

import { getBlockEvidence } from "../../../../../../lib/wiki-read";

type Context = {
  params: Promise<{ blockId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { blockId } = await context.params;
  const evidence = await getBlockEvidence(blockId);

  if (!evidence) {
    return NextResponse.json({ error: "Wiki block not found." }, { status: 404 });
  }

  return NextResponse.json({ evidence });
}
