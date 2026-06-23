import { NextResponse } from "next/server";

import { getWikiReaderData } from "../../../../../lib/wiki-read";

type Context = {
  params: Promise<{ pageId: string }>;
};

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: Context) {
  const { pageId } = await context.params;
  const data = await getWikiReaderData(pageId);

  if (!data) {
    return NextResponse.json({ error: "Wiki page not found." }, { status: 404 });
  }

  return NextResponse.json(data);
}
