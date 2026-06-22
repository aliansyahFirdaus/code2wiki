import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, githubInstallations, repositories } from "@code2wiki/db";

const registerRepositorySchema = z
  .object({
    workspaceId: z.string().trim().min(1),
    role: z.enum(["FRONTEND", "BACKEND"]),
    tagPattern: z.string().trim().min(1).max(200),
    githubInstallationId: z.string().trim().min(1),
    githubRepositoryId: z.string().trim().min(1),
    repositoryFullName: z.string().trim().min(1),
    owner: z.string().trim().min(1),
    repo: z.string().trim().min(1),
    defaultBranch: z.string().trim().min(1)
  })
  .refine((value) => value.repositoryFullName === `${value.owner}/${value.repo}`, {
    message: "repositoryFullName must match owner/repo.",
    path: ["repositoryFullName"]
  });

export async function GET(request: Request) {
  const workspaceId = new URL(request.url).searchParams.get("workspaceId")?.trim();
  if (!workspaceId) {
    return badRequest("WORKSPACE_ID_REQUIRED", "workspaceId is required.");
  }

  const db = getDb();
  const rows = await db.select().from(repositories).where(eq(repositories.workspaceId, workspaceId));

  return NextResponse.json({
    repositories: rows.map(toRepositoryResponse)
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = registerRepositorySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_REPOSITORY_INPUT",
          message: "Repository registration input is invalid.",
          issues: parsed.error.flatten()
        }
      },
      { status: 400 }
    );
  }

  const input = parsed.data;
  const db = getDb();

  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.githubInstallationId, input.githubInstallationId))
    .limit(1);

  if (!installation) {
    return badRequest("INSTALLATION_NOT_FOUND", "githubInstallationId is not registered.");
  }

  if (installation.workspaceId !== input.workspaceId) {
    return forbidden("INSTALLATION_WORKSPACE_MISMATCH", "githubInstallationId does not belong to this workspace.");
  }

  if (!installation.active) {
    return forbidden("INSTALLATION_INACTIVE", "githubInstallationId is not active.");
  }

  const [existingForRole] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.workspaceId, input.workspaceId), eq(repositories.role, input.role)))
    .limit(1);

  if (existingForRole) {
    return NextResponse.json(
      {
        error: {
          code: "REPOSITORY_ROLE_ALREADY_REGISTERED",
          message: `Workspace already has a ${input.role} repository.`
        }
      },
      { status: 409 }
    );
  }

  // Phase 2 trusts posted repository metadata. GitHub lookup/permission verification is deferred.
  const [repository] = await db
    .insert(repositories)
    .values({
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      role: input.role,
      tagPattern: input.tagPattern,
      githubInstallationId: input.githubInstallationId,
      githubRepositoryId: input.githubRepositoryId,
      repositoryFullName: input.repositoryFullName,
      owner: input.owner,
      repo: input.repo,
      defaultBranch: input.defaultBranch,
      active: true
    })
    .returning();

  return NextResponse.json({ repository: toRepositoryResponse(repository) }, { status: 201 });
}

function toRepositoryResponse(repository: typeof repositories.$inferSelect) {
  return {
    id: repository.id,
    workspaceId: repository.workspaceId,
    role: repository.role,
    tagPattern: repository.tagPattern,
    githubInstallationId: repository.githubInstallationId,
    githubRepositoryId: repository.githubRepositoryId,
    repositoryFullName: repository.repositoryFullName,
    owner: repository.owner,
    repo: repository.repo,
    defaultBranch: repository.defaultBranch,
    active: repository.active
  };
}

function badRequest(code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status: 400 });
}

function forbidden(code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status: 403 });
}
