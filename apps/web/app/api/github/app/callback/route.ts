import { NextResponse } from "next/server";

import { getDb, githubInstallations } from "@code2wiki/db";
import { decodeWorkspaceIdFromState, mapSetupActionToInstallationStatus } from "@code2wiki/github";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const installationId = url.searchParams.get("installation_id")?.trim();
  const setupAction = url.searchParams.get("setup_action")?.trim() || null;
  const workspaceId =
    url.searchParams.get("workspaceId")?.trim() || decodeWorkspaceIdFromState(url.searchParams.get("state"));

  if (!workspaceId) {
    return badRequest("WORKSPACE_ID_REQUIRED", "workspaceId is required in query or encoded state.");
  }

  if (!installationId) {
    return badRequest("INSTALLATION_ID_REQUIRED", "installation_id is required.");
  }

  const status = mapSetupActionToInstallationStatus(setupAction);
  const active = status !== "REMOVED";

  const db = getDb();
  const [installation] = await db
    .insert(githubInstallations)
    .values({
      id: crypto.randomUUID(),
      workspaceId,
      githubInstallationId: installationId,
      accountLogin: null,
      accountType: null,
      setupAction,
      status,
      active
    })
    .onConflictDoUpdate({
      target: githubInstallations.githubInstallationId,
      set: {
        workspaceId,
        setupAction,
        status,
        active,
        updatedAt: new Date()
      }
    })
    .returning();

  return NextResponse.json({
    installation: {
      id: installation.id,
      workspaceId: installation.workspaceId,
      githubInstallationId: installation.githubInstallationId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      setupAction: installation.setupAction,
      status: installation.status,
      active: installation.active
    }
  });
}

function badRequest(code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status: 400 });
}
