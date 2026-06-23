import { describe, expect, it } from "vitest";

import { blocksToTiptap, buildBlockTree, formatCoverage, sourceBadge, type WikiBlockRow } from "./wiki-blocks";

describe("wiki block reader helpers", () => {
  it("reconstructs nested blocks by parentBlockId and position", () => {
    const tree = buildBlockTree([
      row({ id: "child-2", parentBlockId: "parent", position: 1, text: "Second" }),
      row({ id: "parent", parentBlockId: null, position: 0, text: "Parent" }),
      row({ id: "child-1", parentBlockId: "parent", position: 0, text: "First" })
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0].children?.map((block) => block.id)).toEqual(["child-1", "child-2"]);
  });

  it("lets DB row metadata override conflicting blockJson", () => {
    const [block] = buildBlockTree([
      row({
        id: "db-id",
        stableKey: "db-key",
        origin: "MANUAL",
        evidenceIds: [],
        blockJson: { id: "json-id", stableKey: "json-key", origin: "CODE", evidenceIds: ["json-evidence"] }
      })
    ]);

    expect(block.id).toBe("db-id");
    expect(block.stableKey).toBe("db-key");
    expect(block.origin).toBe("MANUAL");
    expect(block.evidenceIds).toEqual([]);
  });

  it("preserves block IDs and evidence IDs in Tiptap render JSON", () => {
    const [block] = buildBlockTree([row({ id: "stmt", type: "statement", evidenceIds: ["ev-1"] })]);
    const doc = blocksToTiptap([block]);

    expect(doc.content[0].attrs).toMatchObject({ blockId: "stmt", evidenceIds: ["ev-1"] });
  });

  it("labels source badges", () => {
    const [withEvidence, needsReview, manual] = buildBlockTree([
      row({ id: "with-evidence", type: "statement", evidenceIds: ["ev-1", "ev-2"] }),
      row({ id: "needs-review", type: "statement", evidenceIds: [] }),
      row({ id: "manual", origin: "MANUAL", evidenceIds: [] })
    ]);

    expect(sourceBadge(withEvidence)).toBe("Code · 2 sources");
    expect(sourceBadge(needsReview)).toBe("Needs review");
    expect(sourceBadge(manual)).toBe("Manual");
  });

  it("formats zero denominator coverage as N/A", () => {
    expect(formatCoverage({ indexed: 0, total: 0 })).toBe("N/A");
  });
});

function row(input: Partial<WikiBlockRow> & { text?: string } = {}): WikiBlockRow {
  const type = input.type ?? "paragraph";
  return {
    id: input.id ?? "block",
    parentBlockId: input.parentBlockId ?? null,
    position: input.position ?? 0,
    stableKey: input.stableKey ?? `${input.id ?? "block"}-key`,
    type,
    origin: input.origin ?? "CODE",
    reviewState: input.reviewState ?? "VERIFIED",
    sourceHash: input.sourceHash ?? "source",
    contentHash: input.contentHash ?? "content",
    evidenceIds: input.evidenceIds ?? [],
    locked: input.locked ?? true,
    blockJson:
      input.blockJson ??
      (type === "statement"
        ? { type, text: input.text ?? "Statement", confidence: 1, evidenceIds: input.evidenceIds ?? [], lastGeneratedRunId: "run" }
        : { type, text: input.text ?? "Paragraph" })
  };
}
