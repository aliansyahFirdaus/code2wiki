import { describe, expect, it } from "vitest";

import {
  blockStableKeys,
  buildEvidenceRemap,
  buildIncrementalReport,
  buildPageInput,
  buildPreviousPage,
  evidenceFingerprint,
  remapReusedPage,
  type EvidenceFingerprintInput,
  type WikiBlockRowLike,
  type WikiPageRowLike
} from "./incremental-wiki";

describe("incremental wiki helpers", () => {
  it("keeps page input hash stable across tag and commit changes", () => {
    const current = buildPageInput({
      pageGroup: pageGroup({ tag: "v2", commitSha: "new-sha", evidenceId: "ev-current" }),
      retrievalMode: "fallback",
      evidenceById: new Map([["ev-current", evidence({ id: "ev-current" })]])
    });
    const previous = buildPageInput({
      pageGroup: pageGroup({ tag: "v1", commitSha: "old-sha", evidenceId: "ev-prev" }),
      retrievalMode: "fallback",
      evidenceById: new Map([["ev-prev", evidence({ id: "ev-prev" })]])
    });

    expect(current.inputHash).toBe(previous.inputHash);
  });

  it("changes page input hash when product input changes", () => {
    const first = buildPageInput({
      pageGroup: pageGroup({ factText: "Crew can be added.", evidenceSummary: "Crew can be added." }),
      retrievalMode: "fallback",
      evidenceById: new Map([["ev-1", evidence()]])
    });
    const second = buildPageInput({
      pageGroup: pageGroup({ factText: "Crew can be deleted.", evidenceSummary: "Crew can be added." }),
      retrievalMode: "fallback",
      evidenceById: new Map([["ev-1", evidence()]])
    });

    expect(first.inputHash).not.toBe(second.inputHash);
  });

  it("remaps previous evidence IDs to current evidence IDs by stable fingerprint", () => {
    const remap = buildEvidenceRemap({
      previousEvidence: [evidence({ id: "ev-old" })],
      currentEvidence: [evidence({ id: "ev-new" })]
    });

    expect(remap.ok).toBe(true);
    expect(remap.ok ? remap.idMap.get("ev-old") : null).toBe("ev-new");
    expect(evidenceFingerprint(evidence({ id: "ev-old" }))).toBe(evidenceFingerprint(evidence({ id: "ev-new" })));
  });

  it("fails remap on duplicate evidence fingerprint", () => {
    const remap = buildEvidenceRemap({
      previousEvidence: [evidence({ id: "ev-old" })],
      currentEvidence: [evidence({ id: "ev-new-a" }), evidence({ id: "ev-new-b" })]
    });

    expect(remap).toEqual({ ok: false, reason: "duplicate_current_evidence_fingerprint" });
  });

  it("rebuilds reused page blocks with current run IDs and current evidence IDs", () => {
    const page = buildPreviousPage(previousPage(), [
      blockRow({ id: "old-block", stableKey: "crew.add.0.crew-can-be-added", evidenceIds: ["ev-old"] })
    ]);
    const remapped = remapReusedPage({
      generationRunId: "run-current",
      page,
      evidenceIdMap: new Map([["ev-old", "ev-current"]])
    });

    expect(remapped.ok).toBe(true);
    const block = remapped.ok ? remapped.page.blocks[0] : null;
    expect(block?.id).not.toBe("old-block");
    expect(block?.id).toMatch(/^blk_/);
    expect(block?.evidenceIds).toEqual(["ev-current"]);
    expect(block?.type === "statement" ? block.lastGeneratedRunId : null).toBe("run-current");
    expect(remapped.ok ? blockStableKeys(remapped.page) : []).toEqual(["crew.add.0.crew-can-be-added"]);
  });

  it("reports reuse-only as zero generated pages and one saved request estimate", () => {
    const report = buildIncrementalReport({
      baselineGenerationRunId: "run-old",
      affectedPageKeys: [],
      reusedPageKeys: ["crew.add"],
      reuseMissReasons: {}
    });

    expect(report).toMatchObject({
      mode: "REUSE_ONLY",
      generatedPageCount: 0,
      reusedPageCount: 1,
      aiRequestCountSavedEstimate: 1,
      pageInputHashVersion: "page-input-v1"
    });
  });
});

function evidence(overrides: Partial<EvidenceFingerprintInput> = {}): EvidenceFingerprintInput {
  return {
    id: "ev-1",
    repositoryRole: "FRONTEND",
    repositoryFullName: "acme/web",
    filePath: "app/crew/add/page.tsx",
    startLine: 1,
    endLine: 2,
    sourceKind: "ROUTE",
    summary: "Crew can be added.",
    codeSnippet: "export default function Page() {}",
    ...overrides
  };
}

function pageGroup(input: { tag?: string; commitSha?: string; evidenceId?: string; factText?: string; evidenceSummary?: string } = {}) {
  const evidenceId = input.evidenceId ?? "ev-1";
  return {
    pageKey: "crew.add",
    title: "Crew Add",
    facts: [
      {
        id: "fact-1",
        repositoryRole: "FRONTEND" as const,
        repositoryFullName: "acme/web",
        tag: input.tag ?? "v1",
        commitSha: input.commitSha ?? "sha",
        factKind: "ROUTE",
        text: input.factText ?? "Crew can be added.",
        evidenceIds: [evidenceId],
        confidence: 0.95
      }
    ],
    evidence: [
      {
        id: evidenceId,
        repositoryRole: "FRONTEND" as const,
        repositoryFullName: "acme/web",
        tag: input.tag ?? "v1",
        commitSha: input.commitSha ?? "sha",
        filePath: "app/crew/add/page.tsx",
        startLine: 1,
        endLine: 2,
        sourceKind: "ROUTE",
        summary: input.evidenceSummary ?? "Crew can be added.",
        githubUrl: "https://github.com/acme/web/blob/sha/app/crew/add/page.tsx#L1-L2"
      }
    ]
  };
}

function previousPage(): WikiPageRowLike {
  return {
    id: "page-1",
    pageKey: "crew.add",
    title: "Crew Add",
    inputHash: "hash"
  };
}

function blockRow(overrides: Partial<WikiBlockRowLike> = {}): WikiBlockRowLike {
  return {
    id: "old-block",
    parentBlockId: null,
    position: 0,
    stableKey: "crew.add.0.crew-can-be-added",
    type: "statement",
    origin: "CODE",
    reviewState: "VERIFIED",
    sourceHash: "old-source",
    contentHash: "old-content",
    evidenceIds: ["ev-old"],
    locked: true,
    blockJson: {
      type: "statement",
      text: "Crew can be added.",
      confidence: 0.95,
      evidenceIds: ["ev-old"],
      lastGeneratedRunId: "run-old"
    },
    ...overrides
  };
}
