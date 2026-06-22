import { NextResponse } from "next/server";

export function POST() {
  return NextResponse.json({ error: "GitHub webhook ingestion is not implemented in Phase 1." }, { status: 501 });
}
