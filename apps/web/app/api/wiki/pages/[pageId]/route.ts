import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ error: "Wiki page loading is not implemented in Phase 1." }, { status: 501 });
}
