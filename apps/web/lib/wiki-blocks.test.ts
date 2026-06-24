import { describe, expect, it } from "vitest";

import {
  applyEditOverlays,
  blockBadges,
  blocksToTiptap,
  buildBlockTree,
  collectChangedEdits,
  formatCoverage,
  isEditableBlock,
  sourceBadge,
  type WikiBlockRow,
  type WikiOverlayRow
} from "./wiki-blocks";

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

  it("keeps source badges based on wiki_blocks evidenceIds only", () => {
    const [block] = buildBlockTree([
      row({
        id: "db-source",
        type: "statement",
        evidenceIds: [],
        blockJson: { type: "statement", text: "Statement", confidence: 1, evidenceIds: ["json-only"], lastGeneratedRunId: "run" }
      })
    ]);

    expect(sourceBadge(block)).toBe("Needs review");
  });

  it("formats missing and zero denominator coverage with explicit N/A reasons", () => {
    expect(formatCoverage({ indexed: null, total: null })).toBe("N/A - no data");
    expect(formatCoverage({ indexed: 0, total: 0 })).toBe("N/A - no eligible files");
    expect(formatCoverage({ indexed: 1, total: 2 })).not.toBe("N/A");
  });

  it("applies the latest EDIT overlay by createdAt and id", () => {
    const [block] = buildBlockTree([row({ id: "stmt", stableKey: "stable", type: "statement", evidenceIds: ["ev-1"] })]);
    const [edited] = applyEditOverlays([block], [
      overlay({ id: "b", targetStableKey: "stable", text: "Second", createdAt: new Date("2026-01-01T00:00:00Z") }),
      overlay({ id: "a", targetStableKey: "stable", text: "First", createdAt: new Date("2026-01-01T00:00:00Z") })
    ]);

    expect(edited.type).toBe("statement");
    expect(edited.type === "statement" ? edited.text : "").toBe("Second");
    expect(edited.origin).toBe("CODE_EDITED");
  });

  it("does not mutate base blocks when applying overlays", () => {
    const [block] = buildBlockTree([row({ id: "stmt", stableKey: "stable", type: "statement", evidenceIds: ["ev-1"] })]);
    const original = block.type === "statement" ? block.text : "";

    applyEditOverlays([block], [overlay({ targetStableKey: "stable", text: "Edited" })]);

    expect(block.type === "statement" ? block.text : "").toBe(original);
    expect(block.origin).toBe("CODE");
  });

  it("preserves evidence IDs for CODE_EDITED blocks", () => {
    const [block] = buildBlockTree([row({ id: "stmt", stableKey: "stable", type: "statement", evidenceIds: ["ev-1"] })]);
    const [edited] = applyEditOverlays([block], [overlay({ targetStableKey: "stable", text: "Edited" })]);

    expect(edited.origin).toBe("CODE_EDITED");
    expect(edited.evidenceIds).toEqual(["ev-1"]);
  });

  it("extracts changed local edits only for editable block types", () => {
    const blocks = buildBlockTree([
      row({ id: "p", stableKey: "p-key", type: "paragraph", text: "Old" }),
      row({ id: "h", stableKey: "h-key", type: "heading", text: "Heading", blockJson: { type: "heading", level: 2, text: "Heading" } })
    ]);

    expect(collectChangedEdits(blocks, { p: "New", h: "Ignored" })).toEqual([
      { targetBlockId: "p", targetStableKey: "p-key", text: "New" }
    ]);
    expect(blocks.map(isEditableBlock)).toEqual([true, false]);
  });

  it("shows origin, review, and source badges", () => {
    const [needsReview, manual] = buildBlockTree([
      row({ id: "edited", origin: "CODE_EDITED", reviewState: "NEEDS_REVIEW", evidenceIds: ["ev-1"] }),
      row({ id: "manual", origin: "MANUAL", evidenceIds: [] })
    ]);

    expect(blockBadges(needsReview)).toEqual(["CODE_EDITED", "NEEDS_REVIEW", "1 source"]);
    expect(blockBadges(manual)).toEqual(["MANUAL"]);
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

function overlay(input: Partial<WikiOverlayRow> & { text?: string } = {}): WikiOverlayRow {
  return {
    id: input.id ?? "overlay",
    targetStableKey: input.targetStableKey ?? "stable",
    overlayType: input.overlayType ?? "EDIT",
    overlayJson: input.overlayJson ?? { version: 1, block: { type: "statement", text: input.text ?? "Edited" } },
    createdAt: input.createdAt ?? new Date("2026-01-01T00:00:00Z")
  };
}
