import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ generationRuns: [], phase: "phase_1_stub" });
}
