import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ error: "GitHub App callback is not implemented in Phase 1." }, { status: 501 });
}
