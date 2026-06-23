import { beforeEach, describe, expect, it, vi } from "vitest";

import { getBlockEvidence, getWikiReaderData } from "./wiki-read";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  evidence: { id: "evidence.id", generationRunId: "evidence.generation_run_id" },
  generationRuns: { id: "generation_runs.id" },
  wikiBlockOverlays: { workspaceId: "wiki_block_overlays.workspace_id" },
  wikiBlocks: { id: "wiki_blocks.id", pageId: "wiki_blocks.page_id" },
  wikiPages: { id: "wiki_pages.id", workspaceId: "wiki_pages.workspace_id" }
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  inArray: vi.fn((left: unknown, values: unknown[]) => ({ left, values }))
}));

vi.mock("@code2wiki/db", () => ({
  evidence: mocks.evidence,
  generationRuns: mocks.generationRuns,
  getDb: mocks.getDb,
  wikiBlockOverlays: mocks.wikiBlockOverlays,
  wikiBlocks: mocks.wikiBlocks,
  wikiPages: mocks.wikiPages
}));

describe("wiki-read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies overlays by page-local stableKey when block ID changed across runs", async () => {
    mocks.getDb.mockReturnValue(makeDb());

    const data = await getWikiReaderData("page-1");

    const block = data?.blocks[0];
    expect(block?.id).toBe("new-block");
    expect(block?.stableKey).toBe("crew.add.0.crew-can-be-added");
    expect(block?.origin).toBe("CODE_EDITED");
    expect(block?.type === "statement" ? block.text : null).toBe("Edited overlay text");
  });

  it("resolves evidence from current block generation run", async () => {
    mocks.getDb.mockReturnValue(makeDb());

    const rows = await getBlockEvidence("new-block");

    expect(rows).toEqual([
      expect.objectContaining({
        id: "ev-current",
        generationRunId: "run-current",
        githubUrl: "https://github.com/acme/web/blob/current/app/crew/add/page.tsx#L1-L2"
      })
    ]);
  });
});

function makeDb() {
  const page = {
    id: "page-1",
    workspaceId: "workspace-1",
    generationRunId: "run-current",
    pageKey: "crew.add",
    title: "Crew Add",
    slug: "crew/add"
  };
  const block = {
    id: "new-block",
    pageId: "page-1",
    generationRunId: "run-current",
    parentBlockId: null,
    position: 0,
    stableKey: "crew.add.0.crew-can-be-added",
    type: "statement",
    origin: "CODE" as const,
    reviewState: "VERIFIED" as const,
    sourceHash: "source",
    contentHash: "content",
    evidenceIds: ["ev-current"],
    locked: true,
    blockJson: {
      type: "statement",
      text: "Crew can be added.",
      confidence: 0.95,
      evidenceIds: ["ev-current"],
      lastGeneratedRunId: "run-current"
    }
  };
  const overlay = {
    id: "overlay-1",
    workspaceId: "workspace-1",
    targetBlockId: "old-block",
    targetStableKey: "crew.add.0.crew-can-be-added",
    overlayType: "EDIT" as const,
    overlayJson: { version: 1, block: { type: "statement", text: "Edited overlay text" } },
    createdAt: new Date("2026-01-01T00:00:00Z")
  };
  const currentEvidence = {
    id: "ev-current",
    generationRunId: "run-current",
    repositoryRole: "FRONTEND",
    repositoryFullName: "acme/web",
    tag: "v2",
    commitSha: "current",
    filePath: "app/crew/add/page.tsx",
    startLine: 1,
    endLine: 2,
    sourceKind: "ROUTE",
    summary: "Crew can be added.",
    codeSnippet: "export default function Page() {}",
    githubUrl: "https://github.com/acme/web/blob/current/app/crew/add/page.tsx#L1-L2"
  };

  const rows = (table: unknown) => {
    if (table === mocks.wikiPages) return [page];
    if (table === mocks.generationRuns) return [{ id: "run-current", status: "COMPLETED" }];
    if (table === mocks.wikiBlocks) return [block];
    if (table === mocks.wikiBlockOverlays) return [overlay];
    if (table === mocks.evidence) return [currentEvidence];
    return [];
  };

  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue(rows(table)),
          then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows(table)).then(resolve)
        })),
        limit: vi.fn().mockResolvedValue(rows(table))
      }))
    }))
  };
}
