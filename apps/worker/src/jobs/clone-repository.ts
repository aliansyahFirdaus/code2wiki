import { getDb, generationRuns, repositories } from "@code2wiki/db";
import { createGitHubInstallationAccessToken, cloneRepositoryAtCommit, type RepositoryCheckout } from "@code2wiki/github";
import { and, asc, eq } from "drizzle-orm";

type CloneRepositoryResult =
  | { status: "skipped"; reason: string }
  | { status: "cloned"; generationRunId: string; frontendHead: string; backendHead: string }
  | { status: "failed"; generationRunId: string; errorMessage: string };

type ClaimedGenerationRun = typeof generationRuns.$inferSelect;
type RepositoryRecord = typeof repositories.$inferSelect;

export async function cloneRepository(generationRunId?: string): Promise<CloneRepositoryResult> {
  const db = getDb();
  const claimedRun = await claimGenerationRun(generationRunId);

  if (!claimedRun) {
    return {
      status: "skipped",
      reason: generationRunId ? "Generation run is not queued or does not exist." : "No queued generation run found."
    };
  }

  const checkouts: RepositoryCheckout[] = [];

  try {
    const [frontendRepository, backendRepository] = await Promise.all([
      getActiveRepository(claimedRun.frontendRepositoryId),
      getActiveRepository(claimedRun.backendRepositoryId)
    ]);

    const tokenByInstallationId = new Map<string, string>();
    const getInstallationToken = async (installationId: string) => {
      const existing = tokenByInstallationId.get(installationId);
      if (existing) {
        return existing;
      }

      const { token } = await createGitHubInstallationAccessToken(installationId);
      tokenByInstallationId.set(installationId, token);
      return token;
    };

    const frontendCheckout = await cloneRepositoryAtCommit({
      owner: frontendRepository.owner,
      repo: frontendRepository.repo,
      commitSha: claimedRun.frontendCommitSha,
      token: await getInstallationToken(frontendRepository.githubInstallationId)
    });
    checkouts.push(frontendCheckout);

    const backendCheckout = await cloneRepositoryAtCommit({
      owner: backendRepository.owner,
      repo: backendRepository.repo,
      commitSha: claimedRun.backendCommitSha,
      token: await getInstallationToken(backendRepository.githubInstallationId)
    });
    checkouts.push(backendCheckout);

    await db
      .update(generationRuns)
      .set({
        status: "CLONED",
        errorMessage: null
      })
      .where(eq(generationRuns.id, claimedRun.id));

    return {
      status: "cloned",
      generationRunId: claimedRun.id,
      frontendHead: frontendCheckout.head,
      backendHead: backendCheckout.head
    };
  } catch (error) {
    const errorMessage = sanitizeErrorMessage(error);
    await db
      .update(generationRuns)
      .set({
        status: "FAILED",
        errorMessage,
        finishedAt: new Date()
      })
      .where(eq(generationRuns.id, claimedRun.id));

    return {
      status: "failed",
      generationRunId: claimedRun.id,
      errorMessage
    };
  } finally {
    await cleanupCheckouts(checkouts);
  }
}

async function claimGenerationRun(generationRunId?: string): Promise<ClaimedGenerationRun | null> {
  const db = getDb();

  if (generationRunId) {
    const [claimedRun] = await db
      .update(generationRuns)
      .set({
        status: "CLONING",
        startedAt: new Date(),
        finishedAt: null,
        errorMessage: null
      })
      .where(and(eq(generationRuns.id, generationRunId), eq(generationRuns.status, "QUEUED")))
      .returning();

    return claimedRun ?? null;
  }

  return db.transaction(async (tx) => {
    const [queuedRun] = await tx
      .select()
      .from(generationRuns)
      .where(eq(generationRuns.status, "QUEUED"))
      .orderBy(asc(generationRuns.createdAt))
      .limit(1);

    if (!queuedRun) {
      return null;
    }

    const [claimedRun] = await tx
      .update(generationRuns)
      .set({
        status: "CLONING",
        startedAt: new Date(),
        finishedAt: null,
        errorMessage: null
      })
      .where(and(eq(generationRuns.id, queuedRun.id), eq(generationRuns.status, "QUEUED")))
      .returning();

    return claimedRun ?? null;
  });
}

async function getActiveRepository(repositoryId: string): Promise<RepositoryRecord> {
  const db = getDb();
  const [repository] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.id, repositoryId), eq(repositories.active, true)))
    .limit(1);

  if (!repository) {
    throw new Error(`Active repository record not found for ${repositoryId}.`);
  }

  return repository;
}

function sanitizeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown clone failure.";

  return message
    .replace(/ghs_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/https:\/\/[^/\s@]+:[^@\s]+@github\.com/gi, "https://[redacted]@github.com")
    .slice(0, 1000);
}

async function cleanupCheckouts(checkouts: RepositoryCheckout[]) {
  for (const checkout of checkouts.reverse()) {
    try {
      await checkout.cleanup();
    } catch {
      // Cleanup failure must not mask clone or status-update outcomes.
    }
  }
}
