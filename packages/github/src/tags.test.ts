import { afterEach, describe, expect, it, vi } from "vitest";

import { findLatestMatchingTag, matchesTagPattern } from "./tags";

describe("matchesTagPattern", () => {
  it("supports exact and wildcard tag patterns", () => {
    expect(matchesTagPattern("v*", "v1.2.3")).toBe(true);
    expect(matchesTagPattern("release-*", "release-2026-06-26")).toBe(true);
    expect(matchesTagPattern("release-*", "v1.2.3")).toBe(false);
  });
});

describe("findLatestMatchingTag", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the first matching tag from the GitHub tags API", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { name: "ignore-me", commit: { sha: "a".repeat(40) } },
          { name: "v1.2.3", commit: { sha: "b".repeat(40) } }
        ]),
        { status: 200 }
      )
    );

    await expect(
      findLatestMatchingTag({
        owner: "acme",
        repo: "frontend",
        tagPattern: "v*",
        token: "token"
      })
    ).resolves.toEqual({ tag: "v1.2.3", commitSha: "b".repeat(40) });
  });

  it("continues to the next page when the first page has no match", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ name: `skip-${index}`, commit: { sha: "a".repeat(40) } }))), {
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ name: "v2.0.0", commit: { sha: "c".repeat(40) } }]), { status: 200 })
      );

    await expect(
      findLatestMatchingTag({
        owner: "acme",
        repo: "backend",
        tagPattern: "v*",
        token: "token"
      })
    ).resolves.toEqual({ tag: "v2.0.0", commitSha: "c".repeat(40) });
  });
});
