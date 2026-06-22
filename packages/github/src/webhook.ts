import { createHmac, timingSafeEqual } from "node:crypto";

import { isFortyCharCommitSha, isZeroCommitSha } from "./tags";

export type ParsedTagWebhookEvent =
  | {
      supported: true;
      eventType: "TAG" | "RELEASE";
      tag: string;
      commitSha: string;
      installationId: string;
      githubRepositoryId: string;
      repositoryFullName: string;
    }
  | {
      supported: false;
      reason: string;
    };

export function verifyGitHubWebhookSignature(rawBody: string, signatureHeader: string | null, secret: string) {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const actualBuffer = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expected);

  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function parseTagWebhookEvent(eventName: string | null, payload: unknown): ParsedTagWebhookEvent {
  if (!isRecord(payload)) {
    return { supported: false, reason: "INVALID_PAYLOAD" };
  }

  const repository = isRecord(payload.repository) ? payload.repository : null;
  const installation = isRecord(payload.installation) ? payload.installation : null;
  const repositoryFullName = typeof repository?.full_name === "string" ? repository.full_name : null;
  const githubRepositoryId = repository?.id == null ? null : String(repository.id);
  const installationId = installation?.id == null ? null : String(installation.id);

  if (!repositoryFullName || !githubRepositoryId || !installationId) {
    return { supported: false, reason: "MISSING_REPOSITORY_OR_INSTALLATION" };
  }

  if (eventName === "push") {
    const ref = typeof payload.ref === "string" ? payload.ref : "";
    if (!ref.startsWith("refs/tags/")) {
      return { supported: false, reason: "UNSUPPORTED_PUSH_REF" };
    }

    const commitSha = typeof payload.after === "string" ? payload.after : "";
    if (isZeroCommitSha(commitSha)) {
      return { supported: false, reason: "TAG_DELETED" };
    }

    return {
      supported: true,
      eventType: "TAG",
      tag: ref.slice("refs/tags/".length),
      commitSha,
      installationId,
      githubRepositoryId,
      repositoryFullName
    };
  }

  if (eventName === "release") {
    if (payload.action !== "published") {
      return { supported: false, reason: "UNSUPPORTED_RELEASE_ACTION" };
    }

    const release = isRecord(payload.release) ? payload.release : null;
    const tag = typeof release?.tag_name === "string" ? release.tag_name : "";
    const commitSha = typeof release?.target_commitish === "string" ? release.target_commitish : "";

    if (!tag || !isFortyCharCommitSha(commitSha)) {
      return { supported: false, reason: "RELEASE_TARGET_NOT_COMMIT_SHA" };
    }

    return {
      supported: true,
      eventType: "RELEASE",
      tag,
      commitSha,
      installationId,
      githubRepositoryId,
      repositoryFullName
    };
  }

  return { supported: false, reason: "UNSUPPORTED_EVENT" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
