import { NextResponse } from "next/server";
import { and, desc, eq, inArray, or } from "drizzle-orm";

import { generationRuns, getDb, githubInstallations, repositories, tagEvents } from "@code2wiki/db";
import { matchesTagPattern, parseTagWebhookEvent, verifyGitHubWebhookSignature } from "@code2wiki/github";
import { buildGenerationPair, oppositeRepositoryRole, type TagPairEvent } from "../../../../lib/tag-pairing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: { code: "WEBHOOK_SECRET_NOT_CONFIGURED", message: "GITHUB_WEBHOOK_SECRET is required." } },
      { status: 500 }
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyGitHubWebhookSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: { code: "INVALID_SIGNATURE", message: "Invalid webhook signature." } }, { status: 401 });
  }

  const payload = parseJson(rawBody);
  if (!payload.ok) {
    return NextResponse.json({ error: { code: "INVALID_JSON", message: "Webhook payload is invalid JSON." } }, { status: 400 });
  }

  const deliveryId = request.headers.get("x-github-delivery")?.trim();
  if (!deliveryId) {
    return NextResponse.json({ error: { code: "DELIVERY_ID_REQUIRED", message: "x-github-delivery is required." } }, { status: 400 });
  }

  const parsed = parseTagWebhookEvent(request.headers.get("x-github-event"), payload.value);
  if (!parsed.supported) {
    return ignored(parsed.reason);
  }

  const db = getDb();
  const [repository] = await db
    .select({
      id: repositories.id,
      workspaceId: repositories.workspaceId,
      role: repositories.role,
      tagPattern: repositories.tagPattern,
      githubInstallationId: repositories.githubInstallationId,
      repositoryFullName: repositories.repositoryFullName
    })
    .from(repositories)
    .innerJoin(
      githubInstallations,
      eq(repositories.githubInstallationId, githubInstallations.githubInstallationId)
    )
    .where(
      and(
        eq(repositories.active, true),
        eq(githubInstallations.active, true),
        eq(repositories.githubInstallationId, parsed.installationId),
        or(
          eq(repositories.githubRepositoryId, parsed.githubRepositoryId),
          eq(repositories.repositoryFullName, parsed.repositoryFullName)
        )
      )
    )
    .limit(1);

  if (!repository) {
    return ignored("REPOSITORY_NOT_REGISTERED");
  }

  if (!matchesTagPattern(repository.tagPattern, parsed.tag)) {
    return ignored("TAG_PATTERN_NOT_MATCHED");
  }

  const result = await db.transaction(async (tx) => {
    const [existingDelivery] = await tx
      .select({ id: tagEvents.id, status: tagEvents.status })
      .from(tagEvents)
      .where(eq(tagEvents.githubDeliveryId, deliveryId))
      .limit(1);

    if (existingDelivery) {
      return { outcome: "DUPLICATE_DELIVERY" as const, tagEventId: existingDelivery.id };
    }

    const [existingTagEvent] = await tx
      .select({ id: tagEvents.id })
      .from(tagEvents)
      .where(
        and(
          eq(tagEvents.repositoryId, repository.id),
          eq(tagEvents.tag, parsed.tag),
          eq(tagEvents.commitSha, parsed.commitSha)
        )
      )
      .limit(1);

    if (existingTagEvent) {
      return { outcome: "DUPLICATE_TAG_EVENT" as const, tagEventId: existingTagEvent.id };
    }

    const [currentEvent] = await tx
      .insert(tagEvents)
      .values({
        id: crypto.randomUUID(),
        workspaceId: repository.workspaceId,
        repositoryId: repository.id,
        eventType: parsed.eventType,
        tag: parsed.tag,
        commitSha: parsed.commitSha,
        githubDeliveryId: deliveryId,
        status: "WAITING_FOR_PAIR",
        rawPayload: payload.value
      })
      .returning();

    const currentPairEvent: TagPairEvent = {
      id: currentEvent.id,
      repositoryId: repository.id,
      role: repository.role,
      tag: parsed.tag,
      commitSha: parsed.commitSha
    };
    const oppositeRole = oppositeRepositoryRole(repository.role);
    const [oppositeEvent] = await tx
      .select({
        id: tagEvents.id,
        repositoryId: tagEvents.repositoryId,
        role: repositories.role,
        tag: tagEvents.tag,
        commitSha: tagEvents.commitSha
      })
      .from(tagEvents)
      .innerJoin(repositories, eq(tagEvents.repositoryId, repositories.id))
      .where(
        and(
          eq(tagEvents.workspaceId, repository.workspaceId),
          eq(repositories.active, true),
          eq(repositories.role, oppositeRole),
          eq(tagEvents.status, "WAITING_FOR_PAIR")
        )
      )
      .orderBy(desc(tagEvents.receivedAt))
      .limit(1);

    if (!oppositeEvent) {
      return { outcome: "WAITING_FOR_PAIR" as const, tagEventId: currentEvent.id };
    }

    const pair = buildGenerationPair(currentPairEvent, oppositeEvent);
    if (!pair) {
      return { outcome: "WAITING_FOR_PAIR" as const, tagEventId: currentEvent.id };
    }

    const [generationRun] = await tx
      .insert(generationRuns)
      .values({
        id: crypto.randomUUID(),
        workspaceId: repository.workspaceId,
        frontendRepositoryId: pair.frontend.repositoryId,
        backendRepositoryId: pair.backend.repositoryId,
        frontendTag: pair.frontend.tag,
        frontendCommitSha: pair.frontend.commitSha,
        backendTag: pair.backend.tag,
        backendCommitSha: pair.backend.commitSha,
        status: "QUEUED"
      })
      .onConflictDoNothing({
        target: [generationRuns.workspaceId, generationRuns.frontendCommitSha, generationRuns.backendCommitSha]
      })
      .returning();

    await tx
      .update(tagEvents)
      .set({ status: "PAIRED", processedAt: new Date() })
      .where(inArray(tagEvents.id, [pair.frontend.id, pair.backend.id]));

    return {
      outcome: generationRun ? ("GENERATION_QUEUED" as const) : ("GENERATION_ALREADY_EXISTS" as const),
      tagEventId: currentEvent.id,
      generationRunId: generationRun?.id ?? null
    };
  });

  return NextResponse.json({
    processed: true,
    outcome: result.outcome,
    tagEventId: result.tagEventId,
    generationRunId: "generationRunId" in result ? result.generationRunId : undefined
  });
}

function ignored(reason: string) {
  return NextResponse.json({ ignored: true, reason });
}

function parseJson(rawBody: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(rawBody) };
  } catch {
    return { ok: false };
  }
}
