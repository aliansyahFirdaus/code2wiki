import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ error: "Generation run lookup is not implemented in Phase 1." }, { status: 501 });
}
