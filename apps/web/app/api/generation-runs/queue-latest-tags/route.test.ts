import { describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  createGitHubInstallationAccessToken: vi.fn(),
  findLatestMatchingTag: vi.fn()
}));

vi.mock("@code2wiki/db", () => ({
  generationRuns: {
    workspaceId: "workspaceId",
    frontendCommitSha: "frontendCommitSha",
    backendCommitSha: "backendCommitSha"
  },
  repositories: {
    id: "id",
    workspaceId: "workspaceId",
    role: "role",
    tagPattern: "tagPattern",
    githubInstallationId: "githubInstallationId",
    owner: "owner",
    repo: "repo",
    active: "active"
  },
  githubInstallations: {
    githubInstallationId: "githubInstallationId",
    active: "active"
  },
  getDb: mocks.getDb
}));

vi.mock("@code2wiki/github", () => ({
  createGitHubInstallationAccessToken: mocks.createGitHubInstallationAccessToken,
  findLatestMatchingTag: mocks.findLatestMatchingTag
}));

describe("queue latest tags route", () => {
  it("queues a generation run from the latest FE and BE tags", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: "run-1" }]);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));
    const where = vi.fn().mockResolvedValue([
      {
        id: "repo-fe",
        role: "FRONTEND",
        tagPattern: "v*",
        githubInstallationId: "inst-1",
        owner: "acme",
        repo: "frontend"
      },
      {
        id: "repo-be",
        role: "BACKEND",
        tagPattern: "v*",
        githubInstallationId: "inst-1",
        owner: "acme",
        repo: "backend"
      }
    ]);

    mocks.getDb.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where
          }))
        }))
      })),
      insert
    });
    mocks.createGitHubInstallationAccessToken.mockResolvedValue({ token: "token" });
    mocks.findLatestMatchingTag
      .mockResolvedValueOnce({ tag: "v1.0.0", commitSha: "a".repeat(40) })
      .mockResolvedValueOnce({ tag: "v2.0.0", commitSha: "b".repeat(40) });

    const response = await POST(new Request("http://test.local/api/generation-runs/queue-latest-tags", {
      method: "POST",
      body: JSON.stringify({ workspaceId: "demo" })
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      queued: true,
      duplicate: false,
      generationRunId: "run-1",
      frontendTag: { tag: "v1.0.0", commitSha: "a".repeat(40) },
      backendTag: { tag: "v2.0.0", commitSha: "b".repeat(40) }
    });
    expect(mocks.createGitHubInstallationAccessToken).toHaveBeenCalledTimes(1);
    expect(mocks.findLatestMatchingTag).toHaveBeenNthCalledWith(1, {
      owner: "acme",
      repo: "frontend",
      tagPattern: "v*",
      token: "token"
    });
    expect(mocks.findLatestMatchingTag).toHaveBeenNthCalledWith(2, {
      owner: "acme",
      repo: "backend",
      tagPattern: "v*",
      token: "token"
    });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "demo",
        frontendRepositoryId: "repo-fe",
        backendRepositoryId: "repo-be",
        frontendTag: "v1.0.0",
        backendTag: "v2.0.0",
        status: "QUEUED"
      })
    );
  });

  it("returns 400 when the workspaceId is missing", async () => {
    const response = await POST(new Request("http://test.local/api/generation-runs/queue-latest-tags", {
      method: "POST",
      body: JSON.stringify({})
    }));

    expect(response.status).toBe(400);
  });
});
