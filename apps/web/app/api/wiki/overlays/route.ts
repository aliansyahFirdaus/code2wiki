import { NextResponse } from "next/server";

export function POST() {
  return NextResponse.json({ error: "Wiki overlays are not implemented in Phase 1." }, { status: 501 });
}
