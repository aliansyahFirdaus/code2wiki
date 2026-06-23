import { describe, expect, it } from "vitest";

import { buildGenerationPair, type TagPairEvent } from "./tag-pairing";

describe("tag pairing", () => {
  it("maps BE first then FE second by repository role", () => {
    const backend = event({ id: "be-event", repositoryId: "be-repo", role: "BACKEND", tag: "be-v1", commitSha: "be-sha" });
    const frontend = event({ id: "fe-event", repositoryId: "fe-repo", role: "FRONTEND", tag: "fe-v1", commitSha: "fe-sha" });

    expect(buildGenerationPair(frontend, backend)).toEqual({ frontend, backend });
  });

  it("maps FE first then BE second by repository role", () => {
    const frontend = event({ id: "fe-event", repositoryId: "fe-repo", role: "FRONTEND", tag: "fe-v1", commitSha: "fe-sha" });
    const backend = event({ id: "be-event", repositoryId: "be-repo", role: "BACKEND", tag: "be-v1", commitSha: "be-sha" });

    expect(buildGenerationPair(backend, frontend)).toEqual({ frontend, backend });
  });

  it("does not pair two frontend events", () => {
    expect(
      buildGenerationPair(
        event({ id: "fe-1", repositoryId: "fe-repo", role: "FRONTEND" }),
        event({ id: "fe-2", repositoryId: "fe-repo", role: "FRONTEND" })
      )
    ).toBeNull();
  });

  it("does not pair two backend events", () => {
    expect(
      buildGenerationPair(
        event({ id: "be-1", repositoryId: "be-repo", role: "BACKEND" }),
        event({ id: "be-2", repositoryId: "be-repo", role: "BACKEND" })
      )
    ).toBeNull();
  });
});

function event(input: Partial<TagPairEvent> & Pick<TagPairEvent, "id" | "repositoryId" | "role">): TagPairEvent {
  return {
    tag: `${input.id}-tag`,
    commitSha: `${input.id}-sha`,
    ...input
  };
}
