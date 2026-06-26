import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { generationRuns, getDb, githubInstallations, repositories } from "@code2wiki/db";
import { createGitHubInstallationAccessToken, findLatestMatchingTag } from "@code2wiki/github";
import { sanitizeErrorText } from "@code2wiki/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ActiveRepository = Pick<typeof repositories.$inferSelect, "id" | "role" | "tagPattern" | "githubInstallationId" | "owner" | "repo">;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  if (!workspaceId) {
    return NextResponse.json({ error: { code: "WORKSPACE_ID_REQUIRED", message: "workspaceId is required." } }, { status: 400 });
  }

  try {
    const db = getDb();
    const repoRows = await db
      .select({
        id: repositories.id,
        role: repositories.role,
        tagPattern: repositories.tagPattern,
        githubInstallationId: repositories.githubInstallationId,
        owner: repositories.owner,
        repo: repositories.repo
      })
      .from(repositories)
      .innerJoin(
        githubInstallations,
        eq(repositories.githubInstallationId, githubInstallations.githubInstallationId)
      )
      .where(
        and(
          eq(repositories.workspaceId, workspaceId),
          eq(repositories.active, true),
          eq(githubInstallations.active, true)
        )
      );

    const frontendRepository = repoRows.find((repository) => repository.role === "FRONTEND");
    const backendRepository = repoRows.find((repository) => repository.role === "BACKEND");

    if (!frontendRepository || !backendRepository) {
      return NextResponse.json(
        { error: { code: "REPOSITORY_PAIR_REQUIRED", message: "Active frontend and backend repositories are required." } },
        { status: 400 }
      );
    }

    const tokenByInstallationId = new Map<string, Promise<string>>();
    const installationToken = async (installationId: string) => {
      const existing = tokenByInstallationId.get(installationId);
      if (existing) {
        return existing;
      }

      const pendingToken = createGitHubInstallationAccessToken(installationId).then((value) => value.token);
      tokenByInstallationId.set(installationId, pendingToken);
      return pendingToken;
    };

    const [frontendTag, backendTag] = await Promise.all([
      resolveLatestTag(frontendRepository, installationToken),
      resolveLatestTag(backendRepository, installationToken)
    ]);

    const [generationRun] = await db
      .insert(generationRuns)
      .values({
        id: crypto.randomUUID(),
        workspaceId,
        frontendRepositoryId: frontendRepository.id,
        backendRepositoryId: backendRepository.id,
        frontendTag: frontendTag.tag,
        frontendCommitSha: frontendTag.commitSha,
        backendTag: backendTag.tag,
        backendCommitSha: backendTag.commitSha,
        status: "QUEUED"
      })
      .onConflictDoNothing({
        target: [generationRuns.workspaceId, generationRuns.frontendCommitSha, generationRuns.backendCommitSha]
      })
      .returning();

    return NextResponse.json({
      queued: Boolean(generationRun),
      duplicate: !generationRun,
      generationRunId: generationRun?.id ?? null,
      frontendTag,
      backendTag
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "LATEST_TAG_QUEUE_FAILED",
          message: sanitizeErrorText(error) || "Failed to queue generation from latest tags."
        }
      },
      { status: 500 }
    );
  }
}

async function resolveLatestTag(
  repository: ActiveRepository,
  installationToken: (installationId: string) => Promise<string>
) {
  return findLatestMatchingTag({
    owner: repository.owner,
    repo: repository.repo,
    tagPattern: repository.tagPattern,
    token: await installationToken(repository.githubInstallationId)
  });
}
