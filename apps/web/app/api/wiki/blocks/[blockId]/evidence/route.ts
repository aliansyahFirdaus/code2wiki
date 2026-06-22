import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ evidence: [], phase: "phase_1_stub" });
}
