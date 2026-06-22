import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ repositories: [], phase: "phase_1_stub" });
}

export function POST() {
  return NextResponse.json({ error: "Repository registration is not implemented in Phase 1." }, { status: 501 });
}
